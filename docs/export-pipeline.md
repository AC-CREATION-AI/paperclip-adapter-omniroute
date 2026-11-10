# Export Gitea → GitHub (D263)

## Source unique et arrêt de sécurité
Gitea est la source de développement ; GitHub est un miroir public assaini. Aucun développement ne doit être fusionné uniquement dans le miroir.
Aucun export automatique n'est armé par cette procédure : les workflows actuels exécutent des tests, pas une publication.
**Un export ne peut pas s'exécuter si un instantané public→interne n'a pas été fait depuis la dernière fusion publique.**
Le verrou exécutable est `scripts/check-export.py` ; une sortie non nulle interdit toute préparation ou publication. Ne jamais contourner ce verrou en changeant seulement le manifeste.

## 1. Mesurer puis importer l'instantané
Récupérer les deux têtes fraîches dans un clone privé, avec `origin` = Gitea et `public` = GitHub.
Avant toute écriture, sauvegarder les commits et inventorier les chemins remplacés avec leurs anciens blobs (`git ls-tree -r origin/main` et `git diff --raw origin/main public/main`).
Annoncer le remplacement : les versions courantes anciennes sont remplacées, mais les anciens commits restent accessibles.
Créer une branche depuis Gitea main. Importer l'arbre public exact, en conservant seulement `.gitea/` côté interne.
Créer un commit d'instantané pur AVANT de réappliquer les changements exclusivement internes.
Enregistrer son SHA et la tête publique dans `docs/public-snapshot.json`, dans un commit suivant.
Le verrou vérifie l'ascendance et l'égalité des arbres : un manifeste déclaratif seul n'est pas une preuve.
Reporter les changements internes par leur diff exact, jamais par remplacement d'un fichier entier plus récent.
Ouvrir la PR Gitea ; fusion par merge commit pour conserver l'ascendance du snapshot (pas de squash). Pas de force-push, de tag, de changement de protection ou de fusion par l'auteur.
## 2. Assainir et vérifier la source candidate
Conserver MIT, les deux `LICENSE`, les deux `THIRD_PARTY_NOTICES.md` et l'inventaire des dépendances.
Si les dépendances changent : inventorier les tarballs verrouillés (SHA-512 lockfile = registre = octets), y compris les paquets embarqués, reprendre les textes LICENSE/NOTICE complets et leurs empreintes dans `third-party-inventory.json`. Préserver le NOTICE de `bare-path`, les avis imbriqués et les espaces des textes tiers ; documenter tout recours à une licence amont au commit de provenance. `scripts/test_notices.py` contrôle la couverture et les empreintes des deux notices.
Retirer adresses LAN, chemins internes, identifiants réels et secrets ; les exemples utilisent localhost et les UUID synthétiques de `bench/config.json`.
Exécuter exactement :
```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build
pnpm run test
pnpm --filter @agence/omniroute-native run verify
bash scripts/check-anti-leak.sh
python3 -m unittest discover -s scripts -p 'test_*.py' -v
python3 -m unittest discover -s bench -q
python3 -m unittest discover -s deploy/tests -q
```
Le scanner de marqueurs n'est pas un détecteur universel de secrets : ajouter `gitleaks dir --redact --no-banner .` dans l'arbre exporté et relire les exemples.
## 3. Rejouer sans publication, puis ouvrir UNE PR publique
Fixer `SOURCE` au SHA candidat Gitea et `PUBLIC` au SHA fraîchement récupéré du miroir ; ne jamais employer une tête cachée obsolète.
```sh
git fetch --no-tags public main
python3 scripts/check-export.py "$SOURCE" "$PUBLIC"
test ! -e "$EXPORT_DIR"
git worktree add --detach "$EXPORT_DIR" "$PUBLIC"
git -C "$EXPORT_DIR" restore --source "$SOURCE" --staged --worktree -- . ':(exclude).gitea'
git -C "$EXPORT_DIR" diff --cached --name-status
```
La projection exclut uniquement `.gitea/`. Le verrou exige zéro fichier public effacé et zéro marqueur interne ; il interroge lui-même la tête publique en direct.
Rejouer les tests et scanners dans cette projection. Enregistrer commandes, sorties, SHA et diff exact, pas seulement un compteur de fichiers.
Créer un commit public dont le parent est `PUBLIC`, sans importer l'historique privé, puis pousser une nouvelle branche et ouvrir une seule PR avec le diff exact en description.
Préparer en brouillon tant que la PR source n'est pas fusionnée et que les revues requises au head exact ne sont pas acquises.
Relancer le verrou juste avant toute poussée ; si la tête publique a bougé, STOP et nouvel instantané.
La publication automatique éventuelle doit employer le même verrou avant tout accès aux identifiants d'écriture, puis les portes de tests, anti-fuite et revue. Elle reste désarmée jusqu'à preuve sans perte et validation humaine.
Après la fusion publique, le manifeste devient volontairement périmé : l'export suivant reste bloqué jusqu'au prochain instantané.
Aucune réécriture d'historique, aucun nouveau tag et aucune fusion sans APPROVE A (et B si requis) au head exact.
