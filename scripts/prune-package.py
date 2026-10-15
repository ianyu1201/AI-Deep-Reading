#!/usr/bin/env python3
"""Prune a disposable Apple Silicon candidate before signing, never an install.

The list is deliberately fixed. Small package metadata, host-side JavaScript,
licenses, corresponding-source materials and the target PTY runtime remain.
This script does not build, sign, launch, download, or publish anything.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct


ROOT = Path(__file__).resolve().parents[1]
NODE_MODULES = Path('Contents/Resources/app/apps/desktop/node_modules')
VERSION_REQUIREMENTS = {
    '@deepseek-ai/dsh-app-boot': '0.2.0-rc.2',
    '@deepseek-ai/dsh-sdk-app': '0.2.0-rc.2',
    '@deepseek-ai/dsh-subprocess-local': '0.2.0-rc.2',
    '@deepseek-ai/dsh-lazy-require': '0.2.0-rc.2',
    '@deepseek-ai/libreoffice-kit-darwin-arm64': '0.1.5',
    '@deepseek-ai/libreoffice-kit': '0.1.5',
    '@deepseek-ai/dsh-skill-office': '0.2.0-rc.2',
    'sherpa-onnx-darwin-arm64': '1.13.8',
    'sherpa-onnx-node': '1.13.8',
    '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice': '0.2.0-rc.2',
    '@deepseek-ai/dsh-experimental-voice-input-bundle': '0.2.0-rc.2',
    '@deepseek-ai/dsh-client-ui-sidebar-documentpreview': '0.2.0-rc.2',
    'node-pty': '1.2.0-beta.15',
}
# A prefix identifies package-owned runtime assets only, not a dependency graph.
TREE_TARGETS = {
    'office_native': (
        '@deepseek-ai/libreoffice-kit-darwin-arm64/bin',
        '@deepseek-ai/libreoffice-kit-darwin-arm64/program',
    ),
    'pty_other_platforms': (
        'node-pty/prebuilds/win32-arm64', 'node-pty/prebuilds/win32-x64',
        'node-pty/prebuilds/linux-arm64', 'node-pty/prebuilds/linux-x64',
        'node-pty/prebuilds/darwin-x64',
    ),
    'pty_windows_resources': ('node-pty/third_party/conpty',),
}
FILE_TARGETS = {
    'voice_native': (
        'sherpa-onnx-darwin-arm64/libonnxruntime.dylib',
        'sherpa-onnx-darwin-arm64/libsherpa-onnx-c-api.dylib',
        'sherpa-onnx-darwin-arm64/libsherpa-onnx-cxx-api.dylib',
        'sherpa-onnx-darwin-arm64/sherpa-onnx.node',
    ),
    'unused_document_preview': (
        '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.js',
        '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js',
        '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.excel.js',
    ),
}
METADATA_NAMES = {'package.json', 'prebuilds.json', 'npm-packages.json'}
SOURCE_DIRS = {'source', 'sources', 'src'}
LEGAL_WORDS = ('license', 'licence', 'notice', 'copyright', 'copying', 'authors')
BUILD_NAMES = {'makefile', 'gnumakefile', 'cmakelists.txt', 'build', 'build.gn',
               'meson.build', 'configure', 'configure.ac', 'config.guess', 'config.sub'}


class PruneError(RuntimeError):
    """Fail-closed error without source contents or private absolute paths."""


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for data in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(data)
    return result.hexdigest()


def checked_app(app, root=ROOT):
    supplied_root = Path(root).absolute()
    root = supplied_root.resolve()
    dist = root / 'dist'
    supplied = Path(app).absolute()
    # Reject symlink components, rather than silently resolving an alias to a
    # source install, published bundle, or a user's application directory.
    if dist.is_symlink() or (supplied_root / 'dist').is_symlink():
        raise PruneError('candidate_dist_is_symlink')
    if '..' in supplied.parts or not supplied.is_relative_to(supplied_root / 'dist'):
        raise PruneError('candidate_must_be_an_app_inside_root_dist')
    resolved = supplied.resolve()
    if resolved == dist or not resolved.is_relative_to(dist) or resolved.suffix != '.app':
        raise PruneError('candidate_must_be_an_app_inside_root_dist')
    cursor = supplied
    while cursor != supplied_root and cursor != cursor.parent:
        if cursor.is_symlink():
            raise PruneError('candidate_path_has_symlink')
        cursor = cursor.parent
    if not resolved.is_dir():
        raise PruneError('candidate_directory_missing')
    executable = resolved / 'Contents/MacOS/AIReading'
    cursor = executable
    while cursor != resolved:
        if cursor.is_symlink():
            raise PruneError('candidate_native_entry_path_has_symlink')
        cursor = cursor.parent
    if not executable.is_file() or executable.is_symlink():
        raise PruneError('candidate_native_entry_missing')
    with executable.open('rb') as handle:
        header = handle.read(8)
    if len(header) < 8 or header[:4] != b'\xcf\xfa\xed\xfe' or struct.unpack_from('<I', header, 4)[0] != 0x0100000C:
        raise PruneError('candidate_must_be_thin_macos_arm64')
    nm = resolved / NODE_MODULES
    cursor = nm
    while cursor != resolved:
        if cursor.is_symlink():
            raise PruneError('candidate_dependency_path_has_symlink')
        cursor = cursor.parent
    if not nm.is_dir():
        raise PruneError('candidate_node_modules_missing')
    return resolved, nm


def files_without_following_links(app, nm):
    """Inventory once; reject external links and leave internal links untouched."""
    files, links = [], []
    pending = [nm]
    while pending:
        directory = pending.pop()
        for item in sorted(os.scandir(directory), key=lambda item: item.name):
            path = Path(item.path)
            if item.is_symlink():
                try:
                    target = path.resolve(strict=True)
                except (OSError, RuntimeError):
                    raise PruneError('broken_or_cyclic_dependency_symlink') from None
                if not target.is_relative_to(app):
                    raise PruneError('dependency_symlink_escapes_candidate')
                links.append(str(path.relative_to(app)))
            elif item.is_dir(follow_symlinks=False):
                pending.append(path)
            elif item.is_file(follow_symlinks=False):
                files.append(path)
            else:
                raise PruneError('unsupported_dependency_filesystem_entry')
    return sorted(files), sorted(links)


def protected(relative):
    parts = tuple(part.lower() for part in relative.parts)
    name = parts[-1]
    # Keep legal notices even when embedded in an otherwise removable tree.
    if any(any(word in part for word in LEGAL_WORDS) for part in parts):
        return True
    if name in METADATA_NAMES or SOURCE_DIRS.intersection(parts):
        return True
    if name in BUILD_NAMES or name.endswith(('.gyp', '.gypi', '.cmake')):
        return True
    if name.endswith(('.d.ts', '.d.mts', '.d.cts')):
        return True
    if relative.is_relative_to(Path('node-pty/prebuilds/darwin-arm64')):
        return True
    return False


def read_checked(app, relative):
    path = app / relative
    cursor = path
    while cursor != app:
        if cursor.is_symlink():
            raise PruneError('boundary_proof_must_not_be_a_symlink')
        cursor = cursor.parent
    try:
        return path.read_text()
    except (OSError, UnicodeError):
        raise PruneError('required_boundary_proof_missing_or_unreadable') from None


def verify_boundaries(app, nm):
    versions = {}
    for package, expected in VERSION_REQUIREMENTS.items():
        text = read_checked(app, NODE_MODULES / package / 'package.json')
        try:
            metadata = json.loads(text)
        except (ValueError, TypeError):
            raise PruneError('invalid_package_metadata') from None
        if not isinstance(metadata, dict):
            raise PruneError('invalid_package_metadata')
        if metadata.get('name') != package or metadata.get('version') != expected:
            raise PruneError('reviewed_package_version_changed')
        versions[package] = expected
    carrier = read_checked(app, Path('Contents/Resources/app/apps/desktop/runtime/carrier.mjs'))
    boot = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-app-boot/lib/index.js')
    sdk_patch = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-sdk-app/cordis.patch.yml')
    pty = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-subprocess-local/lib/index.js')
    lazy = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-lazy-require/lib/index.js')
    pty_loader = read_checked(app, NODE_MODULES / 'node-pty/lib/utils.js')
    voice = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/index.js')
    voice_worker = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/lib/worker.js')
    office = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-skill-office/lib/index.js')
    preview_host = read_checked(app, NODE_MODULES / '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/index.js')
    conditions = {
        'sdk_profile_only': bool(re.search(r"new HarnessClient\(\{\s*profile:\s*['\"]sdk['\"]", carrier)),
        'sdk_profile_omits_web_and_voice': bool(re.search(r'sdk:\s*\{\s*bundles:\s*\["@deepseek-ai/dsh-base",\s*"@deepseek-ai/dsh-sdk-app"\]', boot)),
        'voice_bundle_is_optional': bool(re.search(r'const OPTIONAL_BUNDLES\s*=\s*\[[^\]]*"@deepseek-ai/dsh-experimental-voice-input-bundle"', boot)),
        'office_runtime_not_forwarded': 'DSH_PRIMARY_RUNTIME' not in carrier and 'DSH_BUNDLED_PRIMARY_RUNTIME' not in carrier,
        'office_skill_disabled_without_primary_runtime': bool(re.search(r'- id: skill-office\s+name: [\'\"]@deepseek-ai/dsh-skill-office[\'\"]\s+disabled: !!js "!\(process\.env\.DSH_PRIMARY_RUNTIME \?\? process\.env\.DSH_BUNDLED_PRIMARY_RUNTIME\)"', sdk_patch)),
        'office_cli_only_resolved_in_skill_runtime': 'function officeRuntime(config)' in office and 'import.meta.resolve("@deepseek-ai/libreoffice-kit/package.json")' in office,
        'pty_native_is_lazy': 'createLazyRequire("node-pty", import.meta.url)' in pty and 'requireNodePty().spawn(' in pty and 'return () => {' in lazy and 'value = require(specifier)' in lazy,
        'pty_prebuild_selected_by_platform_arch': 'process.platform' in pty_loader and 'process.arch' in pty_loader and 'prebuilds/' in pty_loader,
        'voice_native_only_in_worker': 'sherpa-onnx-node' not in voice and 'function createTranscriber(config)' in voice_worker and 'createRequire(import.meta.url)("sherpa-onnx-node")' in voice_worker,
        'preview_host_independent_of_browser_bundle': '__DSH_DOCUMENT_PREVIEW_CONFIG__' in preview_host and 'client.pdf.js' not in preview_host and 'client.excel.js' not in preview_host,
    }
    if not all(conditions.values()):
        raise PruneError('reviewed_runtime_boundary_changed:' + ','.join(name for name, ok in conditions.items() if not ok))
    # No first-party application module may directly import the disabled features.
    for folder in ('electron', 'runtime', 'shell'):
        base = app / 'Contents/Resources/app/apps/desktop' / folder
        if base.is_symlink():
            raise PruneError('first_party_proof_path_has_symlink')
        for path in base.rglob('*'):
            if path.is_symlink():
                raise PruneError('first_party_proof_path_has_symlink')
            if path.is_file() and path.suffix in {'.js', '.mjs', '.cjs'}:
                text = path.read_text()
                if any(token in text for token in ('@deepseek-ai/libreoffice-kit', 'sherpa-onnx', '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', '@deepseek-ai/dsh-experimental-voice-input-bundle')):
                    raise PruneError('first_party_module_references_pruned_feature')
    return {'packageVersions': versions, 'staticBoundaryChecks': conditions}


def group_for(relative):
    if protected(relative):
        return None
    for group, targets in TREE_TARGETS.items():
        if any(relative.is_relative_to(Path(target)) for target in targets):
            return group
    for group, targets in FILE_TARGETS.items():
        if relative.as_posix() in targets:
            return group
    if relative.name.endswith('.map'):
        return 'source_maps'
    return None


def make_plan(app, root=ROOT):
    app, nm = checked_app(app, root)
    files, links = files_without_following_links(app, nm)
    proof = verify_boundaries(app, nm)
    remove, preserve = [], []
    for path in files:
        relative = path.relative_to(nm)
        group = group_for(relative)
        if group:
            remove.append({'path': str(path.relative_to(app)), 'group': group,
                           'bytes': path.stat().st_size, 'sha256': digest(path)})
        elif protected(relative):
            preserve.append({'path': str(path.relative_to(app)), 'bytes': path.stat().st_size,
                             'sha256': digest(path)})
    return {'schemaVersion': 1, 'candidate': str(app.relative_to(Path(root).resolve())),
            'target': 'darwin-arm64', **proof, 'files': remove,
            'protectedFiles': preserve, 'untouchedInternalSymlinks': links}


def verify_unchanged_file(app, item):
    path = app / item['path']
    cursor = path
    while cursor != app:
        if cursor.is_symlink():
            raise PruneError('planned_path_changed_to_symlink')
        cursor = cursor.parent
    try:
        state = path.lstat()
        if not stat.S_ISREG(state.st_mode) or state.st_size != item['bytes'] or digest(path) != item['sha256']:
            raise PruneError('planned_file_changed')
    except OSError:
        raise PruneError('planned_file_missing_or_unreadable') from None
    return path


def prune_package(app, *, root=ROOT, dry_run=False):
    """Return exact per-file bytes/hashes; invoke only on a disposable candidate.

    Integration: report = prune_package(out); save report beside (not inside)
    the .app, then sign, run the release smoke and release audit, and archive.
    Unknown versions, changed static boundaries or symlink escapes abort before
    deletion. A later I/O failure invalidates this candidate; rebuild it.
    """
    app, _ = checked_app(app, root)
    plan = make_plan(app, Path(root).resolve())
    # Preflight the complete plan before the first unlink. No recursive deletion
    # is used; retained notices and source files prevent parent removal.
    for item in plan['files'] + plan['protectedFiles']:
        verify_unchanged_file(app, item)
    removed = []
    if not dry_run:
        for item in plan['files']:
            path = verify_unchanged_file(app, item)
            path.unlink()
            removed.append(item)
        for item in plan['protectedFiles']:
            verify_unchanged_file(app, item)
    summaries = {}
    for item in plan['files']:
        row = summaries.setdefault(item['group'], {'files': 0, 'bytes': 0})
        row['files'] += 1
        row['bytes'] += item['bytes']
    return {'passed': True, 'dryRun': dry_run, **plan,
            'groups': summaries, 'plannedBytes': sum(row['bytes'] for row in plan['files']),
            'removedFiles': len(removed), 'removedBytes': sum(row['bytes'] for row in removed),
            'protectedFilesUnchanged': True, 'signatureMustBeRegenerated': bool(removed),
            'notVerified': ['candidate startup after pruning', 'reading and AI behavior after pruning',
                            'new code signature and release audit']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    output = args.output.resolve()
    try:
        app, _ = checked_app(args.app)
        if output.is_relative_to(app) or not output.is_relative_to(ROOT / 'dist'):
            raise PruneError('manifest_must_be_inside_root_dist_and_outside_app')
        result = prune_package(app, dry_run=args.dry_run)
    except (PruneError, OSError, ValueError) as error:
        # Do not print native OSError messages: they can contain private paths.
        result = {'passed': False, 'reason': str(error) if isinstance(error, PruneError) else 'candidate_prune_failed',
                  'candidateMustBeRebuilt': True}
        if not output.is_relative_to(ROOT / 'dist') or output.is_relative_to(args.app.resolve()):
            print(json.dumps(result))
            return 1
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({key: result[key] for key in ('passed', 'dryRun', 'removedFiles', 'removedBytes', 'plannedBytes') if key in result}))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
