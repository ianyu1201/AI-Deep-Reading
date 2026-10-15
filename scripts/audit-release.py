#!/usr/bin/env python3
"""Read-only release gate. Reports relative paths and reasons, never secret values.

This is a bounded package audit, not proof of notarization, OS compatibility,
model quality, or a complete third-party redistribution review.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import struct
import subprocess


FORBIDDEN_PARTS = {
    '.fixtures', '.test-data', '__pycache__', '.git', '.codex', '.dsh',
    '.cache', '.index', '.private', 'codex-home', 'harness-home',
}
PRIVATE_NAMES = {
    'auth.json', 'credentials.json', '.credentials.yaml', 'credentials.yaml',
    'credentials.yml', 'config.toml', 'sessions.json', 'history.jsonl',
    'reading-store.json', 'sidecar.json', 'ready.json', '.DS_Store',
}
DATA_SUFFIXES = {
    '.epub', '.mobi', '.pdf', '.fb2', '.cbz', '.npy', '.sqlite', '.sqlite3',
    '.db', '.ses', '.jsonl', '.zstd', '.log', '.pyc', '.pyo',
}
DATA_TEXT_SUFFIXES = {'.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env'}
FIRST_PARTY_TRANSIENT = {'reports', 'diagnostics', 'logs', 'cache', 'sessions', 'indexes'}
PRIVATE_KEY = re.compile(
    rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+'
    rb'[A-Za-z0-9+/=\r\n]{32,16384}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'
)
TOKEN_ASSIGNMENT = re.compile(
    rb'["\'](?:api_key|apiKey|access_token|refresh_token|id_token|authorization)["\']'
    rb'\s*[:=]\s*["\'](?:Bearer\s+)?[A-Za-z0-9_./+\-=]{24,}["\']', re.I
)
MODEL_FILES = {
    'model_optimized.onnx', 'config.json', 'tokenizer.json',
    'tokenizer_config.json', 'special_tokens_map.json',
}
CPU_NAMES = {0x0100000C: 'arm64', 0x01000007: 'x86_64', 12: 'arm', 7: 'x86'}
MACHO_MAGICS = {
    b'\xce\xfa\xed\xfe', b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xce', b'\xfe\xed\xfa\xcf',
    b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca',
}


def finding(path, reason):
    return {'path': str(path), 'reason': reason}


def entries(root):
    """Do not descend through symlinks, including links to external directories."""
    def unreadable(error):
        raise error
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=unreadable):
        dirs.sort()
        files.sort()
        for name in dirs + files:
            yield Path(directory) / name


def inside_file(root, relative):
    """Accept only a real bundle-contained file; never open a symlink escape."""
    path = root / relative
    try:
        return path.is_file() and path.resolve().is_relative_to(root.resolve())
    except (OSError, RuntimeError):
        return False


def scan_privacy(root, home=None):
    root = Path(root).resolve()
    home = str(home if home is not None else Path.home()).rstrip('/')
    # Only this developer's exact home is forbidden. Upstream /Users/runner build
    # metadata and source examples must not be mistaken for local user data.
    needles = [home.encode(), home.replace('/', '-').encode()] if home and home != '/' else []
    issues = []
    counts = {'files': 0, 'directories': 0, 'symlinks': 0, 'bytes': 0}
    for path in entries(root):
        rel = path.relative_to(root)
        parts = rel.parts
        name = path.name
        if path.is_symlink():
            counts['symlinks'] += 1
            try:
                target = path.resolve(strict=True)
                if not target.is_relative_to(root):
                    issues.append(finding(rel, 'symlink_escapes_bundle'))
            except (OSError, RuntimeError):
                issues.append(finding(rel, 'broken_or_cyclic_symlink'))
            # Do not inspect targets or record link target strings.
            continue
        if path.is_dir():
            counts['directories'] += 1
        elif path.is_file():
            counts['files'] += 1
            counts['bytes'] += path.stat().st_size
        else:
            issues.append(finding(rel, 'unsupported_filesystem_entry'))
            continue
        if FORBIDDEN_PARTS.intersection(parts):
            issues.append(finding(rel, 'private_or_generated_directory'))
        if name in PRIVATE_NAMES or name == '.env' or name.startswith('.env.'):
            issues.append(finding(rel, 'private_runtime_or_auth_filename'))
        if path.suffix.lower() in DATA_SUFFIXES:
            issues.append(finding(rel, 'book_index_session_or_generated_data'))
        # SDK packages legitimately have source modules named logs/index/sessions.
        # Restrict broad transient names to first-party application directories.
        dependency = 'node_modules' in parts or 'site-packages' in parts
        if not dependency and FIRST_PARTY_TRANSIENT.intersection(parts):
            issues.append(finding(rel, 'first_party_runtime_artifact'))
        rel_bytes = str(rel).encode()
        if any(needle in rel_bytes for needle in needles):
            issues.append(finding(rel, 'developer_home_in_filename'))
        if not path.is_file():
            continue
        reasons = set()
        try:
            # Chunk overlap covers path strings, token assignments and full PEM
            # blocks. Binary data is checked for exact developer paths too.
            overlap = b''
            with path.open('rb') as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    data = overlap + chunk
                    if any(needle in data for needle in needles):
                        reasons.add('developer_home_in_content')
                    if PRIVATE_KEY.search(data):
                        reasons.add('complete_private_key_block')
                    # Code and compiled string tables contain token vocabulary and
                    # PEM parsing constants. Inspect assignments only in data files.
                    if (path.suffix.lower() in DATA_TEXT_SUFFIXES or name.startswith('.env')) and TOKEN_ASSIGNMENT.search(data):
                        reasons.add('credential_value_in_data_file')
                    overlap = data[-32768:]
            for reason in sorted(reasons):
                issues.append(finding(rel, reason))
            if name == 'catalog.json' and path.parent.name == 'books-assets':
                try:
                    if json.loads(path.read_text()) != []:
                        issues.append(finding(rel, 'nonempty_book_catalog'))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    issues.append(finding(rel, 'unreadable_book_catalog'))
            if 'books-assets' in parts and name != 'catalog.json':
                issues.append(finding(rel, 'unexpected_book_asset'))
        except OSError:
            issues.append(finding(rel, 'file_read_failed'))
    return {'counts': counts, 'findings': issues}


def version_tuple(value):
    pieces = str(value).split('.')
    if not 1 <= len(pieces) <= 3 or any(not p.isdigit() for p in pieces):
        raise ValueError('Invalid macOS version')
    return tuple(map(int, pieces)) + (0,) * (3 - len(pieces))


def packed_version(value):
    return (value >> 16, (value >> 8) & 255, value & 255)


def version_string(value):
    return '.'.join(map(str, value))


def read_macho(path):
    """Read headers only, including every universal binary slice; execute nothing."""
    slices = []
    with Path(path).open('rb') as handle:
        def parse(offset, available):
            handle.seek(offset)
            header = handle.read(min(32, available))
            if len(header) < 4 or header[:4] not in MACHO_MAGICS:
                return
            magic = header[:4]
            if magic in {b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca', b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'}:
                endian = '>' if magic in {b'\xca\xfe\xba\xbe', b'\xca\xfe\xba\xbf'} else '<'
                if len(header) < 8:
                    raise ValueError('Truncated universal header')
                count = struct.unpack_from(endian + 'I', header, 4)[0]
                width = 32 if magic in {b'\xca\xfe\xba\xbf', b'\xbf\xba\xfe\xca'} else 20
                if count > 64 or 8 + count * width > available:
                    raise ValueError('Invalid universal slice table')
                handle.seek(offset + 8)
                table = handle.read(count * width)
                for index in range(count):
                    base = index * width
                    if width == 32:
                        slice_offset, size = struct.unpack_from(endian + 'QQ', table, base + 8)
                    else:
                        slice_offset, size = struct.unpack_from(endian + 'II', table, base + 8)
                    if slice_offset < 8 + count * width or size > available - slice_offset:
                        raise ValueError('Invalid universal slice bounds')
                    parse(offset + slice_offset, size)
                return
            endian = '<' if magic in {b'\xce\xfa\xed\xfe', b'\xcf\xfa\xed\xfe'} else '>'
            header_size = 32 if magic in {b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf'} else 28
            if len(header) < header_size:
                raise ValueError('Truncated Mach-O header')
            cpu = struct.unpack_from(endian + 'I', header, 4)[0]
            count, size = struct.unpack_from(endian + 'II', header, 16)
            if size > available - header_size or size > 64 * 1024 * 1024 or count > size // 8:
                raise ValueError('Invalid Mach-O load commands')
            handle.seek(offset + header_size)
            data = handle.read(size)
            cursor = 0
            minimum = None
            for _ in range(count):
                if cursor + 8 > len(data):
                    raise ValueError('Truncated load command')
                command, command_size = struct.unpack_from(endian + 'II', data, cursor)
                if command_size < 8 or cursor + command_size > len(data):
                    raise ValueError('Invalid load command size')
                if command == 0x32 and command_size >= 24:
                    platform, value = struct.unpack_from(endian + 'II', data, cursor + 8)
                    if platform == 1:
                        minimum = packed_version(value)
                elif command == 0x24 and command_size >= 16:
                    minimum = packed_version(struct.unpack_from(endian + 'I', data, cursor + 8)[0])
                cursor += command_size
            slices.append({'architecture': CPU_NAMES.get(cpu, 'cpu_' + hex(cpu)),
                           'minimumMacOS': version_string(minimum) if minimum else None})
        parse(0, Path(path).stat().st_size)
    return slices


def audit_macho(root, info):
    root = Path(root).resolve()
    issues = []
    binaries = []
    try:
        declared = version_tuple(info.get('LSMinimumSystemVersion', ''))
    except ValueError:
        declared = None
        issues.append(finding('Contents/Info.plist', 'missing_or_invalid_minimum_macos'))
    maximum = None
    exceeds = []
    for path in entries(root):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            slices = read_macho(path)
        except (ValueError, OSError, struct.error):
            issues.append(finding(path.relative_to(root), 'invalid_or_unreadable_macho'))
            continue
        if not slices:
            continue
        rel = str(path.relative_to(root))
        binaries.append({'path': rel, 'slices': slices})
        for item in slices:
            if item['minimumMacOS']:
                value = version_tuple(item['minimumMacOS'])
                maximum = max(maximum or value, value)
                if declared is not None and value > declared:
                    exceeds.append({'path': rel, **item})
    if not binaries:
        issues.append(finding('Contents/MacOS', 'no_macho_binaries'))
    for rel in sorted({item['path'] for item in exceeds}):
        issues.append(finding(rel, 'binary_minimum_macos_exceeds_info_plist'))
    executable = info.get('CFBundleExecutable')
    if not isinstance(executable, str) or not executable or Path(executable).name != executable:
        main = None
        issues.append(finding('Contents/Info.plist', 'invalid_bundle_executable'))
    else:
        main = 'Contents/MacOS/' + executable
    expected = {
        main,
        'Contents/Resources/runtimes/node/bin/node',
        'Contents/Resources/runtimes/python/bin/python3',
        'Contents/Resources/runtime/codex/bin/codex',
    } - {None}
    by_path = {row['path']: {s['architecture'] for s in row['slices']} for row in binaries}
    main_arch = by_path.get(main, set())
    for rel in sorted(expected):
        if rel not in by_path:
            issues.append(finding(rel, 'missing_native_runtime'))
        elif main_arch and not main_arch.issubset(by_path[rel]):
            issues.append(finding(rel, 'runtime_architecture_mismatch'))
    return {'binaryCount': len(binaries), 'architectures': sorted({s['architecture'] for row in binaries for s in row['slices']}),
            'mainArchitectures': sorted(main_arch), 'declaredMinimumMacOS': version_string(declared) if declared else None,
            'maximumBinaryMinimumMacOS': version_string(maximum) if maximum else None,
            'exceedsDeclaredMinimum': exceeds, 'binaries': binaries, 'findings': issues}


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for data in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(data)
    return digest.hexdigest()


def audit_model(root):
    root = Path(root).resolve()
    relative = 'Contents/Resources/runtimes/python/semantic-manifest.json'
    issues = []
    matches = []
    if not inside_file(root, relative):
        return {'verifiedFiles': [], 'findings': [finding(relative, 'missing_semantic_manifest')]}
    try:
        manifest = json.loads((root / relative).read_text())
        hashes = manifest['modelFilesSha256']
        if not isinstance(hashes, dict) or set(hashes) != MODEL_FILES:
            raise ValueError('Invalid model hash manifest')
        if manifest.get('personalIndexesCopied') is not False:
            issues.append(finding(relative, 'manifest_does_not_exclude_personal_indexes'))
        for name, expected in sorted(hashes.items()):
            if not isinstance(expected, str) or not re.fullmatch('[a-fA-F0-9]{64}', expected):
                issues.append(finding(relative, 'invalid_model_sha256'))
                continue
            rel = 'Contents/Resources/runtimes/python/models/bge-small-zh-v1.5/' + name
            if not inside_file(root, rel):
                issues.append(finding(rel, 'missing_or_external_model_file'))
            elif sha256(root / rel) != expected.lower():
                issues.append(finding(rel, 'model_sha256_mismatch'))
            else:
                matches.append(rel)
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        issues.append(finding(relative, 'invalid_semantic_manifest'))
    return {'verifiedFiles': matches, 'findings': issues}


def audit_licenses(root):
    root = Path(root).resolve()
    resources = 'Contents/Resources/'
    reader = resources + 'app/packages/reader-ui/dist/'
    required = {
        'project': [resources + 'app/LICENSE'],
        'thirdPartyNotices': [resources + 'THIRD-PARTY-NOTICES.txt'],
        'electron': [resources + 'ELECTRON-LICENSE'],
        'chromium': [resources + 'LICENSES.chromium.html'],
        'node': [resources + 'runtimes/node/LICENSE'],
        'pythonPSF': [resources + 'runtimes/python/LICENSE.txt', resources + 'runtimes/python/lib/python3.12/LICENSE.txt', resources + 'runtimes/python/licenses/lib/python3.12/LICENSE.txt'],
        'codexLicense': [resources + 'runtime/codex/LICENSE'],
        'codexNotice': [resources + 'runtime/codex/NOTICE'],
        'readerNotices': [reader + 'THIRD_PARTY.md'],
        'foliate': [reader + 'FOLIATE-LICENSE'],
        'fflate': [reader + 'licenses/fflate/LICENSE'],
        'zipjs': [reader + 'licenses/@zip.js_zip.js/LICENSE'],
        'pdfjs': [reader + 'licenses/pdfjs-dist/LICENSE'],
        'icons': [resources + 'app/apps/desktop/shell/icons/LICENSE'],
        'modelNotice': [resources + 'runtimes/python/models/bge-small-zh-v1.5/MODEL-NOTICE.txt'],
    }
    present = {}
    issues = []
    for label, alternatives in required.items():
        match = next((rel for rel in alternatives if inside_file(root, rel) and (root / rel).stat().st_size > 0), None)
        if match:
            present[label] = match
        else:
            issues.append(finding(alternatives[0], 'missing_or_empty_license_' + label))
    manifest_path = reader + 'licenses/npm-packages.json'
    try:
        if not inside_file(root, manifest_path):
            raise ValueError('Missing license manifest')
        packages = json.loads((root / manifest_path).read_text())
        if not isinstance(packages, list) or not packages:
            raise ValueError('Empty license manifest')
        for package in packages:
            name = PurePosixPath(package['name'])
            files = package['files']
            if name.is_absolute() or '..' in name.parts or not name.parts or not isinstance(files, list) or not files:
                raise ValueError('Invalid npm license entry')
            for filename in files:
                if not isinstance(filename, str) or filename in {'.', '..'} or PurePosixPath(filename).name != filename:
                    raise ValueError('Invalid npm license file')
                rel = reader + 'licenses/npm/' + str(name) + '/' + filename
                if not inside_file(root, rel) or not (root / rel).stat().st_size:
                    issues.append(finding(rel, 'missing_or_empty_npm_license'))
        present['readerNpmManifest'] = manifest_path
    except (OSError, UnicodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        issues.append(finding(manifest_path, 'invalid_reader_npm_license_manifest'))
    return {'present': present, 'findings': issues,
            'scope': 'Presence checks only; not a complete redistribution review.'}


def verify_signature(root):
    try:
        result = subprocess.run(['codesign', '--verify', '--deep', '--strict', str(root)], capture_output=True, timeout=120)
        valid = result.returncode == 0
        return {'valid': valid, 'returnCode': result.returncode,
                'findings': [] if valid else [finding('Contents/_CodeSignature', 'codesign_verification_failed')]}
    except (OSError, subprocess.TimeoutExpired):
        return {'valid': False, 'returnCode': None, 'findings': [finding('Contents/_CodeSignature', 'codesign_unavailable_or_timed_out')]}


def audit_release(root):
    root = Path(root).resolve()
    if not root.is_dir():
        return {'passed': False, 'findings': [finding('.', 'bundle_directory_missing')]}
    info_path = 'Contents/Info.plist'
    try:
        if not inside_file(root, info_path):
            raise ValueError('Missing Info.plist')
        info = plistlib.loads((root / info_path).read_bytes())
        if not isinstance(info, dict):
            raise ValueError('Invalid Info.plist root')
    except (OSError, ValueError, plistlib.InvalidFileException):
        info = {}
    checks = {
        'privacy': lambda: scan_privacy(root), 'native': lambda: audit_macho(root, info),
        'model': lambda: audit_model(root), 'licenses': lambda: audit_licenses(root),
        'signature': lambda: verify_signature(root),
    }
    sections = {}
    for label, check in checks.items():
        try:
            sections[label] = check()
        except (OSError, RuntimeError, ValueError, TypeError):
            # Unreadable directories or malformed metadata must never look clean.
            # Exception messages may contain absolute paths, so do not expose them.
            sections[label] = {'findings': [finding('.', label + '_audit_could_not_complete')]}
    issues = [item for section in sections.values() for item in section['findings']]
    # Info values are metadata supplied by the bundle, not executable instructions.
    return {'passed': not issues, 'bundleVersion': info.get('CFBundleShortVersionString'),
            'bundleBuild': info.get('CFBundleVersion'), **sections, 'findings': issues,
            'notVerified': ['notarization', 'Gatekeeper on downloaded build', 'another Mac or minimum macOS runtime',
                            'complete third-party license review', 'model content quality']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    # An audit must not add or replace files inside the candidate being checked.
    app = args.app.resolve()
    output = args.output.resolve()
    if output.is_relative_to(app):
        parser.error('--output must be outside the application bundle')
    result = audit_release(app)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'blockingFindings': len(result['findings'])}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
