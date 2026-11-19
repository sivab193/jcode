import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ScodeConfig } from '../dist/config.js';
import { cavemanEnabledFor, wrapSpawn } from '../dist/core/caveman.js';

function configWith(caveman: ScodeConfig['caveman']): ScodeConfig {
  return {
    quotaFloor: 0.1,
    defaultTimeoutMs: 1000,
    claudeEnabled: false,
    codexHomes: {},
    opencodeModel: 'opencode/big-pickle',
    caveman,
  };
}

test('caveman: off by default', () => {
  assert.equal(cavemanEnabledFor(configWith(undefined), 'codex-a'), false);
  assert.equal(cavemanEnabledFor(configWith({ enabled: false }), 'codex-a'), false);
});

test('caveman: global on enables all backends', () => {
  assert.equal(cavemanEnabledFor(configWith({ enabled: true }), 'codex-a'), true);
  assert.equal(cavemanEnabledFor(configWith({ enabled: true }), 'kiro'), true);
});

test('caveman: per-backend switch overrides the global switch', () => {
  const config = configWith({ enabled: true, perBackend: { kiro: false, agy: true } });
  assert.equal(cavemanEnabledFor(config, 'kiro'), false);
  assert.equal(cavemanEnabledFor(config, 'agy'), true);
  assert.equal(cavemanEnabledFor(config, 'codex-a'), true);
});

test('caveman: skill-only mode never wraps the spawn', async () => {
  const { spec, wrapped } = await wrapSpawn(
    { command: 'codex', args: ['exec'] },
    'codex-a',
    configWith({ enabled: true, mode: 'skill-only' }),
  );
  assert.equal(wrapped, false);
  assert.equal(spec.command, 'codex');
});

test('caveman: missing binary warns and runs bare', async () => {
  const oldPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const { spec, wrapped } = await wrapSpawn(
      { command: 'codex', args: ['exec'] },
      'codex-a',
      configWith({ enabled: true, mode: 'proxy' }),
    );
    assert.equal(wrapped, false);
    assert.equal(spec.command, 'codex');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('caveman: present binary wraps the command and sets DO_NOT_TRACK', async () => {
  const dir = join(tmpdir(), `scode-caveman-test-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const fake = join(dir, process.platform === 'win32' ? 'caveman.cmd' : 'caveman');
  await writeFile(fake, process.platform === 'win32' ? '@echo off\r\necho caveman-stub\r\n' : '#!/bin/sh\necho caveman-stub\n');
  await chmod(fake, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
  try {
    const { spec, wrapped } = await wrapSpawn(
      { command: 'codex', args: ['exec', 'hello'] },
      'codex-a',
      configWith({ enabled: true, mode: 'proxy' }),
    );
    assert.equal(wrapped, true);
    assert.equal(spec.command, 'caveman');
    assert.deepEqual(spec.args, ['codex', 'exec', 'hello']);
    assert.equal(spec.env?.DO_NOT_TRACK, '1');
  } finally {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  }
});
