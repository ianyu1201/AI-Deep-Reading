import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('open_client', Path(__file__).with_name('open-client.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class DailyEntryTests(unittest.TestCase):
    def test_test_environment_cannot_redirect_daily_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            contents = root / 'dist/AI 深度阅读.app/Contents'
            (contents / 'MacOS').mkdir(parents=True)
            (contents / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable': 'reader'}))
            (contents / 'MacOS/reader').touch()
            original = {'PATH': '/usr/bin', 'HOME': '/unchanged',
                        'AI_READING_TEST': '1', 'AI_READING_DATA_DIR': '/test',
                        'AI_READING_CODEX_HOME': '/test-auth', 'ELECTRON_RUN_AS_NODE': '1'}
            _, executable, env = launcher.launch_spec(root, original)
            self.assertEqual(env, {'PATH': '/usr/bin', 'HOME': '/unchanged'})
            self.assertEqual(original['AI_READING_DATA_DIR'], '/test')
            self.assertEqual(executable.name, 'reader')


if __name__ == '__main__':
    unittest.main()
