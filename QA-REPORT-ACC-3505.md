# ACC-3505 — Preuves locales, suivi de revue QA (Cycle 2) et limites

Base initiale : `90a40dd7986753bbb00c3fe03ada82bd068e512e`.
Head cycle 1 : `4d2cadc3c7b211e86f219137734b8098149d9380` (Avis QA REQUEST_CHANGES n°3947 sur PR #47 / ACC-3691).
Worktree de vérification : `<workspace>/acc-3505/wt` (chemin d'exemple, sans identifiant d'instance).

---

## 1. Périmètre et traitement des retours QA (Cycle 2)

Les 5 constats de la revue QA indépendante (ACC-3691) ont été intégralement traités :

1. **Constat 1 (Jeton avec saut de ligne final, `deploy/omniroute_native_deploy.py:1045`)** :
   - `make_remote` nettoie les blancs terminaux (`.strip() or None`) avant `validate_token`.
   - `validate_token` tolère les blancs terminaux (`token.strip()`) tout en continuant de refuser strictement tout caractère de contrôle interne (`\n`, `\r`, `\t`, `\x00`, etc.) sans jamais divulguer la valeur du jeton.
   - Testé unitairement dans `test_admin_token_file_handling` (fichiers terminés par LF ou CRLF acceptés, injections multilignes rejetées).

2. **Constat 2 (Rollback à chaud avec `--served-company`, `deploy/omniroute_native_deploy.py:195,980`)** :
   - `served_check_errors` accepte désormais `expect=None` pour la validation structurelle de l'attestation `loadedCode` (vérification que `proof` est un dictionnaire, que `revision` est présente et non vide, que `moduleRoots` correspond exactement à `[expected_dir]` et que `moduleFiles` est non vide et confiné sous la racine). Le contrôle d'égalité `proof.get('revision') == expect` n'est exigé que lorsque `expect` est fourni (ex. `--expect-served`).
   - Le retour arrière à chaud avec `--served-company` peut désormais réussir ses contrôles dès lors que le serveur fournit une attestation `loadedCode` valide.
   - Ajout des tests `test_hot_rollback_with_served_company_succeeds_when_loaded_code_valid` (succès prouvé avec `loadedCode`) et `test_hot_rollback_with_served_company_fails_closed_when_loaded_code_missing` (fail closed vérifié en l'absence de `loadedCode`).

3. **Constat 3 (Test discriminant du jeton avant transport, `deploy/tests/test_acc3505.py:19`)** :
   - Test unitaire direct de `validate_token` avec assertions explicites sur l'exception et non-divulgation du secret.
   - Test du constructeur `Remote(..., api_token=...)`.
   - Test de `Remote.api()` prouvant l'interception avant transport avec `mock_ct.assert_not_called()`.

4. **Constat 4 (Discrimination stricte sur le statut, `deploy/tests/test_acc3505.py:27-35`)** :
   - Fourniture d'un `loadedCode` valide et de racines conformes dans `test_real_failure_shapes`.
   - Preuve que seul le champ `status: fail` déclenche spécifiquement `['code servi : test-environment en échec ou statut absent']`.
   - Vérification croisée : avec le même `loadedCode`, `status: pass` et `status: warn` sont acceptés, tandis que `status: unknown` est refusé.

5. **Constat 5 (Harmonisation documentaire, `deploy/README.md` et `docs/deploiement.md`)** :
   - Remplacement des mentions résiduelles de `'<texte>'` par `<révision>` dans les exemples de commande et les descriptions des deux guides.

---

## 2. Preuves rejouées localement (environnement sans secrets)

| Suite / Outil | Commande | Résultat | Code retour |
|---|---|---|:---:|
| Deploy tests | `python3 -m unittest discover -s deploy/tests -q` | **90 tests exécutés, OK** | **0** |
| Anti-fuite | `bash scripts/check-anti-leak.sh` | 0 ligne fautive, aucune exclusion | **0** |
| Bench API | `python3 -m unittest discover -s bench -q` | 19 tests exécutés, OK | **0** |
| Scripts & notices | `python3 -m unittest discover -s scripts -p 'test_*.py' -v` | 7 tests exécutés, OK | **0** |
| Diff hygiene | `git diff --check` | 0 anomalie | **0** |

---

## 3. Limites et invariants

- **Fail-closed assumé sur T1** : Tant que le serveur Paperclip n'expose pas l'attestation structurée `loadedCode`, toute vérification avec `--served-company` échoue closed par conception. Aucune recette positive du processus vivant n'est revendiquée sur le serveur actuel. Le contrat minimal nécessaire reste documenté dans `deploy/README.md` et `docs/deploiement.md` pour arbitrage séparé.
- Ce rapport décrit uniquement le correctif Python/documentation du cycle 2 de la PR #47, pas l'ensemble des changements depuis la version publique précédente. Les résultats TypeScript/Vitest mentionnés historiquement (658/658 Vitest, 16+41 verify) ne constituent pas une preuve de l'export public v1.3.2 ; celui-ci requiert ses propres contrôles au SHA exact.
