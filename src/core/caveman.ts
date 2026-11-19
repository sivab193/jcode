/**
 * Phase 3 — Caveman token-efficiency layer (handoff §7).
 *
 * The router spawns the caveman'd CLIs (`caveman codex`, ...) instead of the
 * bare ones, per backend, when enabled. Caveman's native routing is not
 * configured (the router's policy stage does that job locally), and telemetry
 * stays OFF (`DO_NOT_TRACK=1` is set on every wrapped spawn; also run
 * `caveman telemetry off` once after install).
 *
 * What scode takes from Caveman:
 * - Read less: the local proxy compresses tool output before the model reads
 *   it (their number: 33.2% fewer input tokens/session; originals stay on disk).
 * - Say less: concise voice — honest baseline, `/caveman` is only ~3% shorter
 *   than "Answer concisely." on modern models, `/ultracave` ~35% more.
 * - Blocks: reusable scripts kept in the repo — use Blocks for quick script
 *   reuse, the MCP tools (Phase 4) for real operations, never both for one job.
 *
 * If the proxy does not play well with headless `exec`, set mode to
 * `skill-only` (install via `npx skills add JuliusBrussee/caveman -g`) and
 * keep the proxy for interactive sessions. The doctor's `--full` wrap test
 * checks this per machine.
 *
 * Measurement: every run records `cavemanWrapped` in the ledger, and
 * `scode learn` (Phase 5) compares tokens on vs off per backend/task class.
 * No measurement is claimed until real runs exist.
 */
import type { SpawnSpec } from '../adapters/process.js';
import type { ScodeConfig } from '../config.js';
import { cliInfo } from './probes.js';
import type { BackendId } from './types.js';

export interface CavemanConfig {
  enabled: boolean;
  mode: 'proxy' | 'skill-only';
  perBackend: Partial<Record<BackendId, boolean>>;
}

export const CAVEMAN_DEFAULTS: CavemanConfig = {
  enabled: false,
  mode: 'proxy',
  perBackend: {},
};

export function cavemanEnabledFor(config: ScodeConfig, backend: BackendId): boolean {
  const caveman = config.caveman ?? CAVEMAN_DEFAULTS;
  if (!caveman.enabled) return false;
  // Per-backend switch wins when set; otherwise the global switch applies.
  return caveman.perBackend?.[backend] ?? true;
}

let warnedMissing = false;

/**
 * Wrap a spawn spec with the Caveman proxy when enabled for this backend.
 * Never fails a job: if the binary is missing, warn once and run bare.
 */
export async function wrapSpawn(
  spec: SpawnSpec,
  backend: BackendId,
  config: ScodeConfig,
): Promise<{ spec: SpawnSpec; wrapped: boolean }> {
  const caveman = config.caveman ?? CAVEMAN_DEFAULTS;
  if (!cavemanEnabledFor(config, backend) || caveman.mode !== 'proxy') {
    return { spec, wrapped: false };
  }
  const info = await cliInfo('caveman');
  if (!info.present) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.error('[scode] caveman is enabled but not installed — running bare. Install with `npx @caveman-ai/cli@latest`, then `caveman telemetry off`.');
    }
    return { spec, wrapped: false };
  }
  return {
    spec: {
      command: 'caveman',
      args: [spec.command, ...spec.args],
      env: { ...spec.env, DO_NOT_TRACK: '1' },
    },
    wrapped: true,
  };
}
