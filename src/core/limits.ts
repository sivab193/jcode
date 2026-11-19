/**
 * Usage limits view — T3 Code's Usage > Limits page, as plain text.
 *
 * One row per usage window (Codex Session + Weekly, Claude five_hour +
 * seven_day, ...), each with % left, a remaining bar with a pace tick, and
 * a reset countdown. Pure functions over BackendSnapshot[]: the `scode
 * usage` command and the TUI limits view render the same lines.
 *
 * Pace (T3's model): the tick marks where remaining *should* be if usage
 * were evenly spread across the window. Burning faster than time passes is
 * "ahead of pace"; slower is "under pace". A >5 point gap either way
 * counts; anything closer is "on pace".
 */
import type { BackendId, BackendSnapshot, QuotaWindow } from './types.js';

export type QuotaWindowKind = 'session' | 'weekly' | 'monthly' | 'other';

/** One usage window, normalized for display. */
export interface QuotaWindowDetail {
  id: string;
  kind: QuotaWindowKind;
  label: string;
  /** Percent used, 0–100. */
  usedPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export const WINDOW_KIND_ORDER: Record<QuotaWindowKind, number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export const BACKEND_DISPLAY_NAMES: Record<BackendId, string> = {
  'codex-a': 'Codex · account A',
  'codex-b': 'Codex · account B',
  kiro: 'Kiro',
  agy: 'Antigravity',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  claude: 'Claude',
};

export function kindForDuration(mins: number | null): QuotaWindowKind {
  if (mins === null) return 'other';
  if (mins >= 30 * 24 * 60) return 'monthly';
  if (mins >= 7 * 24 * 60) return 'weekly';
  return 'session';
}

export function labelForKind(kind: QuotaWindowKind): string {
  return kind === 'session' ? 'Session' : kind === 'weekly' ? 'Weekly' : kind === 'monthly' ? 'Monthly' : 'Quota';
}

export function sortWindows(windows: QuotaWindowDetail[]): QuotaWindowDetail[] {
  return [...windows].sort(
    (a, b) => WINDOW_KIND_ORDER[a.kind] - WINDOW_KIND_ORDER[b.kind] || a.id.localeCompare(b.id),
  );
}

/** Percent remaining, 0–100, rounded. */
export function remainingPercent(window: QuotaWindowDetail): number {
  return Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
}

/** Share of the window's time that has elapsed, 0–1. Null without a reset + duration. */
export function elapsedShare(window: QuotaWindowDetail, nowMs: number): number | null {
  if (!window.resetsAt || !window.windowMinutes || window.windowMinutes <= 0) return null;
  const resetsAt = Date.parse(window.resetsAt);
  if (!Number.isFinite(resetsAt)) return null;
  const length = window.windowMinutes * 60_000;
  return Math.max(0, Math.min(1, (length - (resetsAt - nowMs)) / length));
}

export type LimitPace = 'ahead' | 'on' | 'under';

export function paceOf(window: QuotaWindowDetail, nowMs: number): LimitPace | null {
  const elapsed = elapsedShare(window, nowMs);
  if (elapsed === null) return null;
  const gap = window.usedPercent - elapsed * 100;
  if (gap > 5) return 'ahead';
  if (gap < -5) return 'under';
  return 'on';
}

/** '36m' | '1h 31m' | '4d 15h' | '12d 3h'. */
export function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** '↻ 1h 31m' | 'resets now' | null when no reset is known. */
export function formatResetsIn(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const ms = at - nowMs;
  if (ms <= 0) return 'resets now';
  if (ms < 60_000) return 'resets momentarily';
  return `↻ ${formatDuration(ms)}`;
}

/** 'just now' | '2m ago' | '3h ago' | '2d ago'. */
export function formatAge(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  return `${formatDuration(ms)} ago`;
}

/**
 * Normalize a stored quota record into display windows. Windows carry the
 * shared probe shape ({ name, remainingFraction, resetsAt, windowMinutes });
 * the no-windows case (manual entries, kiro) synthesizes a single window
 * from the top-level fields. Empty when the backend has no quota data.
 */
export function normalizeWindows(quota: QuotaWindow): QuotaWindowDetail[] {
  if (Array.isArray(quota.windows) && quota.windows.length > 0) {
    const details: QuotaWindowDetail[] = [];
    for (const entry of quota.windows) {
      if (typeof entry.remainingFraction !== 'number') continue;
      const mins = typeof entry.windowMinutes === 'number' && entry.windowMinutes > 0 ? entry.windowMinutes : null;
      const kind = kindForDuration(mins);
      details.push({
        id: entry.name,
        kind,
        label: windowLabel(entry.name, kind),
        usedPercent: Math.max(0, Math.min(100, (1 - entry.remainingFraction) * 100)),
        resetsAt: entry.resetsAt,
        windowMinutes: mins,
      });
    }
    if (details.length > 0) return sortWindows(details);
  }
  if (quota.remainingFraction === null) return [];
  const kind = kindForDuration(quota.windowMinutes);
  return [{
    id: 'quota',
    kind,
    label: labelForKind(kind),
    usedPercent: Math.max(0, Math.min(100, (1 - quota.remainingFraction) * 100)),
    resetsAt: quota.resetsAt,
    windowMinutes: quota.windowMinutes,
  }];
}

/** Display label for a probe window name; duration wins, names cover the rest. */
function windowLabel(name: string, kind: QuotaWindowKind): string {
  if (name === 'individualLimit') return 'Monthly credit limit';
  if (name === 'spend') return 'Monthly spend';
  if (name.startsWith('seven_day_') && name.length > 10) {
    const model = name.slice(10).split('_').filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
    return `Weekly · ${model}`;
  }
  if (kind !== 'other') return labelForKind(kind);
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Remaining bar with a pace tick: filled = remaining, `|` marks where
 * remaining should be at even pace (null pace = no tick). Width is the
 * bar's character count excluding the tick.
 */
export function limitBar(window: QuotaWindowDetail, width: number, nowMs: number): string {
  const remaining = remainingPercent(window);
  const filled = Math.round((remaining / 100) * width);
  const cells: string[] = Array.from({ length: width }, (_, i) => (i < filled ? '█' : '░'));
  const elapsed = elapsedShare(window, nowMs);
  if (elapsed !== null) {
    // Pace tick at the even-pace remaining position.
    const tick = Math.max(0, Math.min(width - 1, Math.round(((1 - elapsed) * width)) - 1));
    cells[tick] = '|';
  }
  return cells.join('');
}

function renderWindow(window: QuotaWindowDetail, nowMs: number): string {
  const remaining = remainingPercent(window);
  const bar = limitBar(window, 16, nowMs);
  const resets = formatResetsIn(window.resetsAt, nowMs);
  const pace = paceOf(window, nowMs);
  const paceText = pace === 'ahead' ? ' · ahead of pace' : pace === 'under' ? ' · under pace' : '';
  const label = window.label.padEnd(22);
  return `  ${label} ${String(remaining).padStart(3)}% left  ${bar}${resets ? `  ${resets}` : ''}${paceText}`;
}

/** Plain-text limits view for every backend, T3's Usage > Limits in spirit. */
export function renderLimits(snapshots: BackendSnapshot[], now: Date = new Date()): string[] {
  const nowMs = now.getTime();
  const lines: string[] = [];
  for (const snapshot of snapshots) {
    const name = BACKEND_DISPLAY_NAMES[snapshot.id];
    const quota = snapshot.quota;
    const header = snapshot.status === 'disabled'
      ? `${name} — disabled (${snapshot.note ?? 'not enabled'})`
      : snapshot.status === 'cooling-down'
        ? `${name} — cooling down until ${quota.coolingUntil ?? 'unknown'}`
        : quota.source === 'manual'
          ? `${name} — MANUAL entry, updated ${formatAge(quota.observedAt, nowMs)}`
          : quota.source === 'probe'
            ? `${name} — updated ${formatAge(quota.observedAt, nowMs)}`
            : `${name}`;
    lines.push(header);
    const windows = normalizeWindows(quota);
    if (windows.length === 0) {
      lines.push(`  ${snapshot.note ?? 'quota unknown'}`);
    } else {
      for (const window of windows) lines.push(renderWindow(window, nowMs));
    }
    if (quota.resetCredits && quota.resetCredits.availableCount > 0) {
      const expiry = quota.resetCredits.nextExpiresAt
        ? ` (next expires ${formatResetsIn(quota.resetCredits.nextExpiresAt, nowMs) ?? quota.resetCredits.nextExpiresAt})`
        : '';
      lines.push(`  Reset credits: ${quota.resetCredits.availableCount} available${expiry}`);
    }
    lines.push('');
  }
  // Drop the trailing blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}
