import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, renameSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { THEME_IDS, type BackendId, type ThemeId } from './core/types.js';

/**
 * Read a renamed env var, honoring the old `JCODE_*` name as a fallback so
 * existing shells and scripts keep working. The `SCODE_*` name wins when
 * both are set. The legacy names are undocumented going forward.
 */
export function envVar(primary: string, legacy: string): string | undefined {
  return process.env[primary] ?? process.env[legacy];
}

export interface BackendProfile {
  label?: string;
  account?: string;
}

export interface ScodeConfig {
  quotaFloor: number;
  defaultTimeoutMs: number;
  claudeEnabled: boolean;
  theme: ThemeId;
  codexHomes: { a?: string; b?: string };
  opencodeModel: string;
  /** Local display metadata only. Never used as a credential. */
  backendProfiles?: Partial<Record<BackendId, BackendProfile>>;
  /** Attach to a warm `opencode serve` to avoid MCP cold-boot. */
  opencodeAttachUrl?: string;
  /** Cap Copilot autonomous steps per run (premium-request budget). */
  copilotMaxContinues?: number;
  /** Claude `-p` turn cap (default 25). Only used when claude is enabled. */
  claudeMaxTurns?: number;
  /** Optional extra spend cap per run, passed as `--max-budget-usd`. */
  claudeMaxBudgetUsd?: number;
  /** Optional hermetic MCP config for claude (`--mcp-config`). */
  claudeMcpConfig?: string;
  /** Caveman token-efficiency layer (Phase 3). Off by default. */
  caveman?: {
    enabled?: boolean;
    mode?: 'proxy' | 'skill-only';
    perBackend?: Partial<Record<import('./core/types.js').BackendId, boolean>>;
  };
  /**
   * Graphify code graph. enabled: build/query the per-repo graph (default
   * true; set SCODE_GRAPHIFY=false or enabled: false to turn it off).
   * autoBuild: build the graph before dispatch when it is missing or stale
   * (default true). No-op when the graphify binary is not installed.
   */
  graphify?: {
    enabled?: boolean;
    autoBuild?: boolean;
  };
}

const defaults: ScodeConfig = {
  quotaFloor: 0.1,
  defaultTimeoutMs: 30 * 60 * 1000,
  claudeEnabled: false,
  theme: 'ember',
  codexHomes: {},
  opencodeModel: 'opencode/big-pickle',
};

let migrationAttempted = false;

export function stateHome(): string {
  const override = envVar('SCODE_HOME', 'JCODE_HOME');
  if (override) return resolve(override);
  const next = join(homedir(), '.scode');
  // One-time migration: an install that kept its state in ~/.jcode moves
  // wholesale to ~/.scode the first time the new name is used. Runs once
  // per process; a failed move leaves the old dir in place and is retried
  // next run (state is never written to both dirs).
  if (!migrationAttempted) {
    migrationAttempted = true;
    const legacy = join(homedir(), '.jcode');
    if (!existsSync(next) && existsSync(legacy)) {
      try {
        renameSync(legacy, next);
        console.error(`[scode] moved state from ~/.jcode to ~/.scode`);
      } catch {
        // Leave the old dir alone; the next run retries the move.
      }
    }
  }
  return resolve(next);
}

export const statePaths = () => ({
  home: stateHome(),
  config: join(stateHome(), 'config.json'),
  quota: join(stateHome(), 'quota.json'),
  ledger: join(stateHome(), 'ledger.jsonl'),
  lessons: join(stateHome(), 'lessons.md'),
  /** Per-task session ids, keyed by task id then backend (handoff §5). */
  sessions: join(stateHome(), 'sessions.json'),
  /** Resumable task metadata for `scode session list|attach`. */
  runs: join(stateHome(), 'runs.json'),
  /** Last `scode doctor` result (Phase 0 gate record). */
  smoke: join(stateHome(), 'smoke.json'),
  /** Last `scode learn` report (Phase 5). */
  learnReport: join(stateHome(), 'learn-report.md'),
  /** MCP tool-call log, for the Phase 5 dead-tool check. */
  toolCalls: join(stateHome(), 'tool-calls.jsonl'),
  /** Scheduled jobs (cron + one-shot). */
  schedules: join(stateHome(), 'schedules.json'),
  /** Threads (T3-style: one branch + worktree + session per thread). */
  threads: join(stateHome(), 'threads.json'),
});

export async function ensureStateHome(): Promise<void> {
  await mkdir(stateHome(), { recursive: true });
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEME_IDS.some((theme) => theme === value);
}

export async function loadConfig(): Promise<ScodeConfig> {
  await ensureStateHome();
  const paths = statePaths();
  let fromDisk: Partial<ScodeConfig> = {};
  try {
    fromDisk = JSON.parse(await readFile(paths.config, 'utf8')) as Partial<ScodeConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Missing config means defaults. Do not create it while reading: multiple
    // concurrent CLI/test processes could otherwise observe a partially
    // written JSON file on first launch.
  }

  return {
    ...defaults,
    ...fromDisk,
    theme: isThemeId(fromDisk.theme) ? fromDisk.theme : defaults.theme,
    claudeEnabled:
      envVar('SCODE_CLAUDE_ENABLED', 'JCODE_CLAUDE_ENABLED') === 'false'
        ? false
        : fromDisk.claudeEnabled === true,
    codexHomes: {
      ...defaults.codexHomes,
      ...fromDisk.codexHomes,
      a: envVar('SCODE_CODEX_A_HOME', 'JCODE_CODEX_A_HOME') || fromDisk.codexHomes?.a,
      b: envVar('SCODE_CODEX_B_HOME', 'JCODE_CODEX_B_HOME') || fromDisk.codexHomes?.b,
    },
    opencodeAttachUrl: envVar('SCODE_OPENCODE_ATTACH', 'JCODE_OPENCODE_ATTACH') || fromDisk.opencodeAttachUrl,
    caveman: {
      ...fromDisk.caveman,
      enabled: envVar('SCODE_CAVEMAN', 'JCODE_CAVEMAN') === 'true' ? true : (fromDisk.caveman?.enabled ?? false),
    },
    graphify: {
      ...fromDisk.graphify,
      enabled: envVar('SCODE_GRAPHIFY', 'JCODE_GRAPHIFY') === 'false' ? false : (fromDisk.graphify?.enabled ?? true),
      autoBuild: fromDisk.graphify?.autoBuild ?? true,
    },
  };
}

export async function setTheme(theme: ThemeId): Promise<void> {
  await updateConfig({ theme });
}

/** Atomically merge top-level config fields while preserving unknown settings. */
export async function updateConfig(patch: Partial<ScodeConfig>): Promise<void> {
  await ensureStateHome();
  const { config } = statePaths();
  let current: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(config, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid config object in ${config}`);
    }
    current = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${config}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, config);
}

export async function setBackendProfile(id: BackendId, profile: BackendProfile): Promise<void> {
  const config = await loadConfig();
  await updateConfig({
    backendProfiles: {
      ...config.backendProfiles,
      [id]: {
        ...config.backendProfiles?.[id],
        ...profile,
      },
    },
  });
}

export async function setOpenCodeModel(model: string): Promise<void> {
  const normalized = model === 'free' ? defaults.opencodeModel : model.trim();
  if (!normalized) throw new Error('OpenCode model cannot be empty');
  await updateConfig({ opencodeModel: normalized });
}

export async function setCodexHome(account: 'a' | 'b', path: string): Promise<void> {
  const config = await loadConfig();
  await updateConfig({ codexHomes: { ...config.codexHomes, [account]: resolve(path) } });
}
