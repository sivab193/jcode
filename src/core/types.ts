export const BACKEND_IDS = [
  'codex-a',
  'codex-b',
  'kiro',
  'agy',
  'copilot',
  'opencode',
  'claude',
] as const;

export type BackendId = (typeof BACKEND_IDS)[number];

export const THEME_IDS = ['ember', 'classic', 'aurora', 'violet'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export type BackendStatus = 'available' | 'unavailable' | 'cooling-down' | 'disabled';

/** How scode learns about limits when a vendor does not expose a quota window. */
export type QuotaMode = 'window' | 'reactive' | 'provider' | 'unknown';

/** One quota window, normalized across backends (handoff §5). */
export interface QuotaWindow {
  remainingFraction: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
  source: 'probe' | 'manual' | 'placeholder';
  observedAt: string;
  /** All windows the probe reported (Codex has 5h/weekly/monthly). The top-level
   * fields carry the tightest window — the binding constraint. */
  windows?: Array<{ name: string; remainingFraction: number; resetsAt: string | null; windowMinutes: number }>;
  /** Codex reset credits (T3-style): one-shot window resets the user can spend. */
  resetCredits?: { availableCount: number; nextExpiresAt?: string };
  /** Codex plan type from the rate-limits snapshot (e.g. 'go', 'plus'). */
  planType?: string;
  /** Manual entries age out; a probe result always replaces them. */
  manualExpiresAt?: string;
  /** Set when a rate-limit failure put this backend into cooldown. */
  coolingUntil?: string;
}

export interface BackendSnapshot {
  id: BackendId;
  /** User-editable label shown in the TUI and formatted CLI output. */
  displayName?: string;
  /** Optional local-only account hint (email, handle, or mention). */
  accountLabel?: string;
  /** Authentication is independent from quota/usage. */
  loginStatus?: 'active' | 'logged-out' | 'setup' | 'disabled';
  status: BackendStatus;
  model: string;
  quota: QuotaWindow;
  /** CLI binary present on this machine (false => status 'unavailable'). */
  cliPresent: boolean;
  cliVersion?: string;
  /** Human-readable credential/provider path; never contains account names or secrets. */
  authProvider?: string;
  /** Window = numeric probe/manual value; reactive = limit errors; provider = provider billing/limits. */
  quotaMode?: QuotaMode;
  note?: string;
}

export interface RunRequest {
  taskId: string;
  brief: string;
  backend: BackendId;
  cwd: string;
  timeoutMs: number;
  /** Resume an earlier session instead of cold-starting (per-backend id). */
  sessionId?: string;
  /** Stop the vendor CLI process when the caller cancels this run. */
  signal?: AbortSignal;
  /** Print the exact command instead of running it. */
  dryRun?: boolean;
}

export type ErrorClass =
  | 'quota' // rate limit / quota exhausted — do not retry this account
  | 'capability' // agent ran but produced nothing usable
  | 'availability' // 5xx / network / MCP startup failure — retry sideways
  | 'timeout'
  | 'cancelled' // the user stopped the run — never fall back, never retry
  | 'backend-error'
  | 'auth';

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  /** Copilot's billing unit — track it, never ignore it. */
  premiumRequests?: number;
}

export interface RunResult {
  taskId: string;
  backend: BackendId;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  success: boolean;
  errorClass: ErrorClass | null;
  /** Session id captured from the run's JSON output, for follow-ups. */
  sessionId?: string;
  usage?: RunUsage;
  /** Last few KB of output, kept for error classification and debugging. */
  stdoutTail?: string;
  /** Worktree the job ran in (kept on failure for inspection/resume). */
  worktree?: string;
  /** True when the isolated worktree contains edits worth preserving. */
  hasChanges?: boolean;
  /** What this run fell back from, if anything. */
  fellBackFrom?: { backend: BackendId; errorClass: ErrorClass; reason: string };
  /** True when the run went through the Caveman proxy (Phase 3). */
  cavemanWrapped?: boolean;
}
