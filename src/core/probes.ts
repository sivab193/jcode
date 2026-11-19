/**
 * Quota probes — one record per backend/account/window, normalized to
 * { remainingFraction, resetsAt, windowMinutes } (handoff §5).
 *
 * Probes first, manual fallback: a probe result always replaces a manual
 * value when it next succeeds. Every probe is best-effort and time-boxed;
 * a failed probe returns null (unknown), never a fabricated number.
 */
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScodeConfig } from '../config.js';
import type { BackendId, QuotaWindow } from './types.js';

export const PROBE_TIMEOUT_MS = 30_000;
/** Vendors update usage at >= 5 min granularity; probing faster is noise. */
export const PROBE_TTL_MS = 5 * 60 * 1000;
/** Manual entries age out after a day — stale numbers are worse than unknown. */
export const MANUAL_TTL_MS = 24 * 60 * 60 * 1000;

function windowFrom(
  remainingFraction: number | null,
  resetsAt: string | null,
  windowMinutes: number | null,
  extra?: Partial<QuotaWindow>,
): QuotaWindow {
  // Round to 4 decimals: 1 - 80/100 is 0.19999999999999996 in IEEE-754,
  // and quota comparisons should not trip on float noise.
  const rounded = remainingFraction === null ? null : Math.round(remainingFraction * 10_000) / 10_000;
  return {
    remainingFraction: rounded,
    resetsAt,
    windowMinutes,
    source: 'probe',
    observedAt: new Date().toISOString(),
    ...extra,
  };
}

function runCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: null });
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > 1_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null });
    });
    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

// ─── Codex: app-server JSON-RPC account/rateLimits/read ─────────────────────
// Consumes no quota. One JSON-RPC request over stdio; the server prints
// newline-delimited JSON responses. Windows: 5h (300) / weekly (10080) /
// monthly (43200). The 5h window has been suspended for many accounts since
// ~Jul 2026 — handle absent windows, never assume them.

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  windowDurationMins?: number;
  resetsAt?: string | number | null;
}

function normalizeResetTime(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  // App-server currently emits Unix seconds; accept milliseconds defensively.
  const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseCodexRateLimits(payload: unknown): QuotaWindow | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as Record<string, unknown>;
  // Response envelope: { jsonrpc, id, result: {...} } — accept both shapes.
  const result = (root.result ?? root) as Record<string, unknown>;
  // Model-specific snapshots live under rateLimitsByLimitId; the 'codex'
  // entry is the account-wide one T3 uses. Anything else is not the
  // binding constraint for routing, so never mix it into the windows.
  const byLimitId = result.rateLimitsByLimitId as Record<string, unknown> | undefined;
  const snapshot = (byLimitId?.codex as Record<string, unknown> | undefined) ?? result;
  const windowsRaw = snapshot.rateLimits ?? snapshot.windows ?? snapshot;
  if (typeof windowsRaw !== 'object' || windowsRaw === null) return null;
  const planType = typeof snapshot.planType === 'string' ? snapshot.planType
    : typeof (windowsRaw as Record<string, unknown>).planType === 'string'
      ? (windowsRaw as Record<string, unknown>).planType as string
      : undefined;
  // Free/go plans have no 5h window — their primary window is monthly.
  const primaryMinutes = planType === 'free' || planType === 'go' ? 43200 : 0;

  const windows: Array<{ name: string; remainingFraction: number; resetsAt: string | null; windowMinutes: number }> = [];
  for (const [name, value] of Object.entries(windowsRaw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const w = value as CodexRateLimitWindow & Record<string, unknown>;
    const used = typeof w.usedPercent === 'number' ? w.usedPercent
      : typeof w.used_percent === 'number' ? w.used_percent
        : typeof w.percentUsed === 'number' ? w.percentUsed
          : null;
    if (used === null || Number.isNaN(used)) continue;
    const windowMinutes =
      typeof w.windowMinutes === 'number' ? w.windowMinutes
        : typeof w.windowDurationMins === 'number' ? w.windowDurationMins
        : name.includes('5h') || name.includes('five') ? 300
          : name.includes('week') ? 10080
            : name.includes('month') ? 43200
              : name === 'primary' ? primaryMinutes
                : 0;
    const resetsAt = normalizeResetTime(w.resetsAt ?? w.resets_at ?? w.resetAt);
    windows.push({ name, remainingFraction: Math.round(Math.max(0, 1 - used / 100) * 10_000) / 10_000, resetsAt, windowMinutes });
  }
  // Monthly credit limit: reported as remaining, not used.
  const individual = (snapshot.individualLimit ?? (windowsRaw as Record<string, unknown>).individualLimit) as Record<string, unknown> | undefined;
  if (individual && typeof individual.remainingPercent === 'number') {
    windows.push({
      name: 'individualLimit',
      remainingFraction: Math.round(Math.max(0, individual.remainingPercent / 100) * 10_000) / 10_000,
      resetsAt: normalizeResetTime(individual.resetsAt ?? individual.resets_at),
      windowMinutes: 43200,
    });
  }
  if (windows.length === 0) return null;
  // The binding constraint is the tightest window.
  const tightest = windows.reduce((a, b) => (a.remainingFraction <= b.remainingFraction ? a : b));
  return windowFrom(tightest.remainingFraction, tightest.resetsAt, tightest.windowMinutes, {
    windows,
    ...(planType ? { planType } : {}),
    ...readResetCredits(result.resetCredits ?? snapshot.resetCredits),
  });
}

function readResetCredits(value: unknown): { resetCredits?: { availableCount: number; nextExpiresAt?: string } } {
  if (typeof value !== 'object' || value === null) return {};
  const credits = value as { availableCount?: unknown; credits?: unknown };
  if (typeof credits.availableCount !== 'number') return {};
  const out: { availableCount: number; nextExpiresAt?: string } = { availableCount: credits.availableCount };
  if (Array.isArray(credits.credits)) {
    let earliest: number | null = null;
    for (const credit of credits.credits) {
      if (typeof credit !== 'object' || credit === null) continue;
      const c = credit as { status?: unknown; expiresAt?: unknown };
      if (c.status !== 'available') continue;
      const ms = typeof c.expiresAt === 'number' ? c.expiresAt * 1000
        : typeof c.expiresAt === 'string' ? new Date(c.expiresAt).getTime() : NaN;
      if (Number.isFinite(ms) && (earliest === null || ms < earliest)) earliest = ms;
    }
    if (earliest !== null) out.nextExpiresAt = new Date(earliest).toISOString();
  }
  return { resetCredits: out };
}

/**
 * Parse the reset time out of a Codex rate-limit error ("Try again at 3:37 PM."
 * or "try again at Nov 11th, 2026 3:37 PM."). Codex drops seconds, so the
 * result is one minute past the printed time. Null when no usable time is
 * in the message or the time is not in the future. T3 does the same parse;
 * this is the only reset signal when a proxy strips the snapshot.
 */
export function parseCodexResetFromMessage(message: string, failedAt: Date): string | null {
  const match = message.match(/[Tt]ry again at (?:([A-Z][a-z]{2}) (\d{1,2})(?:st|nd|rd|th), (\d{4}) )?(\d{1,2}):(\d{2}) ([AP]M)\./);
  if (!match) return null;
  const [, monthName, day, year, hour, minute, meridiem] = match;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthName ? months.indexOf(monthName) : failedAt.getMonth();
  const date = new Date(
    year ? Number(year) : failedAt.getFullYear(),
    month,
    day ? Number(day) : failedAt.getDate(),
    (Number(hour) % 12) + (meridiem === 'PM' ? 12 : 0),
    Number(minute),
  );
  date.setMinutes(date.getMinutes() + 1);
  return date.getTime() > failedAt.getTime() ? date.toISOString() : null;
}

function readCodexRateLimits(env: NodeJS.ProcessEnv): Promise<unknown | null> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      env,
      shell: false,
      windowsHide: true,
    });
    let buffer = '';
    let settled = false;
    const finish = (value: unknown | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    timer.unref();

    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const boundary = buffer.indexOf('\n');
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith('{')) continue;
        try {
          const message = JSON.parse(line) as { id?: number; result?: unknown };
          if (message.id === 1) {
            child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
            child.stdin.write(`${JSON.stringify({
              id: 2,
              method: 'account/rateLimits/read',
              params: { excludeResetCreditDetails: false },
            })}\n`);
          } else if (message.id === 2) {
            finish(message);
          }
        } catch {
          // Non-protocol output is ignored; keep scanning until timeout.
        }
      }
    });

    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'scode', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    })}\n`);
  });
}

export async function probeCodex(config: ScodeConfig, account: 'a' | 'b'): Promise<QuotaWindow | null> {
  const home = account === 'a' ? config.codexHomes.a : config.codexHomes.b;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (home) env.CODEX_HOME = home;
  return parseCodexRateLimits(await readCodexRateLimits(env));
}

// ─── Kiro: `kiro-cli chat --no-interactive "/usage"` ─────────────────────────
// Output format is vendor-controlled text; parse flexibly. If the shape is
// unrecognised, return null rather than guessing.

export function parseKiroUsage(output: string): QuotaWindow | null {
  const text = output.replace(/\u001b\[[0-9;]*m/g, ''); // strip ANSI
  if (/monthly usage limit|usage limit reached|reached your monthly/i.test(text)) {
    const renewalMatch = text.match(/(?:renew(?:s|al)?|reset)[^\d]{0,20}(\d+)\s*(day|days|hour|hours|week|weeks)/i);
    let resetsAt: string | null = null;
    if (renewalMatch) {
      const amount = Number(renewalMatch[1]);
      const unit = renewalMatch[2].toLowerCase();
      const multiplier = unit.startsWith('week') ? 7 * 86_400_000
        : unit.startsWith('day') ? 86_400_000
          : 3_600_000;
      resetsAt = new Date(Date.now() + amount * multiplier).toISOString();
    }
    return windowFrom(0, resetsAt, null);
  }
  // Look for "X% used" / "used: X%" / "remaining: Y%".
  const usedMatch = text.match(/used[^0-9]{0,12}(\d+(?:\.\d+)?)\s*%/i);
  const remainingMatch = text.match(/remain[^0-9]{0,12}(\d+(?:\.\d+)?)\s*%/i);
  let remaining: number | null = null;
  if (remainingMatch) remaining = Number(remainingMatch[1]) / 100;
  else if (usedMatch) remaining = Math.max(0, 1 - Number(usedMatch[1]) / 100);
  if (remaining === null || Number.isNaN(remaining)) return null;
  // Reset: "resets <date>" / "reset at <date>" — accept ISO-ish dates only.
  const resetMatch = text.match(/resets?\b[^0-9]{0,12}([0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.+-Zz]*)/i);
  const resetsAt = resetMatch ? new Date(resetMatch[1]).toISOString() : null;
  return windowFrom(remaining, Number.isNaN(Date.parse(resetsAt ?? '')) ? null : resetsAt, null);
}

export async function probeKiro(): Promise<QuotaWindow | null> {
  const { stdout, stderr, exitCode } = await runCapture(
    'kiro-cli',
    ['chat', '--no-interactive', '/usage'],
    process.env,
    PROBE_TIMEOUT_MS,
  );
  const parsed = parseKiroUsage(`${stdout}\n${stderr}`);
  if (parsed) return parsed;
  if (exitCode !== 0) return null;
  return null;
}

// ─── agy: community reader against the undocumented local gRPC endpoint ─────
// Weakest probe — design for it failing. If the reader is absent, return null
// and the router degrades to reactive mode (per-run usage + 429s).

export async function probeAgy(): Promise<QuotaWindow | null> {
  const { stdout, exitCode } = await runCapture('agy-cli-usage', ['--json'], process.env, PROBE_TIMEOUT_MS);
  if (exitCode !== 0 || !stdout.trim()) return null;
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const remaining =
      typeof data.remainingFraction === 'number' ? data.remainingFraction
        : typeof data.remainingPercent === 'number' ? data.remainingPercent / 100
          : typeof data.usedPercent === 'number' ? Math.max(0, 1 - data.usedPercent / 100)
            : null;
    if (remaining === null || Number.isNaN(remaining)) return null;
    const resetsAt = typeof data.resetsAt === 'string' ? data.resetsAt : null;
    return windowFrom(remaining, resetsAt, null);
  } catch {
    return null;
  }
}

// ─── Copilot: no account-level quota via the CLI ─────────────────────────────
// Per-run accounting comes from the final `result` event's `usage`
// (premiumRequests) in the copilot adapter. Account-level remaining needs
// GitHub's Copilot billing/usage API or a community reader — not wired here,
// so this probe honestly returns null. Exit code 3 (limit reached) is the
// hard signal and is handled in the adapter/dispatcher, not the probe.

export async function probeCopilot(): Promise<QuotaWindow | null> {
  return null;
}

// ─── OpenCode: no native quota (bring-your-own-provider) ─────────────────────
// Usage lives in local logs; `ccusage` turns them into tokens + cost, which is
// spend, not remaining. There is no remaining-fraction to report, so the probe
// returns null and the TUI says so. If OpenCode points at a subscription pool
// (ChatGPT/Copilot), its runs draw on the SAME pool as the codex/copilot
// adapters — never treat it as free capacity.

export async function probeOpencode(): Promise<QuotaWindow | null> {
  return null;
}

// ─── Claude: status-line rate_limits file ────────────────────────────────────
// v2.1.80+ status lines expose five_hour / seven_day with used_percentage +
// resets_at. A status-line script writes these to a file the router reads
// (updates only when Claude Code runs). Probe only — the adapter stays
// disabled until Pro is confirmed live. Path override: SCODE_CLAUDE_RATE_LIMITS_FILE.

export function parseClaudeRateLimits(payload: unknown): QuotaWindow | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const limits = (root.rate_limits ?? root) as Record<string, unknown>;
  const windows: Array<{ name: string; remainingFraction: number; resetsAt: string | null; windowMinutes: number }> = [];
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const w = value as Record<string, unknown>;
    const used = typeof w.used_percentage === 'number' ? w.used_percentage
      : typeof w.usedPercent === 'number' ? w.usedPercent
        : typeof w.utilization === 'number' ? w.utilization : null;
    if (used === null || Number.isNaN(used)) continue;
    const resetsAt = typeof w.resets_at === 'string' ? w.resets_at
      : typeof w.resetsAt === 'string' ? w.resetsAt : null;
    windows.push({
      name,
      remainingFraction: Math.round(Math.max(0, 1 - used / 100) * 10_000) / 10_000,
      resetsAt,
      windowMinutes: name.includes('five') ? 300 : name.includes('seven') ? 10080 : 0,
    });
  }
  // Per-model weekly windows from the SDK (T3: "Weekly · <Model>").
  const scoped = limits.model_scoped;
  if (Array.isArray(scoped)) {
    for (const entry of scoped) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const used = typeof e.utilization === 'number' ? e.utilization
        : typeof e.used_percentage === 'number' ? e.used_percentage : null;
      if (typeof e.display_name !== 'string' || used === null || Number.isNaN(used)) continue;
      const token = e.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      windows.push({
        name: `seven_day_${token}`,
        remainingFraction: Math.round(Math.max(0, 1 - used / 100) * 10_000) / 10_000,
        resetsAt: typeof e.resets_at === 'string' ? e.resets_at : typeof e.resetsAt === 'string' ? e.resetsAt : null,
        windowMinutes: 10080,
      });
    }
  }
  // Monthly spend budget, when the SDK reports one.
  const spend = readClaudeSpendPercent(limits);
  if (spend !== null) {
    windows.push({
      name: 'spend',
      remainingFraction: Math.round(Math.max(0, 1 - spend / 100) * 10_000) / 10_000,
      resetsAt: null,
      windowMinutes: 43200,
    });
  }
  if (windows.length === 0) return null;
  const tightest = windows.reduce((a, b) => (a.remainingFraction <= b.remainingFraction ? a : b));
  return windowFrom(tightest.remainingFraction, tightest.resetsAt, tightest.windowMinutes, { windows });
}

/** Spend usage as a percent (0–100), or null when unreported. */
function readClaudeSpendPercent(limits: Record<string, unknown>): number | null {
  const spend = limits.spend as Record<string, unknown> | undefined;
  if (spend) {
    // SDK minor-unit shape: { used: { amount_minor, currency, exponent }, limit: {...} }.
    const used = spend.used as Record<string, unknown> | undefined;
    const limit = spend.limit as Record<string, unknown> | undefined;
    if (used && limit && typeof used.amount_minor === 'number' && typeof limit.amount_minor === 'number'
      && limit.amount_minor > 0 && used.currency === limit.currency && used.exponent === limit.exponent) {
      return (used.amount_minor / limit.amount_minor) * 100;
    }
    // Flat shape, same currency/exponent guard.
    if (typeof spend.used === 'number' && typeof spend.limit === 'number' && spend.limit > 0
      && typeof spend.currency === 'string' && typeof spend.exponent === 'number') {
      return (spend.used / spend.limit) * 100;
    }
  }
  const extra = limits.extra_usage as Record<string, unknown> | undefined;
  if (extra) {
    if (typeof extra.used_credits === 'number' && typeof extra.monthly_limit === 'number' && extra.monthly_limit > 0) {
      return (extra.used_credits / extra.monthly_limit) * 100;
    }
    if (typeof extra.utilization === 'number') return extra.utilization;
  }
  return null;
}

export async function probeClaude(): Promise<QuotaWindow | null> {
  const file = process.env.SCODE_CLAUDE_RATE_LIMITS_FILE
    ?? process.env.JCODE_CLAUDE_RATE_LIMITS_FILE
    ?? join(homedir(), '.scode', 'claude-rate-limits.json');
  try {
    const text = await readFile(file, 'utf8');
    return parseClaudeRateLimits(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

export async function probeBackend(id: BackendId, config: ScodeConfig): Promise<QuotaWindow | null> {
  switch (id) {
    case 'codex-a': return probeCodex(config, 'a');
    case 'codex-b': return probeCodex(config, 'b');
    case 'kiro': return probeKiro();
    case 'agy': return probeAgy();
    case 'copilot': return probeCopilot();
    case 'opencode': return probeOpencode();
    case 'claude': return probeClaude();
    default: return null;
  }
}

/**
 * Is `binary` on PATH? Returns the version string when it answers.
 * Only a spawn failure (ENOENT) means absent — a binary that runs but exits
 * non-zero on its version flag (pdftotext --version exits 1) is present.
 */
export function cliInfo(binary: string, versionArgs: string[] = ['--version']): Promise<{ present: boolean; version?: string }> {
  return new Promise((resolve) => {
    execFile(binary, versionArgs, { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (process.platform !== 'win32') return resolve({ present: false });
        // npm-installed CLIs commonly exist only as .cmd shims. execFile may
        // report ENOENT for those even though CreateProcess/where can find the
        // command. Presence is enough here; adapters validate execution.
        execFile('where.exe', [binary], { timeout: 5_000, windowsHide: true }, (whereError, whereStdout) => {
          resolve({ present: !whereError && whereStdout.trim().length > 0 });
        });
        return;
      }
      const text = `${stdout}${stderr}`.trim().split('\n')[0]?.trim() ?? '';
      resolve({ present: true, version: text || undefined });
    });
  });
}

export const BACKEND_BINARIES: Record<BackendId, string> = {
  'codex-a': 'codex',
  'codex-b': 'codex',
  kiro: 'kiro-cli',
  agy: 'agy',
  copilot: 'copilot',
  opencode: 'opencode',
  claude: 'claude',
};
