from __future__ import annotations

import io
import json
import os
import errno
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import engine


def asset(name: str, kind: str, target: str | None = None) -> dict[str, object]:
    value: dict[str, object] = {
        'name': name, 'kind': kind, 'sha256': 'a' * 64, 'size': 1,
    }
    if target is not None:
        value['target'] = target
    return value


def manifest(version: str = '2026.6.6.2026') -> bytes:
    items = [
        *[asset(f'slv-{target}-exe.tar.gz', 'executable', target) for target in engine.TARGETS],
        asset('template.tar.gz', 'template'),
        *[asset(f'{skill}.tar.gz', 'skill') for skill in engine.SKILLS],
        asset('install', 'installer'),
        asset('sbom.spdx.json', 'sbom'),
        asset('THIRD_PARTY_NOTICES', 'notices'),
        *[asset(name, 'source') for name in engine.SOURCE_ASSETS],
    ]
    return json.dumps({
        'schema_version': 1,
        'repository': engine.REPOSITORY,
        'version': version,
        'tag': f'v{version}',
        'source': {'commit': 'b' * 40, 'ref': 'refs/heads/main'},
        'workflow': {'path': engine.WORKFLOW_PATH, 'run_id': '42', 'run_attempt': 1},
        'assets': items,
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


class ReleaseEngineTest(unittest.TestCase):
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
                 patch.object(engine, 'verified', return_value=('v2026.6.6.2026', assets)), \
                 patch.object(engine, 'download_asset', side_effect=download):
                result = engine.sync_skills(root, '2026.6.6.2026', ('slv-validator',), False)
            after = installed.stat()
            self.assertEqual(result, {'added': 0, 'updated': 0, 'unchanged': 1, 'failed': 0, 'failedFiles': []})
            self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))
            self.assertEqual((root / 'licenses' / '2026.6.6.2026' / 'THIRD_PARTY_NOTICES').read_bytes(), b'verified notices')
            self.assertEqual((root / 'licenses' / '2026.6.6.2026' / 'sbom.spdx.json').read_bytes(), b'{"spdxVersion":"SPDX-2.3"}')
            self.assertTrue(set(engine.SOURCE_ASSETS).isdisjoint(downloaded))
            with patch.object(engine, 'immutable_release', return_value={'tag_name': 'v2026.6.6.2026'}), \
                 patch.object(engine, 'verified', return_value=('v2026.6.6.2026', assets)), \
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

            with patch.object(engine, 'verified', return_value=(f'v{version}', assets)), \
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

            with patch.object(engine, 'verified', return_value=(f'v{version}', assets)), \
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

            with patch.object(engine, 'verified', return_value=(f'v{version}', assets)), \
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
