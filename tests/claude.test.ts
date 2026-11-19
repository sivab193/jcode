import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../dist/adapters/claude.js';

async function withTempHome(config: Record<string, unknown>, envEnabled: string | undefined, fn: () => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'scode-claude-'));
  await writeFile(join(dir, 'config.json'), JSON.stringify(config), 'utf-8');
  const savedHome = process.env.SCODE_HOME;
  const savedEnv = process.env.SCODE_CLAUDE_ENABLED;
  process.env.SCODE_HOME = dir;
  if (envEnabled === undefined) delete process.env.SCODE_CLAUDE_ENABLED;
  else process.env.SCODE_CLAUDE_ENABLED = envEnabled;
  try {
    await fn();
  } finally {
    if (savedHome === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedHome;
    if (savedEnv === undefined) delete process.env.SCODE_CLAUDE_ENABLED;
    else process.env.SCODE_CLAUDE_ENABLED = savedEnv;
  }
}

test('claude: refuses to run while disabled (config off)', async () => {
  await withTempHome({ claudeEnabled: false }, 'true', async () => {
    const adapter = new ClaudeAdapter();
    await assert.rejects(
      adapter.run({ taskId: 't', brief: 'x', backend: 'claude', cwd: '/tmp', timeoutMs: 1000, dryRun: true }, {}),
      /disabled until Claude Pro/,
    );
  });
});

test('claude: config alone enables a configured account', async () => {
  await withTempHome({ claudeEnabled: true }, undefined, async () => {
    const adapter = new ClaudeAdapter();
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      await adapter.run(
        { taskId: 't', brief: 'x', backend: 'claude', cwd: '/tmp', timeoutMs: 1000, dryRun: true },
        {},
      );
    } finally {
      console.log = originalLog;
    }
    assert.ok(lines.some((line) => line.startsWith('[dry-run] claude -p')));
  });
});

test('claude: explicit environment false disables config', async () => {
  await withTempHome({ claudeEnabled: true }, 'false', async () => {
    const adapter = new ClaudeAdapter();
    await assert.rejects(
      adapter.run({ taskId: 't', brief: 'x', backend: 'claude', cwd: '/tmp', timeoutMs: 1000, dryRun: true }, {}),
      /disabled until Claude Pro/,
    );
  });
});

test('claude: dry-run prints the exact handoff command when enabled', async () => {
  await withTempHome({ claudeEnabled: true, claudeMaxTurns: 10 }, 'true', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
      const adapter = new ClaudeAdapter();
      await adapter.run(
        { taskId: 't', brief: 'fix the bug', backend: 'claude', cwd: '/tmp', timeoutMs: 1000, sessionId: 'sess-1', dryRun: true },
        {},
      );
    } finally {
      console.log = originalLog;
    }
    const dry = lines.find((line) => line.startsWith('[dry-run]'));
    assert.ok(dry);
    assert.match(dry, /claude -p "fix the bug" --output-format json --permission-mode acceptEdits --max-turns 10 --resume sess-1/);
  });
});
