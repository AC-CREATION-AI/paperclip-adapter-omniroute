"""Régressions ACC-3505, exclusivement doubles locaux."""
import copy
import tempfile
import unittest
from unittest import mock
from test_deploy import load_deploy_module
import test_deploy


class Inputs(unittest.TestCase):
    def setUp(self):
        self.d = load_deploy_module()

    def test_token_controls_before_transport(self):
        # 1. Validation unitaire directe de validate_token
        for token in ('tok\nheader: injected', 'tok\rX', 'tok\tX', 'tok\x00X'):
            with self.subTest(token=repr(token)):
                with self.assertRaises(ValueError) as ctx:
                    self.d.validate_token(token)
                self.assertIn("caractères de contrôle interdits", str(ctx.exception))
                self.assertNotIn(token, str(ctx.exception))

        # Acceptation des jetons valides et nettoyage des séparateurs terminaux
        self.assertEqual(self.d.validate_token("valid-token"), "valid-token")
        self.assertEqual(self.d.validate_token("valid-token\n"), "valid-token")
        self.assertEqual(self.d.validate_token("valid-token\r\n"), "valid-token")
        self.assertIsNone(self.d.validate_token(None))

        # 2. Refus dès le constructeur de Remote
        for token in ('tok\nheader: injected', 'tok\rX', 'tok\tX', 'tok\x00X'):
            with self.subTest(remote_init=repr(token)):
                with self.assertRaises(ValueError) as ctx:
                    self.d.Remote('h', 'c', api_token=token)
                self.assertIn("caractères de contrôle interdits", str(ctx.exception))
                self.assertNotIn(token, str(ctx.exception))

        # 3. Preuve d'absence d'appel transport dans Remote.api() avant tout curl
        rm = self.d.Remote('h', 'c', api_token='clean-token')
        rm.api_token = 'injected\nheader'
        with mock.patch.object(rm, 'ct') as mock_ct:
            with self.assertRaises(ValueError) as ctx:
                rm.api('GET', '/health')
            mock_ct.assert_not_called()
            self.assertIn("caractères de contrôle interdits", str(ctx.exception))
            self.assertNotIn('injected', str(ctx.exception))

    def test_admin_token_file_handling(self):
        # Jeton avec saut de ligne final (créé par echo ou éditeur POSIX) : accepté
        with tempfile.NamedTemporaryFile("w+", delete=False) as tf:
            tf.write("mon-jeton-posix\n")
            tf.flush()
            args = self.d.parse_args(["--check", "--admin-token-file", tf.name])
            rm = self.d.make_remote(args)
            self.assertEqual(rm.api_token, "mon-jeton-posix")

        # Jeton avec saut de ligne CRLF : accepté
        with tempfile.NamedTemporaryFile("w+", delete=False) as tf:
            tf.write("mon-jeton-crlf\r\n")
            tf.flush()
            args = self.d.parse_args(["--check", "--admin-token-file", tf.name])
            rm = self.d.make_remote(args)
            self.assertEqual(rm.api_token, "mon-jeton-crlf")

        # Jeton avec caractères de contrôle internes : rejeté sans fuite du secret
        with tempfile.NamedTemporaryFile("w+", delete=False) as tf:
            tf.write("secret\nheader: injected\n")
            tf.flush()
            args = self.d.parse_args(["--check", "--admin-token-file", tf.name])
            with self.assertRaises(ValueError) as ctx:
                self.d.make_remote(args)
            self.assertIn("caractères de contrôle interdits", str(ctx.exception))
            self.assertNotIn("secret", str(ctx.exception))

    def test_container_rejected(self):
        for name in ('c; touch /tmp/x', '-option', 'c\nx', '', 'c x'):
            with self.assertRaises(ValueError):
                self.d.Remote('h', name)

    def test_real_failure_shapes(self):
        loaded = {"revision": "rev-1", "moduleRoots": ["/release/r1"],
                  "moduleFiles": ["/release/r1/dist/server.js"]}
        for check in (
            {'code': 'missing_api_key', 'level': 'error', 'message': 'Clé API manquante',
             'hint': 'ANTHROPIC_API_KEY'},
            {'code': 'unreachable', 'level': 'error', 'message': 'Passerelle injoignable'},
        ):
            # Statut fail : rejeté spécifiquement même avec un loadedCode valide
            response = {'adapterType': 'omniroute_native', 'status': 'fail',
                        'checks': [check], 'loadedCode': loaded}
            errs = self.d.served_check_errors(response, 'rev-1', '/release/r1')
            self.assertEqual(errs, ['code servi : test-environment en échec ou statut absent'])

        # Preuve de discrimination : avec le même loadedCode, statut pass ou warn est accepté
        pass_resp = {'adapterType': 'omniroute_native', 'status': 'pass',
                     'checks': [{'code': 'ok', 'level': 'info'}], 'loadedCode': loaded}
        self.assertEqual(self.d.served_check_errors(pass_resp, 'rev-1', '/release/r1'), [])

        warn_resp = {'adapterType': 'omniroute_native', 'status': 'warn',
                     'checks': [{'code': 'slow', 'level': 'warning'}], 'loadedCode': loaded}
        self.assertEqual(self.d.served_check_errors(warn_resp, 'rev-1', '/release/r1'), [])

        unknown_resp = {'adapterType': 'omniroute_native', 'status': 'unknown',
                        'checks': [{'code': 'unknown', 'level': 'warning'}], 'loadedCode': loaded}
        self.assertEqual(self.d.served_check_errors(unknown_resp, 'rev-1', '/release/r1'),
                         ['code servi : test-environment en échec ou statut absent'])

    def test_common_marker_is_not_loaded_proof(self):
        response = {'adapterType': 'omniroute_native', 'status': 'pass',
                    'checks': [{'detail': 'Source : env(agent):ANTHROPIC_API_KEY'}]}
        self.assertTrue(self.d.served_check_errors(response, 'ANTHROPIC_API_KEY'))

    def test_structured_proof_checks_revision_roots_and_files(self):
        response = {"adapterType": "omniroute_native", "status": "pass",
                    "checks": [{"code": "api_key", "level": "info"}],
                    "loadedCode": {"revision": "sha-new", "moduleRoots": ["/release/new"],
                                   "moduleFiles": ["/release/new/dist/server.js"]}}
        self.assertEqual(self.d.served_check_errors(response, "sha-new", "/release/new"), [])
        for key, value in (("revision", "sha-old"), ("moduleRoots", ["/release/old"]),
                           ("moduleFiles", []), ("moduleFiles", ["/release/new/../old/x"])):
            bad = copy.deepcopy(response)
            bad["loadedCode"][key] = value
            self.assertTrue(self.d.served_check_errors(bad, "sha-new", "/release/new"))

        # Validation structurelle sans contrôle d'égalité de révision si expect est omis
        self.assertEqual(self.d.served_check_errors(response, None, "/release/new"), [])
        # Mais révision absente de loadedCode est refusée
        no_rev = copy.deepcopy(response)
        del no_rev["loadedCode"]["revision"]
        self.assertTrue(self.d.served_check_errors(no_rev, None, "/release/new"))


class Recovery(test_deploy.HotUpdateTests):
    def test_refused_rollback_keeps_three_states_coherent(self):
        for status in (401, 403):
            self.apply(self.art2)
            before = self.current(), self.registry(), self.rm.served_marker()
            self.rm.install_failures, self.rm.install_status = 1, status
            with self.assertRaises(SystemExit) as ctx:
                self.rollback()
            self.assertEqual((self.current(), self.registry(), self.rm.served_marker()), before)
            self.assertNotIn('pour le prochain redémarrage', str(ctx.exception))

    def test_restore_failure_preserves_initial_error(self):
        self.rm.install_failures, self.rm.install_status = 1, 403
        report = {}
        with mock.patch.object(self.d, 'restore_current', side_effect=RuntimeError('restore failed')):
            with self.assertRaises(SystemExit):
                self.d.apply(self.rm, self.args, self.d.ensure_artifact(str(self.art2)),
                             self.d.read_state(self.rm), report)
        self.assertIn('403', str(report['postChecks']['errors']))
        self.assertIn('restore failed', str(report['postChecks']['errors']))
        self.assertTrue(report['postChecks']['divergence'])

    def test_hot_rollback_with_served_company_succeeds_when_loaded_code_valid(self):
        self.apply(self.art2)
        args = self.d.parse_args([
            "--rollback", "--hot", "--skip-catalogue", "--served-company", "c1"])
        rel1 = self.release(self.r1)
        valid_loaded = {
            "adapterType": "omniroute_native", "status": "pass",
            "checks": [{"code": "ok", "level": "info"}],
            "loadedCode": {
                "revision": "r1",
                "moduleRoots": [rel1],
                "moduleFiles": [f"{rel1}/dist/server.js"],
            },
        }
        report = {}
        with mock.patch.object(self.rm, "test_environment", return_value=valid_loaded):
            self.d.rollback(self.rm, args, None, report)
        self.assertEqual(report["rollbackChecks"]["errors"], [])
        self.assertEqual(self.current(), self.r1)

    def test_hot_rollback_with_served_company_fails_closed_when_loaded_code_missing(self):
        self.apply(self.art2)
        args = self.d.parse_args([
            "--rollback", "--hot", "--skip-catalogue", "--served-company", "c1"])
        report = {}
        # test_environment de FakeRemote ne contient pas loadedCode -> fail closed
        with self.assertRaises(SystemExit) as ctx:
            self.d.rollback(self.rm, args, None, report)
        self.assertIn("RETOUR ARRIÈRE À CHAUD : contrôles en échec", str(ctx.exception))
