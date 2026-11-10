"""Tests du lot 14 : installation durable de l'adaptateur `omniroute_native`.

Deux cibles :
- les fonctions pures de `deploy/omniroute_native_deploy.py` (registre, journaux
  du chargeur, plan de retour arrière) ;
- `deploy/verify-artifact.mjs`, la porte qui refuse un artefact non autonome.

Lancement : `python3 -m unittest discover -s deploy/tests -v` (racine du dépôt).
Aucun accès réseau, aucun accès à Paperclip : tout est local et jetable.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

DEPLOY_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = DEPLOY_DIR / "omniroute_native_deploy.py"
VERIFY = DEPLOY_DIR / "verify-artifact.mjs"


def load_deploy_module():
    spec = importlib.util.spec_from_file_location("omniroute_native_deploy", SCRIPT)
    if spec is None or spec.loader is None:
        raise ImportError(f"script introuvable : {SCRIPT}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


OLD = ("/paperclip/instances/default/projects/p/w/_default/agency-starter/"
       "packages/adapters/omniroute-native")
NEW = "/paperclip/adapter-plugins/omniroute-native/current"


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.d = load_deploy_module()

    def test_remplace_seulement_l_entree_omniroute_native(self):
        records = [
            {"packageName": OLD, "localPath": OLD, "version": "0.1.0",
             "type": "omniroute_native", "installedAt": "2026-10-29T00:51:32.948Z"},
            {"packageName": "autre-adaptateur", "version": "1.2.3",
             "type": "autre", "installedAt": "2026-10-01T00:00:00.000Z", "disabled": True},
        ]
        out = self.d.new_registry(records, "omniroute_native", NEW, "0.1.0",
                                  "2026-10-31T12:00:00.000Z")
        self.assertEqual(len(out), 2)
        mine = [r for r in out if r["type"] == "omniroute_native"]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0]["localPath"], NEW)
        # Même convention que POST /api/adapters/install en chemin local :
        # packageName = chemin local.
        self.assertEqual(mine[0]["packageName"], NEW)
        self.assertEqual(mine[0]["installedAt"], "2026-10-31T12:00:00.000Z")
        other = [r for r in out if r["type"] == "autre"][0]
        self.assertEqual(other, records[1])
        # L'entrée d'origine n'est pas modifiée en place.
        self.assertEqual(records[0]["localPath"], OLD)

    def test_ajoute_l_entree_si_absente(self):
        out = self.d.new_registry([], "omniroute_native", NEW, "0.1.0", "t")
        self.assertEqual(out, [{"packageName": NEW, "localPath": NEW, "version": "0.1.0",
                                "type": "omniroute_native", "installedAt": "t"}])

    def test_refuse_un_registre_qui_n_est_pas_une_liste(self):
        with self.assertRaises(ValueError):
            self.d.new_registry({"type": "omniroute_native"}, "omniroute_native", NEW, "0.1.0", "t")

    def test_registre_serialise_comme_paperclip(self):
        # Paperclip écrit JSON.stringify(records, null, 2) sans saut final.
        text = self.d.serialize_registry([{"type": "x"}])
        self.assertEqual(text, '[\n  {\n    "type": "x"\n  }\n]')


class LoaderLogTests(unittest.TestCase):
    def setUp(self):
        self.d = load_deploy_module()

    def _line(self, **kw):
        return json.dumps({"level": 30, "time": 1, "pid": 7, **kw})

    def test_chargement_reussi_depuis_le_nouveau_chemin(self):
        logs = "\n".join([
            "bruit non JSON",
            self._line(packageName=NEW, packageDir=NEW, entryPoint="./dist/index.js",
                       msg="Loading external adapter package"),
            self._line(count=1, adapters=["omniroute_native"],
                       msg="Loaded external adapters from plugin store"),
        ])
        info = self.d.parse_loader_logs(logs)
        self.assertEqual(info["package_dirs"], [NEW])
        self.assertEqual(info["loaded_types"], ["omniroute_native"])
        self.assertEqual(info["failures"], [])
        self.assertEqual(self.d.post_check_errors(info, "omniroute_native", NEW), [])

    def test_echec_de_chargement_detecte(self):
        logs = "\n".join([
            self._line(packageName=OLD, packageDir=OLD, msg="Loading external adapter package"),
            self._line(packageName=OLD, type="omniroute_native",
                       msg="Failed to dynamically load external adapter; skipping"),
        ])
        info = self.d.parse_loader_logs(logs)
        errs = self.d.post_check_errors(info, "omniroute_native", NEW)
        self.assertTrue(any("process" in e for e in errs), errs)
        self.assertTrue(any("Failed to dynamically load" in e for e in errs), errs)
        self.assertTrue(any(NEW in e for e in errs), errs)

    def test_aucun_journal_de_chargement(self):
        errs = self.d.post_check_errors(self.d.parse_loader_logs(""), "omniroute_native", NEW)
        self.assertTrue(errs)


class MiscTests(unittest.TestCase):
    def setUp(self):
        self.d = load_deploy_module()

    def test_identifiant_de_version(self):
        self.assertEqual(self.d.release_id("20261031-120000", "317b564abcdef"),
                         "20261031-120000-317b564")

    def test_comptage_des_runs_actifs(self):
        self.assertEqual(self.d.parse_active_runs("0\n"), 0)
        self.assertEqual(self.d.parse_active_runs(" 3 "), 3)
        with self.assertRaises(ValueError):
            self.d.parse_active_runs("psql: error: connection refused")

    def test_dernier_etat_de_sauvegarde(self):
        names = [
            "omniroute-native-pre-deploy-20261030-101010.tar.gz",
            "omniroute-native-lot14-20261031-090000.state.json",
            "omniroute-native-lot14-20261031-120000.state.json",
            "omniroute-native-lot14-20261031-110000.state.json",
        ]
        self.assertEqual(self.d.latest_state(names),
                         "omniroute-native-lot14-20261031-120000.state.json")
        self.assertIsNone(self.d.latest_state(names[:1]))

    def test_dry_run_par_defaut(self):
        args = self.d.parse_args([])
        self.assertEqual(args.mode, "dry-run")
        self.assertEqual(self.d.parse_args(["--apply"]).mode, "apply")
        self.assertEqual(self.d.parse_args(["--rollback"]).mode, "rollback")
        self.assertEqual(self.d.parse_args(["--check"]).mode, "check")
        with self.assertRaises(SystemExit):
            self.d.parse_args(["--apply", "--rollback"])

    def test_catalogue_de_secours_signale(self):
        self.assertTrue(self.d.catalogue_degraded({"count": 6, "ms": 10004}))
        self.assertFalse(self.d.catalogue_degraded({"count": 60, "ms": 4191}))
        self.assertFalse(self.d.catalogue_degraded(None))

    def test_empreinte_du_contenu_egale_au_manifeste_sha256sum(self):
        import io as _io
        import tarfile as _tarfile
        buf = _io.BytesIO()
        files = {"omniroute-native/b.txt": b"bbb", "omniroute-native/a/x.js": b"x",
                 "omniroute-native/A.md": b"A"}
        with _tarfile.open(fileobj=buf, mode="w:gz") as tf:
            for name, data in files.items():
                info = _tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, _io.BytesIO(data))
        import hashlib as _h
        rows = sorted(("./" + n.split("/", 1)[1], _h.sha256(d).hexdigest()) for n, d in files.items())
        manifest = "".join(f"{h}  {n}\n" for n, h in rows).encode()
        self.assertEqual(self.d.content_digest(buf.getvalue()), _h.sha256(manifest).hexdigest())

    def test_refuse_un_dossier_temporaire_hors_tmp(self):
        with self.assertRaises(ValueError):
            self.d.check_container_tmp("/paperclip/x")
        with self.assertRaises(ValueError):
            self.d.check_container_tmp("/tmp/../paperclip")
        self.assertEqual(self.d.check_container_tmp("/tmp/lot14-dryrun"), "/tmp/lot14-dryrun")


def _fake_package(root: pathlib.Path, *, adapter_type="omniroute_native", export_fn=True):
    root.mkdir(parents=True)
    (root / "dist").mkdir()
    (root / "package.json").write_text(json.dumps({
        "name": "@agence/omniroute-native", "version": "0.1.0", "type": "module",
        "paperclip": {"adapterUiParser": "1.0.0"},
        "exports": {".": "./dist/index.js", "./ui-parser": "./ui-parser.cjs"},
    }))
    body = (f"export function createServerAdapter() {{ return {{ type: '{adapter_type}' }}; }}\n"
            if export_fn else "export const nothing = 1;\n")
    (root / "dist" / "index.js").write_text(body)
    (root / "ui-parser.cjs").write_text("module.exports = {};\n")


@unittest.skipUnless(shutil.which("node"), "node absent")
class VerifyArtifactTests(unittest.TestCase):
    def run_verify(self, pkg: pathlib.Path):
        return subprocess.run(["node", str(VERIFY), "--no-lock", str(pkg)],
                              capture_output=True, text=True, timeout=60)

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="lot14-verify-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_accepte_un_paquet_autonome(self):
        pkg = self.tmp / "ok" / "omniroute-native"
        _fake_package(pkg)
        r = self.run_verify(pkg)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("omniroute_native", r.stdout)

    def test_refuse_un_lien_qui_sort_du_paquet(self):
        # Reproduit l'installation actuelle : node_modules/@paperclipai/adapter-utils
        # est un lien vers le node_modules du dépôt agency-starter.
        outside = self.tmp / "agency-starter" / "node_modules" / "adapter-utils"
        outside.mkdir(parents=True)
        pkg = self.tmp / "agency-starter" / "packages" / "omniroute-native"
        _fake_package(pkg)
        (pkg / "node_modules" / "@paperclipai").mkdir(parents=True)
        os.symlink("../../../../node_modules/adapter-utils",
                   pkg / "node_modules" / "@paperclipai" / "adapter-utils")
        r = self.run_verify(pkg)
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn("sort du paquet", r.stdout + r.stderr)

    def test_refuse_sans_createServerAdapter(self):
        pkg = self.tmp / "noexport" / "omniroute-native"
        _fake_package(pkg, export_fn=False)
        r = self.run_verify(pkg)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("createServerAdapter", r.stdout + r.stderr)

    def test_refuse_un_autre_type(self):
        pkg = self.tmp / "process" / "omniroute-native"
        _fake_package(pkg, adapter_type="process")
        r = self.run_verify(pkg)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("omniroute_native", r.stdout + r.stderr)

    def test_refuse_une_dependance_resolue_hors_du_paquet(self):
        # Le paquet importe une dépendance qu'il n'embarque pas, mais qu'un
        # node_modules PARENT fournit : Node la trouverait en remontant.
        parent_nm = self.tmp / "parent" / "node_modules" / "dep-externe"
        parent_nm.mkdir(parents=True)
        (parent_nm / "package.json").write_text(json.dumps(
            {"name": "dep-externe", "version": "1.0.0", "type": "module", "exports": "./i.js"}))
        (parent_nm / "i.js").write_text("export const x = 1;\n")
        pkg = self.tmp / "parent" / "omniroute-native"
        _fake_package(pkg)
        (pkg / "dist" / "index.js").write_text(
            "import { x } from 'dep-externe';\n"
            "export function createServerAdapter() { return { type: 'omniroute_native', x }; }\n")
        r = self.run_verify(pkg)
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn("hors du paquet", r.stdout + r.stderr)


# ─── Revue A 58201 : apply + rollback de bout en bout sur un faux Remote ────

import io
import re
import tarfile
from unittest import mock


def _artifact(path: pathlib.Path, git_commit: str, marker: str):
    """Archive omniroute-native/ (paquet minimal valide pour verify-artifact.mjs)."""
    src = path.parent / f"src-{git_commit[:7]}" / "omniroute-native"
    _fake_package(src)
    (src / "MARKER").write_text(marker)
    (src / "BUILD-INFO.json").write_text(json.dumps({"gitCommit": git_commit, "dirty": False}))
    with tarfile.open(path, "w:gz") as tf:
        tf.add(src, arcname="omniroute-native")
    return path


_FORBIDDEN = re.compile(r"(?<![\w.-])/(?:paperclip|mnt|app)(?:/|\b)")


class FakeRemote:
    """Faux accès distant : le « conteneur » et l'« hôte » sont un dossier jetable.

    Les commandes shell du script tournent pour de vrai (sh local) sous `root`.
    Bouchons : redémarrage (= un chargeur factice relit le registre), journaux du
    serveur, santé HTTP, runs actifs, horloge. Toute commande qui viserait la
    production (/paperclip, /mnt, /app, docker) fait échouer le test.
    """

    def __init__(self, d, root: pathlib.Path):
        self.d, self.root = d, root
        home = str(root / "paperclip")
        self.host_name, self.container = "faux-hote", "faux-conteneur"
        self.ct_home = home
        self.host_home = home
        self.backup_root = str(root / "backups")
        self.tmp_prefix = str(root / "tmp" / "p")
        (root / "tmp").mkdir(parents=True, exist_ok=True)
        self.restarts = 0
        self.health_failures = 0      # nombre de redémarrages suivis d'un /api/health ≠ 200
        self.fail_scripts = {}        # sous-chaîne → nombre d'échecs à simuler
        self._health_bad = False
        self._logs = ""
        self.commands = []
        self.native_runs = 0          # runs actifs d'agents omniroute_native
        self.other_runs = 0           # runs actifs des autres adaptateurs
        self.installs = []            # chemins passés à POST /api/adapters/install
        self.install_failures = 0     # nombre d'install à faire échouer
        self.install_status = None    # 401/403 : échec d'install = refus d'authentification
        self.stale_install = False    # install accepté mais l'ancien code reste servi
        self.test_env_calls = []      # (société, agent) passés à test-environment
        self.served = None            # chemin réel du code exécuté par le serveur
        self._loaded = {}             # cache ESM : chemin déjà importé → chemin réel figé

    # -- exécution réelle, locale --
    def _run(self, cmd, input_bytes=None, check=True):
        if _FORBIDDEN.search(cmd) or re.match(r"\s*docker\b", cmd):
            raise AssertionError(f"commande hors bac à sable : {cmd[:200]}")
        self.commands.append(cmd)
        for needle, n in list(self.fail_scripts.items()):
            if n > 0 and needle in cmd:
                self.fail_scripts[needle] = n - 1
                r = subprocess.CompletedProcess(cmd, 3, b"", b"echec simule")
                break
        else:
            r = subprocess.run(["sh", "-c", cmd], input=input_bytes, capture_output=True,
                               cwd=self.root, timeout=120)
        if check and r.returncode:
            raise RuntimeError(f"échec distant ({r.returncode}) : {cmd[:160]} "
                               + (r.stdout + r.stderr).decode("utf-8", "replace")[-500:])
        return r

    def ssh(self, cmd, *, input_bytes=None, check=True, timeout=300):
        return self._run(cmd, input_bytes, check)

    def host(self, cmd, *, input_bytes=None, check=True, timeout=300):
        return self._run(cmd, input_bytes, check)

    def ct(self, script, *, user="node", input_bytes=None, check=True, timeout=300):
        return self._run(script, input_bytes, check)

    def out(self, r):
        return r.stdout.decode("utf-8", "replace")

    # -- bouchons --
    def utc_now(self):
        return "2026-10-31T00:00:00Z"

    def started_at(self):
        return "2026-10-31T00:00:00Z"

    def active_runs_raw(self):
        return f"{self.native_runs + self.other_runs}\n"

    def active_native_runs_raw(self):
        return f"{self.native_runs}\n"

    def health(self):
        return "502" if self._health_bad else "200"

    def restart(self):
        self.restarts += 1
        self._health_bad = self.health_failures > 0
        if self.health_failures:
            self.health_failures -= 1
        got = fake_loader(self.ct_home)
        self._loaded = {got["local"]: got["real"]} if got["ok"] else {}
        self.served = got["real"]
        self._logs = "\n".join(json.dumps(line) for line in got["lines"])

    # -- serveur en service : POST /api/adapters/install, GET /api/adapters/:type --
    def _registry(self):
        try:
            return json.loads(pathlib.Path(self.ct_home, "adapter-plugins.json").read_text())
        except json.JSONDecodeError:
            return []

    def install_adapter(self, path):
        """Comme le serveur : importe `path` (resservi depuis le cache s'il l'a déjà été),
        remplace l'adaptateur en mémoire, réécrit le registre avec ce chemin."""
        self.installs.append(path)
        if self.install_failures:
            self.install_failures -= 1
            if self.install_status:
                raise self.d.ApiError(self.install_status, "POST /api/adapters/install : HTTP "
                                      f"{self.install_status} Instance admin access required")
            raise RuntimeError("install refusé (simulé)")
        version = json.loads(pathlib.Path(path, "package.json").read_text())["version"]
        if not self.stale_install:
            self.served = self._loaded.setdefault(path, os.path.realpath(path))
        rec = {"packageName": path, "localPath": path, "version": version,
               "type": "omniroute_native", "installedAt": "2026-10-31T00:00:00.000Z"}
        regs = [r for r in self._registry() if r.get("type") != "omniroute_native"] + [rec]
        pathlib.Path(self.ct_home, "adapter-plugins.json").write_text(
            self.d.serialize_registry(regs))
        self._logs += "\n" + json.dumps({"msg": "External adapter installed and registered",
                                         "type": "omniroute_native", "packageName": path})
        return {"type": "omniroute_native", "packageName": path, "version": version,
                "requiresRestart": True}

    def adapter_info(self):
        rec = next(r for r in self._registry() if r.get("type") == "omniroute_native")
        version = json.loads(pathlib.Path(rec["localPath"], "package.json").read_text())["version"]
        return {"type": "omniroute_native", "source": "external", "loaded": True,
                "version": version}

    def served_marker(self):
        return pathlib.Path(self.served, "MARKER").read_text() if self.served else None

    def test_environment(self, company, agent=None):
        """POST /api/companies/:c/adapters/:type/test-environment : exécute le code SERVI."""
        self.test_env_calls.append((company, agent))
        return {"adapterType": "omniroute_native", "status": "pass",
                "checks": [{"code": "marker", "level": "info",
                            "message": f"code servi : {self.served_marker()}"}]}

    def server_logs(self, since):
        return self._logs


def fake_loader(home):
    """Ce que ferait le chargeur : lire le registre, importer <localPath>/dist/index.js."""
    records = json.loads(pathlib.Path(home, "adapter-plugins.json").read_text())
    rec = next((r for r in records if r.get("type") == "omniroute_native"), None)
    local = rec["localPath"] if rec else None
    lines, real, ok = [], None, False
    if local:
        lines.append({"msg": "Loading external adapter package", "packageDir": local})
        entry = pathlib.Path(local, "dist", "index.js")
        ok = entry.is_file()
        if ok:
            real = os.path.realpath(local)
            lines.append({"msg": "Loaded external adapters from plugin store",
                          "adapters": ["omniroute_native"]})
        else:
            lines.append({"msg": "Failed to dynamically load external adapter; skipping",
                          "packageName": local})
    return {"lines": lines, "ok": ok, "real": real, "local": local}


def fake_probe(rm, home, *, expect_dir=None, catalogue=True, allow_real_home=False, extra=None,
               forbid="agency-starter"):
    got = fake_loader(home)
    errors = [] if got["ok"] else ["omniroute_native non chargé (repli process)"]
    if got["ok"] and expect_dir and os.path.realpath(expect_dir) != got["real"]:
        errors.append(f"modules hors de {expect_dir} (chargé : {got['real']})")
    if got["ok"] and forbid and forbid in (got["real"] or ""):
        errors.append(f"modules dans {forbid}")
    return {"ok": not errors, "errors": errors, "loaded": got["ok"],
            "effectiveAdapterType": "omniroute_native" if got["ok"] else "process",
            "registryLocalPath": got["local"], "registryLocalPathReal": got["real"],
            "loaderLogs": {}}


class _DeployCase(unittest.TestCase):
    """Production factice : ancienne installation agency-starter + deux artefacts."""

    def setUp(self):
        self.d = load_deploy_module()
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="lot14-rollback-"))
        self.rm = FakeRemote(self.d, self.tmp / "remote")
        self.home = pathlib.Path(self.rm.ct_home)
        self.home.mkdir(parents=True)
        pathlib.Path(self.rm.backup_root).mkdir(parents=True)
        self.old = self.home / "instances/default/projects/p/w/_default/agency-starter/packages/adapters/omniroute-native"
        _fake_package(self.old)
        (self.old / "MARKER").write_text("ancienne installation")
        self.registry0 = self.d.serialize_registry([
            {"packageName": str(self.old), "localPath": str(self.old), "version": "0.1.0",
             "type": "omniroute_native", "installedAt": "2026-10-29T00:51:32.948Z"},
            {"packageName": "autre", "version": "1.0.0", "type": "autre",
             "installedAt": "2026-10-01T00:00:00.000Z"}]).encode()
        (self.home / "adapter-plugins.json").write_bytes(self.registry0)
        self.art1 = _artifact(self.tmp / "a1.tar.gz", "1111111aaaa", "r1")
        self.art2 = _artifact(self.tmp / "a2.tar.gz", "2222222bbbb", "r2")
        stamps = (f"20261031-1200{i:02d}" for i in range(60))
        self.patches = [mock.patch.object(self.d, "now_stamp", lambda: next(stamps)),
                        mock.patch.object(self.d, "run_probe", fake_probe),
                        mock.patch.object(self.d.time, "sleep", lambda s: None)]
        for p in self.patches:
            p.start()
        self.args = self.d.parse_args(["--apply", "--skip-catalogue"])

    def tearDown(self):
        for p in self.patches:
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- outils --
    def registry(self):
        return (self.home / "adapter-plugins.json").read_bytes()

    def current(self):
        link = self.home / "adapter-plugins/omniroute-native/current"
        return os.readlink(link) if link.is_symlink() else None

    def effective_marker(self):
        got = fake_loader(str(self.home))
        return (pathlib.Path(got["local"]) / "MARKER").read_text() if got["ok"] else None

    def apply(self, art_path):
        art = self.d.ensure_artifact(str(art_path))
        st = self.d.read_state(self.rm)
        report = {}
        self.d.apply(self.rm, self.args, art, st, report)
        return report

    def rollback(self, state=None):
        report = {}
        self.d.rollback(self.rm, self.args, state, report)
        return report


class DamagedRegistryRollbackTests(_DeployCase):
    def test_truncated_registry_hot_and_cold(self):
        for hot in (False, True):
            with self.subTest(hot=hot):
                self.args.hot = hot
                self.args = self.d.parse_args(["--rollback", "--hot", "--skip-catalogue"]
                                              if hot else ["--rollback", "--skip-catalogue"])
                (self.home / "adapter-plugins.json").write_bytes(self.registry0)
                self.apply(self.art1)
                damaged = b'[{"type":'
                (self.home / "adapter-plugins.json").write_bytes(damaged)
                report = self.rollback()
                self.assertFalse(report["rollbackChecks"]["errors"])
                self.assertEqual(self.effective_marker(), "ancienne installation")
                saved = list(pathlib.Path(self.rm.backup_root).glob("*.before-rollback"))
                self.assertTrue(any(p.read_bytes() == damaged for p in saved))

    def test_registre_json_valide_mais_pas_une_liste(self):
        for raw in (b"null", b"{}", b'"x"'):
            with self.subTest(raw=raw):
                (self.home / "adapter-plugins.json").write_bytes(raw)
                st = self.d.read_state(self.rm)
                self.assertEqual((st["records"], st["localPath"]), ([], None))

    def test_hot_without_previous_version_refuses_before_mutation(self):
        self.args.hot = True
        self.apply(self.art1)
        state_path = next(pathlib.Path(self.rm.backup_root).glob("*.state.json"))
        state = json.loads(state_path.read_text())
        state["previous"].update(localPath=None, current=None)
        state_path.write_text(json.dumps(state))
        before = self.registry(), self.current(), list(self.rm.installs), self.rm.restarts
        self.rm.commands.clear()
        with self.assertRaisesRegex(SystemExit, "ancienne version"):
            self.rollback()
        self.assertEqual(before, (self.registry(), self.current(), self.rm.installs, self.rm.restarts))
        self.assertFalse(any("cp -p" in c or "tar -x" in c or "ln -s" in c
                             for c in self.rm.commands))


class ApplyRollbackTests(_DeployCase):
    """Retour arrière testé à blanc (revue A 58201, point bloquant) : ROUGE si le
    registre ou `current` ne sont pas restaurés."""

    # -- cas 1 : première bascule (agency-starter → installation dédiée) --
    def test_premiere_bascule_puis_retour_arriere(self):
        self.apply(self.art1)
        self.assertEqual(self.effective_marker(), "r1")
        self.assertTrue(self.current().endswith("-1111111"), self.current())
        reg = json.loads(self.registry())
        self.assertEqual(reg[0]["localPath"], str(self.home / "adapter-plugins/omniroute-native/current"))
        self.assertEqual(reg[1]["type"], "autre")
        # Nettoyage d'agency-starter APRÈS la bascule : l'ancien paquet disparaît.
        shutil.rmtree(self.old)
        self.rollback()
        self.assertEqual(self.registry(), self.registry0, "registre non restauré")
        self.assertTrue((self.old / "dist/index.js").is_file(), "ancien paquet non restauré")
        self.assertEqual(self.effective_marker(), "ancienne installation")
        self.assertEqual(self.rm.restarts, 2)
        # Le registre d'avant le retour arrière est conservé (retour du retour).
        self.assertTrue(any(n.endswith(".before-rollback") for n in os.listdir(self.rm.backup_root)))

    # -- cas 2 : deuxième bascule (r1 → r2 → rollback = r1) --
    def test_deuxieme_bascule_puis_retour_arriere_vers_r1(self):
        self.apply(self.art1)
        r1, reg_r1 = self.current(), self.registry()
        self.apply(self.art2)
        self.assertTrue(self.current().endswith("-2222222"))
        self.assertEqual(self.effective_marker(), "r2")
        self.assertEqual(self.registry(), reg_r1, "le registre ne doit pas changer à la 2e bascule")
        self.rollback()
        self.assertEqual(self.current(), r1, "current non restauré")
        self.assertEqual(self.registry(), reg_r1, "registre non restauré")
        self.assertEqual(self.effective_marker(), "r1")
        # Les deux versions restent côte à côte.
        rels = sorted(os.listdir(self.home / "adapter-plugins/omniroute-native/releases"))
        self.assertEqual(len(rels), 2, rels)

    def test_retour_arriere_vers_un_etat_choisi(self):
        self.apply(self.art1)
        first = self.d.latest_state(os.listdir(self.rm.backup_root))
        self.apply(self.art2)
        self.rollback(first)
        self.assertEqual(self.registry(), self.registry0)
        self.assertEqual(self.effective_marker(), "ancienne installation")

    # -- remarque 2a : exception APRÈS la bascule de current --
    def test_echec_ecriture_registre_declenche_le_retour_arriere(self):
        # 1re écriture du registre (mv -f du temporaire) en échec, le retour arrière réussit.
        self.rm.fail_scripts["mv -f"] = 1
        with self.assertRaises(SystemExit):
            self.apply(self.art1)
        self.assertEqual(self.registry(), self.registry0)
        self.assertEqual(self.effective_marker(), "ancienne installation")
        self.assertGreaterEqual(self.rm.restarts, 1)

    def test_api_non_saine_apres_redemarrage_declenche_le_retour_arriere(self):
        self.apply(self.art1)
        r1, reg_r1 = self.current(), self.registry()
        self.rm.health_failures = 1          # /api/health ≠ 200 après le redémarrage de r2
        report = {}
        with self.assertRaises(SystemExit):
            art = self.d.ensure_artifact(str(self.art2))
            self.d.apply(self.rm, self.args, art, self.d.read_state(self.rm), report)
        self.assertEqual(self.current(), r1, "current non restauré après l'échec")
        self.assertEqual(self.registry(), reg_r1)
        self.assertEqual(self.effective_marker(), "r1")
        self.assertIn("rollbackChecks", report)

    def test_sans_retour_automatique_l_echec_est_signale(self):
        self.apply(self.art1)
        r2_args = self.d.parse_args(["--apply", "--skip-catalogue", "--no-auto-rollback"])
        self.rm.health_failures = 1
        art = self.d.ensure_artifact(str(self.art2))
        with self.assertRaises(SystemExit) as ctx:
            self.d.apply(self.rm, r2_args, art, self.d.read_state(self.rm), {})
        self.assertIn("--rollback", str(ctx.exception.code))
        self.assertTrue(self.current().endswith("-2222222"))


class HotUpdateTests(_DeployCase):
    """--hot (ACC-3039) : mise à jour sans redémarrage, par install du chemin VERSIONNÉ.

    Le faux serveur garde en cache le code d'un chemin déjà importé, comme Node : un
    `reload` sur `current` resservirait l'ancien code (constaté sur IA, ACC-3037)."""

    def setUp(self):
        super().setUp()
        self.apply(self.art1)                 # r1 installé à froid, registre sur current
        self.r1, self.reg_r1 = self.current(), self.registry()
        self.restarts0 = self.rm.restarts
        self.args = self.d.parse_args(["--apply", "--hot", "--skip-catalogue"])

    def release(self, rel):
        return str(self.home / "adapter-plugins/omniroute-native" / rel)

    def test_installe_le_chemin_versionne_sans_redemarrer(self):
        self.apply(self.art2)
        self.assertEqual(self.rm.restarts, self.restarts0, "aucun redémarrage en --hot")
        self.assertTrue(self.current().endswith("-2222222"), self.current())
        r2 = self.release(self.current())
        self.assertEqual(self.rm.installs, [r2], "install sur releases/<…>, jamais current")
        self.assertEqual(json.loads(self.registry())[-1]["localPath"], r2)
        self.assertEqual(self.rm.served_marker(), "r2", "le serveur exécute le nouveau code")
        state = json.loads(pathlib.Path(self.rm.backup_root,
                                        self.d.latest_state(os.listdir(self.rm.backup_root))).read_text())
        self.assertEqual(state["mode"], "hot")
        self.assertEqual(state["new"]["localPath"], r2)

    def test_runs_d_autres_adaptateurs_acceptes_runs_natifs_refuses(self):
        self.rm.other_runs = 2
        self.apply(self.art2)                 # d'autres adaptateurs tournent : accepté
        self.assertEqual(self.rm.served_marker(), "r2")
        self.rm.native_runs = 1
        with self.assertRaises(SystemExit) as ctx:
            self.apply(self.art1)
        self.assertIn("omniroute_native", str(ctx.exception.code))

    def test_sans_mode_hot_les_runs_d_autres_adaptateurs_bloquent(self):
        self.rm.other_runs = 1
        self.args = self.d.parse_args(["--apply", "--skip-catalogue"])
        with self.assertRaises(SystemExit):
            self.apply(self.art2)

    def test_echec_de_l_install_retour_arriere_a_chaud(self):
        self.rm.install_failures = 1
        with self.assertRaises(SystemExit):
            self.apply(self.art2)
        self.assertEqual(self.current(), self.r1, "current non restauré")
        self.assertEqual(self.rm.restarts, self.restarts0, "retour arrière à chaud : pas de redémarrage")
        self.assertEqual(self.rm.installs[-1], self.release(self.r1))
        self.assertEqual(self.rm.served_marker(), "r1")

    def test_retour_arriere_a_chaud(self):
        self.apply(self.art2)
        self.rollback()
        self.assertEqual(self.current(), self.r1)
        self.assertEqual(self.rm.installs[-1], self.release(self.r1))
        self.assertEqual(self.rm.served_marker(), "r1")
        self.assertEqual(self.rm.restarts, self.restarts0)
        self.assertTrue(any(n.endswith(".before-rollback") for n in os.listdir(self.rm.backup_root)))

    def test_apply_a_froid_apres_hot_remet_le_registre_sur_current(self):
        self.apply(self.art2)
        self.args = self.d.parse_args(["--apply", "--skip-catalogue"])
        self.apply(self.art1)
        mine = [r for r in json.loads(self.registry()) if r["type"] == "omniroute_native"]
        self.assertEqual([r["localPath"] for r in mine],
                         [str(self.home / "adapter-plugins/omniroute-native/current")])
        self.assertEqual(self.effective_marker(), "r1")

    def test_check_accepte_le_registre_sur_la_version_visee_par_current(self):
        self.apply(self.art2)
        report = {}
        rc = self.d.check(self.rm, self.d.parse_args(["--check", "--skip-catalogue"]), report)
        self.assertEqual(rc, 0, report["check"]["errors"])
        self.assertNotIn("warnings", report["check"])

    def test_journal_d_install_a_chaud(self):
        info = self.d.parse_loader_logs(json.dumps(
            {"msg": "External adapter installed and registered", "type": "omniroute_native",
             "packageName": NEW}))
        self.assertEqual(info["installed"], [NEW])
        self.assertEqual(self.d.post_check_errors(info, "omniroute_native", NEW), [])

    # -- remarques de relecture ACC-3101 (ex-ACC-3111) --
    def test_code_servi_controle_par_test_environment(self):
        self.args = self.d.parse_args(["--apply", "--hot", "--skip-catalogue",
                                       "--served-company", "c1", "--served-agent", "a1",
                                       "--expect-served", "code servi : r2"])
        report = {}
        with self.assertRaises(SystemExit):
            self.d.apply(self.rm, self.args, self.d.ensure_artifact(str(self.art2)),
                         self.d.read_state(self.rm), report)
        self.assertTrue(report["postChecks"]["errors"])
        self.assertTrue(report["rollbackChecks"]["errors"], "API actuelle sans preuve")

    def test_ancien_code_encore_servi_declenche_le_retour_arriere(self):
        # Registre, version annoncée et sonde passent : seul le code servi le révèle.
        self.rm.stale_install = True
        self.args = self.d.parse_args(["--apply", "--hot", "--skip-catalogue",
                                       "--served-company", "c1", "--expect-served", "code servi : r2"])
        report = {}
        art = self.d.ensure_artifact(str(self.art2))
        with self.assertRaises(SystemExit):
            self.d.apply(self.rm, self.args, art, self.d.read_state(self.rm), report)
        self.assertTrue(any("code servi" in e for e in report["postChecks"]["errors"]),
                        report["postChecks"]["errors"])
        self.assertEqual(self.current(), self.r1)
        self.assertEqual(self.rm.installs[-1], self.release(self.r1))
        self.assertTrue(report["rollbackChecks"]["errors"])

    def test_sans_societe_le_code_servi_est_signale_non_verifie(self):
        report = self.apply(self.art2)
        self.assertEqual(self.rm.test_env_calls, [])
        self.assertTrue(any("code servi non vérifié" in w
                            for w in report["postChecks"].get("warnings", [])))

    def test_install_refuse_par_authentification_sans_retour_arriere_inutile(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.rm.installs.clear()
                self.rm.install_failures, self.rm.install_status = 1, status
                with self.assertRaises(SystemExit) as ctx:
                    self.apply(self.art2)
                msg = str(ctx.exception.code)
                self.assertIn(str(status), msg)
                self.assertIn("--admin-token-file", msg)
                self.assertEqual(len(self.rm.installs), 1, "aucun install de retour arrière")
                self.assertEqual(self.current(), self.r1, "current remis sur sa cible")
                self.assertEqual(self.registry(), self.reg_r1)
                self.assertEqual(self.rm.restarts, self.restarts0)
                self.assertEqual(self.rm.served_marker(), "r1")

    def test_retour_arriere_a_chaud_refuse_par_authentification(self):
        self.apply(self.art2)
        self.rm.install_failures, self.rm.install_status = 1, 401
        with self.assertRaises(SystemExit) as ctx:
            self.rollback()
        msg = str(ctx.exception.code)
        self.assertIn("401", msg)
        self.assertIn("--admin-token-file", msg)
        self.assertEqual(self.rm.served_marker(), "r2")

    def test_apply_auth_error_after_install_rolls_back(self):
        for method in ("adapter_info", "test_environment"):
            for status in (401, 403):
                with self.subTest(method=method, status=status):
                    self.args = self.d.parse_args([
                        "--apply", "--hot", "--skip-catalogue", "--served-company", "c1"])
                    original = getattr(self.rm, method)
                    error = self.d.ApiError(status, f"{method}: HTTP {status}")
                    with mock.patch.object(self.rm, method, side_effect=[error, original() if method == "adapter_info"
                                                                           else original("c1")]):
                        report = {}
                        with self.assertRaises(SystemExit) as ctx:
                            self.d.apply(self.rm, self.args,
                                         self.d.ensure_artifact(str(self.art2)),
                                         self.d.read_state(self.rm), report)
                    self.assertIsNotNone(ctx.exception.code)
                    self.assertNotIn("authRefused", report["postChecks"])
                    self.assertTrue(report["rollbackChecks"]["errors"])
                    self.assertEqual(self.rm.served_marker(), "r1")
                    self.assertEqual(self.current(), self.r1)
                    self.assertEqual(self.rm.installs[-1], self.release(self.r1))

    def test_rollback_auth_error_after_install_reports_failed_checks(self):
        for method in ("adapter_info", "test_environment"):
            for status in (401, 403):
                with self.subTest(method=method, status=status):
                    self.args = self.d.parse_args([
                        "--apply", "--hot", "--skip-catalogue", "--served-company", "c1"])
                    with mock.patch.object(self.d, "served_check_errors", return_value=[]):
                        self.apply(self.art2)
                    report = {}
                    with mock.patch.object(self.rm, method, side_effect=self.d.ApiError(
                            status, f"{method}: HTTP {status}")):
                        with self.assertRaises(SystemExit) as ctx:
                            self.d.rollback(self.rm, self.args, None, report)
                    self.assertIn("contrôles en échec", str(ctx.exception.code))
                    self.assertNotIn("sert toujours la version installée", str(ctx.exception.code))
                    self.assertNotIn("authRefused", report["rollbackChecks"])
                    self.assertIn(str(status), report["rollbackChecks"]["errors"][0])
                    self.assertEqual(self.rm.served_marker(), "r1")
                    self.assertEqual(self.current(), self.r1)
                    self.assertEqual(self.rm.installs[-1], self.release(self.r1))

    def _edit_previous(self, **previous):
        state_path = pathlib.Path(self.rm.backup_root,
                                  self.d.latest_state(os.listdir(self.rm.backup_root)))
        state = json.loads(state_path.read_text())
        state["previous"].update(previous)
        state_path.write_text(json.dumps(state))

    def test_retour_arriere_a_chaud_vers_une_version_sans_current(self):
        # Ancien registre sur releases/<…> mais `current` absent : la version de repli
        # est ce chemin même, jamais « …/None ».
        self.apply(self.art2)
        self._edit_previous(localPath=self.release(self.r1), current=None)
        report = self.rollback()
        self.assertFalse(report["rollbackChecks"]["errors"])
        self.assertEqual(self.rm.installs[-1], self.release(self.r1))
        self.assertEqual(self.rm.served_marker(), "r1")

    def test_retour_arriere_a_chaud_sur_current_absent_refuse_avant_mutation(self):
        self.apply(self.art2)
        self._edit_previous(localPath=str(self.home / "adapter-plugins/omniroute-native/current"),
                            current=None)
        before = self.registry(), self.current(), list(self.rm.installs)
        with self.assertRaisesRegex(SystemExit, "ancienne version"):
            self.rollback()
        self.assertEqual(before, (self.registry(), self.current(), self.rm.installs))

    def test_erreurs_du_code_servi(self):
        f = self.d.served_check_errors
        ok = {"adapterType": "omniroute_native", "checks": [{"message": "Source : env(agent):X",
                                                            "detail": "d"}]}
        for expect in (None, "env(agent)", "absent"):
            self.assertTrue(f(ok, expect), "texte commun jamais preuve d'import")

    def test_cible_du_retour_arriere_a_chaud(self):
        inst = "/x/adapter-plugins/omniroute-native"
        f = self.d.hot_rollback_target
        self.assertEqual(f({"localPath": f"{inst}/current", "current": "releases/r1"}, inst),
                         f"{inst}/releases/r1")
        self.assertEqual(f({"localPath": f"{inst}/releases/r1", "current": "releases/r1"}, inst),
                         f"{inst}/releases/r1")
        self.assertEqual(f({"localPath": OLD, "current": None}, inst), OLD)


class HostOptionsTests(unittest.TestCase):
    """Hôte cible paramétrable en ligne de commande (ACC-3039 : instance IA)."""

    def setUp(self):
        self.d = load_deploy_module()

    def test_options_d_hote(self):
        a = self.d.parse_args(["--container", "paperclip-ac", "--host-home", "/srv/pc-ac",
                               "--backup-root", "/srv/backups/pc-ac"])
        rm = self.d.make_remote(a)
        self.assertEqual((rm.container, rm.host_home, rm.backup_root),
                         ("paperclip-ac", "/srv/pc-ac", "/srv/backups/pc-ac"))
        self.assertEqual(rm.ct_home, "/paperclip")
        d = self.d.make_remote(self.d.parse_args([]))
        self.assertEqual((d.container, d.host_home, d.backup_root),
                         (self.d.CONTAINER, self.d.HOST_HOME, self.d.BACKUP_ROOT))

    def test_chemins_d_hote_controles(self):
        with self.assertRaises(ValueError):
            self.d.make_remote(self.d.parse_args(["--host-home", "/srv/a b"]))

    def test_redemarrage_vise_le_conteneur_choisi(self):
        rm = self.d.make_remote(self.d.parse_args(["--container", "paperclip-ac"]))
        with mock.patch.object(rm, "ssh") as ssh:
            rm.restart()
        self.assertIn("docker restart paperclip-ac", ssh.call_args[0][0])

    def test_hot_refuse_avec_check_ou_sandbox(self):
        self.assertTrue(self.d.parse_args(["--apply", "--hot"]).hot)
        self.assertTrue(self.d.parse_args(["--rollback", "--hot"]).hot)
        for bad in (["--check", "--hot"], ["--apply", "--hot", "--sandbox", "/tmp/s"]):
            with self.assertRaises(SystemExit, msg=bad):
                self.d.main(bad)

    def test_jeton_admin_transmis_par_stdin_jamais_en_argument(self):
        rm = self.d.Remote("h", "paperclip-ac", api_token="jeton-de-test-0000")
        done = subprocess.CompletedProcess([], 0, b'{"type":"omniroute_native","version":"1.3.1"}\n201', b"")
        with mock.patch.object(rm, "ssh", return_value=done) as ssh:
            out = rm.install_adapter("/paperclip/adapter-plugins/omniroute-native/releases/r2")
        cmd, kw = ssh.call_args[0][0], ssh.call_args[1]
        self.assertNotIn("jeton-de-test-0000", cmd)
        self.assertIn(b"jeton-de-test-0000", kw["input_bytes"])
        self.assertIn("/api/adapters/install", cmd)
        self.assertEqual(out["version"], "1.3.1")

    def test_json_api_transmis_par_stdin_jamais_dans_argv_curl(self):
        body = {"adapterConfig": {"apiKey": "secret-synthetique-uniquement",
                                  "text": 'guillemets " et barre \\ et\nligne'}}
        for token in (None, "jeton-synthetique"):
            with self.subTest(auth=bool(token)):
                rm = self.d.Remote("h", "c", api_token=token)
                done = subprocess.CompletedProcess([], 0, b'{}\n200', b"")
                with mock.patch.object(self.d.subprocess, "run", return_value=done) as run:
                    self.assertEqual(rm.api("POST", "/example", body), {})
                argv = run.call_args.args[0]
                self.assertNotIn("secret-synthetique-uniquement", str(argv))
                self.assertNotIn(json.dumps(body), str(argv))
                config = run.call_args.kwargs["input"].decode()
                data_line = next(line for line in config.splitlines()
                                 if line.startswith("data-binary = "))
                self.assertEqual(json.loads(json.loads(data_line.split(" = ", 1)[1])), body)
                if token:
                    self.assertNotIn(token, str(argv))
                    self.assertIn("Authorization: Bearer " + token, config)

    def test_install_http_en_erreur(self):
        rm = self.d.Remote("h", "c")
        done = subprocess.CompletedProcess([], 0, b'{"error":"Instance admin access required"}\n403', b"")
        with mock.patch.object(rm, "ssh", return_value=done):
            with self.assertRaises(RuntimeError) as ctx:
                rm.install_adapter("/paperclip/adapter-plugins/omniroute-native/releases/r2")
        self.assertIn("403", str(ctx.exception))
        self.assertEqual(ctx.exception.status, 403)

    def test_test_environment_avec_la_config_de_l_agent(self):
        rm = self.d.Remote("h", "paperclip-ac", api_token="jeton-de-test-0000")
        agent = subprocess.CompletedProcess([], 0, b'{"adapterConfig":{"model":"AC-x"}}\n200', b"")
        tested = subprocess.CompletedProcess([], 0, b'{"adapterType":"omniroute_native","checks":[]}\n200', b"")
        with mock.patch.object(rm, "ssh", side_effect=[agent, tested]) as ssh:
            out = rm.test_environment("c-1", "a-1")
        first, second = ssh.call_args_list[0][0][0], ssh.call_args_list[1][0][0]
        self.assertIn("/api/agents/a-1", first)
        self.assertIn("/api/companies/c-1/adapters/omniroute_native/test-environment", second)
        config = ssh.call_args_list[1][1]["input_bytes"].decode()
        data_line = next(line for line in config.splitlines() if line.startswith("data-binary = "))
        body = json.loads(json.loads(data_line.split(" = ", 1)[1]))
        self.assertEqual(body["agentId"], "a-1")
        self.assertEqual(body["adapterConfig"]["model"], "AC-x")
        self.assertNotIn("jeton-de-test-0000", second)
        self.assertEqual(out["adapterType"], "omniroute_native")

    def test_options_du_code_servi(self):
        a = self.d.parse_args(["--apply", "--hot", "--served-company", "c-1", "--expect-served", "x"])
        self.assertEqual((a.served_company, a.served_agent, a.expect_served), ("c-1", None, "x"))
        for bad in (["--apply", "--hot", "--expect-served", "x"],
                    ["--apply", "--hot", "--served-company", "c 1"],
                    ["--apply", "--served-company", "c-1"]):
            with self.assertRaises(SystemExit, msg=bad), \
                    mock.patch("sys.stderr", new_callable=io.StringIO):
                self.d.parse_args(bad)


class ContainerTmpTests(unittest.TestCase):
    """Remarque 2b : --container-tmp limité à [A-Za-z0-9/_.-]."""

    def setUp(self):
        self.d = load_deploy_module()

    def test_refuse_les_caracteres_shell(self):
        for bad in ["/tmp/a b", "/tmp/x;rm -rf /", "/tmp/$(id)", "/tmp/a`id`", "/tmp/a'b",
                    "/tmp/a\nb", "/tmp/a*", "/tmp/é"]:
            with self.assertRaises(ValueError, msg=bad):
                self.d.check_container_tmp(bad)
        self.assertEqual(self.d.check_container_tmp("/tmp/lot14-s6_a.b"), "/tmp/lot14-s6_a.b")

    def test_les_racines_du_remote_sont_controlees(self):
        with self.assertRaises(ValueError):
            self.d.Remote("h", "c", "/tmp/x", ct_home="/tmp/a b")


class SandboxTests(unittest.TestCase):
    """--sandbox : bac à sable sous /tmp du conteneur, jamais la production."""

    def setUp(self):
        self.d = load_deploy_module()

    def test_racines_sous_le_dossier_du_bac_a_sable(self):
        rm = self.d.SandboxRemote("h", "c", "/tmp/lot14-s6")
        self.assertEqual((rm.ct_home, rm.host_home, rm.backup_root, rm.tmp_prefix),
                         ("/tmp/lot14-s6/home", "/tmp/lot14-s6/home", "/tmp/lot14-s6/backups",
                          "/tmp/lot14-s6/sonde"))
        self.assertEqual(rm.active_runs_raw(), "0")
        for bad in ["/paperclip/x", "/tmp/a b", "/tmp/../paperclip"]:
            with self.assertRaises(ValueError):
                self.d.SandboxRemote("h", "c", bad)

    def test_commandes_de_production_refusees_sans_execution(self):
        rm = self.d.SandboxRemote("h", "c", "/tmp/lot14-s6")
        with mock.patch.object(self.d.subprocess, "run") as run:
            for cmd in ["docker restart c", "cat /paperclip/adapter-plugins.json",
                        "tar -czf /m" + "nt/user/x.tgz y"]:
                with self.assertRaises(RuntimeError):
                    rm.ssh(cmd)
            with self.assertRaises(RuntimeError):
                rm.ct("cp x /paperclip/adapter-plugins.json")
            run.assert_not_called()

    def test_option_sandbox(self):
        self.assertEqual(self.d.parse_args(["--rollback", "--sandbox", "/tmp/s"]).sandbox, "/tmp/s")


if __name__ == "__main__":
    unittest.main()
