# Guide de Contribution

Merci de contribuer au projet `paperclip-adapter-omniroute` !

Ce projet accueille chaleureusement les contributions des développeurs humains ainsi que des **assistants et agents IA de codage** (Claude Code, Cursor, Codex, OpenCode, Hermes, Aider).

---

## Prérequis d'environnement

- **Node.js** : `>=22.15` (CI Node 22 et 24 ; l’adaptateur tourne dans le Node fourni par Paperclip)
- **pnpm** : `9.12.0`
- **Python 3** : `>=3.10` pour les suites de banc et de déploiement hors ligne

---

## Règles d'or

1. **Règle Rouge → Vert (TDD)** : Tout ajout de fonctionnalité ou correction de bug doit être accompagné d'un test automatisé dans `test/` qui prouve le problème avant la correction et valide le comportement attendu après.
2. **Qualité stricte** :
   - `pnpm install --frozen-lockfile --ignore-scripts` pour l'installation initiale propre.
   - `pnpm run typecheck` doit renvoyer 0 erreur TypeScript.
   - `pnpm run build` doit réussir.
   - `pnpm run test` doit passer à 100 %.
   - `pnpm --filter @agence/omniroute-native run verify` doit valider les invariants de chargement et le parseur UI.
   - `python3 -m unittest discover -s bench -q` et `python3 -m unittest discover -s deploy/tests -q` doivent passer.
3. **Sécurité d'abord** :
   - Aucun secret, mot de passe, token ou clé d'API ne doit être stocké en clair ou transmis dans les journaux/transcripts.
   - Les outils de fichiers doivent respecter rigoureusement le confinement au workspace et refuser tout chemin traversant (`..`) ou lien symbolique vers l'extérieur.
   - Le shell local n'est pas une sandbox OS : toute exécution de tests ou d'agent doit se faire dans un environnement jetable et isolé.
4. **Gouvernance et revue** :
   - Toute modification fait l'objet d'une Pull Request avec preuve de tests réels attachée dans la description.
   - Revue humaine obligatoire par un mainteneur avant toute fusion.
   - Aucun déploiement en production n'est effectué directement depuis une PR publique.

---

## Protocole de Pull Request

1. Créez une branche nommée explicitement :
   - `feat/<nom-de-fonctionnalite>` pour un ajout.
   - `fix/<nom-du-bug>` pour un correctif.
2. Écrivez des messages de commit clairs au format Conventional Commits :
   - `feat(omniroute-native): ...`
   - `fix(omniroute-native): ...`
   - `test(omniroute-native): ...`
3. Ouvrez une Pull Request sur GitHub. La CI GitHub Actions valide automatiquement les types, la compilation, la suite de tests et les contrôles anti-fuite.

---

## Signalement de vulnérabilité

Pour tout problème de sécurité ou vulnérabilité suspectée, merci de **ne pas ouvrir d'issue publique**. Utilisez les [Security Advisories privés de GitHub](https://github.com/AC-CREATION-AI/paperclip-adapter-omniroute/security/advisories) pour un échange confidentiel.

---

Consultez [AGENTS.md](./AGENTS.md) pour les consignes techniques détaillées.
