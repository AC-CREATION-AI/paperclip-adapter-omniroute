"""Offline, real-Git regression tests for the export gate."""
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('gate', pathlib.Path(__file__).with_name('check-export.py'))
assert spec is not None and spec.loader is not None
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ExportGateTests(unittest.TestCase):
    def test_gate_rejects_staleness_loss_and_unproved_snapshots(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()
            git('init', '-b', 'main')
            git('config', 'user.name', 'fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            (repo / 'product').write_text('public content')
            git('add', '.'); git('commit', '-m', 'public')
            public = git('rev-parse', 'HEAD')
            git('switch', '-c', 'source')
            (repo / '.gitea').mkdir()
            (repo / '.gitea/ci').write_text('internal-only')
            git('add', '.'); git('commit', '-m', 'snapshot')
            snapshot = git('rev-parse', 'HEAD')
            (repo / 'docs').mkdir()
            manifest = repo / 'docs/public-snapshot.json'
            def commit_manifest(value):
                manifest.write_text(json.dumps(value)); git('add', '-A'); git('commit', '-m', 'source')
            commit_manifest({'public_commit': public, 'snapshot_commit': snapshot})
            result = gate.validate(repo, 'HEAD', public, str(repo))
            self.assertEqual(result['deleted_files'], 0)
            self.assertEqual(result['forbidden_lines'], 0)
            (repo / 'product').write_text('192.' + '168.1.99')
            git('add', '.'); git('commit', '-m', 'unsafe marker')
            with self.assertRaisesRegex(ValueError, 'forbidden'):
                gate.validate(repo, 'HEAD', public, str(repo))
            git('reset', '--hard', 'HEAD~1')
            commit_manifest({'public_commit': '0' * 40, 'snapshot_commit': snapshot})
            with self.assertRaisesRegex(ValueError, 'predates'):
                gate.validate(repo, 'HEAD', public, str(repo))
            git('reset', '--hard', 'HEAD~1')
            git('rm', 'product'); git('commit', '-m', 'unsafe deletion')
            with self.assertRaisesRegex(ValueError, 'deleted'):
                gate.validate(repo, 'HEAD', public, str(repo))
            git('reset', '--hard', 'HEAD~1')
            commit_manifest({'public_commit': public, 'snapshot_commit': '0' * 40})
            with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                gate.validate(repo, 'HEAD', public, str(repo))
            git('reset', '--hard', 'HEAD~1')
            git('branch', '-f', 'main', snapshot)
            with self.assertRaisesRegex(ValueError, 'public head moved'):
                gate.validate(repo, public, public, str(repo))


if __name__ == '__main__':
    unittest.main()
