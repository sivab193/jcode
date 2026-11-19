/**
 * Phase 4 — the scode MCP tool suite (handoff §8).
 *
 * One server, `scode-tools`, exposing the three tools the handoff ships first:
 * pdf-read, latex-build, file-peek — plus graph-query, added for the Graphify
 * integration so agents query the repo's code graph instead of grepping for
 * structure. The rest of the suite is earned, not assumed: the learning loop
 * (Phase 5) turns repeated agent workarounds into tool proposals in
 * `~/.scode/tool-backlog.md` — no tool gets built until the ledger shows the
 * waste.
 *
 * Why these three are tools, not Blocks (handoff §7): a Block is a script the
 * agent runs; a tool is an operation the router owns. pdf-read and latex-build
 * need deterministic binaries, timeouts, and capped output — that is router
 * territory. Never both for one job.
 */
import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { graphJsonPath, readGraphMeta, resolveMainCheckout, runGraphQuery, type GraphQueryKind } from '../core/graphify.js';
import { renderDiffSummary, threadDiff } from '../core/pr.js';
import { cliInfo } from '../core/probes.js';
import { findThread, loadThreads, renderThreadList, renderThreadStatus } from '../core/threads.js';

export interface ToolResult {
  text: string;
  isError: boolean;
}

export const TOOL_NAMES = ['file-peek', 'pdf-read', 'latex-build', 'graph-query', 'thread-list', 'thread-status', 'thread-diff'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  'file-peek': 'Read a slice of a text file by line number, with line numbers. Use this instead of reading a whole file when you only need part of it.',
  'pdf-read': 'Extract text from a PDF, optionally limited to a page range. Returns plain text; output is capped.',
  'latex-build': 'Compile a LaTeX document to PDF (latexmk when available, else two pdflatex passes). Returns the PDF path on success, or the log tail on failure.',
  'graph-query': 'Query the repo code graph (Graphify) instead of grepping for structure: who calls X, what depends on Y, the impact of a change, the most-connected modules. Returns budgeted graph results with file+line. The graph lives at graphify-out/graph.json in the repo root; if it is missing, say so and suggest `scode graph init`. Never read graph.json directly — always query it through this tool.',
  'thread-list': 'List scode threads (durable tasks, each with its own branch, worktree, and backend session): id, title, backend, turns, branch, PR link when one exists.',
  'thread-status': 'Show one thread: branch, base, worktree, backend, turns, and its change summary vs the base branch.',
  'thread-diff': 'Show one thread\'s change vs its base branch: file stats plus the unified diff (capped). Use this to review a thread before shipping it.',
};

/** Zod input shapes — the MCP SDK converts these to JSON Schema for tools/list. */
export const TOOL_INPUT_SHAPES = {
  'file-peek': {
    path: z.string().describe('Absolute or relative path to the text file.'),
    startLine: z.number().int().optional().describe('First line to return (1-based). Default 1.'),
    endLine: z.number().int().optional().describe('Last line to return (inclusive). Default startLine + 199.'),
  },
  'pdf-read': {
    path: z.string().describe('Absolute or relative path to the PDF file.'),
    startPage: z.number().int().optional().describe('First page to extract (1-based). Default 1.'),
    endPage: z.number().int().optional().describe('Last page to extract (inclusive). Default: last page.'),
    maxChars: z.number().int().optional().describe('Maximum characters to return. Default 20000.'),
  },
  'latex-build': {
    path: z.string().describe('Absolute or relative path to the .tex file.'),
    outDir: z.string().optional().describe('Output directory for the PDF. Default: the .tex file directory.'),
  },
  'graph-query': {
    kind: z.enum(['query', 'explain', 'path', 'affected', 'god-nodes']).optional().describe('What to ask the graph. Default "query". query: free-form structure question. explain: what a symbol is and what connects to it. path: shortest path between two symbols (needs target). affected: what a change to a symbol would impact. god-nodes: the most-connected modules.'),
    question: z.string().optional().describe('The question (query) or symbol name (explain/affected) or start symbol (path). Not needed for god-nodes.'),
    target: z.string().optional().describe('End symbol, for kind "path" only.'),
    budget: z.number().int().optional().describe('Token budget for the answer. Default 2000.'),
    depth: z.number().int().optional().describe('Traversal depth, 1-6. Default 2.'),
  },
  'thread-list': {},
  'thread-status': {
    threadId: z.string().describe('Thread id (or unique prefix). See thread-list.'),
  },
  'thread-diff': {
    threadId: z.string().describe('Thread id (or unique prefix). See thread-list.'),
  },
};

const MAX_PEEK_LINES = 1000;
const DEFAULT_PEEK_LINES = 200;
const DEFAULT_PDF_CHARS = 20_000;
const LATEX_TIMEOUT_MS = 120_000;

function error(text: string): ToolResult {
  return { text, isError: true };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function peekFile(args: { path: string; startLine?: number; endLine?: number }): Promise<ToolResult> {
  const path = resolve(args.path);
  if (!(await fileExists(path))) return error(`file-peek: no such file: ${path}`);
  if (!(await stat(path)).isFile()) return error(`file-peek: not a file: ${path}`);
  const raw = await readFile(path);
  if (raw.subarray(0, 8000).includes(0)) return error(`file-peek: ${path} looks binary, not text.`);
  const lines = raw.toString('utf-8').split('\n');
  const start = Math.max(1, args.startLine ?? 1);
  const end = Math.min(lines.length, args.endLine ?? start + DEFAULT_PEEK_LINES - 1);
  if (start > lines.length) return error(`file-peek: ${path} has only ${lines.length} lines; startLine ${start} is past the end.`);
  if (end - start + 1 > MAX_PEEK_LINES) {
    return error(`file-peek: requested ${end - start + 1} lines, cap is ${MAX_PEEK_LINES}. Narrow the range.`);
  }
  const width = String(end).length;
  const numbered = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(width)}: ${line}`);
  return { text: `${path} (lines ${start}-${end} of ${lines.length})\n${numbered.join('\n')}`, isError: false };
}

function runBinary(command: string, args: string[], options: { cwd?: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: options.cwd, timeout: options.timeoutMs ?? 60_000, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolvePromise({ stdout, stderr: `${stderr}\n${err.message}`, code: null }));
    child.on('close', (code) => resolvePromise({ stdout, stderr, code }));
  });
}

export async function readPdf(args: { path: string; startPage?: number; endPage?: number; maxChars?: number }): Promise<ToolResult> {
  const path = resolve(args.path);
  if (!(await fileExists(path))) return error(`pdf-read: no such file: ${path}`);
  const info = await cliInfo('pdftotext', ['-v']);
  if (!info.present) {
    return error('pdf-read: pdftotext is not installed. Install poppler-utils (Linux: apt install poppler-utils; macOS: brew install poppler; Windows: download from poppler.freedesktop.org).');
  }
  const toolArgs = ['-layout'];
  if (args.startPage !== undefined) toolArgs.push('-f', String(args.startPage));
  if (args.endPage !== undefined) toolArgs.push('-l', String(args.endPage));
  toolArgs.push(path, '-');
  const result = await runBinary('pdftotext', toolArgs, { timeoutMs: 60_000 });
  if (result.code !== 0) return error(`pdf-read: pdftotext failed (exit ${result.code}): ${result.stderr.trim().slice(-500)}`);
  const maxChars = args.maxChars ?? DEFAULT_PDF_CHARS;
  const text = result.stdout;
  if (text.length > maxChars) {
    return { text: `${text.slice(0, maxChars)}\n[truncated: ${text.length - maxChars} more characters; narrow the page range or raise maxChars]`, isError: false };
  }
  return { text: text.length > 0 ? text : '[pdf-read: no extractable text in this range]', isError: false };
}

export async function buildLatex(args: { path: string; outDir?: string }): Promise<ToolResult> {
  const path = resolve(args.path);
  if (!(await fileExists(path))) return error(`latex-build: no such file: ${path}`);
  if (!path.toLowerCase().endsWith('.tex')) return error(`latex-build: ${path} is not a .tex file.`);
  const outDir = args.outDir ? resolve(args.outDir) : dirname(path);
  const latexmk = await cliInfo('latexmk');
  const pdflatex = await cliInfo('pdflatex');
  if (!latexmk.present && !pdflatex.present) {
    return error('latex-build: neither latexmk nor pdflatex is installed. Install a TeX distribution (TeX Live, MacTeX, or MiKTeX).');
  }
  const pdfPath = path.replace(/\.tex$/i, '.pdf');
  if (latexmk.present) {
    const result = await runBinary('latexmk', ['-pdf', '-interaction=nonstopmode', `-outdir=${outDir}`, path], { cwd: dirname(path), timeoutMs: LATEX_TIMEOUT_MS });
    if (result.code === 0) return { text: `latex-build: OK — ${pdfPath}`, isError: false };
    const logTail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-30).join('\n');
    return error(`latex-build: latexmk failed (exit ${result.code}). Log tail:\n${logTail}`);
  }
  // pdflatex fallback: two passes (cross-references), nonstop mode.
  for (let pass = 1; pass <= 2; pass++) {
    const result = await runBinary('pdflatex', ['-interaction=nonstopmode', `-output-directory=${outDir}`, path], { cwd: dirname(path), timeoutMs: LATEX_TIMEOUT_MS });
    if (result.code !== 0) {
      const logTail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-30).join('\n');
      return error(`latex-build: pdflatex pass ${pass} failed (exit ${result.code}). Log tail:\n${logTail}`);
    }
  }
  return { text: `latex-build: OK — ${pdfPath}`, isError: false };
}

const MAX_GRAPH_CHARS = 8000;

/**
 * Query the code graph for the repo the agent is working in. The server runs
 * with the agent's cwd, which may be a scode worktree — resolveMainCheckout
 * walks to the main checkout, where the graph lives.
 */
export async function queryGraphTool(
  args: { kind?: GraphQueryKind; question?: string; target?: string; budget?: number; depth?: number },
  runtime: { binary?: string; binaryArgs?: string[] } = {},
): Promise<ToolResult> {
  const kind = args.kind ?? 'query';
  const repoPath = await resolveMainCheckout(process.cwd());
  const meta = await readGraphMeta(repoPath);
  if (!meta) {
    return error(`graph-query: no code graph at ${graphJsonPath(repoPath)}. Run \`scode graph init\` in the repo root (or wait for the next scode dispatch, which builds it automatically when graphify is installed).`);
  }
  const result = await runGraphQuery(repoPath, kind, {
    question: args.question,
    target: args.target,
    budget: args.budget,
    depth: args.depth,
    binary: runtime.binary,
    binaryArgs: runtime.binaryArgs,
  });
  if (!result.ok) return error(`graph-query: ${result.text}`);
  const text = result.text;
  if (text.length > MAX_GRAPH_CHARS) {
    return { text: `${text.slice(0, MAX_GRAPH_CHARS)}\n[truncated: ${text.length - MAX_GRAPH_CHARS} more characters; narrow the question or lower the depth]`, isError: false };
  }
  return { text, isError: false };
}

export async function listThreadsTool(): Promise<ToolResult> {
  const threads = await loadThreads();
  return { text: renderThreadList(threads).join('\n'), isError: false };
}

export async function threadStatusTool(args: { threadId: string }): Promise<ToolResult> {
  try {
    const thread = findThread(await loadThreads(), args.threadId);
    const diff = await threadDiff(thread);
    const lines = [...renderThreadStatus(thread), '', ...renderDiffSummary(diff, thread).slice(2)];
    return { text: lines.join('\n'), isError: false };
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : String(caught));
  }
}

const MAX_TOOL_DIFF_CHARS = 8000;

export async function threadDiffTool(args: { threadId: string }): Promise<ToolResult> {
  try {
    const thread = findThread(await loadThreads(), args.threadId);
    const diff = await threadDiff(thread);
    const lines = renderDiffSummary(diff, thread);
    if (diff.diffText) {
      const text = diff.diffText.length > MAX_TOOL_DIFF_CHARS
        ? `${diff.diffText.slice(0, MAX_TOOL_DIFF_CHARS)}\n… (truncated; run \`scode diff ${thread.id}\` for the full diff)`
        : diff.diffText;
      lines.push('', text);
    }
    return { text: lines.join('\n'), isError: false };
  } catch (caught) {
    return error(caught instanceof Error ? caught.message : String(caught));
  }
}

export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'file-peek': return peekFile(args as { path: string; startLine?: number; endLine?: number });
    case 'pdf-read': return readPdf(args as { path: string; startPage?: number; endPage?: number; maxChars?: number });
    case 'latex-build': return buildLatex(args as { path: string; outDir?: string });
    case 'graph-query': return queryGraphTool(args as { kind?: GraphQueryKind; question?: string; target?: string; budget?: number; depth?: number });
    case 'thread-list': return listThreadsTool();
    case 'thread-status': return threadStatusTool(args as { threadId: string });
    case 'thread-diff': return threadDiffTool(args as { threadId: string });
    default: return error(`Unknown tool: ${name}`);
  }
}
