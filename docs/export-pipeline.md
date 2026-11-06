# Processus d'export et synchronisation Gitea → GitHub

Ce document décrit le protocole d'exportation des modifications depuis le dépôt interne Gitea (`ac-dev-bot/ac-paperclip-adapters`) vers le dépôt public GitHub (`AC-CREATION-AI/paperclip-adapter-omniroute`).

---

## 1. Principes et Sécurité (Décision D284)

Le dépôt public GitHub est sous licence MIT et ouvert aux contributions. Aucun secret, identifiant interne ou donnée d'infrastructure privée ne doit être publié.

**Interdictions formelles :**
- Aucune adresse IP privée de réseau local (hors adresses de boucle locale).
- Aucun chemin de système de fichiers interne (répertoires privés ou montages de stockage).
- Aucun jeton d'instance Paperclip ni secret (fichiers d’authentification, clés API, mots de passe).
- Aucun nom de domaine d'infrastructure privée (domaine privé personnel ou client).
- Aucun identifiant ou nom de client interne.

---

## 2. Étapes du processus d'export

### Étape 1 : Préparation et extraction de la branche
Extraire la branche de travail ou le commit depuis la source interne vers un répertoire de travail isolé.

### Étape 2 : Nettoyage automatique et assainissement
Appliquer les règles d'assainissement :
1. Remplacer toute IP LAN par `http://localhost:20128` ou `127.0.0.1`.
2. Remplacer les chemins internes et les montages de stockage par des chemins génériques (`~/.paperclip/token`, `/var/lib/paperclip`, etc.) ou des variables d'environnement (`PAPERCLIP_HOST_HOME`, `PAPERCLIP_BACKUP_ROOT`).
3. Remplacer les UUIDs réels de sociétés, projets, objectifs ou agents par des identifiants d'exemple synthétiques (`00000000-0000-0000-0000-000000000001`, `TASK-1001`).
4. Vérifier que la configuration d'exemple (`bench/config.json`) ne contient que des valeurs génériques.

### Étape 3 : Exécution du contrôle anti-fuite
Exécuter le script de validation anti-fuite :

```bash
bash scripts/check-anti-leak.sh
```

Le script scanne tous les fichiers suivis, y compris ses propres sources et les binaires, sans exclusion de fichier ni de dossier. Les charges synthétiques des tests sont assemblées à l’exécution : aucune exception permanente pour les fixtures. Les noms des fichiers et lignes sont signalés, jamais le contenu potentiellement sensible. Il doit renvoyer 0 ; un échec Git ou de lecture doit échouer fermé. Ce garde à motifs connus ne remplace pas la revue humaine ni un détecteur de secrets génériques.

```bash
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

### Étape 4 : Licences et validation locale complète

Avant chaque export, inventorier les vrais tarballs des dépendances verrouillées (SHA-512 du lockfile = registre = octets), y compris les paquets embarqués dans `adapter-utils`. Reprendre leurs textes LICENSE/NOTICE en entier dans `THIRD_PARTY_NOTICES.md` à la racine et dans le paquet, sans inventer de copyright. Les sources immuables et empreintes originales sont consignées dans `third-party-inventory.json`. Un manifeste de sous-chemin n’est pas un nouveau paquet. Si un tarball omet sa licence, reprendre la licence du dépôt amont au commit de provenance, en documentant ce recours. Vérifier le NOTICE de `bare-path`, les avis tiers imbriqués et les licences effectivement incluses dans l’archive finale ; ne pas confondre licence déclarée et textes redistribués.

Les tests Python du garde vérifient aussi les empreintes des textes et l’identité des deux notices. Conserver les espaces des textes tiers intacts (ils peuvent déclencher `git diff --check`). Aucun nouveau tag ni réécriture d’historique pendant cet export.
Vérifier l'intégralité des tests avant tout envoi distant :

```bash
# Vérifications TypeScript et Node
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm run build
pnpm run test
pnpm --filter @agence/omniroute-native run verify

# Suites de banc et de déploiement hors ligne
python3 -m unittest discover -s bench -q
python3 -m unittest discover -s deploy/tests -q
```

### Étape 5 : Publication et revue
1. Pousser la branche de travail nettoyée sur le dépôt public GitHub.
2. Ouvrir une Pull Request avec la description détaillée et la preuve des tests.
3. Attendre la validation de la CI GitHub Actions (qui exécute automatiquement `scripts/check-anti-leak.sh` et les suites de tests).
4. Soumettre à la revue (`qa_reviewer`) avant toute fusion dans `main`.
