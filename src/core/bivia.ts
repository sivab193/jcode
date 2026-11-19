import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BackendId } from './types.js';
import type { TaskClass } from './classifier.js';

const API_URL = 'https://api.articul8.ai/bivia/v1/systemone';
const TIMEOUT_MS = 2500;

const TASK_CLASSES: Record<TaskClass, string> = {
  'review-tests': 'Code review, tests, linting, and small fixes.',
  architecture: 'Architecture, system design, migrations, and large refactors.',
  aws: 'AWS services and infrastructure, including Lambda, S3, and DynamoDB.',
  exploration: 'Understanding or exploring a large repository.',
  github: 'GitHub issues, pull requests, and Actions workflows.',
  'free-model': 'Low-stakes work suitable for a free or low-cost model.',
  'deep-reasoning': 'Difficult reasoning, proofs, and algorithm design.',
  general: 'Coding work that does not fit another category.',
};

export interface BiviaDecision {
  taskClass: TaskClass | null;
  taskClassConfidence: number | null;
  backend: BackendId | null;
  backendConfidence: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readApiKey(): Promise<string | null> {
  const envKey = process.env.SCODE_BIVIA_API_KEY
    || process.env.JCODE_BIVIA_API_KEY
    || process.env.BIVIA_API_KEY
    || process.env.A8_API_KEY;
  if (envKey) return envKey;

  try {
    const config = await readFile(join(homedir(), '.bivia', 'config'), 'utf8');
    for (const line of config.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?(?:BIVIA_API_KEY|A8_API_KEY)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const value = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
      if (value) return value;
    }
    return null;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseAnswer<T extends string>(
  answer: unknown,
  allowed: readonly T[],
): { value: T; confidence: number | null } | null {
  if (!isRecord(answer) || answer.abstained === true || typeof answer.choice !== 'string') return null;
  if (!allowed.includes(answer.choice as T)) return null;
  const confidence = typeof answer.confidence === 'number' && Number.isFinite(answer.confidence)
    ? answer.confidence
    : null;
  return { value: answer.choice as T, confidence };
}

export async function biviaRouteDecision(
  brief: string,
  backendOptions: Array<{ id: BackendId; description: string }>,
): Promise<BiviaDecision | null> {
  if ((process.env.SCODE_BIVIA ?? process.env.JCODE_BIVIA)?.toLowerCase() === 'false') return null;
  let apiKey: string | null;
  try {
    apiKey = await readApiKey();
  } catch {
    console.warn('[scode] Could not read Bivia credentials; using local routing.');
    return null;
  }
  if (!apiKey) return null;

  const questions: Record<string, unknown> = {
    taskClass: {
      type: 'choice',
      instructions: 'Classify this coding task into the most specific applicable category.',
      criteria: TASK_CLASSES,
    },
  };
  if (backendOptions.length > 1) {
    questions.backend = {
      type: 'choice',
      instructions: 'Choose the best eligible coding CLI for this task, considering its fit and quota information.',
      criteria: Object.fromEntries(backendOptions.map(({ id, description }) => [id, description])),
    };
  }

  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ state: brief, mode: 'fast', questions }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.warn('[scode] Bivia request timed out or failed; using local routing.');
    return null;
  }
  if (!response.ok) {
    console.warn(`[scode] Bivia request failed (HTTP ${response.status}); using local routing.`);
    return null;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    console.warn('[scode] Bivia returned invalid JSON; using local routing.');
    return null;
  }
  if (!isRecord(payload) || !isRecord(payload.answers)) {
    console.warn('[scode] Bivia returned an invalid decision; using local routing.');
    return null;
  }

  const classes = Object.keys(TASK_CLASSES) as TaskClass[];
  const backends = backendOptions.map(({ id }) => id);
  const taskClass = parseAnswer(payload.answers.taskClass, classes);
  const backend = backends.length > 1 ? parseAnswer(payload.answers.backend, backends) : null;
  if (!taskClass) console.warn('[scode] Bivia returned no usable task class; using the local classifier.');
  if (backends.length > 1 && !backend) console.warn('[scode] Bivia returned no usable backend; using local policy.');
  return {
    taskClass: taskClass?.value ?? null,
    taskClassConfidence: taskClass?.confidence ?? null,
    backend: backend?.value ?? null,
    backendConfidence: backend?.confidence ?? null,
  };
}
