import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { CronExpressionParser } from 'cron-parser';
import { ensureStateHome, statePaths } from '../config.js';
import { dispatch } from './dispatcher.js';
import { routeTask } from './router.js';
import { backendSnapshots } from './quota.js';
import { getPriors } from './scoring.js';
import type { BackendId, RunResult } from './types.js';

/**
 * Scheduled jobs. Schedules live in `~/.scode/schedules.json` (versioned,
 * so the shape can evolve). scode is a CLI, not a daemon, so nothing fires
 * on its own — schedules fire when something runs `scode schedule tick`:
 * the OS scheduler (see `installHint()`), or the TUI, which ticks every
 * minute while it is open.
 *
 * Two kinds:
 * - cron: a 5-field cron expression in LOCAL time, recurring forever.
 * - once: a single ISO datetime; the schedule disables itself after firing.
 */

export interface Schedule {
  /** Short id: first 8 chars of a uuid. Commands match on a unique prefix. */
  id: string;
  brief: string;
  /** Backend override; auto-routed when absent. */
  backend?: BackendId;
  /** Repo to run in. Captured from the cwd at add time when not given. */
  cwd: string;
  kind: 'cron' | 'once';
  cron?: string;
  /** ISO datetime for one-shot schedules. */
  at?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  /** Null when a one-shot has fired (or a cron lost its next run). */
  nextRunAt: string | null;
  runCount: number;
  /** Set while a tick is dispatching this schedule; stale after 2h. */
  runningSince: string | null;
}

interface ScheduleStore {
  version: 1;
  schedules: Schedule[];
}

/** A run stuck longer than this is treated as crashed, not running. */
export const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;

export async function loadSchedules(): Promise<Schedule[]> {
  try {
    const text = await readFile(statePaths().schedules, 'utf8');
    const store = JSON.parse(text) as ScheduleStore;
    if (!Array.isArray(store.schedules)) throw new Error('schedules.json is corrupt: no schedules array');
    return store.schedules;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function saveSchedules(schedules: Schedule[]): Promise<void> {
  await ensureStateHome();
  const store: ScheduleStore = { version: 1, schedules };
  await writeFile(statePaths().schedules, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** Strictly-after next run for a schedule, or null when there is none. */
export function nextRunAfter(schedule: Pick<Schedule, 'kind' | 'cron' | 'at'>, from: Date): string | null {
  if (schedule.kind === 'once') {
    if (!schedule.at) return null;
    const at = new Date(schedule.at);
    if (Number.isNaN(at.getTime())) return null;
    return at.getTime() > from.getTime() ? at.toISOString() : null;
  }
  if (!schedule.cron) return null;
  const iterator = CronExpressionParser.parse(schedule.cron, { currentDate: from });
  return iterator.next().toDate().toISOString();
}

/** Throws on a bad expression — call at add time so bad crons never persist. */
export function validateCron(expression: string): void {
  CronExpressionParser.parse(expression, { currentDate: new Date() });
}

/** Parse "30m", "2h", "1d", "90s", or combos like "1h30m" into milliseconds. */
export function parseDuration(input: string): number | null {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(input.trim());
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    (Number(days ?? 0) * 24 * 60 * 60 +
      Number(hours ?? 0) * 60 * 60 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0)) *
    1000
  );
}

export interface AddScheduleInput {
  brief: string;
  backend?: BackendId;
  cwd?: string;
  cron?: string;
  at?: string;
  inMs?: number;
  now?: Date;
}

export async function addSchedule(input: AddScheduleInput): Promise<Schedule> {
  const now = input.now ?? new Date();
  const kinds = [input.cron !== undefined, input.at !== undefined, input.inMs !== undefined].filter(Boolean).length;
  if (kinds !== 1) throw new Error('A schedule needs exactly one of --cron, --at, or --in.');
  const schedule: Schedule = {
    id: randomUUID().slice(0, 8),
    brief: input.brief,
    backend: input.backend,
    cwd: input.cwd ?? process.cwd(),
    kind: input.cron ? 'cron' : 'once',
    cron: input.cron,
    at: input.at ?? (input.inMs !== undefined ? new Date(now.getTime() + input.inMs).toISOString() : undefined),
    enabled: true,
    createdAt: now.toISOString(),
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    runningSince: null,
  };
  if (schedule.kind === 'cron') validateCron(schedule.cron as string);
  schedule.nextRunAt = nextRunAfter(schedule, now);
  if (!schedule.nextRunAt) {
    throw new Error(
      schedule.kind === 'once'
        ? 'That time is already past. Use a future time, or `scode run` for right now.'
        : 'Could not compute a next run for that cron expression.',
    );
  }
  const schedules = await loadSchedules();
  schedules.push(schedule);
  await saveSchedules(schedules);
  return schedule;
}

/** Unique-prefix lookup: `remove abc` matches id `abcdef12` when unambiguous. */
export function findSchedule(schedules: Schedule[], idPrefix: string): Schedule {
  const matches = schedules.filter((item) => item.id.startsWith(idPrefix));
  if (matches.length === 0) throw new Error(`No schedule matches "${idPrefix}".`);
  if (matches.length > 1) {
    throw new Error(`"${idPrefix}" is ambiguous: ${matches.map((item) => item.id).join(', ')}. Use more characters.`);
  }
  return matches[0];
}

export async function removeSchedule(idPrefix: string): Promise<Schedule> {
  const schedules = await loadSchedules();
  const target = findSchedule(schedules, idPrefix);
  await saveSchedules(schedules.filter((item) => item.id !== target.id));
  return target;
}

export async function setScheduleEnabled(idPrefix: string, enabled: boolean): Promise<Schedule> {
  const schedules = await loadSchedules();
  const target = findSchedule(schedules, idPrefix);
  target.enabled = enabled;
  await saveSchedules(schedules);
  return target;
}

export function isRunning(schedule: Schedule, now: Date): boolean {
  if (!schedule.runningSince) return false;
  return now.getTime() - Date.parse(schedule.runningSince) < STALE_RUNNING_MS;
}

/** Enabled schedules whose next run has arrived, excluding ones mid-run. */
export function dueSchedules(schedules: Schedule[], now: Date): Schedule[] {
  return schedules.filter(
    (item) =>
      item.enabled &&
      item.nextRunAt !== null &&
      Date.parse(item.nextRunAt) <= now.getTime() &&
      !isRunning(item, now),
  );
}

export interface TickJob {
  jobId: string;
  schedule: Schedule;
}

export interface TickEvents {
  onStart?: (job: TickJob) => void;
  onOutput?: (jobId: string, chunk: string) => void;
  onFinish?: (job: TickJob, result: RunResult) => void;
}

export interface TickOptions extends TickEvents {
  /** Defaults to the real dispatch path (classify -> select -> dispatch). */
  dispatchFn?: (schedule: Schedule, onOutput?: (chunk: string) => void, signal?: AbortSignal) => Promise<RunResult>;
  signal?: AbortSignal;
  now?: Date;
  /** List what would fire without dispatching or touching the store. */
  dryRun?: boolean;
}

export interface TickResult {
  fired: Array<{ scheduleId: string; jobId: string; success: boolean; backend: BackendId }>;
  skippedRunning: string[];
  dryRun: boolean;
}

/** The real dispatch path for one due schedule: same routing as `scode run`. */
export async function dispatchScheduled(
  schedule: Schedule,
  onOutput?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  const snapshots = await backendSnapshots();
  const priors = await getPriors();
  const { classification, selection } = await routeTask(schedule.brief, snapshots, schedule.backend, { priors });
  const stream = onOutput
    ? { onStdout: () => {}, onStderr: () => {}, onDisplay: onOutput }
    : undefined;
  return dispatch({
    brief: schedule.brief,
    backend: selection.backend,
    cwd: schedule.cwd,
    allowFallback: true,
    selectionReason: `scheduled (${schedule.id}): ${selection.reason}`,
    classification: { ...classification },
    scheduleId: schedule.id,
    signal,
    ...stream,
  });
}

function failedResult(schedule: Schedule, error: unknown): RunResult {
  const now = new Date().toISOString();
  return {
    taskId: `schedule-${schedule.id}`,
    backend: schedule.backend ?? 'codex-a',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    exitCode: null,
    signal: null,
    success: false,
    errorClass: 'backend-error',
    stdoutTail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Fire every due schedule, sequentially (parallel dispatches would fight
 * over the same quota pools). A tick fires each due schedule at most once —
 * a machine that slept through three runs fires one catch-up, not three.
 */
export async function runDueSchedules(options: TickOptions = {}): Promise<TickResult> {
  const now = options.now ?? new Date();
  const schedules = await loadSchedules();
  const due = dueSchedules(schedules, now);
  const skippedRunning = schedules
    .filter((item) => item.enabled && item.nextRunAt !== null && Date.parse(item.nextRunAt) <= now.getTime() && isRunning(item, now))
    .map((item) => item.id);
  const dispatchFn = options.dispatchFn ?? dispatchScheduled;

  if (options.dryRun) {
    return {
      fired: due.map((item) => ({ scheduleId: item.id, jobId: '', success: false, backend: item.backend ?? 'codex-a' })),
      skippedRunning,
      dryRun: true,
    };
  }

  const fired: TickResult['fired'] = [];
  for (const schedule of due) {
    if (options.signal?.aborted) break;
    const jobId = `sch-${schedule.id}-${Date.now()}`;
    schedule.runningSince = now.toISOString();
    await saveSchedules(schedules);
    options.onStart?.({ jobId, schedule });
    let result: RunResult;
    try {
      result = await dispatchFn(schedule, (chunk) => options.onOutput?.(jobId, chunk), options.signal);
    } catch (error) {
      result = failedResult(schedule, error);
    }
    schedule.runningSince = null;
    schedule.lastRunAt = now.toISOString();
    schedule.runCount += 1;
    if (schedule.kind === 'once') {
      schedule.enabled = false;
      schedule.nextRunAt = null;
    } else {
      try {
        schedule.nextRunAt = nextRunAfter(schedule, new Date());
      } catch {
        // A cron that stops parsing (hand-edited store) disables itself
        // rather than firing every tick forever.
        schedule.enabled = false;
        schedule.nextRunAt = null;
      }
    }
    await saveSchedules(schedules);
    options.onFinish?.({ jobId, schedule }, result);
    fired.push({ scheduleId: schedule.id, jobId, success: result.success, backend: result.backend });
  }
  return { fired, skippedRunning, dryRun: false };
}

/** The OS wiring that makes `tick` run on its own. Pure over the platform. */
export function installHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return [
      'Windows Task Scheduler — run in a terminal (creates a task that ticks every 5 minutes):',
      '',
      '  schtasks /create /tn "scode tick" /tr "scode schedule tick" /sc minute /mo 5 /f',
      '',
      'Remove it later with: schtasks /delete /tn "scode tick" /f',
      'Or skip the OS entirely: the TUI ticks due schedules every minute while it is open.',
    ].join('\n');
  }
  return [
    'Cron — add this line with `crontab -e` (ticks every 5 minutes):',
    '',
    '  */5 * * * * scode schedule tick >/dev/null 2>&1',
    '',
    'Or skip the OS entirely: the TUI ticks due schedules every minute while it is open.',
  ].join('\n');
}
