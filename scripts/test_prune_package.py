"""Synthetic file-boundary tests. No app launch, model, signing or installed-data writes."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('prune_package', Path(__file__).with_name('prune-package.py'))
prune = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prune)


class PrunePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='prune-package-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'public-source'
        self.app = self.root / 'dist/release-preview/Synthetic.app'
        self.nm = self.app / prune.NODE_MODULES
        self.nm.mkdir(parents=True)
        self.write(self.app / 'Contents/MacOS/AIReading', struct.pack('<II', 0xFEEDFACF, 0x0100000C))
        for name, version in prune.VERSION_REQUIREMENTS.items():
            self.write(self.nm / name / 'package.json', json.dumps({'name': name, 'version': version}))
        self.write(self.app / 'Contents/Resources/app/apps/desktop/runtime/carrier.mjs',
                   "const env={PATH:'test'}; sdk = new HarnessClient({ profile: 'sdk', env });")
        proof = {
            '@deepseek-ai/dsh-app-boot/lib/index.js': '''
const PROFILE_TEMPLATES = {sdk: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"] }};
const OPTIONAL_BUNDLES = ["@deepseek-ai/dsh-experimental-voice-input-bundle"];
''',
            '@deepseek-ai/dsh-sdk-app/cordis.patch.yml': '''
    - id: skill-office
      name: '@deepseek-ai/dsh-skill-office'
      disabled: !!js "!(process.env.DSH_PRIMARY_RUNTIME ?? process.env.DSH_BUNDLED_PRIMARY_RUNTIME)"
''',
            '@deepseek-ai/dsh-subprocess-local/lib/index.js': '''
const requireNodePty = createLazyRequire("node-pty", import.meta.url);
function terminal() { return requireNodePty().spawn('synthetic'); }
''',
            '@deepseek-ai/dsh-lazy-require/lib/index.js': '''
function createLazyRequire(specifier) { return () => {value = require(specifier);}; }
''',
            'node-pty/lib/utils.js': "const path = 'prebuilds/' + process.platform + '-' + process.arch;",
            '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/index.js': 'function speech() {}',
            '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/worker.js': '''
function createTranscriber(config) { return createRequire(import.meta.url)("sherpa-onnx-node"); }
''',
            '@deepseek-ai/dsh-skill-office/lib/index.js': '''
function officeRuntime(config) { return import.meta.resolve("@deepseek-ai/libreoffice-kit/package.json"); }
''',
            '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/index.js': 'const config = "__DSH_DOCUMENT_PREVIEW_CONFIG__";',
        }
        for relative, value in proof.items():
            self.write(self.nm / relative, value)
        self.office = self.write(self.nm / '@deepseek-ai/libreoffice-kit-darwin-arm64/bin/libreoffice-kit', b'office-runtime')
        self.voice = self.write(self.nm / 'sherpa-onnx-darwin-arm64/sherpa-onnx.node', b'voice-runtime')
        self.preview = self.write(self.nm / '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js', b'browser-preview')
        self.other_pty = self.write(self.nm / 'node-pty/prebuilds/win32-x64/conpty.pdb', b'other-platform')
        self.target_pty = self.write(self.nm / 'node-pty/prebuilds/darwin-arm64/pty.node', b'target-runtime')
        self.windows_resource = self.write(self.nm / 'node-pty/third_party/conpty/version/win10-arm64/OpenConsole.exe', b'windows-resource')
        self.mapping = self.write(self.nm / 'other-package/lib/main.js.map', b'generated-map')

    def write(self, path, value=b'fixture'):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value.encode() if isinstance(value, str) else value)
        return path

    def run_prune(self, **kwargs):
        return prune.prune_package(self.app, root=self.root, **kwargs)

    def test_exact_groups_deleted_with_hashes_and_target_runtime_retained(self):
        targets = [self.office, self.voice, self.preview, self.other_pty, self.windows_resource, self.mapping]
        expected = {str(path.relative_to(self.app)): (path.stat().st_size, hashlib.sha256(path.read_bytes()).hexdigest()) for path in targets}
        report = self.run_prune()
        self.assertEqual(report['removedFiles'], len(targets))
        self.assertEqual(report['removedBytes'], sum(value[0] for value in expected.values()))
        self.assertEqual({row['path']: (row['bytes'], row['sha256']) for row in report['files']}, expected)
        self.assertTrue(report['protectedFilesUnchanged'])
        self.assertTrue(report['signatureMustBeRegenerated'])
        self.assertEqual(self.target_pty.read_bytes(), b'target-runtime')
        self.assertEqual(set(report['groups']), {'office_native', 'voice_native', 'unused_document_preview',
                                               'pty_other_platforms', 'pty_windows_resources', 'source_maps'})

    def test_legal_source_build_metadata_and_declarations_survive_inside_removed_trees(self):
        relatives = [
            '@deepseek-ai/libreoffice-kit-darwin-arm64/bin/LICENSE',
            '@deepseek-ai/libreoffice-kit-darwin-arm64/program/notices/legal.txt',
            '@deepseek-ai/libreoffice-kit-darwin-arm64/program/COPYRIGHT',
            '@deepseek-ai/libreoffice-kit-darwin-arm64/sources/source.tar.xz',
            '@deepseek-ai/libreoffice-kit-darwin-arm64/prebuilds.json',
            'node-pty/third_party/conpty/LICENSE',
            'node-pty/prebuilds/win32-x64/CMakeLists.txt',
            'node-pty/prebuilds/win32-x64/index.d.ts',
            'other-package/licenses/main.js.map',
            'other-package/src/source.js.map',
        ]
        paths = [self.write(self.nm / rel, 'must remain') for rel in relatives]
        metadata = list(self.nm.rglob('package.json'))
        before = {path: path.read_bytes() for path in paths + metadata}
        report = self.run_prune()
        self.assertTrue(report['protectedFilesUnchanged'])
        self.assertEqual({path: path.read_bytes() for path in before}, before)
        self.assertTrue((self.nm / '@deepseek-ai/dsh-skill-office/lib/index.js').is_file())
        self.assertTrue((self.nm / '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/index.js').is_file())

    def test_dry_run_and_second_run_are_safe(self):
        report = self.run_prune(dry_run=True)
        self.assertGreater(report['plannedBytes'], 0)
        self.assertEqual(report['removedBytes'], 0)
        self.assertFalse(report['signatureMustBeRegenerated'])
        self.assertTrue(self.office.is_file())
        self.run_prune()
        repeated = self.run_prune()
        self.assertEqual(repeated['removedFiles'], 0)
        self.assertEqual(repeated['removedBytes'], 0)

    def test_outside_app_and_source_install_are_rejected(self):
        installed = self.root / 'apps/desktop/node_modules/sherpa-onnx-darwin-arm64/sherpa-onnx.node'
        self.write(installed, b'source-install')
        with self.assertRaises(prune.PruneError):
            prune.prune_package(self.root / 'apps/desktop', root=self.root)
        self.run_prune()
        self.assertEqual(installed.read_bytes(), b'source-install')

    def test_candidate_symlink_is_rejected_before_mutation(self):
        alias = self.root / 'dist/alias.app'
        alias.symlink_to(self.app, target_is_directory=True)
        with self.assertRaises(prune.PruneError):
            prune.prune_package(alias, root=self.root)
        self.assertTrue(self.office.is_file())

    def test_dependency_symlink_escape_aborts_all_deletions(self):
        external = self.root / 'source-install'
        self.write(external / 'private.js.map', b'must stay external')
        (self.nm / 'external-package').symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(prune.PruneError, 'escapes_candidate'):
            self.run_prune()
        self.assertTrue(self.office.is_file())
        self.assertEqual((external / 'private.js.map').read_bytes(), b'must stay external')

    def test_dependency_root_symlink_cannot_target_source_install(self):
        hidden = self.nm.with_name('staged-node-modules')
        self.nm.rename(hidden)
        source = self.root / 'apps/desktop/node_modules'
        source.mkdir(parents=True)
        guard = self.write(source / 'runtime.node', b'installed-runtime')
        self.nm.symlink_to(source, target_is_directory=True)
        with self.assertRaisesRegex(prune.PruneError, 'dependency_path_has_symlink'):
            self.run_prune()
        self.assertEqual(guard.read_bytes(), b'installed-runtime')

    def test_native_entry_parent_symlink_is_rejected(self):
        binary_dir = self.app / 'Contents/MacOS'
        binary_dir.rename(self.app / 'Contents/staged-MacOS')
        external = self.root / 'source-bin'
        self.write(external / 'AIReading', struct.pack('<II', 0xFEEDFACF, 0x0100000C))
        binary_dir.symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(prune.PruneError, 'native_entry_path_has_symlink'):
            self.run_prune()
        self.assertTrue(self.office.is_file())

    def test_internal_symlinks_are_not_removed_or_followed(self):
        alias = self.nm / 'other-package/lib/alias.js.map'
        alias.symlink_to(self.target_pty)
        report = self.run_prune()
        self.assertTrue(alias.is_symlink())
        self.assertIn(str(alias.relative_to(self.app)), report['untouchedInternalSymlinks'])
        self.assertEqual(self.target_pty.read_bytes(), b'target-runtime')

    def test_unknown_dependency_version_aborts_before_first_unlink(self):
        name = '@deepseek-ai/libreoffice-kit-darwin-arm64'
        self.write(self.nm / name / 'package.json', json.dumps({'name': name, 'version': 'unknown'}))
        with self.assertRaisesRegex(prune.PruneError, 'version_changed'):
            self.run_prune()
        self.assertTrue(self.office.is_file())

    def test_changed_runtime_boundary_aborts_before_first_unlink(self):
        carrier = self.app / 'Contents/Resources/app/apps/desktop/runtime/carrier.mjs'
        self.write(carrier, "sdk = new HarnessClient({ profile: 'web' });")
        with self.assertRaisesRegex(prune.PruneError, 'boundary_changed'):
            self.run_prune()
        self.assertTrue(self.office.is_file())

    def test_direct_feature_import_aborts_even_when_sdk_profile_is_unchanged(self):
        self.write(self.app / 'Contents/Resources/app/apps/desktop/electron/main.mjs',
                   "import '@deepseek-ai/libreoffice-kit';")
        with self.assertRaisesRegex(prune.PruneError, 'references_pruned_feature'):
            self.run_prune()
        self.assertTrue(self.office.is_file())

    def test_source_map_and_model_outside_node_modules_are_never_removed(self):
        outside = self.write(self.app / 'Contents/Resources/app/apps/desktop/shell/shell.js.map', b'app-map')
        model = self.write(self.app / 'Contents/Resources/runtimes/python/models/model.onnx', b'required-model')
        self.run_prune()
        self.assertEqual(outside.read_bytes(), b'app-map')
        self.assertEqual(model.read_bytes(), b'required-model')

    def test_changed_hash_or_symlink_after_planning_is_rejected(self):
        plan = prune.make_plan(self.app, root=self.root)
        row = next(row for row in plan['files'] if row['path'].endswith('sherpa-onnx.node'))
        self.voice.write_bytes(b'changed')
        with self.assertRaisesRegex(prune.PruneError, 'planned_file_changed'):
            prune.verify_unchanged_file(self.app, row)
        self.voice.unlink()
        self.voice.symlink_to(self.target_pty)
        with self.assertRaisesRegex(prune.PruneError, 'symlink'):
            prune.verify_unchanged_file(self.app, row)


if __name__ == '__main__':
    unittest.main()
