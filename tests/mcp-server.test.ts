import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'mcp', 'server.js');

interface RpcMessage {
  id?: number;
  result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean };
  error?: { message: string };
}

function startServer(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

function rpc(server: ChildProcessWithoutNullStreams): {
  send: (message: Record<string, unknown>) => void;
  waitFor: (id: number, timeoutMs?: number) => Promise<RpcMessage>;
} {
  let buffer = '';
  const pending = new Map<number, (message: RpcMessage) => void>();
  server.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const message = JSON.parse(line) as RpcMessage;
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
      } catch {
        // Ignore non-JSON lines.
      }
    }
  });
  return {
    send: (message) => { server.stdin.write(`${JSON.stringify(message)}\n`); },
    waitFor: (id, timeoutMs = 10_000) => new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`no response for id ${id} within ${timeoutMs}ms`)), timeoutMs);
      pending.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    }),
  };
}

test('mcp server: initialize + tools/list returns the four tools', async () => {
  const server = startServer();
  try {
    const { send, waitFor } = rpc(server);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scode-test', version: '0.1.0' } } });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listed = await waitFor(2);
    const names = (listed.result?.tools ?? []).map((tool) => tool.name).sort();
    assert.deepEqual(names, ['file-peek', 'graph-query', 'latex-build', 'pdf-read', 'thread-diff', 'thread-list', 'thread-status']);
  } finally {
    server.kill();
  }
});

test('mcp server: tools/call file-peek works end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-mcp-call-'));
  const file = join(dir, 'hello.txt');
  await writeFile(file, 'alpha\nbeta\ngamma\n');
  const server = startServer();
  try {
    const { send, waitFor } = rpc(server);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'scode-test', version: '0.1.0' } } });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'file-peek', arguments: { path: file, startLine: 2, endLine: 2 } },
    });
    const called = await waitFor(2);
    assert.equal(called.result?.isError, false);
    assert.match(called.result?.content?.[0]?.text ?? '', /2: beta/);
  } finally {
    server.kill();
  }
});
