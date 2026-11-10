#!/usr/bin/env python3
"""Read-only export gate. Never pushes, merges, tags or updates a remote."""
import argparse
import json
import pathlib
import re
import subprocess

PUBLIC_REMOTE = 'https://github.com/AC-CREATION-AI/paperclip-adapter-omniroute.git'
MARKERS = (b'192.' + b'168.', b'/opt/' + b'data', b'/mn' + b't/',
           b'ptichalouf' + b'.xyz', b'board' + b'-token')


def validate(repo, source, public, remote=PUBLIC_REMOTE):
    def git(*args):
        return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.DEVNULL, timeout=45)
    def resolve(ref):
        return git('rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip()
    def tree(ref):
        return {p: (mode, sha) for entry in git('ls-tree', '-rz', ref).split(b'\0') if entry
                for meta, p in [entry.split(b'\t', 1)] for mode, _, sha in [meta.split()]
                if not p.startswith(b'.gitea/')}
    source, public = resolve(source), resolve(public)
    live = git('ls-remote', '--exit-code', remote, 'refs/heads/main').split()[0].decode()
    if live != public:
        raise ValueError('public head moved; fetch and import a new snapshot')
    manifest = json.loads(git('show', source + ':docs/public-snapshot.json'))
    if manifest['public_commit'] != public:
        raise ValueError('snapshot predates latest public merge')
    snapshot = resolve(manifest['snapshot_commit'])
    git('merge-base', '--is-ancestor', snapshot, source)
    public_tree, source_tree = tree(public), tree(source)
    if tree(snapshot) != public_tree:
        raise ValueError('snapshot is not an exact public tree')
    deleted = sorted(set(public_tree) - set(source_tree))
    if deleted:
        raise ValueError(f'export deleted {len(deleted)} public files')
    forbidden = 0
    for path, (mode, sha) in source_tree.items():
        if mode not in (b'100644', b'100755'):
            raise ValueError('symlinks and submodules require a separate security review')
        data = git('cat-file', 'blob', sha.decode()).lower()
        forbidden += sum(any(p in line for p in MARKERS) or bool(re.search(
            rb'\b(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b', line))
                         for line in data.splitlines())
    if forbidden:
        raise ValueError(f'export contains {forbidden} forbidden infrastructure lines')
    return {'source': source, 'public': public, 'snapshot': snapshot,
            'deleted_files': 0, 'forbidden_lines': 0, 'exported_files': len(source_tree)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source'); parser.add_argument('public')
    args = parser.parse_args()
    try:
        print(json.dumps(validate(pathlib.Path.cwd(), args.source, args.public), indent=2))
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Export refused: {error}\n')


if __name__ == '__main__':
    main()
