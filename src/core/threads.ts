/**
 * Threads — T3-style durable conversations: one thread = one task + one
 * real git branch + one worktree + one backend session. Follow-ups
 * (`thread continue`) resume the same session in the same worktree, so the
 * agent keeps its context across turns instead of cold-starting.
 *
 * Storage: ~/.scode/threads.json, { version: 1, threads: Thread[] }.
 * The worktree lives at <repo>/.git/scode-worktrees/<id> on branch
 * scode/<id>-<slug>, branched from the repo's current branch at creation.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureStateHome, statePaths } from '../config.js';
import { dispatch } from './dispatcher.js';
import { installPromptPack } from './promptPack.js';
import { backendSnapshots } from './quota.js';
import { routeTask } from './router.js';
import { getPriors } from './scoring.js';
import type { BackendId, RunResult } from './types.js';
import { createBranchWorktree, currentBranch, gitRoot } from './worktree.js';

export interface Thread {
  id: string;
  title: string;
  repoCwd: string;
  baseBranch: string;
  branch: string;
  worktree: string;
  backend: BackendId;
  status: 'active' | 'closed';
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** Briefs sent, in order (for PR-body context). Capped at 20. */
  briefs: string[];
  prUrl?: string;
}

interface ThreadStore {
  version: 1;
  threads: Thread[];
}

export async function loadThreads(): Promise<Thread[]> {
  try {
    const store = JSON.parse(await readFile(statePaths().threads, 'utf8')) as ThreadStore;
    return Array.isArray(store.threads) ? store.threads : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveThreads(threads: Thread[]): Promise<void> {
  await ensureStateHome();
  const store: ThreadStore = { version: 1, threads };
  await writeFile(statePaths().threads, `${JSON.stringify(store, null, 2)}\n`);
}

/** kebab-case slug from a brief, max 30 chars, for the branch name. */
export function slugifyTitle(brief: string): string {
  const slug = brief
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/, '');
  return slug || 'thread';
}

/** Short title from a brief: first line, max 60 chars. */
export function threadTitle(brief: string): string {
  const first = brief.split('\n')[0]?.trim() ?? '';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first || 'Untitled thread';
}

/** Find a thread by id or unique id prefix. Throws when missing or ambiguous. */
export function findThread(threads: Thread[], idOrPrefix: string): Thread {
  const exact = threads.find((t) => t.id === idOrPrefix);
  if (exact) return exact;
  const matches = threads.filter((t) => t.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0] as Thread;
  if (matches.length > 1) {
    throw new Error(`Ambiguous thread id "${idOrPrefix}": ${matches.map((t) => t.id).join(', ')}`);
  }
  throw new Error(`No thread matches "${idOrPrefix}". See \`scode thread list\`.`);
}

/**
 * Create a thread: branch + worktree + prompt pack, no dispatch yet.
 * Throws outside a git repo or on a detached HEAD (there is no base branch).
 */
export async function createThread(
  brief: string,
  options?: { backend?: BackendId; cwd?: string; id?: string },
): Promise<Thread> {
  const cwd = options?.cwd ?? process.cwd();
  const repoCwd = await gitRoot(cwd);
  if (!repoCwd) throw new Error('Threads need a git repo — this directory is not inside one.');
  const baseBranch = await currentBranch(repoCwd);
  if (!baseBranch) throw new Error('Check out a branch first — threads cannot start from a detached HEAD.');
  // ACP sessions pre-assign the id so session id == thread id.
  const id = options?.id ?? randomUUID().replace(/-/g, '').slice(0, 8);
  const slug = slugifyTitle(brief);
  const branch = `scode/${id}-${slug}`;
  const worktreePath = join(repoCwd, '.git', 'scode-worktrees', id);
  await createBranchWorktree(branch, baseBranch, worktreePath, repoCwd);
  await installPromptPack(worktreePath);
  const now = new Date().toISOString();
  const thread: Thread = {
    id,
    title: threadTitle(brief),
    repoCwd,
    baseBranch,
    branch,
    worktree: worktreePath,
    backend: options?.backend ?? 'codex-a',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    turns: 0,
    briefs: [],
  };
  const threads = await loadThreads();
  threads.push(thread);
  await saveThreads(threads);
  return thread;
}

export interface TurnOutcome {
  thread: Thread;
  result: RunResult;
  selectionReason: string;
  /** True when the turn switched backend from the thread's previous one. */
  switchedBackend: boolean;
}

/**
 * Run one turn on a thread: classify, route, dispatch in the thread's
 * worktree with its session, record the turn. Backend choice: an explicit
 * --backend wins; otherwise the thread's backend is kept (session
 * continuity) unless it is unavailable, in which case the router picks
 * another and the switch is reported.
 */
export async function dispatchThreadTurn(
  thread: Thread,
  brief: string,
  options?: {
    backend?: BackendId;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
    signal?: AbortSignal;
  },
): Promise<TurnOutcome> {
  if (thread.status === 'closed') throw new Error(`Thread ${thread.id} is closed.`);
  const priors = await getPriors();
  const snapshots = await backendSnapshots();
  let decision;
  let switchedBackend = false;
  if (options?.backend) {
    decision = await routeTask(brief, snapshots, options.backend, { priors });
    switchedBackend = decision.selection.backend !== thread.backend;
  } else if (thread.turns > 0) {
    // Later turns stay on the thread's backend (session continuity) unless
    // it is unavailable — then re-route rather than failing the turn.
    try {
      decision = await routeTask(brief, snapshots, thread.backend, { priors });
    } catch {
      decision = await routeTask(brief, snapshots, undefined, { priors });
      switchedBackend = decision.selection.backend !== thread.backend;
    }
  } else {
    // First turn: auto-route (the stored backend is just a placeholder
    // until a real turn picks one).
    decision = await routeTask(brief, snapshots, undefined, { priors });
    switchedBackend = decision.selection.backend !== thread.backend;
  }
  const { classification, selection } = decision;
  const taskId = `${thread.id}-turn-${thread.turns + 1}`;
  const result = await dispatch({
    brief,
    backend: selection.backend,
    cwd: thread.repoCwd,
    taskId,
    sessionKey: `thread:${thread.id}`,
    threadId: thread.id,
    reuseWorktree: { path: thread.worktree, isWorktree: true },
    keepWorktree: true,
    selectionReason: selection.reason,
    classification: { ...classification },
    allowFallback: true,
    onStdout: options?.onStdout,
    onStderr: options?.onStderr,
    signal: options?.signal,
  });
  const threads = await loadThreads();
  const stored = threads.find((t) => t.id === thread.id);
  if (!stored) throw new Error(`Thread ${thread.id} disappeared from the store.`);
  stored.turns += 1;
  stored.backend = result.backend;
  stored.updatedAt = new Date().toISOString();
  stored.briefs = [...stored.briefs, brief].slice(-20);
  await saveThreads(threads);
  return { thread: stored, result, selectionReason: selection.reason, switchedBackend };
}

/** Close a thread (archive only — the branch and worktree are kept). */
export async function closeThread(idOrPrefix: string): Promise<Thread> {
  const threads = await loadThreads();
  const thread = findThread(threads, idOrPrefix);
  thread.status = 'closed';
  thread.updatedAt = new Date().toISOString();
  await saveThreads(threads);
  return thread;
}

/** Record a PR URL on a thread (set by `scode pr`). */
export async function setThreadPr(id: string, prUrl: string): Promise<void> {
  const threads = await loadThreads();
  const thread = threads.find((t) => t.id === id);
  if (!thread) return;
  thread.prUrl = prUrl;
  thread.updatedAt = new Date().toISOString();
  await saveThreads(threads);
}

export function renderThreadList(threads: Thread[]): string[] {
  const active = threads.filter((t) => t.status === 'active');
  const closed = threads.filter((t) => t.status === 'closed');
  const lines: string[] = [];
  const render = (list: Thread[]) => {
    for (const t of list) {
      const pr = t.prUrl ? ` · PR: ${t.prUrl}` : '';
      lines.push(
        `${t.id}  ${t.title}  [${t.backend}, ${t.turns} turn${t.turns === 1 ? '' : 's'}]${pr}`,
      );
      lines.push(`    ${t.branch}  ·  ${t.worktree}`);
    }
  };
  if (active.length > 0) {
    lines.push('Active threads:');
    render(active);
  }
  if (closed.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Closed threads:');
    render(closed);
  }
  if (lines.length === 0) lines.push('No threads yet. Start one with `scode thread new "<task>"`.');
  return lines;
}

export function renderThreadStatus(thread: Thread): string[] {
  return [
    `${thread.id}  ${thread.title}`,
    `  status: ${thread.status}`,
    `  branch: ${thread.branch} (from ${thread.baseBranch})`,
    `  worktree: ${thread.worktree}`,
    `  backend: ${thread.backend}`,
    `  turns: ${thread.turns}`,
    `  created: ${thread.createdAt}`,
    `  updated: ${thread.updatedAt}`,
    ...(thread.prUrl ? [`  PR: ${thread.prUrl}`] : []),
  ];
}
