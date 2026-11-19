import { loadConfig } from '../config.js';
import { wrapSpawn } from '../core/caveman.js';
import type { RunRequest } from '../core/types.js';
import { runProcess } from './process.js';
import type { AdapterCallbacks, BackendAdapter } from './types.js';

/**
 * Claude Code: `claude -p "<brief>" --output-format json
 * --permission-mode acceptEdits --max-turns N` (handoff §5). JSON envelope
 * carries `result`, `session_id`, usage and `total_cost_usd`.
 *
 * DISABLED by default behind the double-gate (config `claudeEnabled` AND
 * env `SCODE_CLAUDE_ENABLED=true`) until Claude Pro is live and its smoke
 * test passes. The adapter refuses to run while disabled — the policy and
 * dispatcher also exclude it, so this is the third lock, not the only one.
 *
 * v2.1.302+ defaults `-p` to Manual permission mode, so the permission mode
 * is always set explicitly. Never `--dangerously-skip-permissions`.
 */
export class ClaudeAdapter implements BackendAdapter {
  async run(request: RunRequest, callbacks: AdapterCallbacks) {
    const config = await loadConfig();
    if (!config.claudeEnabled) {
      throw new Error('claude is disabled until Claude Pro is confirmed and its smoke test passes');
    }
    const args = [
      '-p', request.brief,
      '--output-format', 'json',
      '--permission-mode', 'acceptEdits',
      '--max-turns', String(config.claudeMaxTurns ?? 25),
    ];
    if (request.sessionId) args.push('--resume', request.sessionId);
    if (config.claudeMaxBudgetUsd !== undefined) {
      args.push('--max-budget-usd', String(config.claudeMaxBudgetUsd));
    }
    if (config.claudeMcpConfig) args.push('--mcp-config', config.claudeMcpConfig);
    const { spec, wrapped } = await wrapSpawn({ command: 'claude', args }, request.backend, config);
    const result = await runProcess(spec, request, callbacks);
    return { ...result, cavemanWrapped: wrapped };
  }
}
