# Instructions pour les Agents IA (AGENTS.md)

Ce document est destiné aux modèles et agents de codage (Claude Code, Cursor, Codex, OpenCode, Hermes, Aider) qui interviennent sur ce dépôt. Il définit l'architecture, les commandes de vérification, les garde-fous stricts et la méthode de travail attendue.

---

## 1. Vue d'ensemble du projet

Ce dépôt contient l'adaptateur natif **`omniroute_native`** (paquet `@agence/omniroute-native`) pour la plateforme d'agents d'entreprise **Paperclip** ([paperclipai/paperclip](https://github.com/paperclipai/paperclip)).

### Rôle de l'adaptateur
Contrairement aux adaptateurs CLI comme `claude_local` qui lancent un sous-processus binaire externe, `omniroute_native` :
- **Tourne directement dans le processus Node.js de Paperclip** (aucun CLI externe requis dans le conteneur).
- Parle à la passerelle LLM auto-hébergée **OmniRoute** via l'API OpenAI Chat Completions en streaming (`POST /v1/chat/completions`, SSE avec `stream_options.include_usage`).
- Exécute la boucle d'outils (modèle ↔ outils de workspace et d'API Paperclip) de manière autonome.
- Supporte le routage par **combos personnels (`AC-*`)** et génériques (**`auto/*`**).
- Implémente la sous-délégation (`subtask` sur modèle rapide/local) et l'escalade automatique de modèle en cas d'échec objectif.
- Gère l'estimation des coûts via le barème officiel OmniRoute (`rate_card`).

---

## 2. Commandes de développement et vérification

Prérequis : **Node.js >=22.15**, **pnpm 9.12.0**, **Python >=3.10**, Git et les utilitaires POSIX (bash, tar, sha256sum). L’adaptateur tourne dans le Node fourni par Paperclip. Le projet est un monorepo pnpm ; lancer les commandes suivantes depuis la racine d’un clone propre.

```bash
# 1. Installation des dépendances (ignorer les scripts tiers au premier abord)
pnpm install --frozen-lockfile --ignore-scripts

# 2. Vérification statique des types TypeScript (0 erreur tolérée)
pnpm run typecheck

# 3. Compilation TypeScript vers dist/
pnpm run build

# 4. Exécution de la suite complète de tests Vitest
pnpm run test

# 5. Vérification des invariants de paquet et de contrat UI Paperclip
pnpm --filter @agence/omniroute-native run verify

# 6. Suites de banc et déploiement hors ligne (Python 3)
python3 -m unittest discover -s bench -q
python3 -m unittest discover -s deploy/tests -q

# 7. Contrôle des résidus, régressions du garde et licences tierces
bash scripts/check-anti-leak.sh
python3 -m unittest discover -s scripts -p 'test_*.py' -v
```

> **Règle absolue pour tout agent IA** : aucune modification ne doit être proposée ou soumise sans que `typecheck`, `build`, `test` et les scripts de vérification ne soient passés avec un code de sortie 0.

---

## 3. Architecture du code source

Tous les fichiers sources vivent sous `packages/adapters/omniroute-native/src/` :

| Fichier | Responsabilité |
|---|---|
| `index.ts` | Point d'entrée de déclaration (`type`, `models`, `agentConfigurationDoc`). |
| `server/index.ts` | Point d'entrée serveur chargé par Paperclip (`createServerAdapter()`). |
| `server/execute.ts` | Exécution d'un run d'agent, préparation du prompt et synthèse finale. |
| `server/agent-loop.ts` | Boucle multi-tours modèle ↔ outils, surveillance de boucle bloquée et reprise d'escalade. |
| `server/tools.ts` | Outils de fichiers et shell (`read_file`, `write_file`, `edit_file`, `grep`, `glob`, `list_dir`, `shell`). |
| `server/paperclip-tools.ts` | Outils natifs Paperclip (`paperclip_get_issue`, `paperclip_update_issue`, `paperclip_add_comment`, etc.). |
| `server/mcp-bridge.ts` | Intégration de la passerelle MCP (`ctx.runtimeMcp`) avec outils virtuels et préservation du prompt. |
| `server/plugin-tools.ts` | Outils des plugins Paperclip : découverte par run (`GET /api/plugins/tools`), exécution (`POST /api/plugins/tools/execute`), noms sans collision, délai borné, jeton masqué. |
| `server/decision-cards.ts` | Cartes d'interaction interactive Paperclip (`paperclip_ask_user`, `paperclip_request_confirmation`). |
| `server/subtask.ts` | Moteur de sous-tâche déléguée (lecture seule, modèle rapide ou local). |
| `server/escalation.ts` | Moteur d'escalade progressive vers un modèle supérieur en cas d'échec réel. |
| `server/models.ts` | Découverte et filtrage des combos (`auto/*` et personnalisés), cache disque et mémoire avec TTL. |
| `server/session-store.ts` | Persistance atomique et sécurisée des sessions et verrouillage concurrentiel. |
| `server/session-codec.ts` | Sérialisation et validation des états de session. |
| `shared/client.ts` | Client HTTP/SSE vers OmniRoute, surveillance anti-figeage (`StreamWatchdog`). |
| `shared/chat-completions.ts` | Conversion de fil de messages vers OpenAI, normalisation du cache Paperclip. |
| `shared/context-window.ts` | Gestion dynamique de la fenêtre de contexte selon le modèle résolu et découverte de métadonnées. |
| `shared/context-budget.ts` | Fenêtre du run lue à OmniRoute (`/v1/models/{id}`, modèle et `fallbackModel`, minimum ; repli 200 000), cache 10 min, exposée dans `resultJson.contextWindow`. |
| `shared/pricing.ts` | Barème tarifaire officiel OmniRoute et calcul du coût estimé. |

---

## 4. Garde-fous et Invariants stricts

Tout contributeur IA doit respecter rigoureusement ces invariants :

### A. Sécurité et Confinement du Workspace
- Les outils de fichiers (`read_file`, `write_file`, `edit_file`, etc.) doivent **toujours** passer par `resolveConfinedPath`.
- Tout chemin résolu en dehors du répertoire de travail du run doit lever une `ToolRefusal`.
- **Liens symboliques pendants** : un lien dont la cible n'existe pas ne doit jamais permettre une écriture vers l'extérieur.
- **Masquage des secrets** : toute clé API, jeton, ou mot de passe doit être expurgé (`redactSecrets`) avant d'être persisté dans la session ou renvoyé dans les sorties.
- **Confinement du shell** : le shell local lance `/bin/sh -c` dans le répertoire du workspace et dispose de garde-fous applicatifs (refus de publication distante `git push`, refus des commandes destructrices). **Attention** : ce n'est pas une sandbox OS hermétique. Tout déploiement ou test doit s'effectuer dans un conteneur ou environnement jetable, sans accès à des réseaux internes ni credentials sensibles.

### B. Contrat de Cache OmniRoute
- L'en-tête `User-Agent` doit obligatoirement inclure la sous-chaîne **`sdk-cli`** (condition requise par `isClaudeCodeClient` dans OmniRoute pour préserver les marqueurs `cache_control`).
- Le dernier message d'une conversation (`user` ou `tool_result`) doit porter `cache_control: { type: 'ephemeral' }`.
- L'en-tête `x-omniroute-compression: off` doit être présent pour interdire toute altération de prompt en vol.

### C. Tarification et Provenance
- `calculateModelCostUsd` déduit toujours les écritures cache (`cacheWriteTokens`) de `inputTokens` pour ne pas facturer les écritures au tarif plein du prompt.
- Lorsque le coût est calculé d'après le barème officiel OmniRoute (et non renvoyé par la passerelle), la provenance comptable doit être déclarée :
  ```typescript
  pricingProvenance: {
    source: 'rate_card',
    evidence: 'barème officiel OmniRoute (/v1/models/{id}) appliqué aux compteurs SSE'
  }
  ```
  et `costStatus` doit valoir `'estimated'`. Ne jamais déclarer faussement `provider_reported`.

### D. Outils de plugin Paperclip
- Découverte **une seule fois par run** ; la liste reste stable pendant le run (cache de prompt). Un échec de découverte n'échoue jamais le run : aucun outil de plugin et une ligne de journal.
- **Priorité des noms** : outils de workspace, `paperclip_*`, pont MCP (`mcp_*`), `read_skill`/instructions passent d'abord. Un outil de plugin garde son nom court seulement s'il est libre, unique entre plugins et hors préfixes réservés `paperclip_`/`mcp_` ; sinon `plugin_<plugin>__<outil>` (≤ 64 caractères, stable).
- L'appel envoie `runContext` = `agentId`, `runId`, `companyId`, `projectId` du run (exigés par le serveur) : un run sans `projectId` n'expose aucun outil de plugin.
- Désactivable par agent : `pluginTools: false`.

---

## 5. Méthode pour ajouter une fonctionnalité

1. **Règle Rouge → Vert** : Écrire d'abord un test unitaire sous `test/` qui reproduit le besoin ou le bug et échoue sur le code existant.
2. **Implémentation minimale** : Modifier le code pour faire passer le test sans casser les invariants existants.
3. **Vérification** : Lancer `pnpm run typecheck && pnpm run build && pnpm run test`.
4. **Pas de régression** : La suite de tests doit passer à 100 %.
