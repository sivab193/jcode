import { randomUUID } from 'node:crypto';
import { AgyAdapter } from '../adapters/agy.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import { CopilotAdapter } from '../adapters/copilot.js';
import { KiroAdapter } from '../adapters/kiro.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import type { BackendAdapter } from '../adapters/types.js';
import { loadConfig } from '../config.js';
import { ensureGraph, type EnsureGraphResult } from './graphify.js';
import { appendLedger } from './ledger.js';
import { formatBrief, installPromptPack } from './promptPack.js';
import { backendSnapshots, markCoolingDown } from './quota.js';
import { parseCodexResetFromMessage } from './probes.js';
import { getSessionId, saveSessionId } from './sessions.js';
import { saveRunRecord } from './runs.js';
import type { BackendId, RunResult } from './types.js';
import { createWorktree, removeWorktree, worktreeHasChanges, type Worktree } from './worktree.js';

function adapterFor(backend: BackendId): BackendAdapter {
  if (backend === 'codex-a' || backend === 'codex-b') return new CodexAdapter();
  if (backend === 'kiro') return new KiroAdapter();
  if (backend === 'agy') return new AgyAdapter();
  if (backend === 'copilot') return new CopilotAdapter();
  if (backend === 'opencode') return new OpenCodeAdapter();
  return new ClaudeAdapter(); // throws: disabled until Claude Pro is live
}

export interface DispatchOptions {
  brief: string;
  backend: BackendId;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  selectionReason: string;
  classification: Record<string, unknown>;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onDisplay?: (text: string) => void;
  /** Task creates an isolated coding worktree; chat continues in the repo. */
  interactionMode?: 'task' | 'chat';
  dryRun?: boolean;
  /** Allow one fallback to another backend on a classified failure. */
  allowFallback?: boolean;
  /** Internal: resume in an existing worktree instead of creating one. */
  reuseWorktree?: Worktree;
  /** Internal: keep one task id across a fallback retry. */
  taskId?: string;
  /** Set by the scheduler so ledger records tie back to their schedule. */
  scheduleId?: string;
  /** Thread turns share one session key so follow-ups resume the agent. */
  sessionKey?: string;
  /** Thread id, recorded on ledger records for thread turns. */
  threadId?: string;
  /** Thread worktrees are never auto-removed, even when clean. */
  keepWorktree?: boolean;
  /** Skip the graph pre-flight (fallback retries already ensured it). */
  skipGraph?: boolean;
}

/**
 * Dispatch one job: worktree per job, session resume, one fallback on a
 * classified failure, ledger records for every step.
 *
 * Fallback rules (handoff §5):
 * - quota -> mark the account cooling-down until its reset, re-route to the
 *   next available backend, resume from the same worktree. Never retry the
 *   same account (`insufficient_quota` is a hard stop for that account).
 * - capability -> escalate to a stronger backend, never sideways.
 * - availability -> fall back sideways.
 * Phase 1 allows at most one fallback per job to avoid retry loops.
 */
export async function dispatch(options: DispatchOptions): Promise<RunResult> {
  const config = await loadConfig();
  const taskId = options.taskId ?? randomUUID();
  const repoCwd = options.cwd ?? process.cwd();
  const interactionMode = options.interactionMode ?? 'task';
  // Pre-dispatch indexing: build the code graph when it is missing or stale
  // (best-effort — a missing or failing graph never fails the job). Skipped
  // on dry runs and on fallback retries (the first attempt already ensured it).
  let graph: EnsureGraphResult | null = null;
  const graphEnabled = config.graphify?.enabled !== false && (config.graphify?.autoBuild ?? true);
  if (interactionMode === 'task' && graphEnabled && !options.dryRun && !options.skipGraph) {
    graph = await ensureGraph(repoCwd);
    if (graph.action === 'built' || graph.action === 'failed') {
      console.log(`[scode] code graph: ${graph.detail}`);
    }
  }
  const worktree: Worktree = options.reuseWorktree ?? (options.dryRun || interactionMode === 'chat'
    ? { path: repoCwd, isWorktree: false }
    : await createWorktree(taskId, repoCwd));
  if (worktree.isWorktree && !options.reuseWorktree) {
    const pack = await installPromptPack(worktree.path);
    worktree.ignoredPaths = pack.installed;
    if (pack.installed.length > 0) {
      console.log(`[scode] prompt pack seeded into worktree: ${pack.installed.join(', ')}`);
    }
  }
  const sessionId = await getSessionId(options.sessionKey ?? taskId, options.backend);

  const request = {
    taskId,
    brief: interactionMode === 'chat' ? options.brief : formatBrief(options.brief),
    backend: options.backend,
    cwd: worktree.path,
    timeoutMs: options.timeoutMs ?? config.defaultTimeoutMs,
    sessionId,
    signal: options.signal,
    dryRun: options.dryRun,
  };

  await appendLedger({
    event: 'run-started',
    taskId,
    timestamp: new Date().toISOString(),
    brief: options.brief, // ledger keeps the raw brief, not the wrapped one
    backend: request.backend,
    cwd: repoCwd,
    worktree: worktree.path,
    worktreeCreated: worktree.isWorktree,
    sessionResumed: !!sessionId,
    classification: options.classification,
    selectionReason: options.selectionReason,
    interactionMode,
    ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
    // Graph state at dispatch time, so `scode learn` can later compare
    // graph-vs-no-graph token use. Absent when the graph check was skipped.
    ...(graph ? { graphPresent: graph.status.present, graphBuiltAtCommit: graph.status.builtAtCommit, graphAction: graph.action } : {}),
  });
  let result: RunResult;
  try {
    result = await adapterFor(request.backend).run(request, {
      onStdout: options.onStdout ?? ((chunk) => process.stdout.write(chunk)),
      onStderr: options.onStderr ?? ((chunk) => process.stderr.write(chunk)),
      onDisplay: options.onDisplay,
    });
  } catch (error) {
    await appendLedger({
      event: 'run-failed-to-start',
      taskId,
      timestamp: new Date().toISOString(),
      backend: request.backend,
      error: error instanceof Error ? error.message : String(error),
      ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
      ...(options.threadId ? { threadId: options.threadId } : {}),
    });
    if (worktree.isWorktree && !options.keepWorktree) await removeWorktree(worktree, repoCwd);
    throw error;
  }

  const hasChanges = await worktreeHasChanges(worktree, worktree.ignoredPaths);
  result = { ...result, worktree: worktree.path, hasChanges };
  if (result.sessionId) await saveSessionId(options.sessionKey ?? taskId, request.backend, result.sessionId);
  await appendLedger({
    event: 'run-finished',
    ...result,
    ...(options.scheduleId ? { scheduleId: options.scheduleId } : {}),
    ...(options.threadId ? { threadId: options.threadId } : {}),
  });

  // Preserve successful edits so users can inspect, continue, or apply them.
  // A clean successful worktree is disposable and is removed automatically —
  // unless the caller keeps it (threads always keep theirs).
  if (result.success) {
    if (worktree.isWorktree && !hasChanges && !options.keepWorktree) {
      await removeWorktree(worktree, repoCwd);
      result = { ...result, worktree: undefined };
    }
    await saveRunRecord(options.brief, repoCwd, result);
    return result;
  }

  await saveRunRecord(options.brief, repoCwd, result);

  if (!options.allowFallback || !result.errorClass || options.signal?.aborted) return result;

  const fallback = await pickFallback(request.backend, result.errorClass);
  if (!fallback) return result;

  await appendLedger({
    event: 'run-fallback',
    taskId,
    timestamp: new Date().toISOString(),
    from: request.backend,
    to: fallback.backend,
    errorClass: result.errorClass,
    reason: fallback.reason,
  });

  // Quota failure: cool the failed account down until its reset.
  if (result.errorClass === 'quota') {
    const snapshots = await backendSnapshots();
    const failed = snapshots.find((item) => item.id === request.backend);
    // Codex writes the reset into its error text when the probe snapshot is
    // unavailable (e.g. behind a proxy) — prefer it over the cached reset.
    const fromMessage = request.backend.startsWith('codex')
      ? parseCodexResetFromMessage(result.stdoutTail ?? '', new Date())
      : null;
    await markCoolingDown(request.backend, fromMessage ?? failed?.quota.resetsAt ?? null);
  }

  const retry = await dispatch({
    ...options,
    taskId,
    backend: fallback.backend,
    cwd: worktree.path,
    reuseWorktree: worktree, // resume from the same worktree state
    skipGraph: true, // the first attempt already ensured it
    selectionReason: `fallback from ${request.backend}: ${fallback.reason}`,
    allowFallback: false,
  });
  return { ...retry, fellBackFrom: { backend: request.backend, errorClass: result.errorClass, reason: fallback.reason } };
}

async function pickFallback(
  failed: BackendId,
  errorClass: string,
): Promise<{ backend: BackendId; reason: string } | null> {
  const snapshots = await backendSnapshots();
  let available = snapshots.filter((item) => item.status === 'available' && item.id !== failed);
  if (errorClass === 'auth') {
    // An auth failure means this vendor's CLI is not logged in on this
    // machine — the same vendor's other account shares the failure mode
    // (codex-a -> codex-b would just 401 again). Fall back cross-vendor only.
    const { BACKEND_BINARIES } = await import('./probes.js');
    available = available.filter((item) => BACKEND_BINARIES[item.id] !== BACKEND_BINARIES[failed]);
  }
  if (available.length === 0) return null;
  if (errorClass === 'capability') {
    // Escalate to a stronger backend, never sideways. Strength order:
    // claude (when live) > codex-a > codex-b > agy > copilot > kiro > opencode.
    const strength: BackendId[] = ['claude', 'codex-a', 'codex-b', 'agy', 'copilot', 'kiro', 'opencode'];
    const failedRank = strength.indexOf(failed);
    const stronger = available.filter((item) => strength.indexOf(item.id) < failedRank);
    const pick = stronger.sort((a, b) => strength.indexOf(a.id) - strength.indexOf(b.id))[0] ?? available[0];
    return { backend: pick.id, reason: `capability failure on ${failed}, escalating to ${pick.id}` };
  }
  // Quota / availability: sideways to the soonest-expiring available backend.
  const ordered = [...available].sort((a, b) => {
    const aReset = a.quota.resetsAt ? Date.parse(a.quota.resetsAt) : Number.POSITIVE_INFINITY;
    const bReset = b.quota.resetsAt ? Date.parse(b.quota.resetsAt) : Number.POSITIVE_INFINITY;
    return aReset - bReset;
  });
  return { backend: ordered[0].id, reason: `${errorClass} failure on ${failed}, falling back sideways to ${ordered[0].id}` };
}
