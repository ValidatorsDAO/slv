#!/usr/bin/env python3
"""Verified immutable SLV release consumer.

Both sh/install and the compiled CLI embed this exact Python standard-library
engine.  It accepts only canonical ValidatorsDAO/slv GitHub Release identities.
"""
from __future__ import annotations

import argparse
import datetime as datetime
import errno
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Optional

REPOSITORY = 'ValidatorsDAO/slv'
WORKFLOW_PATH = '.github/workflows/slv-remote-build.yml'
WORKFLOW_IDENTITY = 'github.com/ValidatorsDAO/slv/.github/workflows/slv-remote-build.yml'
RELEASE_API = f'https://api.github.com/repos/{REPOSITORY}/releases'
RELEASE_DOWNLOAD = f'https://github.com/{REPOSITORY}/releases/download'
SKILLS = (
    'slv-validator', 'slv-rpc', 'slv-grpc-geyser', 'slv-benchmark',
    'slv-app', 'slv-bot-trade-app', 'slv-server-procurement', 'slv-backup',
    'slv-firewall', 'slv-wireguard',
)
TARGETS = (
    'x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu',
    'x86_64-apple-darwin', 'aarch64-apple-darwin',
)
SOURCE_ASSETS = (
    'slv-source.tar.gz', 'deno-source.tar.gz', 'deno-cargo-vendor.tar.gz',
)
VERSION_RE = re.compile(r'^[0-9]{4}\.(?:[1-9]|1[0-2])\.(?:[1-9]|[12][0-9]|3[01])\.[0-9]{4}$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
COMMIT_RE = re.compile(r'^[0-9a-f]{40}$')
DECIMAL_RE = re.compile(r'^[1-9][0-9]*$')
ASSET_RE = re.compile(r'^[A-Za-z0-9._-]+$')
MAX_METADATA = 16 * 1024 * 1024
MAX_ASSET = 4 * 1024 * 1024 * 1024
MAX_SOURCE_ASSET = 2 * 1024 * 1024 * 1024
MAX_MEMBERS = 10_000
MAX_EXPANDED = 2 * 1024 * 1024 * 1024

# Pin both downloaded official archives and the executable extracted from each.
GH = {
    ('Linux', 'x86_64'): ('linux_amd64', 'tar.gz',
        'bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386',
        '7469124f706944133d6a169691dd1c6c3511b12e85878d255e044e2948df4c9b'),
    ('Linux', 'aarch64'): ('linux_arm64', 'tar.gz',
        '7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484',
        '93308395c2d296a63a662742c6366e4db413d2a4870d07bd9b84e491c065d65d'),
    ('Darwin', 'x86_64'): ('macOS_amd64', 'zip',
        'b245f24eb2bf5f75b426b4c26da3651a107f8d5b6f4fddfbfccc5679041378b3',
        'df615405bcf707c5855f22c8be477c62cd7f7af743de75c4805c2b375b3a479c'),
    ('Darwin', 'aarch64'): ('macOS_arm64', 'zip',
        'da922c20d1792e5b2cbf375593d7a658acf034c12c84e007e71c76ef959c337e',
        '8a4258433c81106343144857750316241759d06dcf16265cf3c4864a8f2f2ad6'),
}


class ReleaseError(RuntimeError):
    pass


def die(message: str) -> None:
    raise ReleaseError(message)


def valid_version(value: object) -> bool:
    if not isinstance(value, str) or not VERSION_RE.fullmatch(value):
        return False
    try:
        year, month, day, clock = value.split('.')
        datetime.datetime(int(year), int(month), int(day), int(clock[:2]), int(clock[2:]))
    except (ValueError, IndexError):
        return False
    return True


def require_version(value: object, field: str = 'version') -> str:
    if not valid_version(value):
        die(f'invalid {field}; expected real UTC YYYY.M.D.HHmm CalVer')
    return value  # type: ignore[return-value]


def compare_versions(a: str, b: str) -> int:
    require_version(a)
    require_version(b)
    aa, bb = tuple(map(int, a.split('.'))), tuple(map(int, b.split('.')))
    return (aa > bb) - (aa < bb)


def target_for_host() -> str:
    system = platform.system()
    raw = platform.machine().lower()
    arch = {'x86_64': 'x86_64', 'amd64': 'x86_64', 'aarch64': 'aarch64', 'arm64': 'aarch64'}.get(raw)
    if system == 'Linux' and arch:
        return f'{arch}-unknown-linux-gnu'
    if system == 'Darwin' and arch:
        return f'{arch}-apple-darwin'
    die(f'unsupported platform: {system}/{raw}')


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def fsync_dir(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        pass


def fsync_dir_required(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as exc:
        die(f'cannot durably synchronize directory {path}: {exc}')


def acquire_lock(root: Path) -> int:
    """Serialize recovery and every replacement boundary for this SLV home."""
    private_dir(root)
    lock = root / '.release.lock'
    descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT, 0o600)
    os.chmod(lock, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        die('another SLV release operation is already running')
    return descriptor


def release_lock(descriptor: int) -> None:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def lstat(path: Path) -> os.stat_result:
    try:
        return path.lstat()
    except FileNotFoundError:
        die(f'missing required path: {path}')


def mkdirs_without_links(path: Path) -> None:
    """Create a directory chain without first traversing an existing link."""
    missing: list[Path] = []
    current = path
    while True:
        try:
            item = current.lstat()
        except FileNotFoundError:
            missing.append(current)
            if current == current.parent:
                die(f'cannot create destination parent: {path}')
            current = current.parent
            continue
        if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
            die(f'unsafe destination parent: {current}')
        break
    for directory in reversed(missing):
        try:
            os.mkdir(directory, 0o700)
        except FileExistsError:
            item = lstat(directory)
            if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
                die(f'unsafe destination parent: {directory}')
        fsync_dir_required(directory.parent)


def private_dir(path: Path) -> None:
    mkdirs_without_links(path)
    info = lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        die(f'unsafe managed directory: {path}')
    os.chmod(path, 0o700)
    fsync_dir_required(path)


def safe_parent(path: Path, managed_root: Optional[Path] = None) -> None:
    mkdirs_without_links(path)
    root = managed_root.resolve() if managed_root is not None else None
    current = path
    while True:
        item = lstat(current)
        if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
            die(f'unsafe destination parent: {current}')
        # Managed trees must be private all the way to their declared root.
        # For an explicit external target, only its immediate parent needs to
        # be writable by the caller; ancestors such as /tmp are not trusted as
        # managed storage and are merely checked for links/non-directories.
        if root is not None:
            if item.st_uid != os.getuid():
                die(f'unsafe managed parent owner: {current}')
            if item.st_mode & 0o022:
                die(f'unsafe destination parent: {current}')
            if current == root:
                return
        elif current == path and item.st_mode & 0o022:
            die(f'unsafe destination parent: {current}')
        if current == current.parent:
            return
        current = current.parent


def validate_existing_parent(path: Path, managed_root: Optional[Path] = None) -> None:
    """Validate an existing parent chain without creating recovery paths."""
    root = managed_root.resolve() if managed_root is not None else None
    current = path
    while True:
        item = lstat(current)
        if stat.S_ISLNK(item.st_mode) or not stat.S_ISDIR(item.st_mode):
            die(f'unsafe destination parent: {current}')
        if root is not None:
            if item.st_uid != os.getuid():
                die(f'unsafe managed parent owner: {current}')
            if item.st_mode & 0o022:
                die(f'unsafe destination parent: {current}')
            if current == root:
                return
        elif current == path and item.st_mode & 0o022:
            die(f'unsafe destination parent: {current}')
        if current == current.parent:
            return
        current = current.parent


def atomic_json(path: Path, value: Any) -> None:
    safe_parent(path.parent, path.parent)
    temporary = path.parent / f'.{path.name}.{uuid.uuid4().hex}.tmp'
    data = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        fsync_dir_required(path.parent)
    finally:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()


def load_journal(path: Path) -> dict[str, Any]:
    info = lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        die(f'unsafe journal: {path}')
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as exc:
        die(f'unreadable journal: {exc}')
    if not isinstance(value, dict):
        die('invalid journal')
    return value


def remove(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode):
        for entry in os.scandir(path):
            remove(Path(entry.path))
        path.rmdir()
    else:
        path.unlink()


def fixed_asset_url(tag: str, name: str) -> str:
    if not isinstance(tag, str) or not tag.startswith('v') or not valid_version(tag[1:]):
        die('invalid release tag')
    if not isinstance(name, str) or not ASSET_RE.fullmatch(name):
        die('unsafe release asset identity')
    return f'{RELEASE_DOWNLOAD}/{tag}/{name}'


def read_http(url: str, limit: int) -> bytes:
    request = urllib.request.Request(url, headers={
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'slv-release-consumer/1',
    })
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            if response.status != 200:
                die(f'download failed: HTTP {response.status}')
            header = response.headers.get('Content-Length')
            if header and (not header.isdigit() or int(header) > limit):
                die('download exceeds bounded size')
            parts: list[bytes] = []
            total = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > limit:
                    die('download exceeds bounded size')
                parts.append(block)
            return b''.join(parts)
    except urllib.error.HTTPError as exc:
        die(f'download failed: HTTP {exc.code}')
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        die(f'download failed: {exc}')


def download_asset(url: str, destination: Path, size: Any, digest: Any) -> None:
    if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= MAX_ASSET:
        die('invalid payload size')
    if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
        die('invalid payload digest')
    safe_parent(destination.parent)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    total, hasher = 0, hashlib.sha256()
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'slv-release-consumer/1'})
        with urllib.request.urlopen(request, timeout=90) as response, os.fdopen(descriptor, 'wb') as output:
            if response.status != 200:
                die(f'payload download failed: HTTP {response.status}')
            header = response.headers.get('Content-Length')
            if header and (not header.isdigit() or int(header) != size):
                die('payload size conflicts with manifest')
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                total += len(block)
                if total > size:
                    die('payload exceeds manifest size')
                hasher.update(block)
                output.write(block)
            output.flush()
            os.fsync(output.fileno())
        if total != size or hasher.hexdigest() != digest:
            die(f'payload digest mismatch: {destination.name}')
        fsync_dir(destination.parent)
    except Exception:
        try:
            destination.unlink()
        except FileNotFoundError:
            pass
        raise


def immutable_release(tag: Optional[str] = None) -> dict[str, Any]:
    url = f'{RELEASE_API}/latest' if tag is None else f'{RELEASE_API}/tags/{tag}'
    try:
        value = json.loads(read_http(url, MAX_METADATA))
    except json.JSONDecodeError as exc:
        die(f'invalid GitHub release JSON: {exc}')
    if not isinstance(value, dict):
        die('invalid GitHub release response')
    found = value.get('tag_name')
    if value.get('immutable') is not True or value.get('draft') is not False or value.get('prerelease') is not False:
        die('release is not immutable, published, and non-prerelease')
    if not isinstance(found, str) or not found.startswith('v') or not valid_version(found[1:]):
        die('release tag is not strict CalVer')
    if tag is not None and tag != found:
        die('release tag response does not match requested version')
    return value


def minimal_identity(raw: bytes, tag: str) -> tuple[str, str]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        die(f'invalid release manifest JSON: {exc}')
    if not isinstance(value, dict) or value.get('repository') != REPOSITORY or value.get('tag') != tag or value.get('version') != tag[1:]:
        die('manifest identity does not match immutable release')
    source = value.get('source')
    if not isinstance(source, dict) or not isinstance(source.get('commit'), str) or not COMMIT_RE.fullmatch(source['commit']):
        die('manifest source commit is invalid')
    if source.get('ref') not in ('refs/heads/main', f'refs/tags/{tag}'):
        die('manifest source ref is invalid')
    return source['ref'], source['commit']


def parse_manifest(raw: bytes, tag: str) -> dict[str, dict[str, Any]]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        die(f'invalid release manifest JSON: {exc}')
    expected_fields = {'schema_version', 'repository', 'version', 'tag', 'source', 'workflow', 'assets'}
    if not isinstance(value, dict) or set(value) != expected_fields:
        die('manifest schema is invalid')
    if value['schema_version'] != 1 or value['repository'] != REPOSITORY or value['tag'] != tag or value['version'] != tag[1:]:
        die('manifest identity is invalid')
    require_version(value['version'])
    source = value['source']
    if not isinstance(source, dict) or set(source) != {'commit', 'ref'} or not isinstance(source.get('commit'), str) or not COMMIT_RE.fullmatch(source['commit']):
        die('manifest source is invalid')
    if source['ref'] not in ('refs/heads/main', f'refs/tags/{tag}'):
        die('manifest source ref is invalid')
    workflow = value['workflow']
    if not isinstance(workflow, dict) or set(workflow) != {'path', 'run_id', 'run_attempt'}:
        die('manifest workflow is invalid')
    if workflow.get('path') != WORKFLOW_PATH or not isinstance(workflow.get('run_id'), str) or not DECIMAL_RE.fullmatch(workflow['run_id']):
        die('manifest workflow identity is invalid')
    if isinstance(workflow.get('run_attempt'), bool) or not isinstance(workflow.get('run_attempt'), int) or workflow['run_attempt'] < 1:
        die('manifest workflow attempt is invalid')
    expected_entries = (
        *[(f'slv-{target}-exe.tar.gz', 'executable', target) for target in TARGETS],
        ('template.tar.gz', 'template', None),
        *[(f'{skill}.tar.gz', 'skill', None) for skill in SKILLS],
        ('install', 'installer', None),
        ('sbom.spdx.json', 'sbom', None),
        ('THIRD_PARTY_NOTICES', 'notices', None),
        *[(name, 'source', None) for name in SOURCE_ASSETS],
    )
    expected = dict((name, (kind, target)) for name, kind, target in expected_entries)
    assets = value['assets']
    if not isinstance(assets, list):
        die('manifest assets are invalid')
    indexed: dict[str, dict[str, Any]] = {}
    for position, asset in enumerate(assets):
        if not isinstance(asset, dict) or set(asset) not in (
            {'name', 'kind', 'sha256', 'size'},
            {'name', 'kind', 'target', 'sha256', 'size'},
        ):
            die('manifest asset schema is invalid')
        name = asset.get('name')
        if not isinstance(name, str) or not ASSET_RE.fullmatch(name) or name in indexed or name not in expected:
            die('manifest asset inventory is invalid')
        if position >= len(expected_entries) or name != expected_entries[position][0]:
            die('manifest asset inventory order is invalid')
        kind, target = expected[name]
        if asset.get('kind') != kind or asset.get('target') != target or (target is None and 'target' in asset):
            die(f'manifest asset kind/target is invalid: {name}')
        if not isinstance(asset.get('sha256'), str) or not SHA256_RE.fullmatch(asset['sha256']):
            die(f'manifest asset digest is invalid: {name}')
        size = asset.get('size')
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            die(f'manifest asset size is invalid: {name}')
        if (kind == 'source' and size >= MAX_SOURCE_ASSET) or (kind != 'source' and size > MAX_ASSET):
            die(f'manifest asset size is invalid: {name}')
        indexed[name] = asset
    if set(indexed) != set(expected):
        die('manifest payload inventory is incomplete')
    return indexed


def clean_env(home: Path) -> dict[str, str]:
    return {
        'HOME': str(home), 'PATH': os.defpath, 'LC_ALL': 'C',
        'XDG_CONFIG_HOME': str(home / '.config'),
        'XDG_CACHE_HOME': str(home / '.cache'),
        'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull,
        'GIT_TERMINAL_PROMPT': '0',
    }


def verifier_spec() -> tuple[str, str, str, str]:
    arch = {'amd64': 'x86_64', 'arm64': 'aarch64'}.get(platform.machine().lower(), platform.machine().lower())
    spec = GH.get((platform.system(), arch))
    if spec is None:
        die(f'no pinned verifier for {platform.system()}/{arch}')
    return spec


def safe_member(name: str) -> str:
    name = name.rstrip('/')
    if not name or name.startswith('/') or '\\' in name or '\x00' in name:
        die('archive contains unsafe path')
    item = PurePosixPath(name)
    if item.is_absolute() or not item.parts or any(part in ('', '.', '..') for part in item.parts):
        die('archive contains unsafe path')
    return str(item)


def extract_gh(archive: Path, platform_name: str, extension: str, executable_digest: str, target: Path) -> None:
    root, wanted = f'gh_2.102.0_{platform_name}', f'gh_2.102.0_{platform_name}/bin/gh'
    names: set[str] = set()
    total = 0
    content: Optional[bytes] = None
    if extension == 'tar.gz':
        try:
            with tarfile.open(archive, 'r:gz') as items:
                records = items.getmembers()
                if len(records) > MAX_MEMBERS:
                    die('verifier archive has too many members')
                for record in records:
                    name = safe_member(record.name)
                    if name in names or not (record.isfile() or record.isdir()):
                        die('verifier archive has unsafe member')
                    names.add(name); total += record.size
                    if total > MAX_EXPANDED:
                        die('verifier archive exceeds expansion limit')
                found = [record for record in records if record.name == wanted and record.isfile()]
                if len(found) != 1:
                    die('pinned verifier binary is missing')
                source = items.extractfile(found[0])
                if source is None:
                    die('cannot read pinned verifier')
                content = source.read()
        except (tarfile.TarError, OSError) as exc:
            die(f'invalid verifier archive: {exc}')
    else:
        try:
            with zipfile.ZipFile(archive) as items:
                records = items.infolist()
                if len(records) > MAX_MEMBERS:
                    die('verifier archive has too many members')
                for record in records:
                    name = safe_member(record.filename)
                    mode = record.external_attr >> 16
                    if name in names or (not record.is_dir() and mode & 0o170000 not in (0, stat.S_IFREG)):
                        die('verifier archive has unsafe member')
                    names.add(name); total += record.file_size
                    if total > MAX_EXPANDED:
                        die('verifier archive exceeds expansion limit')
                found = [record for record in records if record.filename == wanted and not record.is_dir()]
                if len(found) != 1:
                    die('pinned verifier binary is missing')
                content = items.read(found[0])
        except (zipfile.BadZipFile, OSError) as exc:
            die(f'invalid verifier archive: {exc}')
    if content is None or hashlib.sha256(content).hexdigest() != executable_digest:
        die('pinned verifier executable digest mismatch')
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(content); output.flush(); os.fsync(output.fileno())
    os.chmod(target, 0o700)


def managed_gh(root: Path, work: Path) -> Path:
    platform_name, extension, archive_digest, executable_digest = verifier_spec()
    cache = root / 'verify' / 'gh' / '2.102.0' / platform_name
    for directory in (root / 'verify', root / 'verify' / 'gh', root / 'verify' / 'gh' / '2.102.0', cache):
        private_dir(directory)
    cached = cache / 'gh'
    if cached.exists() or cached.is_symlink():
        try:
            info = lstat(cached)
            if not stat.S_ISLNK(info.st_mode) and stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022 and info.st_mode & 0o111 and sha256(cached) == executable_digest:
                return cached
        except ReleaseError:
            pass
    archive = work / f'gh.{extension}'
    url = f'https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_{platform_name}.{extension}'
    raw = read_http(url, 128 * 1024 * 1024)
    if hashlib.sha256(raw).hexdigest() != archive_digest:
        die('pinned verifier archive digest mismatch')
    archive.write_bytes(raw); os.chmod(archive, 0o600)
    candidate = work / 'gh'
    extract_gh(archive, platform_name, extension, executable_digest, candidate)
    # A malicious cache is never executed or recursively erased.  The checked
    # temporary verifier remains usable for this run.
    if not cached.exists() and not cached.is_symlink():
        try:
            os.replace(candidate, cached); fsync_dir(cache)
            return cached
        except OSError:
            pass
    return candidate


def verify_attestation(gh: Path, manifest: Path, bundle: Path, source_ref: str, source_digest: str, work: Path) -> None:
    clean_home = work / 'gh-home'; private_dir(clean_home)
    command = [
        str(gh), 'attestation', 'verify', str(manifest), '--bundle', str(bundle),
        '--repo', REPOSITORY, '--signer-workflow', WORKFLOW_IDENTITY,
        '--source-ref', source_ref, '--source-digest', source_digest,
        '--deny-self-hosted-runners',
    ]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=90, cwd=work, env=clean_env(clean_home))
    except (OSError, subprocess.TimeoutExpired) as exc:
        die(f'managed verifier failed to run: {exc}')
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f'exit {result.returncode}'
        die(f'manifest attestation verification failed: {detail[:500]}')


def verify_peeled_tag(tag: str, source_digest: str, work: Path) -> None:
    clean_home = work / 'git-home'; private_dir(clean_home)
    direct = f'refs/tags/{tag}'
    peeled = f'{direct}^{{}}'
    command = ['git', 'ls-remote', 'https://github.com/ValidatorsDAO/slv.git', direct, peeled]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=45, cwd=work, env=clean_env(clean_home))
    except (OSError, subprocess.TimeoutExpired) as exc:
        die(f'public tag lookup failed: {exc}')
    rows = [line.split() for line in result.stdout.splitlines() if line.strip()]
    refs: dict[str, str] = {}
    if result.returncode:
        die('public release tag lookup failed')
    for row in rows:
        if len(row) != 2 or row[1] not in (direct, peeled) or not COMMIT_RE.fullmatch(row[0]) or row[1] in refs:
            die('public release tag lookup is ambiguous or invalid')
        refs[row[1]] = row[0]
    if direct not in refs:
        die('public release tag is missing')
    # An annotated tag supplies the peeled commit. A lightweight tag points
    # directly to its commit, so its direct ref is the equivalent resolution.
    resolved = refs.get(peeled, refs[direct])
    if resolved != source_digest:
        die('public peeled release tag does not match signed source commit')


def tar_inventory(archive: Path, prefix: str, single: bool) -> list[tarfile.TarInfo]:
    try:
        with tarfile.open(archive, 'r:gz') as items:
            records = items.getmembers()
    except (tarfile.TarError, OSError) as exc:
        die(f'invalid archive {archive.name}: {exc}')
    if not records or len(records) > MAX_MEMBERS:
        die('archive has invalid member count')
    names: set[str] = set()
    files: set[str] = set()
    total = 0
    for record in records:
        name = safe_member(record.name)
        if name in names or not (record.isfile() or record.isdir()):
            die('archive contains duplicate or non-regular member')
        names.add(name); total += record.size
        if total > MAX_EXPANDED:
            die('archive exceeds expansion limit')
        if single:
            if not record.isfile() or name != prefix:
                die('executable archive must contain exactly one regular root member')
        elif name != prefix and not name.startswith(prefix + '/'):
            die('archive member is outside expected root')
        elif name == prefix and not record.isdir():
            die('archive root must be a directory')
        if record.isfile():
            files.add(name)
    if (single and (len(records) != 1 or len(files) != 1)) or (not single and not files):
        die('archive has invalid required content')
    if any(other.startswith(name + '/') for name in files for other in names):
        die('archive has file/directory collision')
    return records


def extract_tar(archive: Path, destination: Path, prefix: str, single: bool = False) -> Path:
    records = tar_inventory(archive, prefix, single)
    private_dir(destination)
    try:
        with tarfile.open(archive, 'r:gz') as items:
            for record in records:
                target = destination.joinpath(*PurePosixPath(record.name.rstrip('/')).parts)
                if record.isdir():
                    target.mkdir(mode=0o700, parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                if target.exists() or target.is_symlink():
                    die('archive extraction path already exists')
                source = items.extractfile(record)
                if source is None:
                    die('archive member cannot be read')
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700 if single else 0o600)
                with os.fdopen(descriptor, 'wb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                    output.flush(); os.fsync(output.fileno())
    except (tarfile.TarError, OSError) as exc:
        die(f'cannot safely extract {archive.name}: {exc}')
    return destination / prefix


def preflight_archives(downloads: Path, target: str, version: str, skills: Iterable[str]) -> None:
    """Scan every requested tar before creating any extracted staging tree."""
    binary_root = f'slv-{target}-exe'
    tar_inventory(downloads / f'{binary_root}.tar.gz', binary_root, True)
    tar_inventory(downloads / 'template.tar.gz', f'template/{version}', False)
    for skill in skills:
        tar_inventory(downloads / f'{skill}.tar.gz', skill, False)


COMPLIANCE_ASSETS = ('THIRD_PARTY_NOTICES', 'sbom.spdx.json')


def stage_compliance_docs(downloads: Path, extracted: Path, version: str) -> Path:
    """Create the versioned, no-link consumer notice directory from verified bytes."""
    staged = extracted / 'licenses' / version
    private_dir(staged)
    for name in COMPLIANCE_ASSETS:
        source = downloads / name
        info = lstat(source)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            die(f'unsafe verified compliance asset: {name}')
        destination = staged / name
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with source.open('rb') as input_file, os.fdopen(descriptor, 'wb') as output:
            shutil.copyfileobj(input_file, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
    fsync_dir_required(staged)
    return staged


def tree_hashes(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    info = lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        die(f'unsafe skill destination: {path}')
    output: dict[str, str] = {}
    for root, directories, filenames in os.walk(path, followlinks=False):
        for directory in directories:
            if Path(root, directory).is_symlink():
                die('unsafe skill link')
        for filename in filenames:
            file = Path(root, filename)
            if file.is_symlink() or not file.is_file():
                die('unsafe skill file')
            output[str(file.relative_to(path))] = sha256(file)
    return output


def skill_counts(staged: Path, installed: Path, force: bool) -> tuple[int, int, int]:
    new, old = tree_hashes(staged), tree_hashes(installed)
    added = sum(key not in old for key in new)
    updated = sum(key in old and old[key] != value for key, value in new.items())
    unchanged = sum(key in old and old[key] == value for key, value in new.items())
    if force:
        updated += unchanged
        unchanged = 0
    return added, updated, unchanged


def tree_fingerprint(path: Path) -> tuple[tuple[str, ...], dict[str, str]]:
    """Return the complete no-link shape and file bytes of a skill tree."""
    if not path.exists():
        return (), {}
    info = lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        die(f'unsafe skill destination: {path}')
    directories: list[str] = []
    for base, names, _files in os.walk(path, followlinks=False):
        for name in names:
            directory = Path(base, name)
            if directory.is_symlink() or not directory.is_dir():
                die('unsafe skill directory')
            directories.append(str(directory.relative_to(path)))
    return tuple(sorted(directories)), tree_hashes(path)


def skill_needs_replacement(staged: Path, installed: Path, force: bool) -> bool:
    return force or tree_fingerprint(staged) != tree_fingerprint(installed)


REQUIRED_TEMPLATE_JINJA_DIRS = (
    'testnet-rpc', 'testnet-validator', 'devnet-rpc', 'mainnet-rpc',
    'mainnet-validator', 'mainnet-hermes', 'mainnet-pythnet', 'cmn',
)


def validate_template_tree(template: Path) -> None:
    root = template / 'jinja'
    if root.is_symlink() or not root.is_dir():
        die('verified template archive is missing jinja')
    missing = [name for name in REQUIRED_TEMPLATE_JINJA_DIRS if (root / name).is_symlink() or not (root / name).is_dir()]
    if missing:
        die(f'verified template archive is missing required jinja directories: {", ".join(missing)}')


# The sudo helper only receives an already hash-checked staged executable and
# one explicit absolute destination. It never fetches, extracts, or verifies.
PRIVILEGED_SWAP = r'''
import os, shutil, stat, sys, uuid
source, target = sys.argv[1], sys.argv[2]
s = os.lstat(source)
if stat.S_ISLNK(s.st_mode) or not stat.S_ISREG(s.st_mode): raise SystemExit('unsafe staged binary')
parent = os.path.dirname(target); p = os.lstat(parent)
if stat.S_ISLNK(p.st_mode) or not stat.S_ISDIR(p.st_mode): raise SystemExit('unsafe binary parent')
try:
    old = os.lstat(target)
    if stat.S_ISLNK(old.st_mode) or not stat.S_ISREG(old.st_mode): raise SystemExit('unsafe binary target')
except FileNotFoundError: pass
temporary = os.path.join(parent, '.slv-release-' + uuid.uuid4().hex)
try:
    with open(source, 'rb') as inp, open(temporary, 'xb') as out:
        shutil.copyfileobj(inp, out, 1024 * 1024); out.flush(); os.fsync(out.fileno())
    os.chmod(temporary, 0o755); os.replace(temporary, target)
    fd = os.open(parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
finally:
    try: os.unlink(temporary)
    except FileNotFoundError: pass
'''


def copy_backup_atomically(source: Path, backup: Path) -> None:
    """Publish a privileged rollback copy only after its bytes are durable."""
    temporary = backup.parent / f'.slv-release-backup-copy-{uuid.uuid4().hex}'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with source.open('rb') as input_file, os.fdopen(descriptor, 'wb') as output:
            shutil.copyfileobj(input_file, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, backup)
        os.chmod(backup, 0o700)
        fsync_dir_required(backup.parent)
    except Exception:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def fsync_file_required(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as exc:
        die(f'cannot durably synchronize file {path}: {exc}')


def fsync_tree_required(path: Path) -> None:
    info = lstat(path)
    if stat.S_ISLNK(info.st_mode):
        die(f'cannot synchronize linked staging path: {path}')
    if stat.S_ISREG(info.st_mode):
        fsync_file_required(path)
        return
    if not stat.S_ISDIR(info.st_mode):
        die(f'cannot synchronize non-file staging path: {path}')
    children = [Path(entry.path) for entry in os.scandir(path)]
    for child in children:
        fsync_tree_required(child)
    fsync_dir_required(path)


class Transaction:
    def __init__(self, root: Path, work: Path):
        self.root, self.work = root, work
        self.path = root / '.release-journal.json'
        self.data: dict[str, Any] = {'schema_version': 1, 'status': 'applying', 'work': str(work), 'operations': []}
        atomic_json(self.path, self.data)

    def save(self) -> None:
        atomic_json(self.path, self.data)

    def replace(self, source: Path, destination: Path, privileged: Optional[bool] = False) -> None:
        managed_destination = child_of(destination, self.root)
        safe_parent(destination.parent, self.root if managed_destination else None)
        if privileged is None:
            privileged = not writable_target(destination)
        had_existing = destination.exists() or destination.is_symlink()
        backup_parent = self.work / 'backups' if privileged else destination.parent
        if privileged:
            private_dir(backup_parent)
        backup = backup_parent / f'.slv-release-backup-{uuid.uuid4().hex}'
        operation = {
            'source': str(source), 'destination': str(destination),
            'backup': str(backup), 'had_existing': had_existing,
            'privileged': privileged, 'backup_ready': False, 'state': 'prepared',
        }
        self.data['operations'].append(operation); self.save()
        if had_existing:
            operation['state'] = 'backing_up'; self.save()
            info = lstat(destination)
            if stat.S_ISLNK(info.st_mode):
                die(f'unsafe replacement target: {destination}')
            if privileged:
                if not stat.S_ISREG(info.st_mode):
                    die('privileged replacement target is not a regular file')
                copy_backup_atomically(destination, backup)
            else:
                fsync_tree_required(destination)
                os.replace(destination, backup)
                fsync_dir_required(destination.parent)
            operation['backup_ready'] = True
            operation['state'] = 'backed_up'; self.save()
        operation['state'] = 'installing'; self.save()
        if privileged:
            result = subprocess.run(['sudo', 'python3', '-I', '-c', PRIVILEGED_SWAP, str(source), str(destination)], stdin=subprocess.DEVNULL)
            if result.returncode:
                die('privileged final binary replacement failed')
        else:
            try:
                fsync_tree_required(source)
                os.replace(source, destination)
                fsync_dir_required(destination.parent)
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                candidate = destination.parent / f'.slv-release-new-{uuid.uuid4().hex}'
                if source.is_dir():
                    shutil.copytree(source, candidate, symlinks=False)
                else:
                    shutil.copyfile(source, candidate); os.chmod(candidate, 0o755)
                fsync_tree_required(candidate)
                os.replace(candidate, destination)
                fsync_dir_required(destination.parent)
        operation['state'] = 'installed'; self.save()

    def commit(self) -> None:
        self.data['status'] = 'committed'; self.save()
        for operation in self.data['operations']:
            backup = Path(operation['backup'])
            remove(backup)
            fsync_dir_required(backup.parent)
        self.path.unlink(missing_ok=True); fsync_dir_required(self.root)


def restore_privileged(source: Path, destination: Path, delete: bool = False) -> None:
    if delete:
        code = r'''import os, stat, sys
target = sys.argv[1]
parent = os.path.dirname(target)
info = os.lstat(parent)
if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
    raise SystemExit('unsafe binary parent')
try:
    info = os.lstat(target)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise SystemExit('unsafe binary target')
    os.unlink(target)
except FileNotFoundError:
    pass
descriptor = os.open(parent, os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
'''
        result = subprocess.run(['sudo', 'python3', '-I', '-c', code, str(destination)], stdin=subprocess.DEVNULL)
    else:
        result = subprocess.run(['sudo', 'python3', '-I', '-c', PRIVILEGED_SWAP, str(source), str(destination)], stdin=subprocess.DEVNULL)
    if result.returncode:
        die('privileged journal recovery failed')


def normalized_absolute(path: Path) -> bool:
    return path.is_absolute() and path == Path(os.path.abspath(str(path)))


def child_of(path: Path, parent: Path) -> bool:
    if not normalized_absolute(path):
        return False
    try:
        return path.relative_to(parent) != Path('.')
    except ValueError:
        return False


def recover(root: Path, authorized_binary: Optional[Path] = None) -> bool:
    journal = root / '.release-journal.json'
    if not journal.exists() and not journal.is_symlink():
        return False
    if authorized_binary is not None:
        authorized_binary = Path(os.path.abspath(str(authorized_binary)))
        if not normalized_absolute(authorized_binary) or authorized_binary.name != 'slv':
            die('authorized binary target is invalid')
    data = load_journal(journal)
    if data.get('schema_version') != 1 or data.get('status') not in ('applying', 'committed') or not isinstance(data.get('operations'), list):
        die('journal schema is invalid')
    work = Path(str(data.get('work', '')))
    stage = root / '.release-staging'
    if not child_of(work, stage) or work.parent != stage:
        die('journal work path is invalid')
    parsed: list[tuple[dict[str, Any], Path, Path, bool, bool, bool, bool]] = []
    for operation in data['operations']:
        if not isinstance(operation, dict) or set(operation) != {
            'source', 'destination', 'backup', 'had_existing', 'privileged',
            'backup_ready', 'state',
        }:
            die('journal operation is invalid')
        destination = Path(str(operation.get('destination', '')))
        backup = Path(str(operation.get('backup', '')))
        source = Path(str(operation.get('source', '')))
        privileged = operation.get('privileged') is True
        existing = operation.get('had_existing') is True
        backup_ready = operation.get('backup_ready') is True
        managed_destination = child_of(destination, root)
        if not isinstance(operation.get('had_existing'), bool) or not isinstance(operation.get('privileged'), bool) or not isinstance(operation.get('backup_ready'), bool) or operation.get('state') not in ('prepared', 'backing_up', 'backed_up', 'installing', 'installed'):
            die('journal operation state is invalid')
        if not child_of(source, work):
            die('journal source path is invalid')
        if privileged:
            if not normalized_absolute(destination) or destination.name != 'slv' or backup.parent != work / 'backups' or not backup.name.startswith('.slv-release-backup-'):
                die('privileged journal paths are invalid')
        elif not managed_destination and (not normalized_absolute(destination) or destination.name != 'slv'):
            die('external journal destination is invalid')
        if not privileged and (backup.parent != destination.parent or not backup.name.startswith('.slv-release-backup-')):
            die('journal paths are invalid')
        # A journal can outlive the command that created it.  Managed SLV-home
        # paths are fixed by this trusted root, but every external binary
        # target needs a fresh, exact authorization from the current command
        # before recovery may touch it or invoke sudo.
        if privileged or not managed_destination:
            if authorized_binary is None:
                die('unfinished external binary transaction requires slv install or upgrade with its exact --install-path')
            if destination != authorized_binary:
                die('journal external binary does not match the selected --install-path')
        if privileged:
            # A lexical child of ~/.slv can still escape via an ancestor link.
            # Validate the entire chain before any sudo helper is considered.
            validate_existing_parent(destination.parent, root if managed_destination else None)
        parsed.append((operation, destination, backup, privileged, existing, backup_ready, managed_destination))
    if data['status'] == 'applying':
        for operation, destination, backup, privileged, existing, backup_ready, managed_destination in reversed(parsed):
            if backup.exists() or backup.is_symlink():
                # A privileged copy is authoritative only after the journal
                # records its atomic publication.  A copy interrupted before
                # that point must never replace the intact destination.
                if privileged and not backup_ready:
                    remove(backup)
                    fsync_dir_required(backup.parent)
                elif privileged:
                    restore_privileged(backup, destination)
                else:
                    safe_parent(destination.parent, root if managed_destination else None)
                    remove(destination)
                    fsync_dir_required(destination.parent)
                    os.replace(backup, destination)
                    fsync_dir_required(destination.parent)
            elif not existing and operation.get('state') in ('installing', 'installed'):
                if privileged:
                    restore_privileged(backup, destination, delete=True)
                else:
                    safe_parent(destination.parent, root if managed_destination else None)
                    remove(destination)
                    fsync_dir_required(destination.parent)
    else:
        # A crash after recording `committed` must preserve destinations and
        # finish only the deferred backup cleanup.
        for _operation, _destination, backup, _privileged, _existing, _backup_ready, _managed_destination in parsed:
            remove(backup)
            fsync_dir_required(backup.parent)
    if work.exists() or work.is_symlink():
        remove(work)
        fsync_dir_required(stage)
    journal.unlink(missing_ok=True); fsync_dir_required(root)
    return True


def choose_target(requested: Optional[str], running: Optional[str]) -> Path:
    home = Path.home().resolve()
    controlled = home / '.local' / 'bin' / 'slv'
    selected = requested or running
    if selected:
        target = Path(os.path.abspath(os.path.expanduser(selected)))
        if not target.is_absolute() or target.name != 'slv':
            die('binary target must be an absolute path ending in slv')
        if target.exists() or target.is_symlink():
            info = lstat(target)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                die('refusing linked or non-regular binary target')
        return target
    existing = shutil.which('slv')
    if existing and Path(existing).resolve() != controlled:
        die(f'existing slv at {existing}; use --install-path {existing} to replace it explicitly')
    return controlled


def writable_target(target: Path) -> bool:
    return target.parent.exists() and os.access(target.parent, os.W_OK | os.X_OK) and (not target.exists() or os.access(target, os.W_OK))


def verified(root: Path, work: Path, release: dict[str, Any]) -> tuple[str, dict[str, dict[str, Any]]]:
    tag = release['tag_name']
    manifest_raw = read_http(fixed_asset_url(tag, 'release-manifest.json'), MAX_METADATA)
    bundle_raw = read_http(fixed_asset_url(tag, 'release-manifest.json.intoto.jsonl'), MAX_METADATA)
    source_ref, source_digest = minimal_identity(manifest_raw, tag)
    manifest, bundle = work / 'release-manifest.json', work / 'release-manifest.json.intoto.jsonl'
    manifest.write_bytes(manifest_raw); bundle.write_bytes(bundle_raw)
    os.chmod(manifest, 0o600); os.chmod(bundle, 0o600)
    verify_attestation(managed_gh(root, work), manifest, bundle, source_ref, source_digest, work)
    assets = parse_manifest(manifest_raw, tag)
    verify_peeled_tag(tag, source_digest, work)
    return tag, assets


def make_work(root: Path, prefix: str, authorized_binary: Optional[Path] = None) -> Path:
    private_dir(root); recover(root, authorized_binary)
    staging = root / '.release-staging'; private_dir(staging)
    work = Path(tempfile.mkdtemp(prefix=prefix, dir=staging)); os.chmod(work, 0o700)
    fsync_dir_required(work)
    fsync_dir_required(staging)
    return work


def _install_release(root: Path, release: dict[str, Any], target_binary: Path, skills: tuple[str, ...], settings: bool, force: bool = False) -> dict[str, int]:
    work = make_work(root, 'release-', target_binary)
    try:
        tag, assets = verified(root, work, release)
        version, target = tag[1:], target_for_host()
        requested = [f'slv-{target}-exe.tar.gz', 'template.tar.gz', *[f'{skill}.tar.gz' for skill in skills], *COMPLIANCE_ASSETS]
        downloads = work / 'downloads'; private_dir(downloads)
        for name in requested:
            asset = assets[name]
            download_asset(fixed_asset_url(tag, name), downloads / name, asset['size'], asset['sha256'])
        preflight_archives(downloads, target, version, skills)
        extracted = work / 'extracted'; private_dir(extracted)
        compliance_docs = stage_compliance_docs(downloads, extracted, version)
        binary_root = f'slv-{target}-exe'
        binary = extract_tar(downloads / f'{binary_root}.tar.gz', extracted / 'binary', binary_root, True)
        template = extract_tar(downloads / 'template.tar.gz', extracted / 'template', f'template/{version}')
        validate_template_tree(template)
        staged_skills: dict[str, Path] = {}
        result = {'added': 0, 'updated': 0, 'unchanged': 0}
        for skill in skills:
            staged_skills[skill] = extract_tar(downloads / f'{skill}.tar.gz', extracted / 'skills', skill)
            added, updated, unchanged = skill_counts(staged_skills[skill], root / 'skills' / skill, force)
            result['added'] += added; result['updated'] += updated; result['unchanged'] += unchanged
        transaction = Transaction(root, work)
        try:
            transaction.replace(template, root / 'template' / version)
            for skill in skills:
                transaction.replace(staged_skills[skill], root / 'skills' / skill)
            transaction.replace(compliance_docs, root / 'licenses' / version)
            # The transaction creates and validates a missing controlled
            # parent before deciding whether privilege is required.  Testing
            # writability here would turn a fresh ~/.local/bin install into a
            # needless sudo request.
            transaction.replace(binary, target_binary, privileged=None)
            transaction.commit()
        except Exception:
            recover(root, target_binary)
            raise
        if settings:
            try:
                completed = subprocess.run([str(target_binary), 'upgrade:settings'], stdin=subprocess.DEVNULL, timeout=120)
            except (OSError, subprocess.TimeoutExpired) as exc:
                die(f'release installed but settings migration could not start ({exc}); settings were not rolled back')
            if completed.returncode:
                die('release installed but settings migration failed; settings were not rolled back')
        return result
    finally:
        if not (root / '.release-journal.json').exists():
            remove(work)


def _sync_skills(root: Path, version: str, selected: tuple[str, ...], force: bool) -> dict[str, Any]:
    if any(skill not in SKILLS for skill in selected) or len(set(selected)) != len(selected):
        die('unknown or duplicate skill selection')
    work = make_work(root, 'skills-')
    try:
        tag, assets = verified(root, work, immutable_release(f'v{version}'))
        downloads = work / 'downloads'; private_dir(downloads)
        for name in [*[f'{skill}.tar.gz' for skill in selected], *COMPLIANCE_ASSETS]:
            asset = assets[name]
            download_asset(fixed_asset_url(tag, name), downloads / name, asset['size'], asset['sha256'])
        # A skills sync does not need binary/template archives, but all of its
        # selected skill archives must pass inventory validation as one set.
        for skill in selected:
            tar_inventory(downloads / f'{skill}.tar.gz', skill, False)
        extracted = work / 'extracted'; private_dir(extracted)
        compliance_docs = stage_compliance_docs(downloads, extracted, version)
        staged: dict[str, Path] = {}
        replacements: list[str] = []
        result: dict[str, Any] = {'added': 0, 'updated': 0, 'unchanged': 0, 'failed': 0, 'failedFiles': []}
        for skill in selected:
            staged[skill] = extract_tar(downloads / f'{skill}.tar.gz', extracted / 'skills', skill)
            added, updated, unchanged = skill_counts(staged[skill], root / 'skills' / skill, force)
            result['added'] += added; result['updated'] += updated; result['unchanged'] += unchanged
            if skill_needs_replacement(staged[skill], root / 'skills' / skill, force):
                replacements.append(skill)
        transaction = Transaction(root, work)
        try:
            for skill in replacements:
                transaction.replace(staged[skill], root / 'skills' / skill)
            # Notices and the SBOM are release artifacts too.  A no-op skill
            # sync still repairs their versioned consumer delivery.
            transaction.replace(compliance_docs, root / 'licenses' / version)
            transaction.commit()
        except Exception:
            recover(root)
            raise
        return result
    finally:
        if not (root / '.release-journal.json').exists():
            remove(work)


def install_release(root: Path, release: dict[str, Any], target_binary: Path, skills: tuple[str, ...], settings: bool, force: bool = False) -> dict[str, int]:
    lock = acquire_lock(root)
    try:
        return _install_release(root, release, target_binary, skills, settings, force)
    finally:
        release_lock(lock)


def sync_skills(root: Path, version: str, selected: tuple[str, ...], force: bool) -> dict[str, Any]:
    lock = acquire_lock(root)
    try:
        return _sync_skills(root, version, selected, force)
    finally:
        release_lock(lock)


def recover_before_release_network(root: Path, authorized_binary: Path) -> bool:
    """Honor an unfinished local journal even when discovery later fails."""
    lock = acquire_lock(root)
    try:
        return recover(root, authorized_binary)
    finally:
        release_lock(lock)


def make_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description='Verified SLV immutable-release consumer')
    parser.add_argument('--bootstrap-version')
    parser.add_argument('--root', help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest='command')
    for name in ('install', 'upgrade'):
        command = sub.add_parser(name)
        command.add_argument('--running-binary')
        command.add_argument('--install-path')
        command.add_argument('--no-settings-migration', action='store_true')
    sub.choices['upgrade'].add_argument('--current-version', required=True)
    skills = sub.add_parser('skills')
    skills.add_argument('--version', required=True)
    skills.add_argument('--only', action='append')
    skills.add_argument('--force', action='store_true')
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    if sys.version_info < (3, 9):
        die('Python 3.9 or later is required')
    raw = list(sys.argv[1:] if argv is None else argv)
    if not raw:
        raw = ['install']
    args = make_parser().parse_args(raw)
    if args.command == 'install':
        # The shell bootstrap has a human-reviewable CalVer label that is
        # rewritten by the existing release-version process.  The engine must
        # not duplicate that mutable value: its release identity comes from
        # the immutable API record, signed manifest, and public tag check.
        if args.bootstrap_version:
            require_version(args.bootstrap_version, 'bootstrap VERSION')
        root = Path(args.root).expanduser().resolve() if args.root else Path.home() / '.slv'
        target = choose_target(args.install_path, args.running_binary)
        recover_before_release_network(root, target)
        release = immutable_release()
        install_release(root, release, target, SKILLS, not args.no_settings_migration)
        print(f'Installed verified SLV {release["tag_name"]} at {target}')
        if target == Path.home() / '.local' / 'bin' / 'slv':
            print('Add ~/.local/bin to PATH before other SLV locations, then open a new shell.')
        return 0
    if args.command == 'upgrade':
        current = require_version(args.current_version, 'running CLI version')
        root = Path(args.root).expanduser().resolve() if args.root else Path.home() / '.slv'
        target = choose_target(args.install_path, args.running_binary)
        recovered = recover_before_release_network(root, target)
        release = immutable_release()
        available = release['tag_name'][1:]
        comparison = compare_versions(available, current)
        if comparison < 0:
            if recovered:
                die('recovered an interrupted release, but the running CLI is newer than the available immutable release; rerun the restored installed slv and retry')
            print(f'SLV v{current} is current; refusing automatic downgrade or reinstall.')
            return 0
        if comparison == 0 and not recovered:
            print(f'SLV v{current} is current; refusing automatic downgrade or reinstall.')
            return 0
        install_release(root, release, target, SKILLS, not args.no_settings_migration)
        if recovered:
            print(f'Repaired interrupted SLV release at {target} with verified v{available}')
        else:
            print(f'Upgraded SLV from v{current} to v{available} at {target}')
        return 0
    if args.command == 'skills':
        version = require_version(args.version, 'running CLI version')
        selected = tuple(args.only) if args.only else SKILLS
        root = Path(args.root).expanduser().resolve() if args.root else Path.home() / '.slv'
        print(json.dumps(sync_skills(root, version, selected, args.force), separators=(',', ':')))
        return 0
    die('missing release engine command')


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except ReleaseError as exc:
        print(f'slv release: {exc}', file=sys.stderr)
        raise SystemExit(1)
