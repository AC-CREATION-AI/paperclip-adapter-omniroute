# Installation durable de l'adaptateur `omniroute_native` dans Paperclip

Paperclip charge les adaptateurs externes listés dans `/paperclip/adapter-plugins.json`
(sur l'hôte : `/var/lib/paperclip/adapter-plugins.json` ou chemin configuré sur l'hôte), au démarrage du
serveur uniquement. Si un paquet listé ne se charge pas, le serveur écrit un simple
avertissement (`Failed to dynamically load external adapter; skipping`) et les agents
`omniroute_native` passent **sans alerte** par l'adaptateur générique `process`.

L'ancienne installation vivait dans le dossier d'un autre projet (`agency-starter`),
avec un lien vers son `node_modules`. Un `git clean -fdx` ou un reclonage de ce projet la
supprimait. Ce dossier `deploy/` la remplace par un paquet autonome, installé dans un
chemin dédié :

```
/paperclip/adapter-plugins/omniroute-native/
  releases/20261031-150000-abc1234/   une version par installation, côte à côte
  releases/20261102-090000-def5678/
  current -> releases/20261102-090000-def5678
```

Le registre pointe sur `…/omniroute-native/current` : il ne change qu'une fois, lors de la
première bascule.

| Fichier | Rôle |
|---|---|
| `build-artifact.sh` | construit `omniroute-native-<sha7>.tar.gz` (dist + node_modules de production, sans lien externe, archive reproductible) |
| `verify-artifact.mjs` | refuse un artefact non autonome : lien qui sort du paquet, module résolu hors du paquet, contrat du plugin-loader, versions différentes du lockfile |
| `real-loader-probe.mjs` | exécute le **vrai** chargeur du serveur (`/app/server/dist/adapters/registry.js`) dans le conteneur, sur le registre d'un `PAPERCLIP_HOME` donné |
| `omniroute_native_deploy.py` | essai à blanc (par défaut), `--apply`, `--rollback`, `--check` ; `--hot` sans redémarrage |
| `tests/` | `python3 -m unittest discover -s deploy/tests` |

## Construire l'artefact

Depuis un clone à jour de `main`, dépendances installées (`pnpm install --frozen-lockfile`) :

```bash
deploy/build-artifact.sh            # → deploy/out/omniroute-native-<sha7>.tar.gz (+ .sha256, .manifest.txt)
# Si pnpm n'est pas dans le PATH global :
env PNPM="npx --yes pnpm" deploy/build-artifact.sh
```

Le script affiche deux empreintes. Pour vérifier que l'artefact déployé correspond au
commit testé en CI, comparer `CONTENT_SHA256`, l'empreinte du contenu, à celle de l'étape
« Construire l'artefact autonome » du job `artifact`. Elle ne dépend pas des versions de
tar et de gzip ; `omniroute_native_deploy.py` la recalcule depuis l'archive et l'affiche.

Le `SHA256` de l'archive, lui, est stable sur un même poste mais varie d'un environnement
à l'autre. Mesure au commit 7939149 : contenu `a9d3020d…` identique en CI et en local,
archives différentes.

## Essai à blanc (défaut, aucune écriture en production)

```bash
python3 deploy/omniroute_native_deploy.py --artifact deploy/out/omniroute-native-<sha7>.tar.gz
```

Le script lit le registre, compte les runs actifs (`heartbeat_runs` en `running`, `queued`
ou `starting`, base ouverte en lecture seule), puis installe une **copie** sous
`/tmp/omniroute-native-dryrun-*` dans le conteneur (version, `current`, registre). Il la
charge avec le vrai chargeur du serveur, interroge le catalogue de modèles (GET), et
supprime la copie. Il affiche enfin le plan de `--apply` et indique si la bascule est
possible tout de suite.

## Installation et mise à jour

```bash
python3 deploy/omniroute_native_deploy.py --apply \
  --artifact deploy/out/omniroute-native-<sha7>.tar.gz --report deploy/out/apply-<date>.json
```

Ordre d'exécution, avec arrêt au premier échec :

1. Contrôles : essai à blanc réussi, 0 run actif, `/api/health` à 200, artefact sans
   modification non commitée (sinon `--allow-dirty`).
2. Sauvegarde sur l'hôte distant, `/var/backups/paperclip/`, contenant :
   - `omniroute-native-pre-deploy-<stamp>.tar.gz` : registre, paquet en service, `current` ;
   - `adapter-plugins.json.<stamp>` ;
   - `omniroute-native-lot14-<stamp>.state.json` : état précédent et empreintes SHA-256.
   Le script vérifie l'empreinte du registre sauvegardé avant d'aller plus loin.
3. Copie de la version dans `releases/<stamp>-<sha7>.partial`, puis `mv` vers son nom
   définitif, puis `verify-artifact` sur la copie installée.
4. Bascule de `current` : nouveau lien, puis `mv -T`, opération atomique.
5. Registre réécrit seulement s'il ne pointe pas déjà sur `current`. Il est écrit dans un
   fichier temporaire, validé comme JSON, puis renommé (`rename`), et seulement si son
   empreinte n'a pas changé depuis la lecture.
6. `docker restart paperclip`, puis attente de `/api/health` à 200.
7. Contrôles après :
   - les journaux du serveur depuis le redémarrage doivent montrer `Loading external
     adapter package` depuis `…/current` et `Loaded external adapters [omniroute_native]`,
     sans `Failed to dynamically load` ;
   - la sonde du vrai chargeur (registre réel, lecture seule) doit trouver
     `omniroute_native`, et non `process`, avec tous ses modules dans la nouvelle version ;
   - le catalogue doit être servi.
   Si un contrôle échoue, le retour arrière est **automatique** (sauf
   `--no-auto-rollback`). Il l'est aussi pour toute erreur survenue après la bascule de
   `current` (étapes 4 à 7) : écriture du registre refusée, redémarrage en échec,
   `/api/health` ≠ 200 après 180 s.

Une mise à jour suit la même commande avec un nouvel artefact : seuls `releases/` et
`current` changent.

Hôte cible : `--host` (SSH), `--container`, `--host-home` (le `PAPERCLIP_HOME` du
conteneur vu depuis l'hôte) et `--backup-root`, ou les variables `PAPERCLIP_SSH_HOST`,
`PAPERCLIP_CONTAINER`, `PAPERCLIP_HOST_HOME` et `PAPERCLIP_BACKUP_ROOT`. Exemple pour une
seconde instance :

```bash
python3 deploy/omniroute_native_deploy.py --apply --hot --host root@<hôte> \
  --container paperclip-ac --host-home <appdata>/paperclip-ac --backup-root <sauvegardes> \
  --artifact deploy/out/omniroute-native-<sha7>.tar.gz --report deploy/out/hot-<date>.json
```

Rétention : les anciennes versions restent dans `releases/`. On les supprime à la main,
jamais celle pointée par `current`, ni celle que vise le registre.

## Mise à jour à chaud, sans redémarrage (exception)

À réserver au cas où le redémarrage n'est pas acceptable (runs d'autres adaptateurs en
cours, par exemple). Cette procédure a été appliquée pour la 1.3.1 (ACC-3037).

**Ne pas faire** : basculer `current`, puis `POST /api/adapters/omniroute_native/reload`.
La route répond avec la nouvelle version, lue dans le `package.json` sur le disque, mais
le serveur continue d'exécuter l'ancien code. Le `?t=` du réimport ne change que l'URL
du module d'entrée. Le chemin réel résolu pour le lien et les sous-modules
(`dist/server/test.js`, `dist/shared/config.js`…) restent en cache. Voir « Pourquoi un
redémarrage » plus bas.

**Faire** : installer le chemin **versionné** de la nouvelle version, jamais `current`.
C'est ce que fait `--apply --hot` (et `--rollback --hot`) :

```bash
python3 deploy/omniroute_native_deploy.py --dry-run --hot --artifact <…>.tar.gz   # plan, blocages
python3 deploy/omniroute_native_deploy.py --apply --hot --artifact <…>.tar.gz \
  [--admin-token-file <fichier>] \
  --served-company <société> [--served-agent <agent>] [--expect-served <révision>] \
  --report deploy/out/hot-<date>.json
python3 deploy/omniroute_native_deploy.py --rollback --hot          # version précédente, à chaud
```

- Seuls les runs `omniroute_native` doivent être terminés ; ceux des autres adaptateurs
  continuent.
- Le jeton d'administrateur d'instance est lu dans `--admin-token-file` et transmis à
  `curl` par l'entrée standard, jamais en argument ni dans le compte rendu. Sans jeton,
  la route n'est acceptée qu'en accès local implicite.
- Contrôles après l'install : type et version annoncés, registre sur le chemin
  versionné, `GET /api/adapters/omniroute_native`, sonde du vrai chargeur sur le
  registre réel. En cas d'échec, `current` reprend sa cible et la version précédente
  est réinstallée à chaud.
- La version annoncée est lue sur le disque : elle ne prouve pas le code servi. Avec
  `--served-company`, le script appelle aussi
  `POST /api/companies/<société>/adapters/omniroute_native/test-environment`, qui
  exécute le code réellement chargé (avec l'`adapterConfig` de `--served-agent` s'il
  est donné). `--expect-served` exige la révision exacte dans la preuve loadedCode de la
  réponse (étape 3 ci-dessous) ; sinon, retour arrière. Sans `--served-company`, le
  compte rendu porte « code servi non vérifié ».
- Install refusé en 401/403 (jeton absent ou non administrateur) : le serveur n'a rien
  chargé ni réécrit. Le script remet seulement `current` sur sa cible, sans retour
  arrière à chaud (il serait refusé de même), et le message indique `--admin-token-file`.
- `--check` accepte un registre qui vise `current` ou la version vers laquelle pointe
  `current`.

Étapes équivalentes à la main :

1. Copier et vérifier la version, comme aux étapes 2 et 3 de `--apply` : sauvegarde du
   registre, extraction dans `releases/<stamp>-<sha7>`, puis
   `node deploy/verify-artifact.mjs --lock pnpm-lock.yaml <dossier>`, qui doit renvoyer 0.
   Basculer `current` sur ce dossier pour le prochain redémarrage.
2. Compte administrateur d'instance. Le jeton passe par l'entrée standard (`-H @-`),
   jamais en argument :
   ```bash
   printf 'Authorization: Bearer %s\n' "$(cat <fichier-jeton>)" |
     curl -s -X POST -H @- -H 'Content-Type: application/json' \
     -d '{"packageName":"/paperclip/adapter-plugins/omniroute-native/releases/<stamp>-<sha7>","isLocalPath":true}' \
     "$PAPERCLIP_API_BASE/api/adapters/install"
   ```
   Une réponse 401 ou 403 signifie que le jeton manque ou n'est pas celui d'un
   administrateur d'instance : rien n'a été chargé.
   Le chemin est nouveau : toutes les URL de modules sont donc nouvelles et le code est
   chargé depuis le disque. La route réenregistre l'adaptateur immédiatement.
   `requiresRestart: true` dans la réponse n'est qu'indicatif.
3. **Validation du code servi bloquée avec l'API actuelle.** Un texte commun tel que
   `Source : env(agent):ANTHROPIC_API_KEY` ne prouve aucune révision. `--expect-served`
   désigne désormais une révision exacte, jamais une sous-chaîne de diagnostic.
   `--served-company` exige une attestation `loadedCode` dans test-environment :
   `revision`, `moduleRoots` (racine versionnée attendue unique), `moduleFiles`
   (liste non vide de chemins réels normalisés sous cette racine).
   Petit contrat serveur nécessaire : capturer ces valeurs à l'import effectif des
   modules de l'adaptateur dans le processus vivant, les lier à l'instance appelée,
   et conserver la révision issue du build chargé. Ne pas relire package.json,
   BUILD-INFO ou le registre sur disque au moment du contrôle. Une sonde Node neuve
   ne prouve que le prochain chargement, jamais la RAM du serveur actuel.
   Ce contrat n'est PAS implémenté ici : l'API actuelle est refusée, sans succès
   cosmétique. Sans `--served-company`, le résultat reste explicitement non vérifié,
   et ne constitue pas une recette du code servi.
   `status: fail` ou inconnu bloque ; `warn` est consigné comme avertissement.
   Un rollback refusé en 401/403 restaure `current` à son état avant tentative :
   registre et RAM restent inchangés. Aucun retour à l'ancienne version au prochain
   boot n'est promis. Si la restauration échoue, le rapport conserve l'erreur initiale
   et signale une divergence ; une intervention est requise.
   Les blancs en début et fin du fichier du jeton (dont LF/CR final) sont retirés ;
   tout caractère de contrôle restant à l'intérieur du jeton est refusé.

4. Au prochain redémarrage planifié, `--apply` (étape 5) réécrit le registre pour qu'il
   vise de nouveau `current`.

Limites :
- `install` écrit le registre sans renommage atomique. D'où la sauvegarde de l'étape 1.
- Un chemin déjà chargé une fois dans ce processus est resservi depuis le cache. Une
  version reconstruite à la même place ne peut donc pas être chargée à chaud. Il faut
  toujours un nouveau dossier `releases/<stamp>-<sha7>`.
- Retour arrière à chaud : `install` sur le dossier de la version précédente. Ce dossier
  a déjà été chargé, et donc resservi depuis le cache, ce qui convient pour un retour à
  l'identique. Si un doute subsiste, redémarrer avec `--rollback`.

## Retour arrière

```bash
python3 deploy/omniroute_native_deploy.py --rollback                     # dernier état sauvegardé
python3 deploy/omniroute_native_deploy.py --rollback --state omniroute-native-lot14-<stamp>.state.json
```

1. Le registre courant est mis de côté (`adapter-plugins.json.<stamp>.before-rollback`).
2. Le registre sauvegardé est restauré, après contrôle de son empreinte, par fichier
   temporaire puis `rename`.
3. `current` reprend sa cible précédente.
4. Si l'ancien dossier du paquet a disparu, il est réextrait de l'archive.
5. Le serveur redémarre et les mêmes contrôles sont rejoués.

Le retour arrière refuse de s'exécuter si des runs sont actifs (`--ignore-active-runs`
pour forcer).

Retour vers l'ancienne installation `agency-starter` : il ne fonctionne que si son
`node_modules` existe encore. L'archive conserve le lien, pas le dépôt pnpm de 984 Mo.

### Retour arrière testé à blanc

- Tests `deploy/tests/test_deploy.py` (`ApplyRollbackTests`) : `apply()` puis
  `rollback()` de bout en bout sur un faux `Remote` (racines `ct_home`, `host_home`,
  `backup_root` dans un dossier jetable ; redémarrage, journaux, santé et sonde bouchonnés ;
  toute commande visant `/paperclip`, `/mnt`, `/app` ou `docker` fait échouer le test).
  Cas couverts : première bascule depuis agency-starter (ancien paquet supprimé puis
  restauré depuis l'archive), deuxième bascule r1 → r2 → retour = r1, retour vers un état
  choisi, retour automatique sur erreur d'écriture du registre ou API non saine.
- Bac à sable avec le **vrai** chargeur, dans le conteneur, sans toucher la production :

  ```bash
  # préparer /tmp/<dossier>/home/adapter-plugins.json (+ l'installation qu'il référence)
  python3 deploy/omniroute_native_deploy.py --apply --sandbox /tmp/<dossier> --artifact <r1>.tar.gz
  python3 deploy/omniroute_native_deploy.py --apply --sandbox /tmp/<dossier> --artifact <r2>.tar.gz
  python3 deploy/omniroute_native_deploy.py --rollback --sandbox /tmp/<dossier>
  ```

  `PAPERCLIP_HOME` et les sauvegardes sont sous `/tmp/<dossier>`. Le « redémarrage » est
  un processus Node neuf qui importe le chargeur du serveur sur le registre du bac à sable
  (`real-loader-probe.mjs`) ; aucun `docker restart`, aucune écriture hors `/tmp/<dossier>`
  (les commandes visant `/paperclip`, `/mnt` ou `docker restart` sont refusées). Supprimer
  le dossier ensuite.

## Paperclip retombe sur `process` : que faire

Symptômes :
- un run d'agent `omniroute_native` échoue avec une erreur de commande manquante ;
- `docker logs paperclip` contient `Failed to dynamically load external adapter; skipping` ;
- `Loaded external adapters` ne cite pas `omniroute_native`.

1. Diagnostic, en lecture seule :
   ```bash
   python3 deploy/omniroute_native_deploy.py --check
   ```
   Le script relit les journaux depuis le démarrage du conteneur et charge le registre réel
   avec le vrai chargeur dans un processus séparé. Il indique le chemin, le type obtenu
   (`process` ou `omniroute_native`) et le catalogue. Il peut tourner en tâche planifiée :
   code 1 en cas d'échec.
2. Si `current` ou sa version a disparu ou est abîmée : `--rollback`, ou `--apply` avec
   l'artefact du commit voulu.
3. Si le registre ne contient plus l'entrée (par exemple après une désinstallation depuis
   l'interface) : `--apply` la recrée.

## Pourquoi un redémarrage et pas la route de rechargement

`POST /api/adapters/:type/reload` existe (`server/src/routes/adapters.ts:599`), mais elle
ne convient pas ici, pour trois raisons mesurées dans le code et à blanc :

- **Registre en cache.** Le serveur garde le registre en mémoire
  (`adapter-plugin-store.ts`, `storeCache`). Après réécriture du fichier, la route
  rechargerait l'ancien chemin, puis réécrirait le fichier avec l'ancien enregistrement
  (`addAdapterPlugin`).
- **Ancienne version réimportée.** Même avec un registre inchangé (`…/current`), un
  rechargement après bascule de `current` réimporte l'ancienne version, car le résolveur
  ESM de Node garde en cache le chemin réel du lien (essai à blanc, scénario S5).
- **Droits.** La route exige un compte administrateur d'instance (`assertInstanceAdmin`).

`POST /api/adapters/install` (chemin local) écrit le registre sans renommage atomique et
répond `requiresRestart: true` lors d'une réinstallation. Il n'est donc pas utilisé par
`--apply`. Il sert seulement pour la mise à jour à chaud décrite plus haut, sur un chemin
versionné jamais chargé auparavant.

Correctif possible côté serveur (amont, hors de ce dépôt) : dans `reloadExternalAdapter`,
importer depuis `fs.realpathSync(packageDir)` plutôt que depuis `packageDir`. Après une
bascule de `current`, l'entrée et tous ses sous-modules auraient alors de nouvelles URL,
et `reload` sur `current` suffirait.

Le redémarrage interrompt tous les adaptateurs. C'est pour cela que le script refuse de
s'exécuter tant qu'un run est actif.

## Limites connues

- La CI construit et recharge l'artefact avec une copie conforme des étapes du chargeur
  (`verify-artifact.mjs`). Elle ne peut pas exécuter le vrai chargeur : l'image
  personnalisée de Paperclip est privée et n'est disponible dans aucun registre public
  accessible au runner. Le vrai chargeur ne s'exécute que pendant l'essai à blanc, dans le
  conteneur.
- `@paperclipai/adapter-utils` reste en `2026.916.1` (celle du lockfile), alors que le
  serveur embarque la `0.3.1`. Cet écart est à traiter dans un autre lot.
