import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, setBackendProfile, setOpenCodeModel, setTheme, stateHome } from '../dist/config.js';

test('config: missing file uses defaults without a first-run write race', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-config-test-'));
  const saved = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    const config = await loadConfig();
    assert.equal(config.quotaFloor, 0.1);
    assert.equal(config.theme, 'ember');
    await assert.rejects(access(join(dir, 'config.json')), { code: 'ENOENT' });
  } finally {
    if (saved === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: backend labels and OpenCode free preset are persisted locally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-backend-config-test-'));
  const saved = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    await setBackendProfile('codex-a', { label: 'Codex school', account: 'student@example.edu' });
    await setOpenCodeModel('free');
    const config = await loadConfig();
    assert.deepEqual(config.backendProfiles?.['codex-a'], { label: 'Codex school', account: 'student@example.edu' });
    assert.equal(config.opencodeModel, 'opencode/big-pickle');
  } finally {
    if (saved === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: setting a theme preserves existing settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-theme-test-'));
  const saved = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ quotaFloor: 0.25, opencodeModel: 'test/model' }));
    await setTheme('aurora');
    const config = await loadConfig();
    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(config.theme, 'aurora');
    assert.equal(persisted.theme, 'aurora');
    assert.equal(persisted.quotaFloor, 0.25);
    assert.equal(persisted.opencodeModel, 'test/model');
  } finally {
    if (saved === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: JCODE_HOME is honored when SCODE_HOME is unset (legacy fallback)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-legacy-home-test-'));
  const savedScode = process.env.SCODE_HOME;
  const savedJcode = process.env.JCODE_HOME;
  delete process.env.SCODE_HOME;
  process.env.JCODE_HOME = dir;
  try {
    assert.equal(stateHome(), dir);
    const config = await loadConfig();
    assert.equal(config.quotaFloor, 0.1);
  } finally {
    if (savedScode === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedScode;
    if (savedJcode === undefined) delete process.env.JCODE_HOME;
    else process.env.JCODE_HOME = savedJcode;
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: SCODE_HOME wins when both names are set', async () => {
  const scodeDir = await mkdtemp(join(tmpdir(), 'scode-new-home-test-'));
  const jcodeDir = await mkdtemp(join(tmpdir(), 'scode-old-home-test-'));
  const savedScode = process.env.SCODE_HOME;
  const savedJcode = process.env.JCODE_HOME;
  process.env.SCODE_HOME = scodeDir;
  process.env.JCODE_HOME = jcodeDir;
  try {
    assert.equal(stateHome(), scodeDir);
  } finally {
    if (savedScode === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedScode;
    if (savedJcode === undefined) delete process.env.JCODE_HOME;
    else process.env.JCODE_HOME = savedJcode;
    await rm(scodeDir, { recursive: true, force: true });
    await rm(jcodeDir, { recursive: true, force: true });
  }
});

test('config: default home migrates ~/.jcode to ~/.scode once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'scode-migrate-home-test-'));
  const savedHome = process.env.HOME;
  const savedScode = process.env.SCODE_HOME;
  const savedJcode = process.env.JCODE_HOME;
  delete process.env.SCODE_HOME;
  delete process.env.JCODE_HOME;
  process.env.HOME = home;
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(home, '.jcode'), { recursive: true });
    await writeFile(join(home, '.jcode', 'ledger.jsonl'), '{"marker":true}\n');
    assert.equal(stateHome(), join(home, '.scode'));
    const moved = await readFile(join(home, '.scode', 'ledger.jsonl'), 'utf8');
    assert.equal(moved, '{"marker":true}\n');
    await assert.rejects(access(join(home, '.jcode')), { code: 'ENOENT' });
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedScode === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedScode;
    if (savedJcode === undefined) delete process.env.JCODE_HOME;
    else process.env.JCODE_HOME = savedJcode;
    await rm(home, { recursive: true, force: true });
  }
});
