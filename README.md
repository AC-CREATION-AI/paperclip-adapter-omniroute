# Paperclip OmniRoute Native Adapter (`omniroute_native`)

[![CI](https://github.com/AC-CREATION-AI/paperclip-adapter-omniroute/actions/workflows/ci.yml/badge.svg)](https://github.com/AC-CREATION-AI/paperclip-adapter-omniroute/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![AI Agent Friendly](https://img.shields.io/badge/AI%20Agent-Friendly%20(AGENTS.md)-blueviolet.svg)](./AGENTS.md)

**Native in-process adapter connecting [Paperclip](https://github.com/paperclipai/paperclip) autonomous agents to self-hosted [OmniRoute](https://github.com/diegosouzapw/OmniRoute) LLM gateways.**

*Adaptateur natif en processus pour connecter les agents autonomes Paperclip à la passerelle LLM auto-hébergée OmniRoute.*

---

## Highlights / Points Forts

- **No CLI Binaries Needed**: Runs directly inside Paperclip's Node.js server process. Zero external CLI daemon (`claude`, `codex`, `opencode`) to install inside the container.
- **Pure Streaming Chat Completions**: Direct SSE communication over `/v1/chat/completions` with streaming token usage and keepalive watchdog protection.
- **Prompt Cache Optimization (>92%)**: Preserves client `cache_control` breakpoints via `sdk-cli` recognition and automatic turn-by-turn checkpointing.
- **Real-Time Rate Card Billing**: Dynamically calculates and reports estimated run costs in USD via OmniRoute's model pricing rate cards (`costStatus: 'estimated'`, `rate_card`).
- **Subtask Delegation (`subtask`)**: Lightweight read-only delegation to fast/free models (e.g. `AC-task` or local models) without full agent re-spawning.
- **Objective Escalation**: Resumes failed runs automatically with full conversation history on stronger models (`escalationModel` / `escalationModel2`) upon verifiable failures.
- **Paperclip Plugin Tools**: Tools registered by installed Paperclip plugins (e.g. Hindsight memory: `hindsight_recall`, `hindsight_retain`) are discovered once per run via `GET /api/plugins/tools` with the agent's run key and dispatched through `POST /api/plugins/tools/execute` (`pluginTools`, on by default).
- **Strict Confinement & Security**: Built-in workspace path containment (rejects dangling symlinks and directory traversal) and automatic secret redaction.

---

## Quickstart / Démarrage Rapide

Prérequis : **Node.js >=22.15** et **pnpm 9.12.0** (Python >=3.10 pour les tests hors ligne). L’adaptateur tourne dans le Node fourni par Paperclip ; la CI vérifie Node 22 et 24. Le badge CI ci-dessus est dynamique, sans compteur de tests figé.

### 1. Cloner et compiler l'adaptateur

```bash
git clone https://github.com/AC-CREATION-AI/paperclip-adapter-omniroute.git
cd paperclip-adapter-omniroute
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
```

### 2. Installation dans Paperclip

L'adaptateur peut être installé selon deux méthodes :

**Via l'API Paperclip (`POST /api/adapters/install`) :**
```json
{
  "packageName": "/chemin/absolu/vers/packages/adapters/omniroute-native",
  "isLocalPath": true
}
```

**Ou via le registre `/paperclip/adapter-plugins.json` sur l'hôte :**
```json
[
  {
    "packageName": "/paperclip/adapter-plugins/omniroute-native/current",
    "localPath": "/paperclip/adapter-plugins/omniroute-native/current",
    "version": "1.3.1",
    "type": "omniroute_native"
  }
]
```

### Configuration de l'Agent

| Clé | Type | Défaut | Description |
|---|---|---|---|
| `baseUrl` | `text` | `http://localhost:20128` | Racine de la passerelle OmniRoute (sans `/v1`). |
| `apiKey` | `text` (secret) | — | Clé Bearer d'authentification OmniRoute. |
| `model` | `combobox` | `auto/best-coding` | Combo personnel (`AC-*`) ou combo automatique (`auto/*`). |
| `fallbackModel` | `combobox` | `aucun` | Modèle de repli en cas d'indisponibilité amont. |
| `subtaskModel` | `combobox` | `aucun` | Modèle rapide (ex. `AC-task`) pour l'outil de sous-tâche `subtask`. |
| `escalationModel` | `combobox` | `aucun` | Modèle de reprise supérieur en cas d'échec réel de la tâche. |
| `maxTurns` | `number` | `0` (illimité) | Plafond de tours modèle ↔ outils (borné par le délai global). |
| `pluginTools` | `select` | `true` | Expose les outils des plugins Paperclip (nom court s'il est libre, sinon `plugin_<plugin>__<outil>`) ; `false` les coupe. Un run sans projet n'en reçoit aucun. |

---

## 🤖 Instructions pour les Agents IA / LLMs

Ce projet est conçu pour être développé, audité et enrichi de manière autonome par des agents de codage (Claude Code, Cursor, Codex, OpenCode, Hermes, Aider).

Consultez **[AGENTS.md](./AGENTS.md)** pour :
- Les commandes exactes de compilation et de test (`pnpm run typecheck`, `pnpm run test`).
- Les règles strictes de sécurité et de confinement.
- Le protocole de validation et les invariants à préserver.

---

## 🗺️ Feuille de Route / Roadmap

Consultez **[ROADMAP.md](./ROADMAP.md)** pour le suivi des jalons :
- **v1.0** : Moteur natif complet, outils de code, prompt caching, coût réel *(Livré)*.
- **v1.1** : Connecteurs MCP (`ctx.runtimeMcp`) — inclus dans v1.3.0.
- **v1.2** : Cartes décisionnelles (`paperclip_ask_user`, `paperclip_request_confirmation`) — incluses dans v1.3.0.
- **v1.3** : Prompt système invariant et fenêtre de contexte dynamique — inclus dans v1.3.0.
- **v1.4** : Sous-tâches locales gratuites DGX Sparks et soumission upstream à `paperclipai/paperclip`.

---

## Licence

Ce projet est sous licence [MIT](./LICENSE) — Copyright (c) 2026 Alexandre Jacq, AC-Création.
