import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLatex, peekFile, queryGraphTool, readPdf } from '../dist/mcp/tools.js';
import { cliInfo } from '../dist/core/probes.js';

/** Build a minimal valid single-page PDF with computed xref offsets. */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('file-peek: returns numbered lines in range', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-peek-'));
  const file = join(dir, 'sample.txt');
  await writeFile(file, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  const result = await peekFile({ path: file, startLine: 3, endLine: 5 });
  assert.equal(result.isError, false);
  assert.match(result.text, /3: line 3/);
  assert.match(result.text, /5: line 5/);
  assert.doesNotMatch(result.text, /line 6/);
});

test('file-peek: missing file is a clean error', async () => {
  const result = await peekFile({ path: '/tmp/scode-no-such-file-xyz.txt' });
  assert.equal(result.isError, true);
  assert.match(result.text, /no such file/);
});

test('file-peek: start past the end is a clean error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-peek-'));
  const file = join(dir, 'short.txt');
  await writeFile(file, 'one\ntwo\n');
  const result = await peekFile({ path: file, startLine: 99 });
  assert.equal(result.isError, true);
  assert.match(result.text, /only 3 lines|only 2 lines/);
});

test('file-peek: binary file is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-peek-'));
  const file = join(dir, 'bin.dat');
  await writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62]));
  const result = await peekFile({ path: file });
  assert.equal(result.isError, true);
  assert.match(result.text, /binary/);
});

test('pdf-read: extracts text from a real PDF', async (t) => {
  const info = await cliInfo('pdftotext', ['-v']);
  if (!info.present) {
    t.skip('pdftotext not installed');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'scode-pdf-'));
  const file = join(dir, 'sample.pdf');
  await writeFile(file, minimalPdf('scode pdf ok'));
  const result = await readPdf({ path: file });
  assert.equal(result.isError, false);
  assert.match(result.text, /scode pdf ok/);
});

test('pdf-read: missing file is a clean error', async () => {
  const result = await readPdf({ path: '/tmp/scode-no-such-pdf-xyz.pdf' });
  assert.equal(result.isError, true);
  assert.match(result.text, /no such file/);
});

test('latex-build: missing file is a clean error', async () => {
  const result = await buildLatex({ path: '/tmp/scode-no-such-tex-xyz.tex' });
  assert.equal(result.isError, true);
  assert.match(result.text, /no such file/);
});

test('latex-build: non-tex file is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-latex-'));
  const file = join(dir, 'notes.txt');
  await writeFile(file, 'not latex');
  const result = await buildLatex({ path: file });
  assert.equal(result.isError, true);
  assert.match(result.text, /not a \.tex file/);
});

test('latex-build: missing toolchain is a clean error', async (t) => {
  const latexmk = await cliInfo('latexmk');
  const pdflatex = await cliInfo('pdflatex');
  if (latexmk.present || pdflatex.present) {
    t.skip('a LaTeX toolchain is installed on this machine');
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), 'scode-latex-'));
  const file = join(dir, 'doc.tex');
  await writeFile(file, '\\documentclass{article}\\begin{document}hi\\end{document}');
  const result = await buildLatex({ path: file });
  assert.equal(result.isError, true);
  assert.match(result.text, /neither latexmk nor pdflatex/);
});

test('graph-query: errors clearly when no graph exists in the repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-graph-query-test-'));
  const savedCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await queryGraphTool({ question: 'who calls hello' });
    assert.equal(result.isError, true);
    assert.match(result.text, /no code graph/);
    assert.match(result.text, /scode graph init/);
  } finally {
    process.chdir(savedCwd);
  }
});

test('graph-query: queries the graph via a fake graphify binary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-graph-query-test-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(dir, 'graphify-out'), { recursive: true });
  await writeFile(join(dir, 'graphify-out', 'graph.json'), JSON.stringify({
    directed: false,
    graph: { schema_version: 1, graphify_version: '0.9.112' },
    nodes: [{ id: 'n0' }],
    links: [],
    built_at_commit: 'abc',
  }));
  const fake = join(dir, 'fake-graphify.mjs');
  await writeFile(fake, 'console.log(`FAKE: ${process.argv.slice(2).join(" ")}`);\n');
  const savedCwd = process.cwd();
  process.chdir(dir);
  try {
    const result = await queryGraphTool(
      { kind: 'explain', question: 'greet' },
      { binary: process.execPath, binaryArgs: [fake] },
    );
    assert.equal(result.isError, false);
    assert.match(result.text, /FAKE: explain greet/);
  } finally {
    process.chdir(savedCwd);
  }
});

test('thread-list: empty store reports honestly', async () => {
  const { listThreadsTool } = await import('../dist/mcp/tools.js');
  const dir = await mkdtemp(join(tmpdir(), 'scode-mcp-threads-'));
  const savedHome = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    const result = await listThreadsTool();
    assert.equal(result.isError, false);
    assert.match(result.text, /No threads yet/);
  } finally {
    if (savedHome === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedHome;
  }
});

test('thread-status and thread-diff: read a real thread', async () => {
  const { execFile } = await import('node:child_process');
  const { createThread } = await import('../dist/core/threads.js');
  const { threadStatusTool, threadDiffTool } = await import('../dist/mcp/tools.js');
  const home = await mkdtemp(join(tmpdir(), 'scode-mcp-threads2-'));
  const repo = await mkdtemp(join(tmpdir(), 'scode-mcp-repo-'));
  const git = (args: string[], cwd: string) => new Promise<string>((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString() || error.message));
      else resolvePromise(stdout.toString());
    });
  });
  await git(['init', '-b', 'main'], repo);
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await writeFile(join(repo, 'a.txt'), 'one\n');
  await git(['add', '.'], repo);
  await git(['commit', '-m', 'initial'], repo);
  const savedHome = process.env.SCODE_HOME;
  process.env.SCODE_HOME = home;
  try {
    const thread = await createThread('Change a file', { cwd: repo });
    await git(['clean', '-fd'], thread.worktree);
    await writeFile(join(thread.worktree, 'a.txt'), 'one\ntwo\n');
    const status = await threadStatusTool({ threadId: thread.id });
    assert.equal(status.isError, false);
    assert.match(status.text, new RegExp(thread.branch.replace('/', '\\/')));
    const diff = await threadDiffTool({ threadId: thread.id.slice(0, 4) });
    assert.equal(diff.isError, false);
    assert.match(diff.text, /Uncommitted \(1\)/);
    const missing = await threadStatusTool({ threadId: 'zzzz' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No thread matches/);
  } finally {
    if (savedHome === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedHome;
  }
});
