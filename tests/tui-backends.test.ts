import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'ink';
import { BackendsPane } from '../dist/tui/BackendsPane.js';
import { THEMES } from '../dist/tui/theme.js';
import type { BackendSnapshot } from '../dist/core/types.js';

function backend(overrides: Partial<BackendSnapshot> & Pick<BackendSnapshot, 'id'>): BackendSnapshot {
  return {
    status: 'available',
    model: 'test',
    cliPresent: true,
    quota: {
      remainingFraction: null,
      resetsAt: null,
      windowMinutes: null,
      source: 'placeholder',
      observedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

test('backends pane separates login, usage, reset, and provider columns', () => {
  const originalColumns = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true });
  const output = renderToString(React.createElement(BackendsPane, {
    backends: [
      backend({
        id: 'codex-a', displayName: 'Codex', loginStatus: 'active', authProvider: 'ChatGPT',
        quota: {
          remainingFraction: 0.24, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
          windowMinutes: 10_080, source: 'probe', observedAt: new Date().toISOString(),
          windows: [
            { name: 'primary', remainingFraction: 0.74, resetsAt: new Date(Date.now() + 4 * 3_600_000).toISOString(), windowMinutes: 300 },
            { name: 'secondary', remainingFraction: 0.24, resetsAt: new Date(Date.now() + 5 * 86_400_000).toISOString(), windowMinutes: 10_080 },
          ],
        },
      }),
      backend({ id: 'codex-b', displayName: 'Codex school', loginStatus: 'setup', status: 'unavailable', note: 'no CODEX_HOME configured (SCODE_CODEX_B_HOME)' }),
      backend({ id: 'agy', displayName: 'Antigravity', loginStatus: 'active', quotaMode: 'reactive', authProvider: 'Google OAuth / GCP' }),
      backend({ id: 'opencode', displayName: 'OpenCode', loginStatus: 'active', model: 'opencode/big-pickle', quotaMode: 'provider', authProvider: 'OpenCode free' }),
      backend({ id: 'claude', displayName: 'Claude', loginStatus: 'active', quotaMode: 'provider', authProvider: 'Amazon Bedrock' }),
    ],
    theme: THEMES.ember,
    wide: true,
  }), { columns: 140 });
  Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true });
  assert.match(output, /Name\s+Login\s+Window \/ usage\s+Resets/);
  assert.match(output, /Codex\s+● active\s+5h 26% used/);
  assert.match(output, /Weekly 76% used/);
  assert.match(output, /Codex school\s+○ setup/);
  assert.match(output, /Antigravity\s+● active.*on run/);
  assert.match(output, /Google OAuth \/ GCP/);
  assert.match(output, /OpenCode\s+● active.*free/);
  assert.match(output, /OpenCode free/);
  assert.match(output, /Claude\s+● active.*provider/);
  assert.match(output, /Amazon Bedrock/);
  assert.match(output, /Upcoming · Cursor CLI/);
  assert.match(output, /Upcoming · Bivia CLI/);
  assert.doesNotMatch(output, /UNKNOWN/);
});
