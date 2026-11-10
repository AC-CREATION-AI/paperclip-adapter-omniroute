/**
 * Configuration déclarée à Paperclip : c'est ce qui alimente le formulaire de
 * configuration de l'adaptateur dans le board.
 *
 * Les clés correspondent exactement à ce que lit `shared/config.ts` — un champ
 * renommé ici sans être renommé là-bas donnerait un réglage silencieusement
 * inopérant, ce qui est pire qu'un champ absent.
 */
import type { AdapterConfigSchema } from '@paperclipai/adapter-utils';

import {
  NO_MODEL,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_SUBTASK_MAX_TURNS,
  DEFAULT_SUBTASK_TIMEOUT_SEC,
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  DEFAULT_TIMEOUT_SEC,
} from '../shared/config.js';

export const configSchema: AdapterConfigSchema = {
  fields: [
    {
      key: 'baseUrl',
      label: 'URL de la passerelle OmniRoute',
      type: 'text',
      default: DEFAULT_BASE_URL,
      hint: 'Racine de la passerelle, sans /v1. Repli sur OMNIROUTE_BASE_URL puis ANTHROPIC_BASE_URL.',
      required: true,
      group: 'Passerelle',
    },
    {
      key: 'apiKey',
      label: 'Clé d’API',
      type: 'text',
      hint: 'Envoyée en Authorization: Bearer (OmniRoute rejette x-api-key). Repli sur OMNIROUTE_API_KEY puis ANTHROPIC_API_KEY. Laissez vide pour utiliser la variable d’environnement.',
      group: 'Passerelle',
          // `secret: true` est le marqueur que le serveur lit pour savoir qu'un
          // champ doit être traité comme un secret : il le résout au moment du
          // run, le masque dans l'API, et l'injecte dans l'environnement.
          //
          // Le marqueur précédent était `sensitive: true`, que le serveur ignore.
          // Résultat : la clé n'était jamais résolue, le serveur réinjectait le
          // masque `***REDACTED***` dans la config, et l'adaptateur envoyait ce
          // masque comme une clé — d'où un « auth rejected » alors que la clé
          // d'environnement du conteneur était parfaitement valide.
          //
          // On garde `sensitive` en plus : l'UI Paperclip le consomme pour
          // masquer le champ dans le formulaire.
      meta: { secret: true, sensitive: true },
    },
    {
      key: 'model',
      label: 'Modèle',
      type: 'combobox',
      default: DEFAULT_MODEL,
      hint: 'Combos natifs OmniRoute auto/* et combinaisons personnelles AC-*, chargés depuis la passerelle.',
      required: true,
      group: 'Modèle',
    },
    {
      key: 'fallbackModel',
      label: 'Modèle de repli',
      type: 'combobox',
      hint: 'Utilisé si le modèle principal est introuvable côté passerelle. « aucun » = échec explicite.',
      group: 'Modèle',
    },
    {
      key: 'parallelToolCalls',
      label: 'Appels d’outils parallèles (parallel_tool_calls)',
      type: 'select',
      default: 'true',
      options: [
        { value: 'true', label: 'true — outils exécutés en lot (défaut)' },
        { value: 'false', label: 'false — un seul outil à la fois (séquentiel)' },
      ],
      hint: 'Désactiver pour forcer le modèle à émettre un seul outil par tour (prévient les conflits d’édition concurrente).',
      group: 'Modèle',
    },
    {
      key: 'reasoningEffort',
      label: 'Effort de raisonnement (reasoning_effort)',
      type: 'select',
      default: DEFAULT_REASONING_EFFORT,
      options: [
        { value: 'none', label: 'none — désactivé' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
      ],
      hint: 'Transmis tel quel en `reasoning_effort` sur /v1/chat/completions. `none` = champ omis. Si l’amont refuse, l’adaptateur réessaie une fois sans.',
      group: 'Modèle',
    },
    {
      key: 'cacheControlPoints',
      label: 'Points de cache (cache_control_points)',
      type: 'textarea',
      hint: 'JSON tableau d’extensions OmniRoute/MiniMax, ex. [{"type":"prefix","marker":"### Contexte"}]. Vide = champ omis. Passé tel quel dans le corps Chat Completions.',
      group: 'Modèle',
    },
    {
      key: 'maxContextChars',
      label: 'Budget de contexte (caractères)',
      type: 'number',
      hint: 'Taille maximale en caractères de l’historique transmis au modèle. Laisser vide : dimensionné d’après la fenêtre lue à OmniRoute au début du run (modèle et repli, la plus petite ; 200 000 tokens si inconnue).',
      group: 'Modèle',
    },
    {
      key: 'maxTokens',
      label: 'Tokens de sortie par tour',
      type: 'number',
      default: DEFAULT_MAX_TOKENS,
      hint: 'Borné au run par le max_output_tokens qu’OmniRoute annonce pour le modèle et son repli.',
      group: 'Modèle',
    },
    {
      key: 'maxTurns',
      label: 'Tours modèle ↔ outils maximum',
      type: 'number',
      default: 0,
      hint: '0 = illimité (par défaut, aligné sur claude_local), borné uniquement par le délai du run. Renseigner un entier positif pour forcer un plafond.',
      group: 'Modèle',
    },
    {
      key: 'subtaskModel',
      label: 'Modèle des sous-tâches',
      type: 'combobox',
      hint: 'Modèle rapide à gros quota (ex. AC-task) à qui l’agent peut confier lectures, recherches et résumés (outil « subtask », lecture seule). « aucun » = désactivé.',
      group: 'Sous-tâches',
    },
    {
      key: 'subtaskMaxTurns',
      label: 'Tours maximum par sous-tâche',
      type: 'number',
      default: DEFAULT_SUBTASK_MAX_TURNS,
      hint: 'Au-delà, la sous-tâche rend ce qu’elle a ou échoue proprement.',
      group: 'Sous-tâches',
      meta: { visibleWhen: { key: 'subtaskModel', notValues: ['', NO_MODEL] } },
    },
    {
      key: 'subtaskTimeoutSec',
      label: 'Délai d’une sous-tâche (secondes)',
      type: 'number',
      default: DEFAULT_SUBTASK_TIMEOUT_SEC,
      hint: 'Jamais plus que le temps restant du run.',
      group: 'Sous-tâches',
      meta: { visibleWhen: { key: 'subtaskModel', notValues: ['', NO_MODEL] } },
    },
    {
      key: 'escalationModel',
      label: 'Modèle d’escalade',
      type: 'combobox',
      hint: 'Modèle plus fort qui reprend la tâche, avec tout son historique, si elle échoue vraiment (pas de réponse finale, boucle bloquée, erreur du modèle). « aucun » = pas d’escalade.',
      group: 'Escalade',
    },
    {
      key: 'escalationModel2',
      label: 'Second modèle d’escalade (facultatif)',
      type: 'combobox',
      hint: 'Encore plus fort, essayé si le premier échoue aussi. « aucun » = s’arrêter au premier.',
      group: 'Escalade',
      meta: { visibleWhen: { key: 'escalationModel', notValues: ['', NO_MODEL] } },
    },
    {
      key: 'maxEscalations',
      label: 'Escalades maximum par run',
      type: 'number',
      default: DEFAULT_MAX_ESCALATIONS,
      hint: 'Par défaut 2 : chaque modèle choisi peut être essayé. 0 = jamais. Pas d’escalade si le run est annulé ou s’il reste moins d’une minute.',
      group: 'Escalade',
      meta: { visibleWhen: { key: 'escalationModel', notValues: ['', NO_MODEL] } },
    },
    {
      key: 'timeoutSec',
      label: 'Délai du run (secondes)',
      type: 'number',
      default: DEFAULT_TIMEOUT_SEC,
      group: 'Exécution',
    },
    {
      key: 'pluginTools',
      label: 'Outils des plugins Paperclip',
      type: 'select',
      default: 'true',
      options: [
        { value: 'true', label: 'true — exposés à l’agent (défaut)' },
        { value: 'false', label: 'false — non exposés' },
      ],
      hint: 'Outils enregistrés par les plugins installés (ex. mémoire Hindsight : hindsight_recall, hindsight_retain), découverts au début du run avec la clé de l’agent.',
      group: 'Exécution',
    },
    {
      key: 'systemPrompt',
      label: 'Prompt système',
      type: 'textarea',
      hint: 'Remplace entièrement le prompt système par défaut (identité + environnement Paperclip).',
      group: 'Prompt',
    },
    {
      key: 'promptTemplate',
      label: 'Template de prompt utilisateur',
      type: 'textarea',
      hint: 'Remplace le template par défaut. Placeholders : {{agent.id}}, {{agent.name}}, {{run.id}}.',
      group: 'Prompt',
    },
  ],
};
