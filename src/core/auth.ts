import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ScodeConfig } from '../config.js';
import type { BackendId } from './types.js';

const AUTH_TIMEOUT_MS = 5_000;

function capture(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: AUTH_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(null);
      resolve(`${stdout}${stderr}`.trim());
    });
  });
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseCodexAuth(output: string): string | null {
  if (/not logged in|logged out/i.test(output)) return null;
  if (!/logged in/i.test(output)) return null;
  if (/chatgpt/i.test(output)) return 'ChatGPT';
  if (/api\s*key/i.test(output)) return 'OpenAI API key';
  return 'OpenAI';
}

export function parseClaudeAuth(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (value.loggedIn === false) return null;
  const provider = typeof value.apiProvider === 'string' ? value.apiProvider.toLowerCase()
    : typeof value.provider === 'string' ? value.provider.toLowerCase() : '';
  if (provider.includes('bedrock')) return 'Amazon Bedrock';
  if (provider.includes('vertex')) return 'Google Vertex AI';
  if (provider.includes('foundry')) return 'Microsoft Foundry';
  const method = typeof value.authMethod === 'string' ? value.authMethod.toLowerCase() : '';
  if (method.includes('oauth')) return 'Claude OAuth';
  if (method.includes('api')) return 'Anthropic API key';
  return value.loggedIn === true ? 'Anthropic' : null;
}

export function parseOpenCodeProviders(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const friendly = new Map([
    ['amazon-bedrock', 'Bedrock'],
    ['github-copilot', 'GitHub Copilot'],
    ['nvidia', 'NVIDIA'],
    ['openai', 'OpenAI'],
    ['anthropic', 'Anthropic'],
    ['google', 'Google'],
  ]);
  const providers = Object.keys(payload as Record<string, unknown>)
    .filter((name) => name !== 'testing')
    .map((name) => friendly.get(name) ?? name)
    .sort();
  return providers.length > 0 ? providers.join(' + ') : null;
}

function truthy(value: unknown): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

async function claudeSettingsFallback(): Promise<string | null> {
  const settings = await readJson(join(homedir(), '.claude', 'settings.json'));
  if (typeof settings !== 'object' || settings === null) return null;
  const env = (settings as Record<string, unknown>).env;
  if (typeof env !== 'object' || env === null) return null;
  const values = env as Record<string, unknown>;
  if (truthy(values.CLAUDE_CODE_USE_BEDROCK)) return 'Amazon Bedrock';
  if (truthy(values.CLAUDE_CODE_USE_VERTEX) || typeof values.ANTHROPIC_VERTEX_PROJECT_ID === 'string') return 'Google Vertex AI';
  if (truthy(values.CLAUDE_CODE_USE_FOUNDRY)) return 'Microsoft Foundry';
  return null;
}

async function detectGoogleAuth(): Promise<string | null> {
  const settings = await readJson(join(homedir(), '.gemini', 'settings.json'));
  const selected = typeof settings === 'object' && settings !== null
    ? ((settings as Record<string, unknown>).security as Record<string, unknown> | undefined)?.auth
    : undefined;
  const selectedType = typeof selected === 'object' && selected !== null
    ? (selected as Record<string, unknown>).selectedType
    : undefined;
  const hasGcp = await fileExists(join(homedir(), '.config', 'gcloud', 'active_config'));
  if (typeof selectedType === 'string' && selectedType.toLowerCase().includes('oauth')) {
    return hasGcp ? 'Google OAuth / GCP' : 'Google OAuth';
  }
  const accounts = await readJson(join(homedir(), '.gemini', 'google_accounts.json'));
  if (accounts) return hasGcp ? 'Google / GCP' : 'Google';
  return hasGcp ? 'GCP' : null;
}

async function detectKiroAuth(): Promise<string | null> {
  const output = await capture('kiro-cli', ['whoami']);
  if (!output) return null;
  if (/builder\s*id/i.test(output)) return 'AWS Builder ID';
  if (/identity\s*center|\bidc\b/i.test(output)) return 'AWS IAM Identity Center';
  if (/api\s*key/i.test(output)) return 'Kiro API key';
  return 'Kiro account';
}

async function detectClaudeAuth(): Promise<string | null> {
  const output = await capture('claude', ['auth', 'status', '--json']);
  if (output) {
    try {
      const parsed = parseClaudeAuth(JSON.parse(output) as unknown);
      if (parsed) return parsed;
    } catch {
      // Older Claude versions do not support JSON auth status.
    }
  }
  return claudeSettingsFallback();
}

export async function detectBackendAuth(id: BackendId, config: ScodeConfig): Promise<string | null> {
  switch (id) {
    case 'codex-a':
    case 'codex-b': {
      const home = id === 'codex-b' ? config.codexHomes.b : config.codexHomes.a;
      if (id === 'codex-b' && !home) return null;
      const env = { ...process.env, ...(home ? { CODEX_HOME: home } : {}) };
      return parseCodexAuth((await capture('codex', ['login', 'status'], env)) ?? '');
    }
    case 'kiro': return detectKiroAuth();
    case 'agy': return detectGoogleAuth();
    case 'copilot': {
      const hasSession = await fileExists(join(homedir(), '.copilot', 'session-store.db'));
      const hasConfig = await fileExists(join(homedir(), '.copilot', 'config.json'));
      return hasSession || hasConfig ? 'GitHub OAuth' : null;
    }
    case 'opencode':
      if (config.opencodeModel.startsWith('opencode/')) return 'OpenCode free';
      if (config.opencodeModel.startsWith('amazon-bedrock/')) return 'Amazon Bedrock';
      if (config.opencodeModel.startsWith('github-copilot/')) return 'GitHub Copilot';
      if (config.opencodeModel.startsWith('nvidia/')) return 'NVIDIA';
      return parseOpenCodeProviders(await readJson(join(homedir(), '.local', 'share', 'opencode', 'auth.json')));
    case 'claude': return detectClaudeAuth();
    default: return null;
  }
}
