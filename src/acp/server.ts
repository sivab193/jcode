/**
 * Minimal ACP v1 agent server over stdio NDJSON — the Zed integration.
 *
 * Zed's Agent panel speaks the Agent Client Protocol; `scode acp` lets Zed
 * drive scode's router as if it were a coding agent. One ACP session is one
 * scode thread (same id): the first prompt creates the thread (branch +
 * worktree) from the prompt text, later prompts continue it with session
 * resume. Agent output streams back as agent_message_chunk updates;
 * session/cancel aborts the running dispatch.
 *
 * Shapes follow ACP v1 (agentclientprotocol.com), cross-checked against
 * T3 Code's generated schema (packages/effect-acp/src/_generated/
 * schema-v1.gen.ts). Only the methods Zed needs are implemented:
 * initialize, session/new, session/prompt, session/cancel. Everything
 * else answers -32601 (method not found) — honest, not faked.
 *
 * Protocol rule: stdout carries ONLY JSON-RPC frames. All diagnostics go
 * to stderr.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createThread, dispatchThreadTurn, type Thread } from '../core/threads.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface AcpSession {
  id: string;
  cwd: string;
  thread: Thread | null;
  controller: AbortController | null;
  running: boolean;
}

type Params = Record<string, unknown>;

function isParams(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOfPrompt(prompt: unknown): string | null {
  if (!Array.isArray(prompt)) return null;
  const parts: string[] = [];
  for (const block of prompt) {
    if (typeof block === 'object' && block !== null && (block as Params).type === 'text'
      && typeof (block as Params).text === 'string') {
      parts.push((block as Params).text as string);
    }
  }
  const text = parts.join('\n').trim();
  return text ? text : null;
}

let cachedVersion: string | null = null;

export async function agentVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.1.0';
  } catch {
    cachedVersion = '0.1.0';
  }
  return cachedVersion;
}

export interface AcpServer {
  /** Handle one NDJSON line (a request or notification). */
  handleLine: (line: string) => Promise<void>;
  /** Sessions, for tests. */
  sessions: Map<string, AcpSession>;
}

export function createAcpServer(send: (frame: Record<string, unknown>) => void): AcpServer {
  const sessions = new Map<string, AcpSession>();

  const reply = (id: string | number | null, result: unknown) => {
    send({ jsonrpc: '2.0', id, result });
  };
  const replyError = (id: string | number | null, code: number, message: string) => {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };
  const notify = (method: string, params: unknown) => {
    send({ jsonrpc: '2.0', method, params });
  };
  const update = (sessionId: string, sessionUpdate: string, text: string) => {
    notify('session/update', {
      sessionId,
      update: { sessionUpdate, content: { type: 'text', text } },
    });
  };

  const handleInitialize = async (id: string | number | null) => {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: 'scode', version: await agentVersion() },
    });
  };

  const handleSessionNew = (id: string | number | null, params: unknown) => {
    const cwd = isParams(params) && typeof params.cwd === 'string' ? params.cwd : process.cwd();
    const sessionId = randomUUID().replace(/-/g, '').slice(0, 8);
    sessions.set(sessionId, { id: sessionId, cwd, thread: null, controller: null, running: false });
    reply(id, { sessionId });
  };

  const handlePrompt = async (id: string | number | null, params: unknown) => {
    if (!isParams(params) || typeof params.sessionId !== 'string') {
      replyError(id, -32602, 'session/prompt requires a sessionId');
      return;
    }
    const session = sessions.get(params.sessionId);
    if (!session) {
      replyError(id, -32602, `Unknown session: ${params.sessionId}`);
      return;
    }
    const brief = textOfPrompt(params.prompt);
    if (!brief) {
      replyError(id, -32602, 'session/prompt needs at least one text block');
      return;
    }
    if (session.running) {
      replyError(id, -32000, 'A turn is already running on this session');
      return;
    }
    session.running = true;
    const controller = new AbortController();
    session.controller = controller;
    try {
      if (!session.thread) {
        session.thread = await createThread(brief, { cwd: session.cwd, id: session.id });
        update(session.id, 'agent_thought_chunk', `Thread ${session.thread.id} on branch ${session.thread.branch}.\n`);
      }
      const outcome = await dispatchThreadTurn(session.thread, brief, {
        signal: controller.signal,
        onStdout: (chunk) => update(session.id, 'agent_message_chunk', chunk),
        onStderr: (chunk) => update(session.id, 'agent_thought_chunk', chunk),
      });
      const { result } = outcome;
      if (result.errorClass === 'cancelled') {
        reply(id, { stopReason: 'cancelled' });
        return;
      }
      if (!result.success) {
        const detail = result.errorClass ? ` (${result.errorClass})` : '';
        update(session.id, 'agent_message_chunk', `\n[Turn failed on ${result.backend}${detail}.]`);
      } else if (outcome.switchedBackend) {
        update(session.id, 'agent_thought_chunk', `\n[Routed to ${result.backend}: ${outcome.selectionReason}]`);
      }
      reply(id, { stopReason: 'end_turn' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[scode acp] prompt failed: ${message}`);
      replyError(id, -32000, message);
    } finally {
      session.running = false;
      session.controller = null;
    }
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      console.error('[scode acp] ignoring malformed JSON line');
      return;
    }
    if (typeof message !== 'object' || message === null || typeof message.method !== 'string') {
      console.error('[scode acp] ignoring message without a method');
      return;
    }
    const isRequest = message.id !== undefined && message.id !== null;
    const id = message.id ?? null;
    switch (message.method) {
      case 'initialize':
        if (isRequest) await handleInitialize(id);
        break;
      case 'session/new':
        if (isRequest) handleSessionNew(id, message.params);
        break;
      case 'session/prompt':
        if (isRequest) await handlePrompt(id, message.params);
        break;
      case 'session/cancel': {
        // Notification: abort the session's running turn, if any.
        const params = isParams(message.params) ? message.params : {};
        const session = typeof params.sessionId === 'string' ? sessions.get(params.sessionId) : undefined;
        session?.controller?.abort();
        break;
      }
      default:
        // Unknown methods are not faked: -32601 for requests, ignored
        // for notifications.
        if (isRequest) replyError(id, -32601, `Method not found: ${message.method}`);
        break;
    }
  };

  return { handleLine, sessions };
}

/** stdio transport: NDJSON in on stdin, NDJSON out on stdout. */
export async function runAcpServer(): Promise<number> {
  const server = createAcpServer((frame) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  });
  // Lines are handled concurrently, never queued behind a running turn:
  // a session/cancel arriving mid-turn must reach the abort controller
  // while the turn is still running, not after it finishes. JSON-RPC
  // replies carry ids, so out-of-order completion is fine.
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    const task = server.handleLine(line).catch((error: unknown) => {
      console.error(`[scode acp] ${error instanceof Error ? error.message : String(error)}`);
    });
    pending.add(task);
    void task.then(() => pending.delete(task));
  }
  // Client disconnected: stop every running turn, wait for them to settle,
  // then exit. A turn must never outlive the ACP process.
  for (const session of server.sessions.values()) session.controller?.abort();
  await Promise.allSettled(pending);
  return 0;
}
