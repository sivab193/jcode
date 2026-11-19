import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpServer } from '../dist/acp/server.js';
import { loadThreads } from '../dist/core/threads.js';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString() || error.message));
      else resolvePromise(stdout.toString());
    });
  });
}

async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'scode-acp-test-'));
  const savedHome = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    await fn();
  } finally {
    if (savedHome === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedHome;
  }
}

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scode-acp-repo-'));
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  return dir;
}

/** Drive a server with JSON-RPC lines and collect its frames. */
function harness() {
  const frames: Record<string, unknown>[] = [];
  const server = createAcpServer((frame) => frames.push(frame));
  const send = (message: Record<string, unknown>) => server.handleLine(JSON.stringify(message));
  const reply = (id: number) => frames.find((f) => f.id === id) as { result?: Record<string, unknown>; error?: { code: number; message: string } } | undefined;
  return { frames, server, send, reply };
}

test('acp: initialize negotiates protocol v1', async () => {
  const { send, reply } = harness();
  await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  const frame = reply(1);
  assert.equal(frame?.result?.protocolVersion, 1);
  assert.equal((frame?.result?.agentInfo as { name?: string })?.name, 'scode');
  assert.equal((frame?.result?.agentCapabilities as { loadSession?: boolean })?.loadSession, false);
});

test('acp: session/new returns a session id', async () => {
  const { send, reply, server } = harness();
  await send({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } });
  const sessionId = reply(1)?.result?.sessionId as string;
  assert.match(sessionId, /^[0-9a-f]{8}$/);
  assert.equal(server.sessions.has(sessionId), true);
});

test('acp: prompt errors on unknown session, empty prompt, unknown method', async () => {
  const { send, reply } = harness();
  await send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'nope1234', prompt: [{ type: 'text', text: 'hi' }] } });
  assert.equal(reply(1)?.error?.code, -32602);
  await send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: '/tmp', mcpServers: [] } });
  const sessionId = reply(2)?.result?.sessionId as string;
  await send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [] } });
  assert.equal(reply(3)?.error?.code, -32602);
  await send({ jsonrpc: '2.0', id: 4, method: 'session/set_mode', params: { sessionId, modeId: 'x' } });
  assert.equal(reply(4)?.error?.code, -32601);
  // Notifications and malformed lines are ignored, not answered.
  await send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  await send({ jsonrpc: '2.0', method: 'bogus/notification' });
  await harness().server.handleLine('not json');
});

test('acp: a prompt creates a thread and ends the turn (auth failure on this VM)', async () => {
  await withTempHome(async () => {
    const repo = await fixtureRepo();
    const { frames, send, reply } = harness();
    await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    await send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: repo, mcpServers: [] } });
    const sessionId = reply(2)?.result?.sessionId as string;
    await send({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Say hello in a file' }] } });
    // codex is installed but unauthenticated here: the turn fails with auth,
    // and the server still ends the turn with a failure chunk.
    assert.equal(reply(3)?.result?.stopReason, 'end_turn');
    const updates = frames.filter((f) => f.method === 'session/update');
    assert.ok(updates.length >= 1, 'expected at least one session/update');
    const chunks = updates.map((f) => (f.params as { update: { content: { text: string } } }).update.content.text).join('');
    assert.match(chunks, /Thread/);
    assert.match(chunks, /failed on codex-a \(auth\)/);
    const threads = await loadThreads();
    assert.equal(threads.length, 1);
    assert.equal(threads[0]?.id, sessionId);
    assert.equal(threads[0]?.turns, 1);
  });
});
