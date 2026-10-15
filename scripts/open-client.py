"""Open the local packaged client using its stable daily-use profile.

This never copies acceptance data or credentials. Test previews have separate
launchers and remain in their existing profiles.
"""
from pathlib import Path
import json
import os
import plistlib
import subprocess


def launch_spec(root, inherited):
    bundle = root / 'dist/AI 深度阅读.app'
    info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
    executable = bundle / 'Contents/MacOS' / info['CFBundleExecutable']
    if not executable.is_file():
        raise FileNotFoundError('Build the desktop package before opening it')
    # Let the packaged application resolve its own stable userData and private
    # Codex home. A terminal inherited from a test must not redirect daily use.
    env = {k: v for k, v in inherited.items()
           if not k.startswith('AI_READING_') and k != 'ELECTRON_RUN_AS_NODE'}
    return bundle, executable, env


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1]
    bundle, executable, env = launch_spec(root, os.environ)
    profile = Path.home() / 'Library/Application Support/AI 深度阅读'
    logs = profile / 'diagnostics'
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (logs / 'launch.log').open('a') as log:
        process = subprocess.Popen([str(executable)], env=env,
                                   stdout=log, stderr=log, start_new_session=True)
    print(json.dumps({'pid': process.pid, 'bundle': str(bundle),
                      'profile': str(profile), 'migratedTestData': False},
                     ensure_ascii=False))
