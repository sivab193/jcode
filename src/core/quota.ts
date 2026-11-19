import { readFile, writeFile } from 'node:fs/promises';
import { ensureStateHome, loadConfig, statePaths } from '../config.js';
import { detectBackendAuth } from './auth.js';
import { BACKEND_BINARIES, MANUAL_TTL_MS, PROBE_TTL_MS, cliInfo, probeBackend } from './probes.js';
import { BACKEND_IDS, type BackendId, type BackendSnapshot, type QuotaMode, type QuotaWindow } from './types.js';

export type QuotaState = Partial<Record<BackendId, QuotaWindow>>;

const models: Record<BackendId, string> = {
  'codex-a': 'vendor default',
  'codex-b': 'vendor default',
  kiro: 'vendor default',
  agy: 'vendor default',
  copilot: 'auto',
  opencode: 'free model',
  claude: 'disabled pending Pro',
};

const defaultNames: Record<BackendId, string> = {
  'codex-a': 'Codex A',
  'codex-b': 'Codex B',
  kiro: 'Kiro',
  agy: 'Antigravity',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  claude: 'Claude',
};

function nextCalendarMonth(from = new Date()): string {
  return new Date(from.getFullYear(), from.getMonth() + 1, 1, 0, 0, 0, 0).toISOString();
}

export async function readQuotaState(): Promise<QuotaState> {
  try {
    return JSON.parse(await readFile(statePaths().quota, 'utf8')) as QuotaState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeQuotaState(state: QuotaState): Promise<void> {
  await ensureStateHome();
  await writeFile(statePaths().quota, `${JSON.stringify(state, null, 2)}\n`);
}

function placeholder(now: string): QuotaWindow {
  return {
    remainingFraction: null,
    resetsAt: null,
    windowMinutes: null,
    source: 'placeholder',
    observedAt: now,
  };
}

/**
 * Run every probe whose cached value is stale, then merge results into state.
 * A probe result always replaces a manual value when it succeeds. Manual
 * values past their TTL are dropped back to placeholder. Cooling-down
 * markers survive a probe refresh — only time (or a successful run) clears
 * them. Returns the merged state.
 */
export async function refreshProbes(): Promise<QuotaState> {
  const [state, config] = await Promise.all([readQuotaState(), loadConfig()]);
  const now = Date.now();
  const next: QuotaState = { ...state };
  const toProbe: BackendId[] = [];

  for (const id of BACKEND_IDS) {
    // Without a separate home, codex-b is the same account as codex-a. Do not
    // probe it or retain a duplicated quota window that looks like a second pool.
    if (id === 'codex-b' && !config.codexHomes.b) {
      delete next[id];
      continue;
    }
    const current = state[id];
    // Manual entries age out.
    if (current?.source === 'manual' && current.manualExpiresAt && Date.parse(current.manualExpiresAt) <= now) {
      delete next[id];
    }
    // Expired cooldowns clear.
    if (current?.coolingUntil && Date.parse(current.coolingUntil) <= now) {
      const { coolingUntil: _dropped, ...rest } = current;
      next[id] = rest;
    }
    // Fresh probe results are still good — vendors update at >= 5 min granularity.
    if (current?.source === 'probe' && now - Date.parse(current.observedAt) < PROBE_TTL_MS) continue;
    toProbe.push(id);
  }
  // Probes are independent — run them in parallel so `status` stays fast.
  const results = await Promise.all(
    toProbe.map(async (id) => ({ id, probed: await probeBackend(id, config).catch(() => null) })),
  );
  for (const { id, probed } of results) {
    if (!probed) continue;
    // Preserve an active cooldown marker across the refresh.
    const coolingUntil = next[id]?.coolingUntil;
    next[id] = coolingUntil && Date.parse(coolingUntil) > now ? { ...probed, coolingUntil } : probed;
  }
  await writeQuotaState(next);
  return next;
}

/** Manual quota entry (TUI `m` key): remaining fraction + reset time, marked MANUAL. */
export async function setManualQuota(id: BackendId, remainingFraction: number, resetsAt: string | null): Promise<void> {
  if (remainingFraction < 0 || remainingFraction > 1) throw new Error('remaining fraction must be between 0 and 1');
  const state = await readQuotaState();
  const now = new Date();
  state[id] = {
    remainingFraction,
    resetsAt,
    windowMinutes: null,
    source: 'manual',
    observedAt: now.toISOString(),
    manualExpiresAt: new Date(now.getTime() + MANUAL_TTL_MS).toISOString(),
  };
  await writeQuotaState(state);
}

/** Mark a backend cooling-down until its reset (after a rate-limit failure). */
export async function markCoolingDown(id: BackendId, untilIso: string | null): Promise<void> {
  const state = await readQuotaState();
  const current = state[id] ?? placeholder(new Date().toISOString());
  state[id] = { ...current, coolingUntil: untilIso ?? new Date(Date.now() + 60 * 60 * 1000).toISOString() };
  await writeQuotaState(state);
}

/**
 * Snapshots for status/TUI/policy. Availability is honest: a backend is
 * 'available' only when its CLI binary is present on this machine, it is not
 * disabled, and it is not cooling down. Set `refresh` to run probes first
 * (status does; the TUI refreshes on `r`).
 */
export async function backendSnapshots(options?: { refresh?: boolean }): Promise<BackendSnapshot[]> {
  const state = options?.refresh ? await refreshProbes() : await readQuotaState();
  const config = await loadConfig();
  const now = new Date().toISOString();
  const nowMs = Date.now();

  const details = await Promise.all(
    BACKEND_IDS.map(async (id) => ({
      id,
      info: await cliInfo(BACKEND_BINARIES[id]),
      authProvider: await detectBackendAuth(id, config),
    })),
  );
  const infoById = new Map(details.map(({ id, info }) => [id, info]));
  const authById = new Map(details.map(({ id, authProvider }) => [id, authProvider]));

  return BACKEND_IDS.map((id) => {
    let quota = state[id] ?? placeholder(now);
    const disabled = id === 'claude' && !config.claudeEnabled;
    const info = infoById.get(id) ?? { present: false };
    const cooling = !!quota.coolingUntil && Date.parse(quota.coolingUntil) > nowMs;
    // codex-b without its own CODEX_HOME would silently use account A's login
    // and double-count one pool — treat it as unavailable, not available.
    const missingHome = id === 'codex-b' && !config.codexHomes.b;
    const exhausted = quota.remainingFraction === 0 && id === 'kiro';
    if (id === 'kiro' && (exhausted || quota.remainingFraction !== null) && !quota.resetsAt) {
      quota = { ...quota, resetsAt: nextCalendarMonth(), windowMinutes: 43_200 };
    }
    const status = disabled ? 'disabled'
      : exhausted ? 'cooling-down'
      : cooling ? 'cooling-down'
        : !info.present || missingHome ? 'unavailable'
          : 'available';
    const authProvider = authById.get(id) ?? undefined;
    const loginStatus = missingHome ? 'setup' as const
      : authProvider ? 'active' as const
        : disabled ? 'disabled' as const
          : 'logged-out' as const;
    const quotaMode: QuotaMode = quota.remainingFraction !== null ? 'window'
      : id === 'agy' || id === 'copilot' || id === 'kiro' ? 'reactive'
        : id === 'opencode' || id === 'claude' ? 'provider'
          : 'unknown';
    const note = disabled ? 'Claude Pro not confirmed'
      : exhausted ? 'monthly limit reached · renews at the start of next month'
      : cooling ? `cooling down until ${quota.coolingUntil}`
        : !info.present ? `${BACKEND_BINARIES[id]} not installed`
          : missingHome ? 'no CODEX_HOME configured (SCODE_CODEX_B_HOME)'
            : quota.source === 'placeholder' && quotaMode === 'reactive' ? 'limits detected during runs'
              : quota.source === 'placeholder' && id === 'opencode' ? 'quota belongs to the selected provider'
                : quota.source === 'placeholder' && id === 'claude' ? 'provider-metered usage'
                  : quota.source === 'placeholder' ? 'quota probe unavailable'
              : quota.source === 'manual' ? 'MANUAL entry'
                : undefined;
    const profile = config.backendProfiles?.[id];
    const model = id === 'opencode' ? config.opencodeModel : models[id];
    return {
      id,
      displayName: profile?.label?.trim() || defaultNames[id],
      accountLabel: profile?.account?.trim() || undefined,
      loginStatus,
      model,
      status,
      quota,
      cliPresent: info.present,
      cliVersion: info.version,
      authProvider,
      quotaMode,
      note,
    };
  });
}
