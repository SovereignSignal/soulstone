"""Offline acceptance checks for release and adoption trust boundaries."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from bridge_support import manifest, verify

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('compatibility', ROOT / 'scripts/compatibility.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.pin = verify(ROOT / 'harness/bridge')

    def test_missing_or_wrong_release_checksum_is_rejected(self):
        release = {'tag_name': 'v3.4.13', 'assets': [{'name': 'ViaProxy-3.4.13.jar',
                   'browser_download_url': 'https://github.com/ViaVersion/ViaProxy/releases/download/v3.4.13/ViaProxy-3.4.13.jar'}]}
        for digest in [None, 'md5:' + 'a' * 32, 'sha256:bad']:
            release['assets'][0]['digest'] = digest
            with self.assertRaisesRegex(ValueError, 'official download URL and SHA-256'):
                upgrade.select_asset(release)
        release['assets'][0]['digest'] = 'sha256:' + 'a' * 64
        self.assertEqual(upgrade.select_asset(release)['name'], 'ViaProxy-3.4.13.jar')
        release['assets'][0]['browser_download_url'] = 'https://untrusted.example/helper.jar'
        with self.assertRaises(ValueError):
            upgrade.select_asset(release)

    def test_candidate_pin_cannot_escape_its_directory_or_repeat_routes(self):
        for change in [{'jar': '../helper.jar'}, {'routes': self.pin['routes'] * 2}, {'clientProtocol': -1}]:
            with tempfile.TemporaryDirectory() as folder:
                (Path(folder) / 'compatibility.json').write_text(json.dumps({**self.pin, **change}))
                with self.assertRaises(ValueError):
                    manifest(folder)

    def test_changed_binary_is_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / 'compatibility.json').write_text(json.dumps(self.pin))
            (path / self.pin['jar']).write_bytes(b'corrupt candidate')
            with self.assertRaisesRegex(ValueError, 'Integrity check failed'):
                verify(path)

    def test_blocked_candidate_cannot_be_applied(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / 'receipt.json').write_text(json.dumps({'status': 'blocked'}))
            with patch.object(upgrade, 'verify', return_value=self.pin), patch.object(upgrade.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'not passed'):
                    upgrade.apply(path)
                run.assert_not_called()

    def test_pin_changed_since_staging_cannot_be_applied(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            receipt = {'status': 'translation-verified', 'manifestSha256': 'a', 'licenseSha256': 'b', 'baseManifestSha256': 'old'}
            (path / 'receipt.json').write_text(json.dumps(receipt))
            with patch.object(upgrade, 'verify', return_value=self.pin), patch.object(upgrade, 'digest', side_effect=['a', 'b', 'new']), patch.object(upgrade.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'pin changed'):
                    upgrade.apply(path)
                run.assert_not_called()

    def test_upgrading_cannot_drop_existing_server_versions(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            receipt = {'status': 'translation-verified', 'manifestSha256': 'a', 'licenseSha256': 'b', 'baseManifestSha256': 'c'}
            (path / 'receipt.json').write_text(json.dumps(receipt))
            candidate = copy.deepcopy(self.pin)
            candidate['routes'] = [{'version': '26.3', 'protocol': 777}]
            with patch.object(upgrade, 'verify', side_effect=[candidate, self.pin]), patch.object(upgrade, 'digest', side_effect=['a', 'b', 'c']), patch.object(upgrade.subprocess, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'drop an existing'):
                    upgrade.apply(path)
                run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
