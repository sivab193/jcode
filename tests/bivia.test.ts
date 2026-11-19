import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../dist/core/router.js';
import type { BackendSnapshot } from '../dist/core/types.js';

function snapshot(id: BackendSnapshot['id'], status: BackendSnapshot['status'] = 'available'): BackendSnapshot {
  return {
    id,
    status,
    model: 'test',
    cliPresent: status !== 'unavailable',
    quota: {
      remainingFraction: 0.8,
      resetsAt: '2026-12-01T00:00:00.000Z',
      windowMinutes: 60,
      source: 'probe',
      observedAt: new Date().toISOString(),
    },
  };
}

const ENV_KEYS = ['SCODE_BIVIA', 'SCODE_BIVIA_API_KEY', 'BIVIA_API_KEY', 'A8_API_KEY', 'SCODE_LAYA_URL'] as const;

function saveEnvironment(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function response(taskClass: string, backend: string, confidence = 0.9): Response {
  return new Response(JSON.stringify({
    answers: {
      taskClass: { type: 'choice', choice: taskClass, confidence, abstained: false },
      backend: { type: 'choice', choice: backend, confidence, abstained: false },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('bivia: classifies and selects a policy-eligible backend in fast mode', async () => {
  const saved = saveEnvironment();
  const originalFetch = globalThis.fetch;
  process.env.BIVIA_API_KEY = 'test-key';
  delete process.env.SCODE_BIVIA;
  delete process.env.SCODE_LAYA_URL;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return response('aws', 'kiro');
  };
  try {
    const result = await routeTask('Add a Lambda endpoint', [snapshot('codex-a'), snapshot('kiro')]);
    assert.equal(result.classification.taskClass, 'aws');
    assert.equal(result.selection.backend, 'kiro');
    assert.match(result.selection.reason, /Bivia selected kiro/);
    assert.equal(requestBody?.mode, 'fast');
    assert.equal(requestBody?.state, 'Add a Lambda endpoint');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(saved);
  }
});

test('bivia: rejects an available backend outside the local task policy', async () => {
  const saved = saveEnvironment();
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  process.env.BIVIA_API_KEY = 'test-key';
  delete process.env.SCODE_BIVIA;
  delete process.env.SCODE_LAYA_URL;
  console.warn = () => {};
  globalThis.fetch = async () => response('general', 'kiro');
  try {
    const result = await routeTask('Build a small feature', [snapshot('codex-a'), snapshot('kiro')]);
    assert.equal(result.classification.taskClass, 'general');
    assert.equal(result.selection.backend, 'codex-a');
    assert.doesNotMatch(result.selection.reason, /Bivia selected/);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    restoreEnvironment(saved);
  }
});

test('bivia: falls back to local rules when the API is unavailable', async () => {
  const saved = saveEnvironment();
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  process.env.BIVIA_API_KEY = 'test-key';
  delete process.env.SCODE_BIVIA;
  delete process.env.SCODE_LAYA_URL;
  console.warn = () => {};
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const result = await routeTask('Add a Lambda endpoint', [snapshot('codex-a'), snapshot('kiro')]);
    assert.equal(result.classification.taskClass, 'aws');
    assert.equal(result.selection.backend, 'kiro');
    assert.match(result.selection.reason, /AWS-native keywords/);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    restoreEnvironment(saved);
  }
});

test('bivia: can be disabled without sending the task brief', async () => {
  const saved = saveEnvironment();
  const originalFetch = globalThis.fetch;
  process.env.BIVIA_API_KEY = 'test-key';
  process.env.SCODE_BIVIA = 'false';
  delete process.env.SCODE_LAYA_URL;
  globalThis.fetch = async () => {
    throw new Error('Bivia must be disabled');
  };
  try {
    const result = await routeTask('Add a Lambda endpoint', [snapshot('codex-a'), snapshot('kiro')]);
    assert.equal(result.classification.taskClass, 'aws');
    assert.equal(result.selection.backend, 'kiro');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(saved);
  }
});

test('bivia: legacy JCODE_BIVIA=false disables routing', async () => {
  const saved = saveEnvironment();
  const savedJcode = process.env.JCODE_BIVIA;
  const originalFetch = globalThis.fetch;
  process.env.BIVIA_API_KEY = 'test-key';
  delete process.env.SCODE_BIVIA;
  process.env.JCODE_BIVIA = 'false';
  delete process.env.SCODE_LAYA_URL;
  globalThis.fetch = async () => {
    throw new Error('Bivia must be disabled');
  };
  try {
    const result = await routeTask('Add a Lambda endpoint', [snapshot('codex-a'), snapshot('kiro')]);
    assert.equal(result.classification.taskClass, 'aws');
    assert.equal(result.selection.backend, 'kiro');
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(saved);
    if (savedJcode === undefined) delete process.env.JCODE_BIVIA;
    else process.env.JCODE_BIVIA = savedJcode;
  }
});
