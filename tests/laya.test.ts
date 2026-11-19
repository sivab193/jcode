import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { layaClassify } from '../dist/core/laya.js';
import { classifyAsync } from '../dist/core/classifier.js';

test('laya: returns null when not configured', async () => {
  const saved = process.env.SCODE_LAYA_URL;
  delete process.env.SCODE_LAYA_URL;
  try {
    assert.equal(await layaClassify('fix the bug'), null);
  } finally {
    if (saved !== undefined) process.env.SCODE_LAYA_URL = saved;
  }
});

test('laya: parses a valid classification from the endpoint', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ taskClass: 'aws', difficulty: 'high', confidence: 0.9 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const result = await layaClassify('deploy the lambda', `http://127.0.0.1:${port}`);
    assert.ok(result);
    assert.equal(result.taskClass, 'aws');
    assert.equal(result.difficulty, 'high');
    assert.match(result.reason, /Laya/);
  } finally {
    server.close();
  }
});

test('laya: invalid answers fall back to null', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ taskClass: 'not-a-class', difficulty: 'high' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    assert.equal(await layaClassify('deploy the lambda', `http://127.0.0.1:${port}`), null);
  } finally {
    server.close();
  }
});

test('laya: unreachable endpoint falls back to null', async () => {
  assert.equal(await layaClassify('fix the bug', 'http://127.0.0.1:1'), null);
});

test('laya: classifyAsync falls back to rules when Laya is unconfigured', async () => {
  const saved = process.env.SCODE_LAYA_URL;
  delete process.env.SCODE_LAYA_URL;
  try {
    const result = await classifyAsync('add a lambda function for the API');
    assert.equal(result.taskClass, 'aws');
  } finally {
    if (saved !== undefined) process.env.SCODE_LAYA_URL = saved;
  }
});

test('laya: JCODE_LAYA_URL is honored when SCODE_LAYA_URL is unset (legacy fallback)', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ taskClass: 'aws', difficulty: 'high', confidence: 0.9 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const savedScode = process.env.SCODE_LAYA_URL;
  const savedJcode = process.env.JCODE_LAYA_URL;
  delete process.env.SCODE_LAYA_URL;
  process.env.JCODE_LAYA_URL = `http://127.0.0.1:${port}`;
  try {
    const result = await layaClassify('deploy the lambda');
    assert.ok(result);
    assert.equal(result.taskClass, 'aws');
  } finally {
    server.close();
    if (savedScode === undefined) delete process.env.SCODE_LAYA_URL;
    else process.env.SCODE_LAYA_URL = savedScode;
    if (savedJcode === undefined) delete process.env.JCODE_LAYA_URL;
    else process.env.JCODE_LAYA_URL = savedJcode;
  }
});
