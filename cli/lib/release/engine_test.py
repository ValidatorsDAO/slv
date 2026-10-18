from __future__ import annotations

import io
import copy
import hashlib
import json
import os
import errno
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from email.message import Message
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import engine

EMPTY_REVOCATION_POLICY = b'{"schema_version":1,"revoked_identities":[]}'
POLICY_VALIDATORS = {'etag': '"fixture"', 'last_modified': None}


def verified_payload_stub(tag: str, assets: dict):
    """Keep transaction fixtures isolated, with the required verified context."""
    def accept(_root: Path, work: Path, _release: dict):
        (work / 'release-manifest.json').write_bytes(manifest(tag[1:]))
        return tag, assets
    return accept


def asset(name: str, kind: str, target: str | None = None) -> dict[str, object]:
    value: dict[str, object] = {
        'name': name, 'kind': kind, 'sha256': 'a' * 64, 'size': 1,
    }
    if target is not None:
        value['target'] = target
    return value


def qualification_fixture() -> dict[str, object]:
    # Exercise the real, reviewed public descriptor as well as synthetic negatives.
    return json.loads((Path(__file__).resolve().parents[3] / 'source-materials/runtime-qualification.json').read_bytes())


def qualification_reference(qualification: dict, source: dict, workflow: dict) -> dict:
    identity = hashlib.sha256(engine.canonical_json(qualification, True)).hexdigest()
    products = []
    for target, qualified in zip(engine.TARGETS, qualification['targets']):
        arch = 'aarch64' if target == 'aarch64-unknown-linux-gnu' else 'x86_64'
        assets = qualification['assets']
        receipt = {
            'schema_version': 2, 'kind': 'slv-current-product-receipt', 'target': target,
            'source': {**source, **dict.fromkeys(('lock_sha256', 'graph_sha256', 'sbom_sha256', 'notices_sha256',
                                                 'source_receipt_sha256', 'engine_sha256', 'bridge_source_sha256'), 'a' * 64)},
            'qualification': {
                'identity': identity, 'state': 'final-qualified',
                'baseline_denort_sha256': assets[qualified['runtime']]['sha256'],
                'selected_lock_sha256': assets[qualification['source']['selected_lock']]['sha256'],
                'derived_lock_sha256': assets[qualified['derived_lock']]['sha256'],
                'native_proof_sha256': assets[qualified['proof']]['sha256'],
                'build_receipt_sha256': assets[qualified['build_receipt']]['sha256'],
            },
            'producer': {'repository': engine.REPOSITORY, 'workflow': engine.WORKFLOW_PATH,
                         'workflow_sha': source['commit'], 'run_id': workflow['run_id'],
                         'run_attempt': str(workflow['run_attempt']), 'job': f'build-{target}',
                         'host_os': 'linux', 'host_arch': arch,
                         'profile': 'linux-arm64-4' if arch == 'aarch64' else 'linux-16'},
            'frontend': {'version': '2.9.3', 'sha256': qualification['compatibility']['frontend'][f'{arch}-unknown-linux-gnu']['sha256'],
                         'flags': engine.product_flags(target), 'bridge_flags': engine.product_flags(target, True)},
            'output': dict.fromkeys(('executable_sha256', 'archive_sha256', 'bridge_sha256', 'verification_sha256'), 'a' * 64),
            'native_execution': 'passed' if target.endswith('linux-gnu') else 'not_performed',
        }
        products.append({'receipt_sha256': hashlib.sha256(engine.canonical_json(receipt)).hexdigest(), 'receipt': receipt})
    return {'identity': identity, 'tag': f'runtime-deno-v2.9.3-{identity}', 'manifest_sha256': identity,
            'state': 'final-qualified', 'products': products}


def rehash_products(value: dict) -> None:
    for item in value['runtime_qualification']['products']:
        item['receipt_sha256'] = hashlib.sha256(engine.canonical_json(item['receipt'])).hexdigest()


def manifest(version: str = '2026.6.6.2026') -> bytes:
    qualification = qualification_fixture()
    items = [
        *[asset(f'slv-{target}-exe.tar.gz', 'executable', target) for target in engine.TARGETS],
        asset('template.tar.gz', 'template'),
        *[asset(f'{skill}.tar.gz', 'skill') for skill in engine.SKILLS],
        asset('install', 'installer'),
        asset('sbom.spdx.json', 'sbom'),
        asset('THIRD_PARTY_NOTICES', 'notices'),
        *[asset(name, 'source') for name in engine.SOURCE_ASSETS],
    ]
    for item in items:
        if item['name'] in ('deno-source.tar.gz', 'deno-cargo-vendor.tar.gz'):
            item.update(qualification['assets'][qualification['source']['archives'][item['name']]])
    source = {'commit': 'b' * 40, 'ref': 'refs/heads/main'}
    workflow = {'path': engine.WORKFLOW_PATH, 'run_id': '42', 'run_attempt': 1}
    return json.dumps({
        'schema_version': 2,
        'repository': engine.REPOSITORY,
        'version': version,
        'tag': f'v{version}',
        'source': source,
        'workflow': workflow,
        'assets': items,
        'runtime_qualification': qualification_reference(qualification, source, workflow),
    }).encode()


def write_tar(path: Path, records: list[tuple[str, bytes, bytes | None]]) -> None:
    with tarfile.open(path, 'w:gz') as output:
        for name, content, link in records:
            info = tarfile.TarInfo(name)
            if link is not None:
                info.type = tarfile.SYMTYPE
                info.linkname = link.decode()
                output.addfile(info)
            else:
                info.size = len(content)
                output.addfile(info, io.BytesIO(content))


def write_template_tar(path: Path, version: str) -> None:
    with tarfile.open(path, 'w:gz') as output:
        for name in (f'template/{version}', f'template/{version}/jinja', *[f'template/{version}/jinja/{entry}' for entry in engine.REQUIRED_TEMPLATE_JINJA_DIRS]):
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            output.addfile(info)
        marker = tarfile.TarInfo(f'template/{version}/jinja/cmn/marker')
        marker.size = 8
        output.addfile(marker, io.BytesIO(b'template'))


def verification_fixture(application: dict | None = None, qualification: dict | None = None) -> tuple[dict, dict, dict[str, bytes]]:
    app = application or json.loads(manifest())
    qualification = qualification or qualification_fixture()
    tag = app['runtime_qualification']['tag']
    base = f'{engine.RELEASE_DOWNLOAD}/{tag}'
    raw = engine.canonical_json(qualification, True)
    bundle = b'controlled attestation bytes\n'
    expected = {**qualification['assets'],
                'runtime-qualification.json': {'size': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()},
                'runtime-qualification.json.intoto.jsonl': {'size': len(bundle), 'sha256': hashlib.sha256(bundle).hexdigest()}}
    release = {'tag_name': tag, 'immutable': True, 'draft': False, 'prerelease': True,
               'target_commitish': 'c' * 40,
               'assets': [{'name': name, 'size': spec['size'], 'digest': f"sha256:{spec['sha256']}",
                           'browser_download_url': f'{base}/{name}'} for name, spec in expected.items()]}
    responses = {
        f'{engine.RELEASE_DOWNLOAD}/{app["tag"]}/release-manifest.json': json.dumps(app).encode(),
        f'{engine.RELEASE_DOWNLOAD}/{app["tag"]}/release-manifest.json.intoto.jsonl': bundle,
        f'{engine.RELEASE_API}/tags/{tag}': json.dumps(release).encode(),
        f'{base}/runtime-qualification.json': raw,
        f'{base}/runtime-qualification.json.intoto.jsonl': bundle,
        f'https://api.github.com/repos/{engine.REPOSITORY}/compare/{"c" * 40}...{app["source"]["commit"]}?per_page=1':
            json.dumps({'status': 'ahead', 'base_commit': {'sha': 'c' * 40}, 'merge_base_commit': {'sha': 'c' * 40}}).encode(),
    }
    return app, release, responses


class ReleaseEngineTest(unittest.TestCase):
    def policy_worker_fixture(self, body: bytes, *, status: int = 200, headers: list[tuple[str, str]] = (),
                              url: str = engine.REVOCATION_URL, fail_open: bool = False) -> tuple[int, bytes, dict]:
        """Run the actual fixed worker with a mocked transport, never a test URL."""
        message = Message()
        for name, value in headers:
            message[name] = value
        class Response:
            def __init__(self):
                self.status, self.headers, self.stream, self.closed = status, message, io.BytesIO(body), False
            def __enter__(self):
                return self
            def __exit__(self, *args):
                self.closed = True
            def geturl(self):
                return url
            def read(self, limit):
                self_limit = min(65536, engine.MAX_REVOCATION_POLICY + 1)
                if not 0 < limit <= self_limit:
                    raise AssertionError('unbounded policy read')
                return self.stream.read(limit)
        response = Response()
        opener_calls = []
        def build_opener(*handlers):
            self.assertEqual(len(handlers), 2)
            self.assertIsInstance(handlers[0], engine.urllib.request.ProxyHandler)
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsInstance(handlers[1], engine.urllib.request.HTTPRedirectHandler)
            opener_calls.extend(handlers)
            def open_request(request, timeout):
                self.assertEqual(request.full_url, engine.REVOCATION_URL)
                self.assertEqual(timeout, 10)
                supplied = {name.lower(): value for name, value in request.header_items()}
                self.assertEqual(set(supplied), {'accept', 'accept-encoding', 'cache-control', 'pragma', 'user-agent'})
                self.assertEqual(supplied['accept-encoding'], 'identity')
                self.assertIn('no-cache', supplied['cache-control'])
                self.assertEqual(supplied['pragma'], 'no-cache')
                self.assertIsNone(request.data)
                if fail_open:
                    raise OSError('controlled transport unavailable')
                return response
            return SimpleNamespace(open=open_request)
        output, errors, namespace = io.BytesIO(), io.StringIO(), {}
        code = 0
        with patch.object(engine.urllib.request, 'build_opener', side_effect=build_opener), \
             patch.object(sys, 'stdout', SimpleNamespace(buffer=output)), patch.object(sys, 'stderr', errors):
            try:
                exec(engine.REVOCATION_FETCH_CODE, namespace)
            except SystemExit as exc:
                code = exc.code
        if not fail_open:
            self.assertTrue(response.closed)
        self.assertEqual(len(opener_calls), 2)
        return code, output.getvalue(), namespace

    def run_verified_fixture(self, app: dict, responses: dict[str, bytes], subject_change=None,
                             reject_signer: bool | str = False, wrong_qualification_tag: bool = False,
                             policy: bytes = EMPTY_REVOCATION_POLICY, entrypoint: str = 'verified',
                             later_policy: bytes | None = None) -> tuple[list[str], list[list[str]]]:
        requests, commands = [], []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); work = root / 'work'; work.mkdir(mode=0o700)
            installed = root / 'slv'; installed.write_bytes(b'existing executable')
            files = root / 'fixture-assets'; files.mkdir()
            if entrypoint != 'verified':
                version = app['version']; target = engine.TARGETS[0]
                write_tar(files / f'slv-{target}-exe.tar.gz', [(f'slv-{target}-exe', b'new binary', None)])
                write_template_tar(files / 'template.tar.gz', version)
                write_tar(files / 'slv-validator.tar.gz', [('slv-validator/SKILL.md', b'new skill', None)])
                (files / 'THIRD_PARTY_NOTICES').write_bytes(b'new notices')
                (files / 'sbom.spdx.json').write_bytes(b'{"new":"sbom"}')
            policy_calls = 0

            def request(url: str, limit: int) -> bytes:
                requests.append(url)
                data = responses[url]
                self.assertLessEqual(len(data), limit)
                return data

            def execute(command: list[str], **kwargs) -> SimpleNamespace:
                nonlocal policy_calls
                commands.append(command)
                if command[:3] == [sys.executable, '-I', '-c']:
                    self.assertEqual(command[3], engine.REVOCATION_FETCH_CODE)
                    self.assertEqual(kwargs['timeout'], 10)
                    self.assertEqual(set(kwargs['env']), {'PATH', 'LC_ALL'} | ({'HOME'} if 'HOME' in os.environ else set()))
                    if 'HOME' in os.environ:
                        self.assertEqual(kwargs['env']['HOME'], os.environ['HOME'])
                    policy_calls += 1
                    current_policy = later_policy if policy_calls > 1 and later_policy is not None else policy
                    return SimpleNamespace(returncode=0, stdout=json.dumps(POLICY_VALIDATORS).encode() + b'\n' + current_policy, stderr=b'')
                if command[0] == 'git':
                    ref = command[-2]
                    digest = 'c' * 40 if ref.startswith('refs/tags/runtime-') else app['source']['commit']
                    if wrong_qualification_tag and ref.startswith('refs/tags/runtime-'):
                        digest = 'd' * 40
                    return SimpleNamespace(returncode=0, stdout=f'{digest}\t{ref}\n', stderr='')
                self.assertEqual(command[1:3], ['attestation', 'verify'])
                name = Path(command[3]).name
                expected_commit = 'c' * 40 if name == 'runtime-qualification.json' else app['source']['commit']
                for flag, value in (('--repo', engine.REPOSITORY), ('--signer-workflow', engine.WORKFLOW_IDENTITY),
                                    ('--source-ref', 'refs/heads/main'), ('--source-digest', expected_commit),
                                    ('--signer-digest', expected_commit), ('--format', 'json')):
                    self.assertEqual(command[command.index(flag) + 1], value)
                self.assertIn('--deny-self-hosted-runners', command)
                self.assertEqual(kwargs['timeout'], 90)
                self.assertNotIn('GH_TOKEN', kwargs['env'])
                if reject_signer is True or reject_signer == name:
                    return SimpleNamespace(returncode=1, stdout='', stderr='untrusted signer')
                statement = {'_type': 'https://in-toto.io/Statement/v1', 'predicateType': 'https://slsa.dev/provenance/v1',
                             'subject': [{'name': name, 'digest': {'sha256': engine.sha256(Path(command[3]))}}]}
                if name == 'release-manifest.json':
                    # actions/attest subject-path release/* signs all payloads,
                    # the manifest and SHA256SUMS in one shared statement.
                    statement['subject'].extend({'name': item['name'], 'digest': {'sha256': item['sha256']}}
                                                for item in app['assets'])
                    statement['subject'].append({'name': 'SHA256SUMS', 'digest': {'sha256': 'e' * 64}})
                    self.assertEqual(len(statement['subject']), 23)
                if subject_change:
                    subject_change(statement)
                return SimpleNamespace(returncode=0, stdout=json.dumps([{'verificationResult': {'statement': statement}}]), stderr='')

            try:
                with patch.object(engine, 'read_http', side_effect=request), \
                     patch.object(engine, 'managed_gh', return_value=work / 'pinned-gh'), \
                     patch.object(engine.subprocess, 'run', side_effect=execute), \
                     patch.object(engine, 'target_for_host', return_value=engine.TARGETS[0]), \
                     patch.object(engine, 'download_asset', side_effect=lambda _url, destination, _size, _digest: shutil.copyfile(files / destination.name, destination)), \
                     patch.object(engine, 'immutable_release', return_value={'tag_name': app['tag']}):
                    if entrypoint == 'verified':
                        tag, assets = engine.verified(root, work, {'tag_name': app['tag']})
                        self.assertEqual(tag, app['tag']); self.assertEqual(len(assets), 21)
                        observation = json.loads((work / 'runtime-policy-verified.json').read_bytes())
                        self.assertEqual(observation['current_main_policy']['sha256'], hashlib.sha256(policy).hexdigest())
                        self.assertEqual(observation['current_main_policy']['url'], engine.REVOCATION_URL)
                        self.assertIsNone(observation['current_main_policy']['source_commit'])
                        self.assertEqual(observation['outcome'], 'allowed')
                    elif entrypoint == 'install':
                        engine.install_release(root, {'tag_name': app['tag']}, installed, ('slv-validator',), False)
                    elif entrypoint == 'skills':
                        engine.sync_skills(root, app['version'], ('slv-validator',), False)
                    else:
                        self.fail('unknown entrypoint')
                    if entrypoint != 'verified':
                        self.assertEqual(policy_calls, 2)
            finally:
                expected_binary = b'new binary' if entrypoint == 'install' and policy_calls == 2 and later_policy is None else b'existing executable'
                self.assertEqual(installed.read_bytes(), expected_binary)
                self.assertFalse((root / '.release-journal.json').exists())
                if later_policy is not None:
                    self.assertFalse((root / 'template').exists())
                    self.assertFalse((root / 'skills').exists())
                    self.assertFalse((root / 'licenses').exists())
        return requests, commands

    def test_current_main_policy_is_mandatory_in_verified_install_and_skills(self) -> None:
        app, _, responses = verification_fixture()
        identity = app['runtime_qualification']['identity']
        denied = json.dumps({'schema_version': 1, 'revoked_identities': [identity]}).encode()
        for entrypoint in ('verified', 'install', 'skills'):
            with self.subTest(entrypoint=entrypoint), self.assertRaisesRegex(engine.ReleaseError, 'revoked'):
                self.run_verified_fixture(app, responses, policy=denied, entrypoint=entrypoint)
        for entrypoint in ('install', 'skills'):
            with self.subTest(phase='after-download', entrypoint=entrypoint), \
                 patch.object(engine.Transaction, 'replace', side_effect=AssertionError('revoked policy reached replacement')) as replace, \
                 self.assertRaisesRegex(engine.ReleaseError, 'revoked'):
                self.run_verified_fixture(app, responses, entrypoint=entrypoint, later_policy=denied)
            replace.assert_not_called()
        unrelated = json.dumps({'schema_version': 1, 'revoked_identities': ['f' * 64]}).encode()
        for entrypoint in ('verified', 'install', 'skills'):
            with self.subTest(allowed=entrypoint):
                self.run_verified_fixture(app, responses, policy=unrelated, entrypoint=entrypoint)

    def test_invalid_current_policy_rejects_actual_acceptance_without_cached_success(self) -> None:
        app, _, responses = verification_fixture()
        identity = app['runtime_qualification']['identity']
        bad_values = [b'', b'\xff', b'\xe2\x82', b'{', b'{"schema_version":1,"revoked_identities":[]} extra',
                      b'{"schema_version":1,"schema_version":1,"revoked_identities":[]}',
                      b'{"schema_version":1,"revoked_identities":[],"revoked_identities":[]}',
                      b'{"schema_version":true,"revoked_identities":[]}',
                      b'{"schema_version":1.0,"revoked_identities":[]}',
                      b'{"schema_version":2,"revoked_identities":[]}',
                      b'{"schema_version":1,"revoked_identities":null}',
                      b'{"schema_version":1,"revoked_identities":[],"url":"https://example.invalid"}',
                      b'{"schema_version":1}', b' ' * (engine.MAX_REVOCATION_POLICY + 1)]
        for identities in ([identity, identity], [identity.upper()], [identity[:-1]], [True], [None], [{}]):
            bad_values.append(json.dumps({'schema_version': 1, 'revoked_identities': identities}).encode())
        for value in bad_values:
            with self.subTest(policy=value[:60]), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses, policy=value)
        for entrypoint in ('install', 'skills'):
            with self.subTest(recheck=entrypoint), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses, entrypoint=entrypoint, later_policy=b'{')
        # An unlisted identity does not grant trust to a changed product receipt.
        changed = copy.deepcopy(app)
        changed['runtime_qualification']['products'][0]['receipt']['output']['archive_sha256'] = 'd' * 64
        rehash_products(changed)
        invalid, _, invalid_responses = verification_fixture(changed)
        with self.assertRaises(engine.ReleaseError):
            self.run_verified_fixture(invalid, invalid_responses)

    def test_policy_worker_uses_fixed_unauthenticated_transport_and_closes_response(self) -> None:
        headers = [('Content-Length', str(len(EMPTY_REVOCATION_POLICY))), ('ETag', '"fresh"')]
        code, output, namespace = self.policy_worker_fixture(EMPTY_REVOCATION_POLICY, headers=headers)
        self.assertEqual(code, 0)
        metadata, raw = output.split(b'\n', 1)
        self.assertEqual(raw, EMPTY_REVOCATION_POLICY)
        self.assertEqual(json.loads(metadata), {'etag': '"fresh"', 'last_modified': None})
        handler = namespace['NoRedirect']()
        for location in (engine.REVOCATION_URL, engine.REVOCATION_URL.replace('/main/', '/other/'), 'https://example.invalid/policy'):
            with self.subTest(location=location), self.assertRaisesRegex(ValueError, 'redirect'):
                handler.redirect_request(None, None, 302, '', {}, location)

    def test_policy_worker_denies_http_errors_redirects_truncation_encoding_and_oversize(self) -> None:
        cases = [
            {'status': status} for status in (201, 204, 301, 302, 304, 307, 308, 404, 500)
        ] + [
            {'url': engine.REVOCATION_URL.replace('/main/', '/other/')},
            {'url': 'https://example.invalid/policy'}, {'fail_open': True},
            {'headers': [('Content-Length', str(len(EMPTY_REVOCATION_POLICY) + 1))]},
            {'headers': [('Content-Length', str(engine.MAX_REVOCATION_POLICY + 1))]},
            {'headers': [('Content-Length', '1'), ('Content-Length', '2')]},
            {'headers': [('Content-Length', '-1')]}, {'headers': [('Content-Length', 'invalid')]},
            {'headers': [('Content-Encoding', 'gzip')]}, {'headers': [('Content-Encoding', 'br')]},
        ]
        for options in cases:
            with self.subTest(options=options):
                code, output, _ = self.policy_worker_fixture(EMPTY_REVOCATION_POLICY, **options)
                self.assertEqual(code, 1); self.assertEqual(output, b'')
        for body in (b'', b' ' * (engine.MAX_REVOCATION_POLICY + 1)):
            code, output, _ = self.policy_worker_fixture(body)
            self.assertEqual(code, 1); self.assertEqual(output, b'')

    def test_revocation_fetch_failure_never_reuses_prior_valid_bytes(self) -> None:
        good = json.dumps(POLICY_VALIDATORS).encode() + b'\n' + EMPTY_REVOCATION_POLICY
        failures = [SimpleNamespace(returncode=1, stdout=b'', stderr=b''),
                    SimpleNamespace(returncode=0, stdout=b'partial', stderr=b''),
                    SimpleNamespace(returncode=0, stdout=b' ' * (engine.MAX_REVOCATION_POLICY + 4097), stderr=b''),
                    subprocess.TimeoutExpired('controlled worker', 10), OSError('controlled start failure')]
        for failure in failures:
            with self.subTest(failure=type(failure).__name__), patch.object(engine.subprocess, 'run', side_effect=[
                SimpleNamespace(returncode=0, stdout=good, stderr=b''), failure,
            ]):
                self.assertEqual(engine.fetch_revocation_policy()[0], EMPTY_REVOCATION_POLICY)
                with self.assertRaises(engine.ReleaseError):
                    engine.fetch_revocation_policy()
        with tempfile.TemporaryDirectory() as temporary, patch.object(engine, 'fetch_revocation_policy') as fetch:
            with self.assertRaisesRegex(engine.ReleaseError, 'context is unavailable'):
                engine.recheck_runtime_policy(Path(temporary), 'before-install')
            fetch.assert_not_called()

    def test_policy_worker_total_deadline_kills_and_reaps_child(self) -> None:
        # Exercise the real parent timeout against a harmless local worker. No
        # network request runs; a per-read-only timeout would not stop this child.
        children = []
        original_popen = subprocess.Popen
        def spawn(*args, **kwargs):
            child = original_popen(*args, **kwargs); children.append(child); return child
        started = time.monotonic()
        with patch.object(engine, 'REVOCATION_FETCH_CODE', 'import time; time.sleep(30)'), \
             patch.object(engine.subprocess, 'Popen', side_effect=spawn), \
             self.assertRaisesRegex(engine.ReleaseError, 'total 10-second deadline'):
            engine.fetch_revocation_policy()
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 9.5); self.assertLess(elapsed, 15)
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertNotEqual(children[0].returncode, 0)

    def test_denied_policy_records_only_observed_bytes_in_private_work(self) -> None:
        identity = qualification_reference(qualification_fixture(), {'commit': 'b' * 40, 'ref': 'refs/heads/main'},
                                           {'run_id': '42', 'run_attempt': 1})['identity']
        denied = json.dumps({'schema_version': 1, 'revoked_identities': [identity]}).encode()
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary).resolve()
            with patch.object(engine, 'fetch_revocation_policy', return_value=(denied, POLICY_VALIDATORS)), \
                 self.assertRaisesRegex(engine.ReleaseError, 'revoked'):
                engine.check_current_runtime_policy(identity, work, 'before-install')
            path = work / 'runtime-policy-before-install.json'
            receipt = json.loads(path.read_bytes())
            self.assertEqual(receipt['outcome'], 'denied')
            self.assertEqual(receipt['current_main_policy']['sha256'], hashlib.sha256(denied).hexdigest())
            self.assertIsNone(receipt['current_main_policy']['source_commit'])
            self.assertEqual(receipt['current_main_policy']['source_commit_status'], 'unavailable')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_verified_schema2_checks_both_manifests_without_runtime_execution(self) -> None:
        app, _, responses = verification_fixture()
        requests, commands = self.run_verified_fixture(app, responses)
        self.assertEqual(len(requests), 6)
        self.assertEqual(len([cmd for cmd in commands if cmd[1:3] == ['attestation', 'verify']]), 2)
        self.assertTrue(all(cmd[0] == 'git' or cmd[0].endswith('pinned-gh') or cmd[:3] == [sys.executable, '-I', '-c'] for cmd in commands))
        self.assertFalse(any('baseline-denort' in request or 'release-bridge' in request for request in requests))

    def test_manifest_rejects_schema1_missing_qualification_candidate_and_duplicate_keys(self) -> None:
        for change in (lambda m: m.update(schema_version=1), lambda m: m.pop('runtime_qualification'),
                       lambda m: m['runtime_qualification'].update(state='candidate-validation'),
                       lambda m: m['runtime_qualification'].update(identity='f' * 64),
                       lambda m: m['runtime_qualification'].update(manifest_sha256='f' * 64),
                       lambda m: m['runtime_qualification'].update(tag='runtime-deno-v2.9.3-' + 'f' * 64),
                       lambda m: m['runtime_qualification']['products'].pop(),
                       lambda m: m['runtime_qualification'].update(extra=True),
                       lambda m: m['source'].update(ref='refs/tags/' + m['tag'])):
            m = json.loads(manifest()); change(m)
            with self.subTest(change=change), self.assertRaises(engine.ReleaseError):
                engine.parse_manifest(json.dumps(m).encode(), m['tag'])
        raw = manifest().replace(b'"schema_version": 2', b'"schema_version": 1, "schema_version": 2', 1)
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(raw, 'v2026.6.6.2026')

    def test_rehashed_product_rejects_stale_sources_run_attempt_target_profile_and_claims(self) -> None:
        changes = [
            ('source', 'commit', 'd' * 40), ('source', 'ref', 'refs/heads/other'),
            ('source', 'lock_sha256', 'd' * 64), ('source', 'graph_sha256', 'd' * 64),
            ('source', 'source_receipt_sha256', 'd' * 64), ('source', 'engine_sha256', 'd' * 64),
            ('source', 'bridge_source_sha256', 'd' * 64), ('source', 'notices_sha256', 'd' * 64),
            ('source', 'sbom_sha256', 'd' * 64), ('producer', 'run_id', '43'), ('producer', 'run_attempt', '0'),
            ('producer', 'run_attempt', '2'), ('producer', 'run_attempt', '01'), ('producer', 'run_attempt', True),
            ('producer', 'workflow_sha', 'd' * 40), ('producer', 'workflow', 'other.yml'),
            ('producer', 'repository', 'elsewhere/slv'), ('producer', 'job', 'build'),
            ('producer', 'profile', 'hosted-linux'), ('producer', 'host_os', 'darwin'),
            ('producer', 'host_arch', 'aarch64'), ('qualification', 'state', 'candidate-validation'),
            ('qualification', 'identity', 'd' * 64), ('frontend', 'version', '2.9.4'),
            ('frontend', 'flags', []), ('frontend', 'bridge_flags', []), ('output', 'archive_sha256', 'd' * 64),
        ]
        for section, key, value in changes:
            m = json.loads(manifest()); m['runtime_qualification']['products'][0]['receipt'][section][key] = value
            rehash_products(m)
            with self.subTest(section=section, key=key, value=value), self.assertRaises(engine.ReleaseError):
                engine.parse_manifest(json.dumps(m).encode(), m['tag'])
        for key, value in (('target', engine.TARGETS[1]), ('native_execution', 'not_performed'), ('extra', 1)):
            m = json.loads(manifest()); m['runtime_qualification']['products'][0]['receipt'][key] = value; rehash_products(m)
            with self.subTest(key=key), self.assertRaises(engine.ReleaseError):
                engine.parse_manifest(json.dumps(m).encode(), m['tag'])
        m = json.loads(manifest()); m['runtime_qualification']['products'][2]['receipt']['native_execution'] = 'passed'; rehash_products(m)
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(m).encode(), m['tag'])
        m = json.loads(manifest()); m['workflow']['run_attempt'] = 2
        self.assertEqual(len(engine.parse_manifest(json.dumps(m).encode(), m['tag'])), 21)

    def test_product_digest_and_qualified_runtime_mappings_are_independently_checked(self) -> None:
        m = json.loads(manifest()); m['runtime_qualification']['products'][0]['receipt']['output']['bridge_sha256'] = 'd' * 64
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(m).encode(), m['tag'])
        for section, key in [('qualification', x) for x in ('baseline_denort_sha256', 'selected_lock_sha256',
                                                           'derived_lock_sha256', 'native_proof_sha256', 'build_receipt_sha256')] + [('frontend', 'sha256')]:
            m = json.loads(manifest()); m['runtime_qualification']['products'][0]['receipt'][section][key] = 'd' * 64
            rehash_products(m)
            app, _, responses = verification_fixture(m)
            with self.subTest(key=key), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses)

    def test_current_source_archives_may_embed_current_notices_and_source_metadata(self) -> None:
        m = json.loads(manifest())
        for name in ('deno-source.tar.gz', 'deno-cargo-vendor.tar.gz'):
            entry = next(item for item in m['assets'] if item['name'] == name)
            entry.update(sha256='d' * 64, size=entry['size'] + 1)
        app, _, responses = verification_fixture(m)
        self.run_verified_fixture(app, responses)

    def test_qualification_rejects_tampered_bytes_even_with_rewritten_metadata_digest(self) -> None:
        app, release, responses = verification_fixture()
        tag = app['runtime_qualification']['tag']; base = f'{engine.RELEASE_DOWNLOAD}/{tag}'
        for content in (responses[f'{base}/runtime-qualification.json'] + b' ',
                        responses[f'{base}/runtime-qualification.json'].replace(b'"upstream_fallback":false', b'"upstream_fallback":true')):
            changed = dict(responses); changed[f'{base}/runtime-qualification.json'] = content
            metadata = copy.deepcopy(release)
            entry = next(x for x in metadata['assets'] if x['name'] == 'runtime-qualification.json')
            entry.update(size=len(content), digest='sha256:' + hashlib.sha256(content).hexdigest())
            changed[f'{engine.RELEASE_API}/tags/{tag}'] = json.dumps(metadata).encode()
            with self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, changed)

    def test_qualification_schema_rejects_rehashed_unknown_policy_abi_and_lineage(self) -> None:
        changes = [lambda m: m.update(extra=1), lambda m: m.update(schema_version=True),
                   lambda m: m['policy'].update(upstream_fallback=True),
                   lambda m: m['compatibility'].update(deno_version='2.9.4'),
                   lambda m: m['compatibility'].update(embedding_recipe_sha256='d' * 64),
                   lambda m: m['targets'][0]['abi'].update(minimum_os='glibc-2.35'),
                   lambda m: m['targets'][0].update(runtime=m['targets'][1]['runtime']),
                   lambda m: m['targets'].reverse(), lambda m: m['targets'].pop(),
                   lambda m: m['producer'].update(repository='elsewhere/slv'),
                   lambda m: m['producer'].update(reviewed_main_equivalent=None),
                   lambda m: m['source']['members'].update({'slv-source/../escape': m['source']['pins']}),
                   lambda m: m['assets'].update({'unreferenced': {'size': 1, 'sha256': 'd' * 64}}),
                   lambda m: m['assets'][m['source']['selected_lock']].update(sha256='d' * 64),
                   lambda m: m['artifacts'].append(copy.deepcopy(m['artifacts'][0]))]
        for change in changes:
            m = qualification_fixture(); change(m); raw = engine.canonical_json(m, True)
            with self.subTest(change=change), self.assertRaises(engine.ReleaseError):
                engine.parse_qualification(raw, hashlib.sha256(raw).hexdigest())
        m = qualification_fixture()
        m['producer'].update(reviewed_main_equivalent=None, workflow_ref='refs/heads/main', api_head_sha=m['producer']['source_commit'])
        raw = engine.canonical_json(m, True)
        self.assertEqual(engine.parse_qualification(raw, hashlib.sha256(raw).hexdigest()), m)

    def test_qualification_public_metadata_inventory_and_ancestry_fail_closed(self) -> None:
        changes = [lambda r: r.update(immutable=False), lambda r: r.update(draft=True), lambda r: r.update(prerelease=False),
                   lambda r: r.update(tag_name='runtime-deno-v2.9.3-' + 'd' * 64), lambda r: r.update(target_commitish='main'),
                   lambda r: r['assets'].pop(), lambda r: r['assets'].append(copy.deepcopy(r['assets'][0])),
                   lambda r: r['assets'][0].update(digest='sha256:' + 'd' * 64),
                   lambda r: r['assets'][0].update(size=True), lambda r: r['assets'][0].update(name='unknown'),
                   lambda r: r['assets'][0].update(browser_download_url='https://example.invalid/asset')]
        for change in changes:
            app, release, responses = verification_fixture(); change(release)
            responses[f'{engine.RELEASE_API}/tags/{app["runtime_qualification"]["tag"]}'] = json.dumps(release).encode()
            with self.subTest(change=change), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses)
        for status in ('behind', 'diverged'):
            app, _, responses = verification_fixture()
            url = next(url for url in responses if '/compare/' in url)
            value = json.loads(responses[url]); value['status'] = status; responses[url] = json.dumps(value).encode()
            with self.subTest(status=status), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses)
        app, _, responses = verification_fixture()
        url = next(url for url in responses if '/compare/' in url)
        value = json.loads(responses[url]); value['base_commit'] = None; responses[url] = json.dumps(value).encode()
        with self.assertRaises(engine.ReleaseError):
            self.run_verified_fixture(app, responses)
        app, _, responses = verification_fixture()
        url = f'{engine.RELEASE_DOWNLOAD}/{app["runtime_qualification"]["tag"]}/runtime-qualification.json.intoto.jsonl'
        responses[url] += b'corrupted'
        with self.assertRaises(engine.ReleaseError):
            self.run_verified_fixture(app, responses)

    def test_verified_attestation_requires_exact_subject_and_trusted_signer(self) -> None:
        app, _, responses = verification_fixture()
        changes = [lambda s: s['subject'][0].update(name='other.json'),
                   lambda s: s['subject'][0]['digest'].update(sha256='d' * 64),
                   lambda s: s.update(subject=[]), lambda s: s.update(predicateType='other')]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses, subject_change=change)
            def qualification_only(statement):
                if statement['subject'][0]['name'] == 'runtime-qualification.json':
                    change(statement)
            with self.subTest(qualification_change=change), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses, subject_change=qualification_only)
        with self.assertRaises(engine.ReleaseError):
            self.run_verified_fixture(app, responses, reject_signer=True)
        with self.assertRaises(engine.ReleaseError):
            self.run_verified_fixture(app, responses, reject_signer='runtime-qualification.json')
        with self.assertRaises(engine.ReleaseError):
            self.run_verified_fixture(app, responses, wrong_qualification_tag=True)

    def test_application_attestation_accepts_shared_subjects_in_any_order(self) -> None:
        app, _, responses = verification_fixture()
        self.run_verified_fixture(app, responses, subject_change=lambda s: s['subject'].reverse())

    def test_shared_attestation_rejects_duplicate_conflicting_missing_and_malformed_subjects(self) -> None:
        app, _, responses = verification_fixture()
        changes = [
            lambda s: s['subject'].append(copy.deepcopy(s['subject'][0])),
            lambda s: s['subject'].append({'name': 'release-manifest.json', 'digest': {'sha256': 'd' * 64}}),
            lambda s: s['subject'].pop(0),
            lambda s: s['subject'][0].update(name='other-manifest.json'),
            lambda s: s['subject'].append({'name': 'malformed', 'digest': {'sha256': 'short'}}),
            lambda s: s['subject'].append({'name': 'malformed', 'digest': None}),
            lambda s: s['subject'].append({'name': 'malformed', 'digest': {'sha256': 'd' * 64}, 'extra': True}),
            lambda s: s['subject'].append({'name': None, 'digest': {'sha256': 'd' * 64}}),
            lambda s: s['subject'].append(None),
            lambda s: s.pop('subject'),
        ]
        for change in changes:
            def application_only(statement):
                if len(statement['subject']) == 23:
                    change(statement)
            with self.subTest(change=change), self.assertRaises(engine.ReleaseError):
                self.run_verified_fixture(app, responses, subject_change=application_only)

    def test_qualification_attestation_remains_exactly_one_subject(self) -> None:
        app, _, responses = verification_fixture()
        def append_other_subject(statement):
            if statement['subject'][0]['name'] == 'runtime-qualification.json':
                statement['subject'].append({'name': 'other', 'digest': {'sha256': 'd' * 64}})
        with self.assertRaises(engine.ReleaseError):
            self.run_verified_fixture(app, responses, subject_change=append_other_subject)

    def test_calver_is_real_utc_and_canonical(self) -> None:
        self.assertTrue(engine.valid_version('2026.6.7.0001'))
        self.assertTrue(engine.valid_version('2024.2.29.2359'))
        for value in ('2026.06.7.0001', '2026.6.07.0001', '2026.2.29.0001',
                      '2026.6.7.2460', '2026.13.1.0000', '2026.6.7.001'):
            self.assertFalse(engine.valid_version(value), value)

    def test_manifest_requires_exact_complete_inventory(self) -> None:
        raw = manifest()
        parsed = engine.parse_manifest(raw, 'v2026.6.6.2026')
        self.assertEqual(len(parsed), 21)
        bad = json.loads(raw)
        bad['assets'].pop()
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'][0]['target'] = 'aarch64-apple-darwin'
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'][0]['size'] = True
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'].append(dict(bad['assets'][0]))
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'].append(asset('source-rebuild-receipt.json', 'source'))
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'][-1]['kind'] = 'skill'
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'][-1]['target'] = engine.TARGETS[0]
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'][-1]['size'] = engine.MAX_SOURCE_ASSET
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['assets'][-1], bad['assets'][-2] = bad['assets'][-2], bad['assets'][-1]
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')
        bad = json.loads(raw)
        bad['source']['commit'] = 'B' * 40
        with self.assertRaises(engine.ReleaseError):
            engine.parse_manifest(json.dumps(bad).encode(), 'v2026.6.6.2026')

    def test_minimal_identity_binds_tag_source_and_repo(self) -> None:
        raw = manifest()
        self.assertEqual(
            engine.minimal_identity(raw, 'v2026.6.6.2026'),
            ('refs/heads/main', 'b' * 40),
        )
        bad = json.loads(raw)
        bad['source']['ref'] = 'refs/heads/other'
        with self.assertRaises(engine.ReleaseError):
            engine.minimal_identity(json.dumps(bad).encode(), 'v2026.6.6.2026')

    def test_release_metadata_rejects_mutable_draft_prerelease_and_tag_conflicts(self) -> None:
        base = {
            'immutable': True, 'draft': False, 'prerelease': False,
            'tag_name': 'v2026.6.6.2026',
        }
        with patch.object(engine, 'read_http', return_value=json.dumps(base).encode()):
            self.assertEqual(engine.immutable_release()['tag_name'], base['tag_name'])
        for key, value in (('immutable', False), ('draft', True), ('prerelease', True)):
            bad = dict(base); bad[key] = value
            with patch.object(engine, 'read_http', return_value=json.dumps(bad).encode()):
                with self.assertRaises(engine.ReleaseError):
                    engine.immutable_release()
        with patch.object(engine, 'read_http', return_value=json.dumps(base).encode()):
            with self.assertRaises(engine.ReleaseError):
                engine.immutable_release('v2026.6.6.2027')

    def test_archive_scan_rejects_traversal_links_duplicates_and_expansion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / 'bad.tar.gz'
            write_tar(archive, [('../escape', b'x', None)])
            with self.assertRaises(engine.ReleaseError):
                engine.tar_inventory(archive, 'slv-x', False)
            write_tar(archive, [('slv-x/file', b'', b'outside')])
            with self.assertRaises(engine.ReleaseError):
                engine.tar_inventory(archive, 'slv-x', False)
            write_tar(archive, [('slv-x/file', b'x', None), ('slv-x/file', b'x', None)])
            with self.assertRaises(engine.ReleaseError):
                engine.tar_inventory(archive, 'slv-x', False)
            write_tar(archive, [('slv-x', b'x', None)])
            self.assertEqual(len(engine.tar_inventory(archive, 'slv-x', True)), 1)

    def test_archive_extracts_only_validated_expected_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / 'skill.tar.gz'
            write_tar(archive, [('slv-validator/SKILL.md', b'checked', None)])
            destination = directory / 'extract'
            extracted = engine.extract_tar(archive, destination, 'slv-validator')
            self.assertEqual((extracted / 'SKILL.md').read_bytes(), b'checked')

    def test_archive_allows_only_expected_explicit_root_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / 'template.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                root = tarfile.TarInfo('template/2026.6.6.2026')
                root.type = tarfile.DIRTYPE
                output.addfile(root)
                file = tarfile.TarInfo('template/2026.6.6.2026/a.txt')
                file.size = 1
                output.addfile(file, io.BytesIO(b'x'))
            self.assertEqual(len(engine.tar_inventory(archive, 'template/2026.6.6.2026', False)), 2)
            write_tar(archive, [('template/2026.6.6.2026', b'x', None)])
            with self.assertRaises(engine.ReleaseError):
                engine.tar_inventory(archive, 'template/2026.6.6.2026', False)

    def test_preflight_rejects_one_bad_archive_before_any_extraction_tree_exists(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            downloads = Path(temporary) / 'downloads'
            downloads.mkdir()
            version, target = '2026.6.6.2026', engine.TARGETS[0]
            write_tar(downloads / f'slv-{target}-exe.tar.gz', [(f'slv-{target}-exe', b'x', None)])
            write_tar(downloads / 'template.tar.gz', [(f'template/{version}/ok', b'x', None)])
            for skill in engine.SKILLS:
                write_tar(downloads / f'{skill}.tar.gz', [(f'{skill}/ok', b'x', None)])
            # Corrupt the final archive so prior archives have been scanned,
            # while extraction has not begun anywhere.
            write_tar(downloads / f'{engine.SKILLS[-1]}.tar.gz', [('../escape', b'x', None)])
            with self.assertRaises(engine.ReleaseError):
                engine.preflight_archives(downloads, target, version, engine.SKILLS)
            self.assertFalse((Path(temporary) / 'extracted').exists())

    def test_destination_parent_rejects_link_before_creating_descendants(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            outside = Path(temporary) / 'outside'
            root.mkdir(mode=0o700)
            outside.mkdir(mode=0o700)
            (root / 'template').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(engine.ReleaseError):
                engine.safe_parent(root / 'template' / '2026.6.6.2026', root)
            self.assertFalse((outside / '2026.6.6.2026').exists())

    def test_template_preflight_requires_all_postinstall_jinja_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            template = Path(temporary) / 'template'
            (template / 'jinja').mkdir(parents=True)
            with self.assertRaises(engine.ReleaseError):
                engine.validate_template_tree(template)
            for name in engine.REQUIRED_TEMPLATE_JINJA_DIRS:
                (template / 'jinja' / name).mkdir()
            engine.validate_template_tree(template)

    def test_journal_recovers_an_interrupted_normal_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            engine.private_dir(root)
            destination = root / 'skills' / 'slv-validator'
            engine.private_dir(destination.parent)
            destination.write_text('new', encoding='utf-8')
            backup = destination.parent / '.slv-release-backup-test'
            backup.write_text('old', encoding='utf-8')
            stage = root / '.release-staging' / 'release-test'
            stage.mkdir(parents=True, mode=0o700)
            journal = {
                'schema_version': 1, 'status': 'applying', 'work': str(stage),
                'operations': [{
                    'source': str(stage / 'source'), 'destination': str(destination),
                    'backup': str(backup), 'had_existing': True,
                    'privileged': False, 'backup_ready': True, 'state': 'installing',
                }],
            }
            engine.atomic_json(root / '.release-journal.json', journal)
            engine.recover(root)
            self.assertEqual(destination.read_text(encoding='utf-8'), 'old')
            self.assertFalse((root / '.release-journal.json').exists())

    def test_journal_recovers_every_normal_replacement_boundary(self) -> None:
        for state, had_existing, destination_content, backup_content, backup_ready, expected in (
            ('prepared', True, 'old', None, False, 'old'),
            ('backing_up', True, 'old', None, False, 'old'),
            ('backed_up', True, None, 'old', True, 'old'),
            ('installing', True, 'new', 'old', True, 'old'),
            ('installed', True, 'new', 'old', True, 'old'),
            ('prepared', False, None, None, False, None),
            ('installing', False, 'new', None, False, None),
            ('installed', False, 'new', None, False, None),
        ):
            with self.subTest(state=state, had_existing=had_existing):
                with tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary) / '.slv'
                    destination = root / 'skills' / 'slv-validator'
                    engine.private_dir(destination.parent)
                    if destination_content is not None:
                        destination.write_text(destination_content, encoding='utf-8')
                    stage = root / '.release-staging' / 'release-boundary'
                    stage.mkdir(parents=True, mode=0o700)
                    backup = destination.parent / '.slv-release-backup-boundary'
                    if backup_content is not None:
                        backup.write_text(backup_content, encoding='utf-8')
                    journal = {
                        'schema_version': 1, 'status': 'applying', 'work': str(stage),
                        'operations': [{
                            'source': str(stage / 'source'), 'destination': str(destination),
                            'backup': str(backup), 'had_existing': had_existing,
                            'privileged': False, 'backup_ready': backup_ready, 'state': state,
                        }],
                    }
                    engine.atomic_json(root / '.release-journal.json', journal)
                    engine.recover(root)
                    if expected is None:
                        self.assertFalse(destination.exists())
                    else:
                        self.assertEqual(destination.read_text(encoding='utf-8'), expected)

    def test_committed_journal_keeps_new_destination_and_cleans_backup(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            destination = root / 'skills' / 'slv-validator'
            engine.private_dir(destination.parent)
            destination.write_text('new', encoding='utf-8')
            stage = root / '.release-staging' / 'release-committed'
            stage.mkdir(parents=True, mode=0o700)
            backup = destination.parent / '.slv-release-backup-committed'
            backup.write_text('old', encoding='utf-8')
            engine.atomic_json(root / '.release-journal.json', {
                'schema_version': 1, 'status': 'committed', 'work': str(stage),
                'operations': [{
                    'source': str(stage / 'source'), 'destination': str(destination),
                    'backup': str(backup), 'had_existing': True,
                    'privileged': False, 'backup_ready': True, 'state': 'installed',
                }],
            })
            engine.recover(root)
            self.assertEqual(destination.read_text(encoding='utf-8'), 'new')
            self.assertFalse(backup.exists())

    def test_journal_cannot_redirect_recovery_outside_slv_home(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            engine.private_dir(root)
            stage = root / '.release-staging' / 'release-invalid'
            stage.mkdir(parents=True, mode=0o700)
            outside = Path(temporary) / 'outside'
            outside.write_text('keep', encoding='utf-8')
            engine.atomic_json(root / '.release-journal.json', {
                'schema_version': 1, 'status': 'applying', 'work': str(stage),
                'operations': [{
                    'source': str(stage / 'source'), 'destination': str(outside),
                    'backup': str(stage / '.slv-release-backup-invalid'),
                    'had_existing': False, 'privileged': False, 'backup_ready': False, 'state': 'installed',
                }],
            })
            with self.assertRaises(engine.ReleaseError):
                engine.recover(root)
            self.assertEqual(outside.read_text(encoding='utf-8'), 'keep')

    def test_external_writable_binary_transaction_recovers_normally(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'external-recovery-')
            destination = base / '.local' / 'bin' / 'slv'
            engine.private_dir(destination.parent)
            destination.write_bytes(b'old')
            source = work / 'new-slv'
            source.write_bytes(b'new')
            source.chmod(0o700)
            transaction = engine.Transaction(root, work)
            transaction.replace(source, destination, privileged=False)
            self.assertEqual(destination.read_bytes(), b'new')
            self.assertTrue(engine.recover(root, destination))
            self.assertEqual(destination.read_bytes(), b'old')
            self.assertFalse((root / '.release-journal.json').exists())

    def test_fresh_controlled_binary_parent_is_created_before_privilege_decision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'fresh-target-')
            destination = base / '.local' / 'bin' / 'slv'
            source = work / 'new-slv'
            source.write_bytes(b'new')
            source.chmod(0o700)
            transaction = engine.Transaction(root, work)
            with patch.object(engine.subprocess, 'run') as run:
                transaction.replace(source, destination, privileged=None)
                run.assert_not_called()
            self.assertEqual(destination.read_bytes(), b'new')
            transaction.commit()

    def test_interrupted_privileged_backup_never_restores_partial_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'privileged-backup-')
            destination = base / 'system-bin' / 'slv'
            engine.private_dir(destination.parent)
            destination.write_bytes(b'old-complete')
            source = work / 'new-slv'
            source.write_bytes(b'new-complete')
            source.chmod(0o700)

            def partial_copy(_input: object, output: object, _length: int) -> None:
                output.write(b'old-partial')  # type: ignore[attr-defined]
                raise OSError(errno.ENOSPC, 'injected full filesystem')

            transaction = engine.Transaction(root, work)
            with patch.object(engine.shutil, 'copyfileobj', side_effect=partial_copy):
                with self.assertRaises(OSError):
                    transaction.replace(source, destination, privileged=True)
            self.assertEqual(destination.read_bytes(), b'old-complete')
            self.assertTrue(engine.recover(root, destination))
            self.assertEqual(destination.read_bytes(), b'old-complete')

    def test_recovery_authorizes_only_the_selected_external_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'forged-privileged-journal-')
            intended = base / 'intended' / 'slv'
            unrelated = base / 'unrelated' / 'slv'
            engine.private_dir(unrelated.parent)
            unrelated.write_bytes(b'current-unrelated')
            backups = work / 'backups'
            engine.private_dir(backups)
            backup = backups / '.slv-release-backup-injected'
            backup.write_bytes(b'forged-rollback')
            source = work / 'source'
            source.write_bytes(b'ignored')
            engine.atomic_json(root / '.release-journal.json', {
                'schema_version': 1, 'status': 'applying', 'work': str(work),
                'operations': [{
                    'source': str(source), 'destination': str(unrelated),
                    'backup': str(backup), 'had_existing': True,
                    'privileged': True, 'backup_ready': True, 'state': 'installed',
                }],
            })
            with patch.object(engine, 'restore_privileged') as restore:
                with self.assertRaisesRegex(engine.ReleaseError, 'does not match'):
                    engine.main([
                        '--root', str(root), 'install', '--install-path', str(intended),
                        '--no-settings-migration',
                    ])
                restore.assert_not_called()
            self.assertEqual(unrelated.read_bytes(), b'current-unrelated')
            self.assertTrue((root / '.release-journal.json').exists())
            with patch.object(engine, 'restore_privileged') as restore:
                with self.assertRaisesRegex(engine.ReleaseError, 'requires slv install or upgrade'):
                    engine.recover(root)
                restore.assert_not_called()

    def test_privileged_journal_cannot_bypass_target_binding_through_slv_home_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'forged-managed-privileged-journal-')
            intended = base / 'intended' / 'slv'
            unrelated = base / 'unrelated' / 'bin'
            engine.private_dir(unrelated)
            (root / 'redirect').symlink_to(unrelated, target_is_directory=True)
            destination = root / 'redirect' / 'slv'
            backups = work / 'backups'
            engine.private_dir(backups)
            backup = backups / '.slv-release-backup-injected'
            backup.write_bytes(b'forged-rollback')
            source = work / 'source'
            source.write_bytes(b'ignored')
            engine.atomic_json(root / '.release-journal.json', {
                'schema_version': 1, 'status': 'applying', 'work': str(work),
                'operations': [{
                    'source': str(source), 'destination': str(destination),
                    'backup': str(backup), 'had_existing': True,
                    'privileged': True, 'backup_ready': True, 'state': 'installed',
                }],
            })
            with patch.object(engine, 'restore_privileged') as restore:
                with self.assertRaisesRegex(engine.ReleaseError, 'does not match'):
                    engine.main([
                        '--root', str(root), 'install', '--install-path', str(intended),
                        '--no-settings-migration',
                    ])
                restore.assert_not_called()
            with patch.object(engine, 'restore_privileged') as restore:
                with self.assertRaisesRegex(engine.ReleaseError, 'unsafe destination parent'):
                    engine.main([
                        '--root', str(root), 'install', '--install-path', str(destination),
                        '--no-settings-migration',
                    ])
                restore.assert_not_called()
            self.assertTrue((root / '.release-journal.json').exists())

    def test_recovery_durably_unlinks_a_fresh_external_binary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            stage = root / '.release-staging' / 'fresh-external-recovery'
            engine.private_dir(stage)
            destination = base / '.local' / 'bin' / 'slv'
            engine.private_dir(destination.parent)
            destination.write_bytes(b'interrupted-new-binary')
            engine.atomic_json(root / '.release-journal.json', {
                'schema_version': 1, 'status': 'applying', 'work': str(stage),
                'operations': [{
                    'source': str(stage / 'source'), 'destination': str(destination),
                    'backup': str(destination.parent / '.slv-release-backup-unused'),
                    'had_existing': False, 'privileged': False,
                    'backup_ready': False, 'state': 'installed',
                }],
            })
            original_sync = engine.fsync_dir_required
            synced: list[Path] = []

            def observe_sync(path: Path) -> None:
                synced.append(path)
                original_sync(path)

            with patch.object(engine, 'fsync_dir_required', side_effect=observe_sync):
                engine.recover(root, destination)
            self.assertFalse(destination.exists())
            self.assertIn(destination.parent, synced)

    def test_directory_sync_failure_after_rename_leaves_recoverable_journal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'fsync-failure-')
            destination = root / 'skills' / 'slv-validator'
            engine.private_dir(destination.parent)
            destination.write_bytes(b'old')
            source = work / 'new'
            source.write_bytes(b'new')
            original_sync = engine.fsync_dir_required

            def fail_destination(path: Path) -> None:
                if path == destination.parent:
                    raise engine.ReleaseError('injected directory fsync failure')
                original_sync(path)

            transaction = engine.Transaction(root, work)
            with patch.object(engine, 'fsync_dir_required', side_effect=fail_destination):
                with self.assertRaisesRegex(engine.ReleaseError, 'fsync'):
                    transaction.replace(source, destination)
            self.assertTrue((root / '.release-journal.json').exists())
            engine.recover(root)
            self.assertEqual(destination.read_bytes(), b'old')

    def test_exdev_candidate_sync_failure_leaves_recoverable_journal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'exdev-sync-failure-')
            destination = root / 'skills' / 'slv-validator'
            engine.private_dir(destination.parent)
            destination.write_bytes(b'old')
            source = work / 'new'
            source.write_bytes(b'new')
            original_replace = engine.os.replace

            def cross_device(source_path: object, destination_path: object) -> None:
                if Path(source_path) == source and Path(destination_path) == destination:
                    raise OSError(errno.EXDEV, 'injected cross-device replacement')
                original_replace(source_path, destination_path)

            transaction = engine.Transaction(root, work)
            with patch.object(engine.os, 'replace', side_effect=cross_device), \
                 patch.object(engine, 'fsync_tree_required', side_effect=engine.ReleaseError('injected candidate fsync failure')):
                with self.assertRaisesRegex(engine.ReleaseError, 'candidate fsync'):
                    transaction.replace(source, destination)
            self.assertTrue((root / '.release-journal.json').exists())
            engine.recover(root)
            self.assertEqual(destination.read_bytes(), b'old')

    def test_upgrade_reinstalls_after_recovery_even_when_running_version_matches(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'upgrade-recovery-')
            binary = base / '.local' / 'bin' / 'slv'
            engine.private_dir(binary.parent)
            binary.write_bytes(b'old-binary')
            skill = root / 'skills' / 'slv-validator'
            engine.private_dir(skill)
            (skill / 'value').write_bytes(b'old-skill')
            staged_binary = work / 'new-slv'
            staged_binary.write_bytes(b'new-binary')
            staged_binary.chmod(0o700)
            staged_skill = work / 'new-skill'
            staged_skill.mkdir()
            (staged_skill / 'value').write_bytes(b'new-skill')
            transaction = engine.Transaction(root, work)
            transaction.replace(staged_skill, skill)
            transaction.replace(staged_binary, binary, privileged=False)
            self.assertEqual(binary.read_bytes(), b'new-binary')
            version = '2026.6.6.2026'

            def reinstall(
                install_root: Path, _release: dict[str, object], target: Path,
                _skills: tuple[str, ...], _settings: bool, _force: bool = False,
            ) -> dict[str, int]:
                target.write_bytes(b'new-binary')
                restored_skill = install_root / 'skills' / 'slv-validator'
                engine.remove(restored_skill)
                restored_skill.mkdir(parents=True)
                (restored_skill / 'value').write_bytes(b'new-skill')
                return {'added': 0, 'updated': 0, 'unchanged': 0}

            with patch.object(engine, 'immutable_release', return_value={'tag_name': f'v{version}'}), \
                 patch.object(engine, 'install_release', side_effect=reinstall) as install:
                self.assertEqual(engine.main([
                    '--root', str(root), 'upgrade', '--current-version', version,
                    '--install-path', str(binary), '--no-settings-migration',
                ]), 0)
                install.assert_called_once()
            self.assertEqual(binary.read_bytes(), b'new-binary')
            self.assertEqual((skill / 'value').read_bytes(), b'new-skill')
            self.assertFalse((root / '.release-journal.json').exists())

    def test_upgrade_recovers_before_a_discovery_network_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            work = engine.make_work(root, 'upgrade-offline-recovery-')
            binary = base / '.local' / 'bin' / 'slv'
            engine.private_dir(binary.parent)
            binary.write_bytes(b'old-binary')
            staged = work / 'new-slv'
            staged.write_bytes(b'new-binary')
            transaction = engine.Transaction(root, work)
            transaction.replace(staged, binary)
            with patch.object(engine, 'immutable_release', side_effect=engine.ReleaseError('offline')):
                with self.assertRaisesRegex(engine.ReleaseError, 'offline'):
                    engine.main([
                        '--root', str(root), 'upgrade', '--current-version', '2026.6.6.2026',
                        '--install-path', str(binary), '--no-settings-migration',
                    ])
            self.assertEqual(binary.read_bytes(), b'old-binary')
            self.assertFalse((root / '.release-journal.json').exists())

    def test_python_isolation_blocks_cwd_stdlib_shadow_for_engine_and_shell(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        engine_source = (repository / 'cli/lib/release/engine.py').read_bytes()
        installer = repository / 'sh/install'
        with tempfile.TemporaryDirectory() as temporary:
            attacker = Path(temporary)
            marker = attacker / 'shadow-ran'
            (attacker / 'argparse.py').write_text(
                "from pathlib import Path\nPath('shadow-ran').write_text('bad')\nraise RuntimeError('shadow')\n",
                encoding='utf-8',
            )
            direct = subprocess.run(
                [sys.executable, '-I', '-', '--help'], input=engine_source,
                cwd=attacker, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertEqual(direct.returncode, 0, direct.stderr.decode())
            shell = subprocess.run(
                ['sh', str(installer), '--help'], cwd=attacker,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            self.assertEqual(shell.returncode, 0, shell.stderr.decode())
            self.assertFalse(marker.exists())

    def test_every_python_engine_launch_uses_isolated_mode(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        source = (repository / 'cli/lib/release/engine.py').read_text(encoding='utf-8')
        bridge = (repository / 'cli/lib/release/index.ts').read_text(encoding='utf-8')
        installer = (repository / 'sh/install').read_text(encoding='utf-8')
        self.assertNotIn("['sudo', 'python3', '-c'", source)
        self.assertEqual(source.count("['sudo', 'python3', '-I', '-c'"), 3)
        self.assertIn("args: ['-I', '-', ...args]", bridge)
        self.assertIn("python3 -I - --bootstrap-version", installer)
        self.assertIn("python3 -I -c", installer)

    def test_managed_gh_rejects_bad_cached_binary_before_any_execution(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, work = Path(temporary) / '.slv', Path(temporary) / 'work'
            engine.private_dir(root)
            engine.private_dir(work)
            cache = root / 'verify' / 'gh' / '2.102.0' / 'linux_amd64'
            engine.private_dir(cache)
            cached = cache / 'gh'
            cached.write_bytes(b'not-gh')
            cached.chmod(0o700)
            with patch.object(engine, 'verifier_spec', return_value=('linux_amd64', 'tar.gz', 'a' * 64, 'b' * 64)), \
                 patch.object(engine, 'read_http', side_effect=engine.ReleaseError('network used after rejecting cache')) as read, \
                 patch.object(engine.subprocess, 'run') as run:
                with self.assertRaisesRegex(engine.ReleaseError, 'network used'):
                    engine.managed_gh(root, work)
                self.assertEqual(read.call_count, 1)
                run.assert_not_called()

    def test_invalid_pinned_verifier_archive_never_creates_an_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / 'gh.tar.gz'
            write_tar(archive, [('gh_2.102.0_linux_amd64/bin/gh', b'bad', None)])
            target = directory / 'gh'
            with self.assertRaisesRegex(engine.ReleaseError, 'digest'):
                engine.extract_gh(archive, 'linux_amd64', 'tar.gz', 'a' * 64, target)
            self.assertFalse(target.exists())

    def test_target_selection_preserves_existing_path_and_requires_explicit_replacement(self) -> None:
        with patch.object(engine.shutil, 'which', return_value='/usr/local/bin/slv'):
            with self.assertRaisesRegex(engine.ReleaseError, 'install-path'):
                engine.choose_target(None, None)
        with tempfile.TemporaryDirectory() as temporary:
            explicit = Path(temporary) / 'slv'
            self.assertEqual(engine.choose_target(str(explicit), None), explicit)
            wrong = Path(temporary) / 'not-slv'
            with self.assertRaises(engine.ReleaseError):
                engine.choose_target(str(wrong), None)

    def test_skill_selection_rejects_unknown_names_before_network_or_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            with self.assertRaisesRegex(engine.ReleaseError, 'unknown'):
                engine.sync_skills(root, '2026.6.6.2026', ('slv-validator', 'unknown'), False)
            self.assertFalse((root / 'skills').exists())

    def test_skill_counts_honor_force_without_treating_unknown_files_as_current(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            staged, installed = base / 'staged', base / 'installed'
            staged.mkdir(); installed.mkdir()
            (staged / 'same').write_text('same', encoding='utf-8')
            (staged / 'changed').write_text('new', encoding='utf-8')
            (staged / 'added').write_text('added', encoding='utf-8')
            (installed / 'same').write_text('same', encoding='utf-8')
            (installed / 'changed').write_text('old', encoding='utf-8')
            (installed / 'obsolete').write_text('old', encoding='utf-8')
            self.assertEqual(engine.skill_counts(staged, installed, False), (1, 1, 1))
            self.assertEqual(engine.skill_counts(staged, installed, True), (1, 2, 0))

    def test_skill_sync_preserves_identical_tree_unless_force_is_selected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / '.slv'
            engine.private_dir(root)
            archive = base / 'slv-validator.tar.gz'
            write_tar(archive, [('slv-validator/SKILL.md', b'verified skill', None)])
            notices, sbom = base / 'THIRD_PARTY_NOTICES', base / 'sbom.spdx.json'
            notices.write_bytes(b'verified notices')
            sbom.write_bytes(b'{"spdxVersion":"SPDX-2.3"}')
            installed = root / 'skills' / 'slv-validator'
            engine.private_dir(installed)
            (installed / 'SKILL.md').write_bytes(b'verified skill')
            before = installed.stat()
            assets = {
                'slv-validator.tar.gz': {'size': archive.stat().st_size, 'sha256': 'a' * 64},
                'THIRD_PARTY_NOTICES': {'size': notices.stat().st_size, 'sha256': 'b' * 64},
                'sbom.spdx.json': {'size': sbom.stat().st_size, 'sha256': 'c' * 64},
                **{name: {'size': 1, 'sha256': 'd' * 64} for name in engine.SOURCE_ASSETS},
            }
            downloaded: list[str] = []

            def download(_url: str, destination: Path, _size: int, _digest: str) -> None:
                downloaded.append(destination.name)
                shutil.copyfile({'slv-validator.tar.gz': archive, 'THIRD_PARTY_NOTICES': notices, 'sbom.spdx.json': sbom}[destination.name], destination)

            with patch.object(engine, 'immutable_release', return_value={'tag_name': 'v2026.6.6.2026'}), \
                 patch.object(engine, 'verified', side_effect=verified_payload_stub('v2026.6.6.2026', assets)), \
                 patch.object(engine, 'fetch_revocation_policy', return_value=(EMPTY_REVOCATION_POLICY, POLICY_VALIDATORS)), \
                 patch.object(engine, 'download_asset', side_effect=download):
                result = engine.sync_skills(root, '2026.6.6.2026', ('slv-validator',), False)
            after = installed.stat()
            self.assertEqual(result, {'added': 0, 'updated': 0, 'unchanged': 1, 'failed': 0, 'failedFiles': []})
            self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))
            self.assertEqual((root / 'licenses' / '2026.6.6.2026' / 'THIRD_PARTY_NOTICES').read_bytes(), b'verified notices')
            self.assertEqual((root / 'licenses' / '2026.6.6.2026' / 'sbom.spdx.json').read_bytes(), b'{"spdxVersion":"SPDX-2.3"}')
            self.assertTrue(set(engine.SOURCE_ASSETS).isdisjoint(downloaded))
            with patch.object(engine, 'immutable_release', return_value={'tag_name': 'v2026.6.6.2026'}), \
                 patch.object(engine, 'verified', side_effect=verified_payload_stub('v2026.6.6.2026', assets)), \
                 patch.object(engine, 'fetch_revocation_policy', return_value=(EMPTY_REVOCATION_POLICY, POLICY_VALIDATORS)), \
                 patch.object(engine, 'download_asset', side_effect=download):
                forced = engine.sync_skills(root, '2026.6.6.2026', ('slv-validator',), True)
            self.assertEqual(forced, {'added': 0, 'updated': 1, 'unchanged': 0, 'failed': 0, 'failedFiles': []})
            self.assertNotEqual(installed.stat().st_ino, before.st_ino)

    def test_install_delivers_verified_compliance_docs_before_binary_activation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base, version, target = Path(temporary), '2026.6.6.2026', engine.TARGETS[0]
            root, binary = base / '.slv', base / 'bin' / 'slv'
            files = base / 'assets'; files.mkdir()
            write_tar(files / f'slv-{target}-exe.tar.gz', [(f'slv-{target}-exe', b'new binary', None)])
            write_template_tar(files / 'template.tar.gz', version)
            write_tar(files / 'slv-validator.tar.gz', [('slv-validator/SKILL.md', b'new skill', None)])
            (files / 'THIRD_PARTY_NOTICES').write_bytes(b'new notices')
            (files / 'sbom.spdx.json').write_bytes(b'{"new":"sbom"}')
            assets = {path.name: {'size': path.stat().st_size, 'sha256': 'a' * 64} for path in files.iterdir()}
            assets.update({name: {'size': 1, 'sha256': 'a' * 64} for name in engine.SOURCE_ASSETS})
            downloaded: list[str] = []

            def download(_url: str, destination: Path, _size: int, _digest: str) -> None:
                downloaded.append(destination.name)
                shutil.copyfile(files / destination.name, destination)

            with patch.object(engine, 'verified', side_effect=verified_payload_stub(f'v{version}', assets)), \
                 patch.object(engine, 'fetch_revocation_policy', return_value=(EMPTY_REVOCATION_POLICY, POLICY_VALIDATORS)), \
                 patch.object(engine, 'target_for_host', return_value=target), \
                 patch.object(engine, 'download_asset', side_effect=download):
                engine.install_release(root, {'tag_name': f'v{version}'}, binary, ('slv-validator',), False)
            self.assertEqual(binary.read_bytes(), b'new binary')
            self.assertEqual((root / 'template' / version / 'jinja' / 'cmn' / 'marker').read_bytes(), b'template')
            self.assertEqual((root / 'skills' / 'slv-validator' / 'SKILL.md').read_bytes(), b'new skill')
            self.assertEqual((root / 'licenses' / version / 'THIRD_PARTY_NOTICES').read_bytes(), b'new notices')
            self.assertEqual((root / 'licenses' / version / 'sbom.spdx.json').read_bytes(), b'{"new":"sbom"}')
            self.assertTrue(set(engine.SOURCE_ASSETS).isdisjoint(downloaded))

    def test_corrupt_compliance_download_aborts_before_installed_payload_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base, version, target = Path(temporary), '2026.6.6.2026', engine.TARGETS[0]
            root, binary = base / '.slv', base / 'bin' / 'slv'
            engine.private_dir(root)
            engine.private_dir(binary.parent); binary.write_bytes(b'old binary')
            installed = root / 'licenses' / version; engine.private_dir(installed)
            (installed / 'THIRD_PARTY_NOTICES').write_bytes(b'old notices')
            assets = {name: {'size': 1, 'sha256': 'a' * 64} for name in (f'slv-{target}-exe.tar.gz', 'template.tar.gz', 'slv-validator.tar.gz', *engine.COMPLIANCE_ASSETS)}

            def corrupt(_url: str, _destination: Path, _size: int, _digest: str) -> None:
                raise engine.ReleaseError('payload digest mismatch: THIRD_PARTY_NOTICES')

            with patch.object(engine, 'verified', side_effect=verified_payload_stub(f'v{version}', assets)), \
                 patch.object(engine, 'fetch_revocation_policy', return_value=(EMPTY_REVOCATION_POLICY, POLICY_VALIDATORS)), \
                 patch.object(engine, 'target_for_host', return_value=target), \
                 patch.object(engine, 'download_asset', side_effect=corrupt):
                with self.assertRaisesRegex(engine.ReleaseError, 'THIRD_PARTY_NOTICES'):
                    engine.install_release(root, {'tag_name': f'v{version}'}, binary, ('slv-validator',), False)
            self.assertEqual(binary.read_bytes(), b'old binary')
            self.assertEqual((installed / 'THIRD_PARTY_NOTICES').read_bytes(), b'old notices')

    def test_install_fault_rolls_back_payload_and_compliance_docs_as_one_group(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base, version, target = Path(temporary), '2026.6.6.2026', engine.TARGETS[0]
            root, binary = base / '.slv', base / 'bin' / 'slv'
            engine.private_dir(root); engine.private_dir(binary.parent)
            binary.write_bytes(b'old binary')
            old_template = root / 'template' / version; engine.private_dir(old_template)
            (old_template / 'value').write_bytes(b'old template')
            old_skill = root / 'skills' / 'slv-validator'; engine.private_dir(old_skill)
            (old_skill / 'SKILL.md').write_bytes(b'old skill')
            old_docs = root / 'licenses' / version; engine.private_dir(old_docs)
            (old_docs / 'THIRD_PARTY_NOTICES').write_bytes(b'old notices')
            (old_docs / 'sbom.spdx.json').write_bytes(b'old sbom')
            files = base / 'assets'; files.mkdir()
            write_tar(files / f'slv-{target}-exe.tar.gz', [(f'slv-{target}-exe', b'new binary', None)])
            write_template_tar(files / 'template.tar.gz', version)
            write_tar(files / 'slv-validator.tar.gz', [('slv-validator/SKILL.md', b'new skill', None)])
            (files / 'THIRD_PARTY_NOTICES').write_bytes(b'new notices')
            (files / 'sbom.spdx.json').write_bytes(b'new sbom')
            assets = {path.name: {'size': path.stat().st_size, 'sha256': 'a' * 64} for path in files.iterdir()}
            original_replace = engine.os.replace

            def download(_url: str, destination: Path, _size: int, _digest: str) -> None:
                shutil.copyfile(files / destination.name, destination)

            def fail_docs(source: object, destination: object) -> None:
                if Path(destination) == root / 'licenses' / version and Path(source).parent.name == 'licenses':
                    raise OSError('injected compliance replacement failure')
                original_replace(source, destination)

            with patch.object(engine, 'verified', side_effect=verified_payload_stub(f'v{version}', assets)), \
                 patch.object(engine, 'fetch_revocation_policy', return_value=(EMPTY_REVOCATION_POLICY, POLICY_VALIDATORS)), \
                 patch.object(engine, 'target_for_host', return_value=target), \
                 patch.object(engine, 'download_asset', side_effect=download), \
                 patch.object(engine.os, 'replace', side_effect=fail_docs):
                with self.assertRaisesRegex(OSError, 'injected compliance'):
                    engine.install_release(root, {'tag_name': f'v{version}'}, binary, ('slv-validator',), False)
            # The injected fault also prevents the in-command rollback from
            # publishing the document backup. A later normal invocation must
            # recover the whole interrupted group, including prior payloads.
            self.assertTrue((root / '.release-journal.json').exists())
            engine.recover(root, binary)
            self.assertEqual(binary.read_bytes(), b'old binary')
            self.assertEqual((old_template / 'value').read_bytes(), b'old template')
            self.assertEqual((old_skill / 'SKILL.md').read_bytes(), b'old skill')
            self.assertEqual((old_docs / 'THIRD_PARTY_NOTICES').read_bytes(), b'old notices')
            self.assertEqual((old_docs / 'sbom.spdx.json').read_bytes(), b'old sbom')
            self.assertFalse((root / '.release-journal.json').exists())

    def test_license_destination_rejects_symlink_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, outside = Path(temporary) / '.slv', Path(temporary) / 'outside'
            engine.private_dir(root); engine.private_dir(outside)
            (root / 'licenses').symlink_to(outside, target_is_directory=True)
            work = engine.make_work(root, 'license-link-')
            source = work / 'licenses'; engine.private_dir(source)
            (source / 'THIRD_PARTY_NOTICES').write_bytes(b'notices')
            transaction = engine.Transaction(root, work)
            with self.assertRaisesRegex(engine.ReleaseError, 'unsafe destination parent'):
                transaction.replace(source, root / 'licenses' / '2026.6.6.2026')
            engine.recover(root)

    def test_interrupted_license_replacement_recovers_prior_docs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root, version = Path(temporary) / '.slv', '2026.6.6.2026'
            engine.private_dir(root)
            destination = root / 'licenses' / version; engine.private_dir(destination)
            (destination / 'THIRD_PARTY_NOTICES').write_bytes(b'new notices')
            stage = root / '.release-staging' / 'license-interrupted'; engine.private_dir(stage)
            backup = destination.parent / '.slv-release-backup-license'
            engine.private_dir(backup)
            (backup / 'THIRD_PARTY_NOTICES').write_bytes(b'old notices')
            engine.atomic_json(root / '.release-journal.json', {
                'schema_version': 1, 'status': 'applying', 'work': str(stage), 'operations': [{
                    'source': str(stage / 'source'), 'destination': str(destination), 'backup': str(backup),
                    'had_existing': True, 'privileged': False, 'backup_ready': True, 'state': 'installed',
                }],
            })
            engine.recover(root)
            self.assertEqual((destination / 'THIRD_PARTY_NOTICES').read_bytes(), b'old notices')
            self.assertFalse((root / '.release-journal.json').exists())

    def test_skill_group_transaction_rolls_back_on_second_replacement_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / '.slv'
            engine.private_dir(root)
            work = root / '.release-staging' / 'skills-rollback'
            engine.private_dir(work)
            destination_one = root / 'skills' / 'slv-validator'
            destination_two = root / 'skills' / 'slv-rpc'
            engine.private_dir(destination_one)
            engine.private_dir(destination_two)
            (destination_one / 'value').write_text('old-one', encoding='utf-8')
            (destination_two / 'value').write_text('old-two', encoding='utf-8')
            source_one, source_two = work / 'one', work / 'two'
            source_one.mkdir(); source_two.mkdir()
            (source_one / 'value').write_text('new-one', encoding='utf-8')
            (source_two / 'value').write_text('new-two', encoding='utf-8')
            original_replace = engine.os.replace

            def fail_second(source: object, destination: object) -> None:
                if Path(source) == source_two and Path(destination) == destination_two:
                    raise OSError('injected replacement failure')
                original_replace(source, destination)

            transaction = engine.Transaction(root, work)
            with patch.object(engine.os, 'replace', side_effect=fail_second):
                transaction.replace(source_one, destination_one)
                with self.assertRaisesRegex(OSError, 'injected'):
                    transaction.replace(source_two, destination_two)
            engine.recover(root)
            self.assertEqual((destination_one / 'value').read_text(encoding='utf-8'), 'old-one')
            self.assertEqual((destination_two / 'value').read_text(encoding='utf-8'), 'old-two')

    def test_public_tag_resolution_accepts_lightweight_and_annotated_tags(self) -> None:
        digest, tag = 'c' * 40, 'v2026.6.6.2026'
        with tempfile.TemporaryDirectory() as temporary:
            work = Path(temporary)
            direct = f'refs/tags/{tag}'
            peeled = f'{direct}^{{}}'
            lightweight = SimpleNamespace(returncode=0, stdout=f'{digest}\t{direct}\n', stderr='')
            with patch.object(engine.subprocess, 'run', return_value=lightweight):
                engine.verify_peeled_tag(tag, digest, work)
            annotated = SimpleNamespace(returncode=0, stdout=f'{"a" * 40}\t{direct}\n{digest}\t{peeled}\n', stderr='')
            with patch.object(engine.subprocess, 'run', return_value=annotated):
                engine.verify_peeled_tag(tag, digest, work)
            mismatch = SimpleNamespace(returncode=0, stdout=f'{"a" * 40}\t{direct}\n{"d" * 40}\t{peeled}\n', stderr='')
            with patch.object(engine.subprocess, 'run', return_value=mismatch):
                with self.assertRaises(engine.ReleaseError):
                    engine.verify_peeled_tag(tag, digest, work)

    def test_shell_contains_exact_engine_and_canonical_bootstrap_version(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        source = (repository / 'cli/lib/release/engine.py').read_text(encoding='utf-8')
        shell = (repository / 'sh/install').read_text(encoding='utf-8')
        embedded = shell.split("<<'PY'\n", 1)[1].rsplit('\nPY', 1)[0] + '\n'
        self.assertEqual(embedded, source)
        version = next(line.split('"', 2)[1] for line in shell.splitlines() if line.startswith('VERSION="'))
        self.assertTrue(engine.valid_version(version))
        self.assertNotIn('ENGINE_VERSION', source)


if __name__ == '__main__':
    unittest.main()
