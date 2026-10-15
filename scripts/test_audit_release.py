"""Synthetic release-gate tests; no installed app, user data or model execution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('audit_release', Path(__file__).with_name('audit-release.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def thin(cpu=0x0100000C, minimum=(13, 0, 0), endian='<'):
    encoded = minimum[0] << 16 | minimum[1] << 8 | minimum[2]
    return (struct.pack(endian + 'IIIIIIII', 0xFEEDFACF, cpu, 0, 2, 1, 24, 0, 0)
            + struct.pack(endian + 'IIIIII', 0x32, 24, 1, encoded, encoded, 0))


class GateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='release-audit-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'Candidate.app'
        self.root.mkdir()

    def write(self, relative, data=b'test'):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data.encode() if isinstance(data, str) else data)
        return path

    def reasons(self, section):
        return {item['reason'] for item in section['findings']}

    def test_clean_sources_and_dependency_module_names_are_not_private_data(self):
        self.write('Contents/Resources/app/apps/desktop/node_modules/sdk/logs/index.js',
                   'const secretName = "credentials"; const pem = "-----BEGIN PRIVATE KEY-----";')
        self.write('Contents/Resources/app/apps/desktop/node_modules/sdk/sessions/config.json', '{"name":"sdk"}')
        self.write('Contents/Resources/app/apps/desktop/node_modules/sdk/index/index.js', 'const key = "sk-";')
        self.write('Contents/Resources/app/packages/reader-ui/dist/books-assets/catalog.json', '[]')
        result = audit.scan_privacy(self.root, home='/Users/synthetic-audit-user')
        self.assertEqual(result['findings'], [])
        self.assertEqual(result['counts']['files'], 4)

    def test_rejects_runtime_fixtures_auth_books_catalog_and_python_cache(self):
        for relative in [
            'Contents/Resources/app/apps/desktop/runtime/.fixtures/run/profile.yml',
            'Contents/Resources/app/apps/desktop/runtime/cache/item.json',
            'Contents/Resources/app/apps/desktop/reports/result.json',
            'Contents/Resources/runtime/codex/auth.json',
            'Contents/Resources/runtime/.env.local',
            'Contents/Resources/runtimes/python/__pycache__/a.pyc',
            'Contents/Resources/book.epub',
            'Contents/Resources/session.v4.jsonl.zstd',
        ]:
            self.write(relative)
        self.write('Contents/Resources/app/packages/reader-ui/dist/books-assets/catalog.json', '[{"id":"synthetic"}]')
        self.write('Contents/Resources/app/packages/reader-ui/dist/books-assets/cover.jpg')
        reasons = self.reasons(audit.scan_privacy(self.root, home='/Users/synthetic-audit-user'))
        self.assertTrue({'private_or_generated_directory', 'first_party_runtime_artifact',
                         'private_runtime_or_auth_filename', 'book_index_session_or_generated_data',
                         'nonempty_book_catalog', 'unexpected_book_asset'}.issubset(reasons))

    def test_exact_home_and_encoded_path_are_detected_even_in_binary_content(self):
        home = '/Users/synthetic-audit-user'
        self.write('Contents/a.bin', b'\x00' + home.encode() + b'/private\x00')
        self.write('Contents/--Users-synthetic-audit-user-sessions/item.json', '{}')
        self.write('Contents/upstream.js', 'const upstream="/Users/runner/build/project";')
        result = audit.scan_privacy(self.root, home=home)
        self.assertEqual(self.reasons(result), {'developer_home_in_content', 'developer_home_in_filename'})
        self.assertFalse(any(row['path'].endswith('upstream.js') for row in result['findings']))
        self.assertNotIn(home, json.dumps(result))

    def test_scan_does_not_follow_external_or_internal_symlink_targets(self):
        external = Path(self.tmp.name) / 'outside'
        external.mkdir()
        (external / 'auth.json').write_text('{"synthetic":"must not be opened"}')
        (self.root / 'escape').symlink_to(external, target_is_directory=True)
        self.write('Contents/safe.js', 'export const n=1;')
        (self.root / 'internal').symlink_to('Contents/safe.js')
        (self.root / 'broken').symlink_to('missing')
        result = audit.scan_privacy(self.root, home='/Users/synthetic-audit-user')
        self.assertEqual(result['counts']['files'], 1)
        self.assertEqual(result['counts']['symlinks'], 3)
        self.assertEqual(self.reasons(result), {'symlink_escapes_bundle', 'broken_or_cyclic_symlink'})
        self.assertFalse(any('auth.json' in row['path'] for row in result['findings']))

    def test_secret_data_reports_only_reason_and_relative_path(self):
        value = 'syntheticCredentialValue0123456789'
        self.write('Contents/settings.json', json.dumps({'access_token': value}))
        self.write('Contents/key.pem', '-----BEGIN PRIVATE KEY-----\n' + 'A' * 64 + '\n-----END PRIVATE KEY-----')
        result = audit.scan_privacy(self.root, home='/Users/synthetic-audit-user')
        self.assertEqual(self.reasons(result), {'credential_value_in_data_file', 'complete_private_key_block'})
        self.assertNotIn(value, json.dumps(result))
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_unreadable_catalog_blocks(self):
        self.write('Contents/books-assets/catalog.json', '{bad json')
        self.assertIn('unreadable_book_catalog', self.reasons(audit.scan_privacy(self.root)))

    def test_macho_thin_and_universal_slices_preserve_architecture_and_minimum(self):
        single = self.write('thin', thin(minimum=(14, 2, 1)))
        self.assertEqual(audit.read_macho(single), [{'architecture': 'arm64', 'minimumMacOS': '14.2.1'}])
        intel, arm = thin(cpu=0x01000007, minimum=(11, 0, 0)), thin(minimum=(15, 0, 0))
        data = (struct.pack('>II', 0xCAFEBABE, 2)
                + struct.pack('>IIIII', 0x01000007, 0, 64, len(intel), 0)
                + struct.pack('>IIIII', 0x0100000C, 0, 64 + len(intel), len(arm), 0)
                + b'\0' * 16 + intel + arm)
        universal = self.write('universal', data)
        self.assertEqual(audit.read_macho(universal), [
            {'architecture': 'x86_64', 'minimumMacOS': '11.0.0'},
            {'architecture': 'arm64', 'minimumMacOS': '15.0.0'},
        ])

    def test_malformed_macho_rejected(self):
        path = self.write('bad', b'\xcf\xfa\xed\xfe')
        with self.assertRaises(ValueError):
            audit.read_macho(path)

    def test_declared_minimum_below_native_code_blocks(self):
        self.write('Contents/MacOS/App', thin())
        self.write('Contents/Resources/runtimes/node/bin/node', thin())
        self.write('Contents/Resources/runtimes/python/bin/python3', thin())
        self.write('Contents/Resources/runtime/codex/bin/codex', thin())
        self.write('Contents/Resources/optional.node', thin(minimum=(15, 0, 0)))
        info = {'CFBundleExecutable': 'App', 'LSMinimumSystemVersion': '13.0'}
        result = audit.audit_macho(self.root, info)
        self.assertEqual(result['maximumBinaryMinimumMacOS'], '15.0.0')
        self.assertEqual(result['mainArchitectures'], ['arm64'])
        self.assertEqual(len(result['exceedsDeclaredMinimum']), 1)
        self.assertIn('binary_minimum_macos_exceeds_info_plist', self.reasons(result))
        info['LSMinimumSystemVersion'] = '15.0'
        self.assertEqual(audit.audit_macho(self.root, info)['findings'], [])

    def test_runtime_architecture_mismatch_blocks(self):
        self.write('Contents/MacOS/App', thin())
        self.write('Contents/Resources/runtimes/node/bin/node', thin(cpu=0x01000007))
        result = audit.audit_macho(self.root, {'CFBundleExecutable': 'App', 'LSMinimumSystemVersion': '13.0'})
        self.assertIn('runtime_architecture_mismatch', self.reasons(result))
        self.assertIn('missing_native_runtime', self.reasons(result))

    def model_fixture(self):
        hashes = {}
        for name in audit.MODEL_FILES:
            value = ('synthetic:' + name).encode()
            self.write('Contents/Resources/runtimes/python/models/bge-small-zh-v1.5/' + name, value)
            hashes[name] = hashlib.sha256(value).hexdigest()
        return self.write('Contents/Resources/runtimes/python/semantic-manifest.json', json.dumps({
            'modelFilesSha256': hashes, 'personalIndexesCopied': False,
        }))

    def test_model_hashes_checked_without_running_a_model(self):
        self.model_fixture()
        result = audit.audit_model(self.root)
        self.assertEqual(result['findings'], [])
        self.assertEqual(len(result['verifiedFiles']), 5)
        self.write('Contents/Resources/runtimes/python/models/bge-small-zh-v1.5/config.json', 'changed')
        self.assertIn('model_sha256_mismatch', self.reasons(audit.audit_model(self.root)))

    def test_model_manifest_cannot_escape_bundle(self):
        manifest = self.model_fixture()
        data = json.loads(manifest.read_text())
        data['modelFilesSha256']['../../outside'] = '0' * 64
        manifest.write_text(json.dumps(data))
        self.assertIn('invalid_semantic_manifest', self.reasons(audit.audit_model(self.root)))

    def test_license_presence_and_npm_manifest_files_required(self):
        reader = 'Contents/Resources/app/packages/reader-ui/dist/'
        for path in [
            'Contents/Resources/app/LICENSE', 'Contents/Resources/THIRD-PARTY-NOTICES.txt',
            'Contents/Resources/ELECTRON-LICENSE', 'Contents/Resources/LICENSES.chromium.html',
            'Contents/Resources/runtimes/node/LICENSE', 'Contents/Resources/runtimes/python/lib/python3.12/LICENSE.txt',
            'Contents/Resources/runtime/codex/LICENSE', 'Contents/Resources/runtime/codex/NOTICE',
            'Contents/Resources/app/apps/desktop/shell/icons/LICENSE',
            'Contents/Resources/runtimes/python/models/bge-small-zh-v1.5/MODEL-NOTICE.txt',
            reader + 'THIRD_PARTY.md', reader + 'FOLIATE-LICENSE',
            reader + 'licenses/fflate/LICENSE', reader + 'licenses/@zip.js_zip.js/LICENSE',
            reader + 'licenses/pdfjs-dist/LICENSE', reader + 'licenses/npm/example/LICENSE',
        ]:
            self.write(path, 'Synthetic license notice')
        self.write(reader + 'licenses/npm-packages.json', json.dumps([{'name': 'example', 'files': ['LICENSE']}]))
        self.assertEqual(audit.audit_licenses(self.root)['findings'], [])
        (self.root / 'Contents/Resources/LICENSES.chromium.html').unlink()
        self.assertIn('missing_or_empty_license_chromium', self.reasons(audit.audit_licenses(self.root)))
        (self.root / (reader + 'licenses/npm/example/LICENSE')).unlink()
        self.assertIn('missing_or_empty_npm_license', self.reasons(audit.audit_licenses(self.root)))

    def test_codesign_command_and_failure_do_not_echo_tool_output(self):
        with patch.object(audit.subprocess, 'run') as run:
            run.return_value.returncode = 1
            run.return_value.stderr = b'synthetic private details must not escape'
            result = audit.verify_signature(self.root)
            self.assertFalse(result['valid'])
            self.assertNotIn('private details', json.dumps(result))
            self.assertEqual(run.call_args.args[0][:4], ['codesign', '--verify', '--deep', '--strict'])

    def test_incomplete_privacy_scan_blocks_without_exposing_error_details(self):
        self.write('Contents/Info.plist', plistlib.dumps({'CFBundleExecutable': 'App', 'LSMinimumSystemVersion': '13.0'}))
        with patch.object(audit, 'scan_privacy', side_effect=OSError('private absolute details')):
            with patch.object(audit, 'verify_signature', return_value={'valid': True, 'findings': []}):
                result = audit.audit_release(self.root)
        self.assertFalse(result['passed'])
        self.assertIn('privacy_audit_could_not_complete', self.reasons(result))
        self.assertNotIn('private absolute details', json.dumps(result))

    def test_cli_exits_nonzero_and_keeps_report_outside_app(self):
        output = Path(self.tmp.name) / 'report.json'
        with patch.object(audit, 'audit_release', return_value={'passed': False, 'findings': [audit.finding('.', 'synthetic_block')]}):
            with patch('builtins.print'):
                self.assertEqual(audit.main(['--app', str(self.root), '--output', str(output)]), 1)
        self.assertFalse(json.loads(output.read_text())['passed'])
        with patch('sys.stderr'):
            with self.assertRaises(SystemExit):
                audit.main(['--app', str(self.root), '--output', str(self.root / 'report.json')])


if __name__ == '__main__':
    unittest.main()
