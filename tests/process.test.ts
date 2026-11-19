import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, extractDisplayText, extractSessionId, extractUsage, runProcess } from '../dist/adapters/process.js';

test('classifyFailure: timeout wins over exit code', () => {
  assert.equal(classifyFailure(null, '', true), 'timeout');
});

test('classifyFailure: cancellation is distinct from backend errors', () => {
  assert.equal(classifyFailure(143, '', false, true), 'cancelled');
});

test('runProcess: an aborted signal terminates the child process', async () => {
  const controller = new AbortController();
  const promise = runProcess(
    { command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'] },
    {
      taskId: 'cancel-test',
      brief: 'test cancellation',
      backend: 'codex-a',
      cwd: process.cwd(),
      timeoutMs: 5000,
      signal: controller.signal,
    },
    { onStdout: () => {}, onStderr: () => {} },
  );
  setTimeout(() => controller.abort(), 50);
  const result = await promise;
  assert.equal(result.success, false);
  assert.equal(result.errorClass, 'cancelled');
});

test('classifyFailure: exit 0 is not a failure', () => {
  assert.equal(classifyFailure(0, 'rate limit mentioned in passing', false), null);
});

test('classifyFailure: rate-limit text classifies as quota', () => {
  assert.equal(classifyFailure(1, 'Error: 429 Too Many Requests', false), 'quota');
  assert.equal(classifyFailure(1, 'insufficient_quota for this account', false), 'quota');
  assert.equal(classifyFailure(1, "You've hit your weekly limit", false), 'quota');
});

test('classifyFailure: 5xx text classifies as availability', () => {
  assert.equal(classifyFailure(1, '503 Service Unavailable', false), 'availability');
  assert.equal(classifyFailure(1, 'socket hang up', false), 'availability');
});

test('classifyFailure: auth text classifies as auth', () => {
  assert.equal(classifyFailure(1, '401 Unauthorized — not logged in', false), 'auth');
});

test('classifyFailure: unknown failures stay backend-error', () => {
  assert.equal(classifyFailure(2, 'something broke', false), 'backend-error');
});

test('extractSessionId: finds session ids across vendor key names', () => {
  assert.equal(extractSessionId([{ raw: { session_id: 'abc' } }]), 'abc');
  assert.equal(extractSessionId([{ raw: { thread_id: 't-1' } }]), 't-1');
  assert.equal(extractSessionId([{ raw: { result: { sessionId: 'nested' } } }]), 'nested');
  assert.equal(extractSessionId([{ raw: { sessionID: 'opencode-session' } }]), 'opencode-session');
  assert.equal(extractSessionId([{ raw: { type: 'text', text: 'hi' } }]), undefined);
});

test('extractUsage: merges token and premium-request usage', () => {
  const usage = extractUsage([
    { raw: { usage: { input_tokens: 100, output_tokens: 50 } } },
    { raw: { result: { usage: { premiumRequests: 3, total_cost_usd: 0.02 } } } },
    { raw: { part: { tokens: { input: 125, output: 75 } } } },
  ]);
  assert.deepEqual(usage, { inputTokens: 125, outputTokens: 75, premiumRequests: 3, totalCostUsd: 0.02 });
});

test('extractDisplayText: renders agent prose and ignores protocol noise', () => {
  assert.equal(extractDisplayText({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Hello from Codex' },
  }), 'Hello from Codex');
  assert.equal(extractDisplayText({ type: 'result', result: 'Hello from Claude' }), 'Hello from Claude');
  assert.equal(extractDisplayText({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } }), undefined);
  assert.equal(extractDisplayText({ type: 'thread.started', thread_id: 'abc' }), undefined);
});

test('classifyFailure: cancelled wins over everything', () => {
  assert.equal(classifyFailure(1, 'rate limit hit', false, true), 'cancelled');
});
