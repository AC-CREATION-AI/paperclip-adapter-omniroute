# @agence/omniroute-native

Adaptateur Paperclip pour la passerelle **OmniRoute** auto-hébergée.

OmniRoute expose une API compatible **OpenAI Chat Completions** (`POST /v1/chat/completions`) et
agrège plusieurs modèles derrière des combos `auto/*` et personnalisés. Cet
adaptateur fait tourner un agent Paperclip directement sur cette API — sans CLI
intermédiaire — en streaming SSE avec détection de flux figé et gestion du cache.

## Pourquoi un adaptateur et pas une simple config de base URL

`claude_local` suppose un binaire CLI et une session à reprendre. OmniRoute n'en
a pas : c'est un fournisseur HTTP sans état. Il faut donc porter soi-même :

- la **boucle d'agent** (appel modèle → exécution d'outils → réinjection des
  résultats) ;
- les **outils** exposés au modèle (fichiers dans le workspace, shell) ;
- la **classification des erreurs** de la passerelle, pour que Paperclip
  suspende un run sur un `503` transitoire au lieu de le compter comme un échec
  définitif ;
- le **rendu du transcript** côté UI.

## Installation

Node.js >=22.15 et pnpm 9.12.0 sont requis. L’adaptateur tourne dans le Node fourni par Paperclip.

Le paquet est chargé par le `plugin-loader` de Paperclip, qui exige :

1. `createServerAdapter()` exporté à la racine de `exports["."]` ;
2. un parser UI déclaré sous `exports["./ui-parser"]`, dont le fichier est lu
   **comme du texte source** puis évalué dans un Web Worker verrouillé.

Le parser est donc volontairement un `.cjs` sans aucun `import` : le worker
l'évalue via `new Function(...)` avec `self`, `globalThis`, `fetch` et
`importScripts` neutralisés. Un `export` y serait une erreur de syntaxe, un
`require` y serait irrésoluble. Il ne doit **jamais** lever — une ligne
non reconnue est renvoyée telle quelle plutôt que de vider l'onglet de sortie.

## Configuration

Les clés ci-dessous sont exactement celles de `src/server/config-schema.ts`, qui
alimente le formulaire du board. Un champ renommé d'un côté sans l'être de
l'autre serait un réglage silencieusement inopérant.

| Champ | Défaut | Rôle |
| --- | --- | --- |
| `baseUrl` | `http://localhost:20128` | Racine de la passerelle, sans `/v1`. Repli sur `OMNIROUTE_BASE_URL` puis `ANTHROPIC_BASE_URL`, d’abord dans les variables de l’agent (`env`), puis dans celles du serveur. |
| `apiKey` | — | Clé Bearer HTTP. Repli sur `OMNIROUTE_API_KEY` puis `ANTHROPIC_API_KEY`, d’abord dans les variables de l’agent (`env`, où Paperclip résout les `secret_ref`), puis dans celles du serveur. Une valeur masquée est ignorée. |
| `model` | `auto/best-coding` | Identifiant avec préfixe de fournisseur (`claude/claude-sonnet-5`) ou combo `auto/*`. |
| `fallbackModel` | — | Repli si `model` est introuvable côté passerelle. Vide = échec explicite. |
| `reasoningEffort` | `high` | `reasoning_effort` Chat Completions : none/low/medium/high. `none` = champ omis. Relance sans en cas de refus amont. |
| `cacheControlPoints` | *(vide)* | JSON `cache_control_points` (extension OmniRoute/MiniMax). Vide = champ omis. |
| `maxTokens` | `8192` | Tokens de sortie par tour, bornés au run par le `max_output_tokens` qu'OmniRoute annonce (modèle et repli). |
| `maxContextChars` | — | Seuil d'historique et de troncature intra-run, en caractères. Vide = dérivé de la fenêtre lue à OmniRoute au début du run (`GET /v1/models/{id}` du modèle et de `fallbackModel`, la plus petite ; 200 000 tokens si OmniRoute ne répond pas ou si une fenêtre est inconnue). Fenêtre et source visibles dans le journal et dans `resultJson.contextWindow`. |
| `maxTurns` | `0` | Allers-retours modèle ↔ outils avant arrêt. `0` = illimité (comme `claude_local`) : la boucle s'arrête quand le modèle répond sans outil, ou à `timeoutSec`. |
| `timeoutSec` | `900` | Délai du run. |
| `systemPrompt` | — | Remplace entièrement le prompt système par défaut. |
| `promptTemplate` | — | Remplace le template utilisateur. Placeholders : `{{agent.id}}`, `{{agent.name}}`, `{{run.id}}`. |
| `subtaskModel` | *(vide ou `aucun` = désactivé)* | Modèle rapide (ex. `AC-task`) de l'outil `subtask` : lecture, recherche, résumé délégués, outils en lecture seule, compte rendu compact. |
| `subtaskMaxTurns` | `12` | Tours maximum d'une sous-tâche (plus le tour de synthèse). |
| `subtaskTimeoutSec` | `300` | Délai d'une sous-tâche, borné par le temps restant du run. |
| `escalationModel` | *(vide ou `aucun` = désactivé)* | Menu : modèle plus fort qui reprend une tâche en échec réel (ex. `AC-code`). |
| `escalationModel2` | *(vide ou `aucun`)* | Menu : second modèle, encore plus fort (ex. `AC-pro-coding`), essayé si le premier échoue aussi. |
| `escalationModels` | — | Ancien champ texte (virgules), toujours lu après les deux menus. |
| `maxEscalations` | `2` | Escalades maximum par run (`0` = jamais). |

### Sous-tâches et escalade (lot 20)

**Sous-tâches.** Avec `subtaskModel`, l'agent reçoit l'outil `subtask` `{task, context?}`. Une boucle
enfant tourne sur ce modèle avec un prompt court et les seuls outils de lecture du parent
(`read_file`, `list_dir`, `search`, `grep`, `glob`, `read_skill`, `read_instructions_file`,
`paperclip_get_*`, `paperclip_list_*`) ; pas de `subtask` imbriqué. Bornes : `subtaskMaxTurns` et
min(`subtaskTimeoutSec`, temps restant du run) ; l'annulation du run est propagée. Le compte rendu
est tronqué à 12 000 caractères (signalé). Un échec de l'enfant est une erreur d'outil, le run
continue. Plusieurs `subtask` dans un même tour tournent en parallèle (4 au plus). Tokens et coût
sont ajoutés au run ; détail par sous-tâche dans `resultJson.subtasks`
(`model, servedModel, turns, durationMs, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costUsd, ok`).
Dans le transcript, les étapes de l'enfant sont préfixées `sous-tâche N`.

**Escalade.** Avec `escalationModels`, une tentative qui échoue réellement est reprise, avec tout
l'historique et un court message « la tentative avec X a échoué (motif) : reprends et termine », sur
le modèle suivant de l'échelle (le modèle courant est sauté s'il y figure). Déclencheurs :
`no_final_response` (pas de finale même après le tour de synthèse), `stuck_tool_errors` (3 erreurs
d'outil identiques de suite), `model_error:<code>` (erreur passerelle non récupérée après
`fallbackModel` : refus, contexte dépassé, quota, indisponibilité). Jamais si le run est annulé, s'il
reste moins de 60 s, ou sur `omniroute_auth_rejected`. Trace : avertissement `system` dans le
transcript et `resultJson.escalations: [{from, to, reason, turnsBefore}]`, plus `finalModel`. L'usage
est cumulé sur toutes les tentatives. `fallbackModel` reste le repli de **disponibilité** ;
l'escalade porte sur la **qualité**.

L'authentification utilise le schéma HTTP Bearer. La passerelle **refuse**
`x-api-key` (401) — n'essayez pas de basculer sur ce schéma.

`PAPERCLIP_API_KEY` n'est **jamais** lue depuis la config : le jeton vient
exclusivement de `ctx.authToken`, le JWT de run minté par l'harness. Une valeur
posée en config ne peut donc pas usurper ce rôle.

## Outils exposés au modèle

`read_file`, `write_file`, `list_dir`, `search`, `shell` — tous confinés au
répertoire de travail du run (`context.paperclipWorkspace.cwd`). L'outil `shell`
reçoit l'environnement Paperclip (`PAPERCLIP_API_KEY` compris), sans quoi l'agent
ne pourrait pas mettre à jour son propre ticket. Le JWT est délibérément retiré
du prompt système : il part dans le transcript du modèle, un secret n'y a pas sa
place.

### Outils Paperclip directs (lot 9)

Quand le run a un jeton (`ctx.authToken`) et une URL d'API (`PAPERCLIP_API_URL`),
l'adaptateur expose en plus des outils typés qui parlent à l'API Paperclip en
processus (`fetch`, sans dépendance ajoutée) — l'agent n'a plus à écrire de
requête HTTP à la main dans le shell :

| Outil | Route (relative à `/api`) |
|---|---|
| `paperclip_get_issue` | `GET /issues/:id` + `GET /issues/:id/comments?order=desc&limit=5` + `GET /issues/:id/documents` |
| `paperclip_list_comments` | `GET /issues/:id/comments` (`limit` ≤ 100, `order`, `after`) |
| `paperclip_add_comment` | `POST /issues/:id/comments` |
| `paperclip_update_issue` | `PATCH /issues/:id` (statut, commentaire, priorité, assignation, titre) |
| `paperclip_list_documents` / `paperclip_get_document` | `GET /issues/:id/documents[/:key]` (corps par fenêtres de 10 000 caractères) |
| `paperclip_write_document` | `PUT /issues/:id/documents/:key` (dernière révision reprise si `baseRevisionId` absent) |
| `paperclip_create_subtask` | `POST /companies/:companyId/issues` avec `parentId` = ticket courant |
| `paperclip_list_my_issues` | `GET /companies/:companyId/issues?assigneeAgentId=…&status=…&limit=…` |
| `paperclip_api_request` | toute autre route (GET/POST/PATCH/PUT ; DELETE refusé) |
| `paperclip_deliver` | document (PUT) puis commentaire (POST) ou commentaire + statut (PATCH) |

- `issueId` vaut par défaut le ticket courant (`PAPERCLIP_TASK_ID`).
- Chaque requête porte `Authorization` et `X-Paperclip-Run-Id` (run courant).
- Le jeton n'apparaît jamais dans un résultat ni une erreur (masqué `[REDACTED]`).
- Les réponses sont réduites aux champs utiles et plafonnées à 12 000 caractères,
  avec une mention « tronqué » quand c'est le cas.
- `paperclip_deliver` est séquentiel et s'arrête au premier échec ; son rapport
  liste les étapes `FAIT` et `NON FAIT`. Le lien du document
  (`/<préfixe>/issues/<identifiant>#document-<clé>`) est ajouté au commentaire.
- Quand l'hôte fournit les outils runtime (`ctx.runtimeTools`),
  `connections_search` et `connection_request` sont aussi exposés ; sinon le
  prompt système dit qu'ils ne sont pas disponibles.

## Vérification

```sh
pnpm --filter @agence/omniroute-native typecheck
pnpm --filter @agence/omniroute-native build
pnpm --filter @agence/omniroute-native verify
```

`verify` rejoue les deux chemins de chargement réels :

- `test/load-path.verify.mjs` — réplique `plugin-loader.ts` : résolution de
  `exports["."]`, présence et forme de `createServerAdapter()`, schéma de
  config, modèles déclarés, dégradation de `listModels()` sans passerelle
  joignable, contrat `adapterUiParser`, confinement du parser, absence
  d'import, dépendances runtime ;
- `test/ui-parser.verify.mjs` — réplique `sandboxed-parser-worker.ts` : compile
  et évalue `ui-parser.cjs` en `new Function` avec les globals neutralisés, puis
  vérifie les 17 `TranscriptEntry`, le repli `stdout`, le préfixe `[omniroute]`,
  le JSON malformé, les lignes vides et l'absence d'exception.

Ces deux scripts tournent sur Node seul, sans dépendance de test — ils
fonctionnent donc dans un environnement où `vitest` n'est pas installé.

## Contraintes de packaging

`@paperclipai/adapter-utils` est une dépendance **runtime**, pas seulement de
typage : `dist/server/execute.js` importe `buildPaperclipEnv`,
`buildRuntimeToolsEnv`, `renderTemplate` et `parseObject`, et les appelle
réellement. L'installation depuis un **chemin local** n'exécute aucun
gestionnaire de paquets : le `node_modules` du paquet doit donc déjà contenir
la dépendance (`npm install` dans le répertoire du paquet). Une installation
par **nom de paquet npm**, elle, lance `npm install` dans le répertoire géré.

Aucune autre dépendance runtime tierce n'est utilisée : tout le reste est du
`import type`, effacé à la compilation, ou de la bibliothèque standard Node.

Le `files` de `package.json` doit expédier `dist` **et** le fichier parser —
`test/` n'est pas nécessaire à l'exécution.
