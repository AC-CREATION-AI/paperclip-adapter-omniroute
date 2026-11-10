/**
 * Stockage des sessions : droits, écriture atomique, verrou, purge
 * (ACC-2297, ACC-2300).
 *
 * Constats mesurés en production (D-exploitation Q2/Q3) :
 * - fichiers `0644` lisibles par tous, dont un contenant un jeton de run ;
 * - `fs.writeFile` direct : un arrêt brutal laisse un JSON tronqué, relu
 *   ensuite comme « aucun historique » ; deux runs du même agent sur la même
 *   session → le dernier écrivain efface l'autre sans signal ;
 * - aucune purge (22 fichiers en 2,5 jours pour un seul agent) ;
 * - aucun `.gitignore` : dans un checkout de projet, `git add -A` les
 *   embarquerait.
 *
 * Ce module ne connaît pas le format des messages ; il vérifie seulement
 * l'enveloppe version/identité avant de muter un checkpoint. `session.ts`
 * valide les messages et l'utilise pour les opérations de fichiers sûres.
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { redactJsonValue } from './secrets-redact.js';

/** Durée de vie d'une session inactive (pas de mise à jour depuis). */
export const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
/** Nombre maximal de fichiers de session gardés par dossier (donc par agent). */
export const SESSION_MAX_FILES = 50;
/** Un verrou plus vieux que ceci est périmé : une sauvegarde dure quelques ms. */
export const LOCK_STALE_MS = 30_000;
/** Attente maximale d'un verrou avant de renoncer (la sauvegarde est sautée). */
export const LOCK_TIMEOUT_MS = 10_000;
/** Un temporaire d'écriture plus vieux que ceci est un reste d'arrêt brutal. */
const TMP_STALE_MS = 3600 * 1000;

const GITIGNORE_ALL = '# Fichiers internes de l’adaptateur omniroute_native : jamais suivis par git.\n*\n';

/**
 * Crée (ou resserre) un dossier privé : `0700`, avec un `.gitignore` « * ».
 * `mkdir` ne change pas les droits d'un dossier existant : on les force.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await ensureGitIgnoreAll(dir);
}

/** Pose un `.gitignore` « * » s'il n'existe pas (jamais d'écrasement). */
export async function ensureGitIgnoreAll(dir: string): Promise<void> {
  try {
    await fs.writeFile(path.join(dir, '.gitignore'), GITIGNORE_ALL, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Écriture atomique : temporaire `0600` dans le même dossier, `fsync`, puis
 * `rename`. Un lecteur voit l'ancien fichier complet ou le nouveau complet,
 * jamais un fichier tronqué ; un arrêt brutal laisse au pire un temporaire,
 * purgé plus tard.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmp, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tmp, file);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class SessionLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`verrou de session occupé : ${path.basename(lockPath)}`);
    this.name = 'SessionLockTimeoutError';
  }
}

interface LockOwner {
  pid: number;
  host: string;
  token: string;
  createdAt: string;
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
}

/**
 * Verrous du processus courant. Paperclip exécute tous les runs dans le même
 * processus : le PID du fichier `.lock` ne suffit pas à distinguer deux runs,
 * d'où une file d'attente en mémoire par fichier, en plus du verrou disque
 * (qui protège contre un autre processus ou un autre hôte).
 */
const inProcessQueues = new Map<string, Promise<void>>();

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(lockPath: string): Promise<{ owner: LockOwner | null; mtimeMs: number } | null> {
  try {
    const [raw, stat] = await Promise.all([fs.readFile(lockPath, 'utf8'), fs.stat(lockPath)]);
    let owner: LockOwner | null = null;
    try {
      owner = JSON.parse(raw) as LockOwner;
    } catch {
      owner = null;
    }
    return { owner, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/** Un verrou est périmé si son processus est mort (même hôte) ou s'il est trop vieux. */
function isStale(found: { owner: LockOwner | null; mtimeMs: number }, staleMs: number): boolean {
  const created = found.owner?.createdAt ? Date.parse(found.owner.createdAt) : NaN;
  const age = Date.now() - (Number.isFinite(created) ? created : found.mtimeMs);
  if (age > staleMs) return true;
  const owner = found.owner;
  if (!owner) return false;
  if (owner.host === os.hostname() && owner.pid !== process.pid && !isProcessAlive(owner.pid)) return true;
  return false;
}

async function acquireFileLock(lockPath: string, options: Required<LockOptions>): Promise<string> {
  const token = randomUUID();
  const owner: LockOwner = { pid: process.pid, host: os.hostname(), token, createdAt: new Date().toISOString() };
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    try {
      await fs.writeFile(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const found = await readOwner(lockPath);
    if (found && isStale(found, options.staleMs)) {
      // Reprise d'un verrou périmé : on le renomme d'abord (une seule reprise
      // gagne), puis on le supprime.
      const grave = `${lockPath}.${randomUUID().slice(0, 8)}.stale`;
      try {
        await fs.rename(lockPath, grave);
        await fs.rm(grave, { force: true });
      } catch {
        /* un autre l'a repris avant nous */
      }
      continue;
    }
    if (Date.now() >= deadline) throw new SessionLockTimeoutError(lockPath);
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)));
  }
}

async function releaseFileLock(lockPath: string, token: string): Promise<void> {
  const found = await readOwner(lockPath);
  if (found?.owner?.token === token) await fs.rm(lockPath, { force: true });
}

/**
 * Exécute `fn` sous le verrou du fichier `file` (`<file>.lock`, contenant
 * PID, hôte, jeton et date). Lève `SessionLockTimeoutError` si le verrou
 * reste pris par un processus vivant au-delà de `timeoutMs`.
 */
export async function withSessionLock<T>(file: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lockPath = `${file}.lock`;
  const resolved: Required<LockOptions> = {
    timeoutMs: options.timeoutMs ?? LOCK_TIMEOUT_MS,
    staleMs: options.staleMs ?? LOCK_STALE_MS,
  };
  const previous = inProcessQueues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  inProcessQueues.set(lockPath, tail);
  try {
    await previous;
    const token = await acquireFileLock(lockPath, resolved);
    try {
      return await fn();
    } finally {
      await releaseFileLock(lockPath, token).catch(() => undefined);
    }
  } finally {
    release();
    if (inProcessQueues.get(lockPath) === tail) inProcessQueues.delete(lockPath);
  }
}

/**
 * Masquage par défaut d'un ancien fichier : JSON relu, chaînes masquées,
 * réécrit. Un fichier illisible est laissé tel quel (seuls ses droits sont
 * resserrés) plutôt que d'être réécrit à l'aveugle.
 */
function scrubJsonText(raw: string): string {
  return JSON.stringify(redactJsonValue(JSON.parse(raw)));
}

/** Enveloppe disque version1 uniquement ; aucune migration implicite. */
export function isCompatibleSessionEnvelope(value: unknown, sessionId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const stored = value as Record<string, unknown>;
  return stored['version'] === 1 && stored['sessionId'] === sessionId;
}

/** Sous verrou : conserver une enveloppe inconnue, même face à la rétention. */
async function canMutateSessionFile(file: string, expectedId?: string): Promise<boolean> {
  const raw = await fs.readFile(file, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return true; } // JSON tronqué : politique existante.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
  const id = (parsed as Record<string, unknown>)['sessionId'];
  if (typeof id === 'string' && isCompatibleSessionEnvelope(parsed, expectedId ?? id)
    && `${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json` === path.basename(file)) return true;
  // Ne pas réécrire, renommer ni supprimer la source refusée. Seuls les droits
  // sont resserrés, y compris pour un checkpoint incompatible déjà ancien.
  await fs.chmod(file, 0o600);
  return false;
}

export interface PurgeOptions {
  /** Identifiants de session à ne jamais supprimer (session courante). */
  keep?: string[];
  ttlMs?: number;
  maxFiles?: number;
  now?: number;
  /** Masqueur appliqué aux anciens fichiers non privés (migration 0644 → 0600). */
  scrub?: (raw: string) => string;
}

export interface PurgeReport {
  deleted: number;
  scrubbed: number;
  tmpRemoved: number;
}

/**
 * Purge d'un dossier de sessions :
 * - supprime les sessions inactives depuis plus de `ttlMs` (14 jours) ;
 * - garde au plus `maxFiles` sessions (les plus récentes) ;
 * - supprime les temporaires d'écriture abandonnés et les verrous périmés ;
 * - repasse en `0600` (et masque) les anciens fichiers lisibles par d'autres.
 *
 * La session courante (`keep`) n'est jamais supprimée. Les enveloppes
 * incompatibles sont conservées octet pour octet (chmod 0600 seulement).
 * Toute erreur sur un fichier est ignorée : la purge ne doit jamais faire
 * échouer un run.
 */
export async function purgeSessionDir(dir: string, options: PurgeOptions = {}): Promise<PurgeReport> {
  const report: PurgeReport = { deleted: 0, scrubbed: 0, tmpRemoved: 0 };
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const maxFiles = Math.max(1, options.maxFiles ?? SESSION_MAX_FILES);
  const keepIds = new Map((options.keep ?? []).map((id) => [`${id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`, id]));
  const keep = new Set(keepIds.keys());
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return report;
  }

  const sessions: Array<{ name: string; mtimeMs: number; mode: number }> = [];
  for (const name of names) {
    const full = path.join(dir, name);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (name.endsWith('.tmp') || name.endsWith('.stale')) {
      if (now - stat.mtimeMs > TMP_STALE_MS) {
        await fs.rm(full, { force: true }).catch(() => undefined);
        report.tmpRemoved += 1;
      }
      continue;
    }
    if (name.endsWith('.lock')) {
      const found = await readOwner(full);
      if (found && isStale(found, LOCK_STALE_MS)) await fs.rm(full, { force: true }).catch(() => undefined);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    sessions.push({ name, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 });
  }

  const doomed = new Set<string>();
  for (const session of sessions) {
    if (!keep.has(session.name) && now - session.mtimeMs > ttlMs) doomed.add(session.name);
  }
  const alive = sessions.filter((s) => !doomed.has(s.name)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  let kept = 0;
  for (const session of alive) {
    if (keep.has(session.name)) continue;
    kept += 1;
    // Les sessions gardées (`keep`) comptent dans le plafond.
    if (kept + keep.size > maxFiles) doomed.add(session.name);
  }

  for (const name of doomed) {
    const full = path.join(dir, name);
    try {
      const deleted = await withSessionLock(full, async () => {
        if (!await canMutateSessionFile(full)) return false;
        await fs.rm(full, { force: true });
        return true;
      }, { timeoutMs: 200 });
      if (deleted) report.deleted += 1;
    } catch {
      /* fichier occupé : il sera purgé au prochain passage */
    }
  }

  // Migration des anciens fichiers lisibles par d'autres : masquage + 0600.
  for (const session of sessions) {
    if (doomed.has(session.name) || (session.mode & 0o077) === 0) continue;
    const full = path.join(dir, session.name);
    try {
      const scrubbed = await withSessionLock(
        full,
        async () => {
          if (!await canMutateSessionFile(full, keepIds.get(session.name))) return false;
          const raw = await fs.readFile(full, 'utf8');
          const cleaned = (options.scrub ?? scrubJsonText)(raw);
          await writeFileAtomic(full, cleaned);
          return true;
        },
        { timeoutMs: 200 },
      );
      if (scrubbed) report.scrubbed += 1;
    } catch {
      await fs.chmod(full, 0o600).catch(() => undefined);
    }
  }
  return report;
}
