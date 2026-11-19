import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildGraph,
  ensureGitignored,
  graphJsonPath,
  graphOutDir,
  graphStatus,
  graphifyInfo,
  headCommit,
  readGraphMeta,
  resolveMainCheckout,
  runGraphQuery,
} from '../dist/core/graphify.js';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout) => {
      if (error) reject(error);
      else resolvePromise(stdout.trim());
    });
  });
}

async function tempRepo(): Promise<string> {
  const dir = join(tmpdir(), `scode-graphify-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'a.ts'), 'export function hello(): string { return "hi"; }\n');
  await git(['init', '-q'], dir);
  await git(['add', '-A'], dir);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], dir);
  return dir;
}

function fakeGraphJson(builtAtCommit: string, nodes = 3): string {
  return JSON.stringify({
    directed: false,
    multigraph: false,
    graph: { schema_version: 1, graphify_version: '0.9.112' },
    nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })),
    links: [],
    built_at_commit: builtAtCommit,
  });
}

test('graphify: graphOutDir honors GRAPHIFY_OUT (absolute and relative)', () => {
  const saved = process.env.GRAPHIFY_OUT;
  try {
    delete process.env.GRAPHIFY_OUT;
    assert.equal(graphOutDir('/repo'), join('/repo', 'graphify-out'));
    process.env.GRAPHIFY_OUT = '/elsewhere/graphs';
    assert.equal(graphOutDir('/repo'), '/elsewhere/graphs');
    process.env.GRAPHIFY_OUT = 'custom-out';
    assert.equal(graphOutDir('/repo'), join('/repo', 'custom-out'));
  } finally {
    if (saved === undefined) delete process.env.GRAPHIFY_OUT;
    else process.env.GRAPHIFY_OUT = saved;
  }
});

test('graphify: readGraphMeta parses a fixture graph.json', async () => {
  const dir = await tempRepo();
  try {
    await mkdir(join(dir, 'graphify-out'), { recursive: true });
    await writeFile(graphJsonPath(dir), fakeGraphJson('abc123', 7));
    const meta = await readGraphMeta(dir);
    assert.equal(meta?.builtAtCommit, 'abc123');
    assert.equal(meta?.nodeCount, 7);
    assert.equal(meta?.graphifyVersion, '0.9.112');
    assert.equal(meta?.schemaVersion, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphify: readGraphMeta returns null when the graph is missing or corrupt', async () => {
  const dir = await tempRepo();
  try {
    assert.equal(await readGraphMeta(dir), null);
    await mkdir(join(dir, 'graphify-out'), { recursive: true });
    await writeFile(graphJsonPath(dir), '{not json');
    assert.equal(await readGraphMeta(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphify: graphStatus reports current vs stale from built_at_commit', async () => {
  const dir = await tempRepo();
  try {
    const head = await headCommit(dir);
    assert.ok(head, 'temp repo should have a HEAD');
    await mkdir(join(dir, 'graphify-out'), { recursive: true });
    await writeFile(graphJsonPath(dir), fakeGraphJson(head as string));
    const current = await graphStatus(dir);
    assert.equal(current.present, true);
    assert.equal(current.stale, false);
    assert.equal(current.headCommit, head);

    await writeFile(graphJsonPath(dir), fakeGraphJson('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'));
    const stale = await graphStatus(dir);
    assert.equal(stale.present, true);
    assert.equal(stale.stale, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphify: resolveMainCheckout finds the main checkout from a worktree', async () => {
  const dir = await tempRepo();
  const worktree = join(tmpdir(), `scode-graphify-wt-${Date.now()}`);
  try {
    await git(['worktree', 'add', '-q', worktree, 'HEAD'], dir);
    const main = await resolveMainCheckout(worktree);
    assert.equal(await realpath(main), await realpath(dir));
    assert.equal(await realpath(await resolveMainCheckout(dir)), await realpath(dir));
  } finally {
    await git(['worktree', 'remove', '--force', worktree], dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphify: resolveMainCheckout falls back to cwd outside a repo', async () => {
  const dir = join(tmpdir(), `scode-graphify-nogit-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    assert.equal(await resolveMainCheckout(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphify: ensureGitignored adds graphify-out/ once, never twice', async () => {
  const dir = await tempRepo();
  try {
    assert.equal(await ensureGitignored(dir), 'added');
    assert.equal(await ensureGitignored(dir), 'present');
    const content = await readFile(join(dir, '.gitignore'), 'utf8');
    assert.equal(content.split('\n').filter((line) => line.trim() === 'graphify-out/').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphify: runGraphQuery maps exit codes 0/3/4 to answers, others to errors', async () => {
  const dir = await tempRepo();
  // A Node script is portable across Windows and POSIX; binaryArgs lets the
  // test exercise the real argument mapping without a shell shim.
  const fake = join(dir, 'fake-graphify.mjs');
  await writeFile(fake, 'console.log(`FAKE-QUERY args: ${process.argv.slice(2).join(" ")}`); process.exit(Number(process.env.FAKE_EXIT ?? 0));\n');
  try {
    await mkdir(join(dir, 'graphify-out'), { recursive: true });
    await writeFile(graphJsonPath(dir), fakeGraphJson('x'));

    const runtime = { binary: process.execPath, binaryArgs: [fake] };
    const ok = await runGraphQuery(dir, 'query', { question: 'who calls hello', budget: 500, ...runtime });
    assert.equal(ok.ok, true);
    assert.match(ok.text, /FAKE-QUERY args: query who calls hello/);
    assert.match(ok.text, /--budget 500/);

    process.env.FAKE_EXIT = '3';
    const ambiguous = await runGraphQuery(dir, 'explain', { question: 'hello', ...runtime });
    assert.equal(ambiguous.ok, true, 'exit 3 (ambiguous) is an answer, not an error');

    process.env.FAKE_EXIT = '4';
    const noMatch = await runGraphQuery(dir, 'affected', { question: 'nope', ...runtime });
    assert.equal(noMatch.ok, true, 'exit 4 (no match) is an answer, not an error');

    process.env.FAKE_EXIT = '1';
    const failed = await runGraphQuery(dir, 'query', { question: 'who calls hello', ...runtime });
    assert.equal(failed.ok, false);

    const missing = await runGraphQuery(dir, 'path', { question: 'a', ...runtime });
    assert.equal(missing.ok, false, 'path without a target is a caller error');
    assert.match(missing.text, /needs a question.*and a target/);
  } finally {
    delete process.env.FAKE_EXIT;
    await rm(dir, { recursive: true, force: true });
  }
});

test('graphify: buildGraph reports failure without throwing when the binary is missing', async () => {
  const dir = await tempRepo();
  try {
    const result = await buildGraph(dir, { binary: 'definitely-not-a-real-binary-scode', timeoutMs: 10_000 });
    assert.equal(result.ok, false);
    assert.match(result.output, /ENOENT|not found|no such/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Live tests: run only where graphify is actually installed (the host, and
// this VM's verification venv when it is on PATH). Elsewhere they skip,
// per the doctor convention — a missing graphify is not a failure.
test('graphify (live): update + query on a tiny repo', async (t) => {
  const info = await graphifyInfo();
  if (!info.present) {
    t.skip('graphify not installed');
    return;
  }
  const dir = await tempRepo();
  try {
    await writeFile(join(dir, 'b.ts'), 'import { hello } from "./a";\nexport function greet(): string { return hello(); }\n');
    await git(['add', '-A'], dir);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'add b'], dir);
    const build = await buildGraph(dir);
    assert.equal(build.ok, true, build.output);
    assert.ok((build.nodeCount ?? 0) > 0);
    const status = await graphStatus(dir);
    assert.equal(status.present, true);
    assert.equal(status.stale, false);
    const query = await runGraphQuery(dir, 'query', { question: 'who calls hello' });
    assert.equal(query.ok, true, query.text);
    assert.match(query.text, /hello/);
    const explain = await runGraphQuery(dir, 'explain', { question: 'greet' });
    assert.equal(explain.ok, true, explain.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
