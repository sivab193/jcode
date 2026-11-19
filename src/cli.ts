import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { runAcpServer } from './acp/server.js';
import { dispatch } from './core/dispatcher.js';
import { buildGraph, ensureGitignored, graphStatus, graphifyInfo, installGraphHooks } from './core/graphify.js';
import { readLedgerTail } from './core/ledger.js';
import { routeTask } from './core/router.js';
import { createPr, renderDiffSummary, threadDiff } from './core/pr.js';
import {
  closeThread,
  createThread,
  dispatchThreadTurn,
  findThread,
  loadThreads,
  renderThreadList,
  renderThreadStatus,
} from './core/threads.js';
import { computeTokenStats, renderTokenDashboard } from './core/tokenStats.js';
import { renderLimits } from './core/limits.js';
import { backendSnapshots } from './core/quota.js';
import {
  addSchedule,
  installHint,
  loadSchedules,
  parseDuration,
  removeSchedule,
  runDueSchedules,
  setScheduleEnabled,
  validateCron,
} from './core/schedules.js';
import { getPriors } from './core/scoring.js';
import { BACKEND_IDS, THEME_IDS, type BackendId, type BackendSnapshot, type ThemeId } from './core/types.js';
import { loadConfig, setBackendProfile, setCodexHome, setOpenCodeModel, setTheme } from './config.js';
import { THEMES } from './tui/theme.js';
import { runDoctor } from './doctor.js';
import { runLearn } from './core/learn.js';
import { installForBackend, toolsStatus } from './mcp/install.js';
import { attachRun, listRunRecords } from './core/runs.js';
import { section, table, ui } from './format.js';
import { displayQuotaWindows } from './core/quotaDisplay.js';

export type Command =
  | { name: 'tui' }
  | { name: 'run'; brief: string; backend?: BackendId; cwd?: string; dryRun?: boolean }
  | { name: 'status' }
  | { name: 'session'; action: 'list' | 'attach'; id?: string }
  | { name: 'backend'; action: 'list' | 'set'; backend?: BackendId; label?: string; account?: string; model?: string; home?: string }
  | { name: 'doctor'; quick?: boolean; full?: boolean }
  | { name: 'learn' }
  | { name: 'tokens' }
  | { name: 'usage' }
  | { name: 'theme'; action: 'list' | 'set'; theme?: ThemeId }
  | { name: 'tools'; action: 'install' | 'status' }
  | { name: 'graph'; action: 'init' | 'status' | 'refresh'; path: string; force?: boolean }
  | {
      name: 'thread';
      action: 'new' | 'list' | 'continue' | 'status' | 'close';
      brief?: string;
      id?: string;
      backend?: BackendId;
      cwd?: string;
    }
  | { name: 'diff'; id: string; statOnly?: boolean }
  | { name: 'pr'; id: string; draft?: boolean; dryRun?: boolean }
  | { name: 'acp' }
  | { name: 'zed'; id: string }
  | { name: 'zed-setup' }
  | {
      name: 'schedule';
      action: 'add' | 'list' | 'remove' | 'enable' | 'disable' | 'tick' | 'install';
      brief?: string;
      cron?: string;
      at?: string;
      inMs?: number;
      backend?: BackendId;
      cwd?: string;
      id?: string;
      dryRun?: boolean;
    }
  | { name: 'help' };

function isBackend(value: string): value is BackendId {
  return BACKEND_IDS.includes(value as BackendId);
}

function isTheme(value: string): value is ThemeId {
  return THEME_IDS.includes(value as ThemeId);
}

export function parseArgs(argv: string[]): Command {
  if (argv.length === 0) return { name: 'tui' };
  const [name, ...rest] = argv;
  if (name === '--help' || name === '-h' || name === 'help') return { name: 'help' };
  if (name === 'status') return { name: 'status' };
  if (name === 'session') {
    if (rest.length === 0 || rest[0] === 'list') return { name: 'session', action: 'list' };
    if (rest[0] === 'attach' && rest[1]) return { name: 'session', action: 'attach', id: rest[1] };
    throw new Error('Usage: scode session [list | attach <task-id>]');
  }
  if (name === 'backend') return parseBackendArgs(rest);
  if (name === 'learn') return { name: 'learn' };
  if (name === 'tokens') return { name: 'tokens' };
  if (name === 'usage') return { name: 'usage' };
  if (name === 'thread') return parseThreadArgs(rest);
  if (name === 'acp') return { name: 'acp' };
  if (name === 'zed-setup') return { name: 'zed-setup' };
  if (name === 'zed') {
    if (!rest[0]) throw new Error('Usage: scode zed <thread-id>');
    return { name: 'zed', id: rest[0] };
  }
  if (name === 'diff') {
    if (!rest[0]) throw new Error('Usage: scode diff <thread-id> [--stat]');
    return { name: 'diff', id: rest[0], statOnly: rest.includes('--stat') };
  }
  if (name === 'pr') {
    if (!rest[0]) throw new Error('Usage: scode pr <thread-id> [--draft] [--dry-run]');
    return { name: 'pr', id: rest[0], draft: rest.includes('--draft'), dryRun: rest.includes('--dry-run') };
  }
  if (name === 'theme') {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === 'list')) {
      return { name: 'theme', action: 'list' };
    }
    if (rest.length === 2 && rest[0] === 'set' && isTheme(rest[1])) {
      return { name: 'theme', action: 'set', theme: rest[1] };
    }
    throw new Error(`Usage: scode theme [list | set <${THEME_IDS.join('|')}>]`);
  }
  if (name === 'doctor') {
    return {
      name: 'doctor',
      quick: rest.includes('--quick'),
      full: rest.includes('--full'),
    };
  }
  if (name === 'tools') {
    const action = rest[0];
    if (action !== 'install' && action !== 'status') throw new Error('Usage: scode tools <install|status>');
    return { name: 'tools', action };
  }
  if (name === 'schedule') return parseScheduleArgs(rest);
  if (name === 'graph') return parseGraphArgs(rest);
  if (name !== 'run') throw new Error(`Unknown command: ${name}`);

  let backend: BackendId | undefined;
  let cwd: string | undefined;
  let dryRun = false;
  const briefParts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--backend') {
      const value = rest[++index];
      if (!value || !isBackend(value)) throw new Error(`Invalid backend. Choose: ${BACKEND_IDS.join(', ')}`);
      backend = value;
    } else if (rest[index] === '--cwd') {
      const value = rest[++index];
      if (!value) throw new Error('--cwd requires a path');
      cwd = resolve(value);
    } else if (rest[index] === '--dry-run') {
      dryRun = true;
    } else {
      briefParts.push(rest[index]);
    }
  }
  const brief = briefParts.join(' ').trim();
  if (!brief) throw new Error('scode run requires a task brief');
  return { name: 'run', brief, backend, cwd, dryRun };
}

function parseBackendArgs(rest: string[]): Extract<Command, { name: 'backend' }> {
  if (rest.length === 0 || rest[0] === 'list') return { name: 'backend', action: 'list' };
  if (rest[0] !== 'set' || !rest[1] || !isBackend(rest[1])) {
    throw new Error(`Usage: scode backend set <${BACKEND_IDS.join('|')}> [--label NAME] [--account HINT] [--model MODEL|free] [--home PATH]`);
  }
  const command: Extract<Command, { name: 'backend' }> = { name: 'backend', action: 'set', backend: rest[1] };
  for (let index = 2; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(`${flag} requires a value`);
    if (flag === '--label') command.label = value;
    else if (flag === '--account') command.account = value;
    else if (flag === '--model') command.model = value;
    else if (flag === '--home') command.home = resolve(value);
    else throw new Error(`Unknown backend setting: ${flag}`);
  }
  return command;
}

function snapshotRows(item: BackendSnapshot): string[][] {
  const used = item.quota.remainingFraction === null ? null : 1 - item.quota.remainingFraction;
  const usage = item.status === 'disabled' ? '—'
    : used !== null ? `${Math.round(used * 100)}% used`
      : item.id === 'opencode' && item.model.startsWith('opencode/') ? 'free'
        : item.quotaMode === 'provider' ? 'provider'
          : 'on run';
  const login = item.loginStatus === 'active' ? 'active'
    : item.loginStatus === 'setup' ? 'setup'
      : item.loginStatus === 'disabled' ? 'disabled' : 'logged out';
  const context = item.id === 'kiro' ? 'monthly allowance'
    : item.status === 'disabled' ? item.note : undefined;
  const via = [item.authProvider, item.accountLabel, context].filter(Boolean).join(' · ') || item.note || '—';
  const windows = displayQuotaWindows(item);
  if (windows.length === 0) return [[item.displayName ?? item.id, login, usage, '—', via]];
  return windows.map((window, index) => [
    index === 0 ? item.displayName ?? item.id : '',
    index === 0 ? login : '',
    `${window.label} ${window.usage}`,
    window.reset,
    index === 0 ? via : '',
  ]);
}

function parseThreadArgs(rest: string[]): Extract<Command, { name: 'thread' }> {
  const [action, ...args] = rest;
  if (action === 'list') return { name: 'thread', action: 'list' };
  if (action === 'status' || action === 'close') {
    if (!args[0]) throw new Error(`Usage: scode thread ${action} <thread-id>`);
    return { name: 'thread', action, id: args[0] };
  }
  if (action !== 'new' && action !== 'continue') {
    throw new Error('Usage: scode thread <new|list|continue|status|close>');
  }
  let backend: BackendId | undefined;
  let cwd: string | undefined;
  let id: string | undefined;
  const briefParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--backend') {
      const value = args[++index];
      if (!value || !isBackend(value)) throw new Error(`Invalid backend. Choose: ${BACKEND_IDS.join(', ')}`);
      backend = value;
    } else if (args[index] === '--cwd') {
      const value = args[++index];
      if (!value) throw new Error('--cwd requires a path');
      cwd = resolve(value);
    } else if (action === 'continue' && !id && briefParts.length === 0) {
      // `thread continue <id> "<brief>"` — the first bare word is the id.
      id = args[index];
    } else {
      briefParts.push(args[index]);
    }
  }
  const brief = briefParts.join(' ').trim();
  if (!brief) throw new Error(`scode thread ${action} requires a task brief`);
  if (action === 'continue' && !id) throw new Error('Usage: scode thread continue <thread-id> "<follow-up>"');
  return { name: 'thread', action, brief, id, backend, cwd };
}

function parseGraphArgs(rest: string[]): Extract<Command, { name: 'graph' }> {
  const [action, ...args] = rest;
  if (action !== 'init' && action !== 'status' && action !== 'refresh') {
    throw new Error('Usage: scode graph <init|status|refresh> [path] [--force]');
  }
  const force = args.includes('--force');
  const pathArg = args.find((arg) => !arg.startsWith('--'));
  return { name: 'graph', action, path: resolve(pathArg ?? process.cwd()), force };
}

function parseScheduleArgs(rest: string[]): Extract<Command, { name: 'schedule' }> {
  const [action, ...args] = rest;
  if (action === 'list') return { name: 'schedule', action: 'list' };
  if (action === 'install') return { name: 'schedule', action: 'install' };
  if (action === 'tick') {
    return { name: 'schedule', action: 'tick', dryRun: args.includes('--dry-run') };
  }
  if (action === 'remove' || action === 'enable' || action === 'disable') {
    if (!args[0]) throw new Error(`Usage: scode schedule ${action} <id>`);
    return { name: 'schedule', action, id: args[0] };
  }
  if (action !== 'add') {
    throw new Error('Usage: scode schedule <add|list|remove|enable|disable|tick|install>');
  }
  let backend: BackendId | undefined;
  let cwd: string | undefined;
  let cron: string | undefined;
  let at: string | undefined;
  let inMs: number | undefined;
  const briefParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--backend') {
      const value = args[++index];
      if (!value || !isBackend(value)) throw new Error(`Invalid backend. Choose: ${BACKEND_IDS.join(', ')}`);
      backend = value;
    } else if (args[index] === '--cwd') {
      const value = args[++index];
      if (!value) throw new Error('--cwd requires a path');
      cwd = resolve(value);
    } else if (args[index] === '--cron') {
      const value = args[++index];
      if (!value) throw new Error('--cron requires a 5-field expression, e.g. "0 9 * * 1-5"');
      try {
        validateCron(value);
      } catch (error) {
        throw new Error(`Invalid cron expression "${value}": ${error instanceof Error ? error.message : String(error)}`);
      }
      cron = value;
    } else if (args[index] === '--at') {
      const value = args[++index];
      if (!value || Number.isNaN(new Date(value).getTime())) {
        throw new Error('--at requires a valid date, e.g. "2026-11-20T09:00" (local time)');
      }
      at = new Date(value).toISOString();
    } else if (args[index] === '--in') {
      const value = args[++index];
      const parsed = value ? parseDuration(value) : null;
      if (parsed === null) throw new Error('--in requires a duration like "30m", "2h", or "1d"');
      inMs = parsed;
    } else {
      briefParts.push(args[index]);
    }
  }
  const brief = briefParts.join(' ').trim();
  if (!brief) throw new Error('scode schedule add requires a task brief');
  const kinds = [cron !== undefined, at !== undefined, inMs !== undefined].filter(Boolean).length;
  if (kinds !== 1) throw new Error('scode schedule add needs exactly one of --cron, --at, or --in');
  return { name: 'schedule', action: 'add', brief, cron, at, inMs, backend, cwd };
}

export async function runHeadless(command: Exclude<Command, { name: 'tui' }>): Promise<number> {
  if (command.name === 'help') {
    console.log([
      section('Command guide', 'route, run, and continue coding agents'),
      '',
      ui.accent('CORE'),
      '  scode                                    open the terminal UI',
      '  scode run [--backend ID] [--cwd PATH] [--dry-run] "<task>"',
      '  scode status                             per-backend headroom (runs probes)',
      '  scode session [list|attach TASK_ID]      continue in the vendor\'s native terminal UI',
      '  scode backend [list|set ...]             name accounts and configure backends',
      '',
      ui.accent('INSPECT & AUTOMATE'),
      '  scode doctor [--quick] [--full]          Phase 0 machine smoke tests',
      '  scode learn                              learning fold (Phase 5)',
      '  scode tokens                             token usage dashboard (today + last 7 days)',
      '  scode usage                              usage limits per backend (Session/Weekly windows)',
      `  scode theme [list | set <${THEME_IDS.join('|')}>]  choose a TUI color theme`,
      '  scode tools <install|status>             wire the scode-tools MCP server into backends',
      '  scode graph <init|status|refresh> [path] code graph for a repo (Graphify, local only)',
      '  scode schedule add "<task>" --cron "0 9 * * 1-5"  recurring job (local time)',
      '  scode schedule add "<task>" --at 2026-11-20T09:00  one-shot job',
      '  scode schedule add "<task>" --in 2h       one-shot job, relative',
      '  scode schedule <list|remove|enable|disable|tick|install>',
      '',
      ui.accent('THREADS & ZED'),
      '  scode thread new "<task>" [--backend ID]  new thread (branch + worktree + session)',
      '  scode thread <list|status|close> [id]     manage threads',
      '  scode thread continue <id> "<follow-up>"  next turn on a thread',
      '  scode diff <thread-id> [--stat]           thread change vs its base branch',
      '  scode pr <thread-id> [--draft] [--dry-run] commit, push, open the PR',
      '  scode acp                                ACP agent server for Zed (stdio)',
      '  scode zed <thread-id>                    open a thread worktree in Zed',
      '  scode zed-setup                          print the Zed agent_servers snippet',
      '',
      '',
      ui.dim(`Backends  ${BACKEND_IDS.join(' · ')}`),
      ui.dim('Upcoming  Cursor CLI'),
      ui.dim('Upcoming  Bivia CLI'),
    ].join('\n'));
    return 0;
  }
  if (command.name === 'session') {
    if (command.action === 'attach') return attachRun(command.id as string);
    const runs = await listRunRecords();
    console.log(section('Sessions', 'native CLI conversations and preserved worktrees'));
    if (runs.length === 0) {
      console.log(ui.dim('No recorded sessions yet. Run a task first.'));
      return 0;
    }
    console.log(table(['TASK ID', 'BACKEND', 'STATE', 'UPDATED', 'BRIEF'], runs.slice(0, 20).map((run) => [
      run.taskId, run.backend, run.hasChanges ? 'changes' : run.success ? 'done' : 'failed',
      new Date(run.updatedAt).toLocaleString(), run.brief.slice(0, 48),
    ])).join('\n'));
    console.log(ui.dim('\nContinue with: scode session attach <task-id>'));
    return 0;
  }
  if (command.name === 'backend') {
    if (command.action === 'set') {
      const backend = command.backend as BackendId;
      if (command.label !== undefined || command.account !== undefined) {
        await setBackendProfile(backend, { label: command.label, account: command.account });
      }
      if (command.model !== undefined) {
        if (backend !== 'opencode') throw new Error('--model is currently supported for opencode only');
        await setOpenCodeModel(command.model);
      }
      if (command.home !== undefined) {
        if (backend !== 'codex-a' && backend !== 'codex-b') throw new Error('--home is supported for codex-a/codex-b only');
        await setCodexHome(backend === 'codex-a' ? 'a' : 'b', command.home);
      }
      console.log(`${ui.good('Saved')} ${backend}. Run ${ui.accent('scode status')} to verify login and usage.`);
      if (command.home) console.log(ui.dim(`Login separately: CODEX_HOME=${JSON.stringify(command.home)} codex login`));
      return 0;
    }
    const snapshots = await backendSnapshots();
    console.log(section('Backend settings', 'labels and account hints are local-only'));
    console.log(table(['ID', 'DISPLAY', 'ACCOUNT', 'MODEL'], snapshots.map((item) => [
      item.id, item.displayName ?? item.id, item.accountLabel ?? '—', item.model,
    ])).join('\n'));
    console.log(ui.dim('\nExample: scode backend set codex-b --label "Codex school" --account me@school.edu --home ~/.codex-school'));
    console.log(ui.dim('Free OpenCode: scode backend set opencode --model free'));
    return 0;
  }
  if (command.name === 'learn') {
    return runLearn();
  }
  if (command.name === 'theme') {
    if (command.action === 'set') {
      const theme = command.theme;
      if (!theme) throw new Error('A theme is required when using `scode theme set`.');
      await setTheme(theme);
      console.log(`Theme set to ${THEMES[theme].name}. Restart the TUI to apply it.`);
    } else {
      const config = await loadConfig();
      console.log(`Current theme: ${THEMES[config.theme].name} (${config.theme})`);
      console.log('Available themes: ember (red/black), classic (cyan/purple), aurora (green/blue), violet (lavender/pink)');
    }
    return 0;
  }
  if (command.name === 'tokens') {
    // 2000 records ≈ 1000 runs — comfortably covers a heavy week.
    const records = await readLedgerTail(2000);
    const stats = computeTokenStats(records, new Date());
    for (const line of renderTokenDashboard(stats)) console.log(line);
    return 0;
  }
  if (command.name === 'usage') {
    const snapshots = await backendSnapshots({ refresh: true });
    for (const line of renderLimits(snapshots, new Date())) console.log(line);
    return 0;
  }
  if (command.name === 'doctor') {
    const { exitCode } = await runDoctor({ quick: command.quick, full: command.full });
    return exitCode;
  }
  if (command.name === 'tools') {
    if (command.action === 'status') {
      const rows = await toolsStatus();
      for (const row of rows) {
        const legacy = row.legacy ? '  (stale jcode-tools entry — run `scode tools install` to clean it up)' : '';
        console.log(`${row.backend.padEnd(10)} ${row.configured ? 'configured' : 'not configured'}  ${row.path}${legacy}`);
      }
      console.log('agy        skipped (config path unconfirmed — see `scode tools install`)');
      return 0;
    }
    // codex-a and codex-b share one config file — install once.
    const targets: BackendId[] = ['codex-a', 'claude', 'kiro', 'copilot', 'opencode', 'agy'];
    let errors = 0;
    for (const backend of targets) {
      const outcome = await installForBackend(backend);
      if (outcome.status === 'error') errors++;
      console.log(`${backend.padEnd(10)} ${outcome.status.padEnd(16)} ${outcome.detail}`);
    }
    return errors > 0 ? 1 : 0;
  }
  if (command.name === 'schedule') {
    if (command.action === 'install') {
      console.log(installHint());
      return 0;
    }
    if (command.action === 'list') {
      const schedules = await loadSchedules();
      if (schedules.length === 0) {
        console.log('No schedules. Add one with: scode schedule add "<task>" --cron "0 9 * * 1-5"');
        return 0;
      }
      for (const item of schedules) {
        const state = item.enabled ? 'on ' : 'off';
        const when = item.nextRunAt ?? '—';
        const via = item.backend ?? 'auto';
        console.log(`${item.id}  ${state}  ${when}  ${item.kind.padEnd(4)} ${via.padEnd(9)} ${item.brief.slice(0, 60)}`);
      }
      return 0;
    }
    if (command.action === 'add') {
      const created = await addSchedule({
        brief: command.brief as string,
        cron: command.cron,
        at: command.at,
        inMs: command.inMs,
        backend: command.backend,
        cwd: command.cwd,
      });
      console.log(`Scheduled ${created.id} — next run ${created.nextRunAt} (${created.kind}, ${created.backend ?? 'auto'}).`);
      console.log('It fires when `scode schedule tick` runs — see `scode schedule install`, or keep the TUI open.');
      return 0;
    }
    if (command.action === 'remove') {
      const removed = await removeSchedule(command.id as string);
      console.log(`Removed ${removed.id} ("${removed.brief.slice(0, 60)}").`);
      return 0;
    }
    if (command.action === 'enable' || command.action === 'disable') {
      const updated = await setScheduleEnabled(command.id as string, command.action === 'enable');
      console.log(`${updated.id} is now ${updated.enabled ? 'enabled' : 'disabled'}.`);
      return 0;
    }
    // tick
    const result = await runDueSchedules({
      dryRun: command.dryRun,
      onStart: ({ schedule }) => console.log(`[scode] firing ${schedule.id}: ${schedule.brief.slice(0, 60)}`),
      onFinish: ({ schedule }, runResult) => {
        console.log(`[scode] ${schedule.id} ${runResult.success ? 'succeeded' : `failed (${runResult.errorClass ?? 'unknown'})`} on ${runResult.backend}`);
      },
    });
    if (result.dryRun) {
      if (result.fired.length === 0) console.log('Nothing due right now.');
      for (const item of result.fired) console.log(`Would fire ${item.scheduleId}.`);
      return 0;
    }
    if (result.fired.length === 0) console.log('Nothing due right now.');
    if (result.skippedRunning.length > 0) {
      console.log(`Skipped mid-run: ${result.skippedRunning.join(', ')}.`);
    }
    return result.fired.some((item) => !item.success) ? 1 : 0;
  }
  if (command.name === 'graph') {
    const repoPath = command.path;
    if (command.action === 'status') {
      const status = await graphStatus(repoPath);
      if (!status.present) {
        console.log(`No code graph at ${status.outDir}. Build one with: scode graph init ${repoPath}`);
        return 0;
      }
      console.log(`Graph: ${status.outDir}`);
      console.log(`  nodes: ${status.nodeCount ?? '?'} · built at ${status.builtAtCommit?.slice(0, 7) ?? 'unknown'} · graphify ${status.graphifyVersion ?? 'unknown'}`);
      console.log(`  HEAD: ${status.headCommit?.slice(0, 7) ?? 'not a git repo'}`);
      console.log(`  state: ${status.stale ? 'STALE — run `scode graph refresh`' : 'current'}`);
      return 0;
    }
    const info = await graphifyInfo();
    if (!info.present) {
      console.log('graphify is not installed. Install it first: uv tool install "graphifyy[mcp]" (needs Python 3.11+).');
      console.log('See docs/graphify.md for the Windows setup.');
      return 1;
    }
    if (command.action === 'init') {
      const existing = await graphStatus(repoPath);
      if (existing.present && !existing.stale) {
        console.log(`Graph already current (${existing.nodeCount ?? '?'} nodes, built at ${existing.builtAtCommit?.slice(0, 7)}).`);
      } else {
        const build = await buildGraph(repoPath, { force: command.force });
        if (!build.ok) {
          console.log(`Graph build failed: ${build.output}`);
          return 1;
        }
        console.log(`Graph ${existing.present ? 'rebuilt' : 'built'}: ${build.nodeCount ?? '?'} nodes in ${(build.durationMs / 1000).toFixed(1)}s.`);
      }
      const ignored = await ensureGitignored(repoPath);
      if (ignored === 'added') console.log('Added graphify-out/ to .gitignore.');
      const hooks = await installGraphHooks(repoPath);
      console.log(hooks.ok ? 'Git hooks installed — the graph refreshes on commit.' : `Hook install failed (the graph still works; refreshes happen on dispatch): ${hooks.output}`);
      return 0;
    }
    // refresh
    const build = await buildGraph(repoPath, { force: command.force });
    if (!build.ok) {
      console.log(`Graph refresh failed: ${build.output}`);
      return 1;
    }
    console.log(`Graph refreshed: ${build.nodeCount ?? '?'} nodes in ${(build.durationMs / 1000).toFixed(1)}s.`);
    return 0;
  }
  if (command.name === 'acp') {
    return runAcpServer();
  }
  if (command.name === 'zed-setup') {
    // Zed reads settings.json, not the shell's PATH — an absolute command
    // is what works when Zed starts from the Dock or Start menu.
    const entry = process.argv[1] ?? '';
    const commandPath = entry.endsWith('index.js') ? entry : 'scode';
    console.log('Add this to Zed settings.json (~/.config/zed/settings.json),');
    console.log('then pick scode in the Agent Panel:');
    console.log(JSON.stringify({
      agent_servers: {
        scode: { type: 'custom', command: commandPath, args: ['acp'], env: {} },
      },
    }, null, 2));
    return 0;
  }
  if (command.name === 'zed') {
    const threads = await loadThreads();
    const thread = findThread(threads, command.id);
    const opened = await new Promise<boolean>((resolvePromise) => {
      const child = execFile('zed', [thread.worktree], { windowsHide: true }, (error) => {
        resolvePromise(!error);
      });
      child.on('error', () => resolvePromise(false));
    });
    if (!opened) {
      console.log('The zed CLI is not available. Install Zed and its CLI (zed.dev), then retry.');
      return 1;
    }
    console.log(`Opened ${thread.worktree} in Zed.`);
    return 0;
  }
  if (command.name === 'thread') {
    if (command.action === 'list') {
      for (const line of renderThreadList(await loadThreads())) console.log(line);
      return 0;
    }
    if (command.action === 'status') {
      const thread = findThread(await loadThreads(), command.id as string);
      for (const line of renderThreadStatus(thread)) console.log(line);
      const diff = await threadDiff(thread);
      for (const line of renderDiffSummary(diff, thread).slice(2)) console.log(line);
      return 0;
    }
    if (command.action === 'close') {
      const closed = await closeThread(command.id as string);
      console.log(`Closed thread ${closed.id} ("${closed.title}"). Branch and worktree are kept.`);
      return 0;
    }
    if (command.action === 'new') {
      const thread = await createThread(command.brief as string, { backend: command.backend, cwd: command.cwd });
      console.log(`Thread ${thread.id} on branch ${thread.branch} (from ${thread.baseBranch}).`);
      const outcome = await dispatchThreadTurn(thread, command.brief as string, { backend: command.backend });
      console.log(`Turn 1 ${outcome.result.success ? 'succeeded' : `failed (${outcome.result.errorClass ?? 'unknown'})`} on ${outcome.result.backend}.`);
      console.log(`Continue with: scode thread continue ${thread.id} "<follow-up>"`);
      return outcome.result.success ? 0 : 1;
    }
    // continue
    const thread = findThread(await loadThreads(), command.id as string);
    const outcome = await dispatchThreadTurn(thread, command.brief as string, { backend: command.backend });
    if (outcome.switchedBackend) {
      console.log(`[scode] switched backend: ${outcome.selectionReason}`);
    }
    console.log(`Turn ${outcome.thread.turns} ${outcome.result.success ? 'succeeded' : `failed (${outcome.result.errorClass ?? 'unknown'})`} on ${outcome.result.backend}.`);
    return outcome.result.success ? 0 : 1;
  }
  if (command.name === 'diff') {
    const thread = findThread(await loadThreads(), command.id);
    const diff = await threadDiff(thread);
    for (const line of renderDiffSummary(diff, thread)) console.log(line);
    if (!command.statOnly && diff.diffText) {
      console.log('');
      console.log(diff.diffText);
    }
    return 0;
  }
  if (command.name === 'pr') {
    const thread = findThread(await loadThreads(), command.id);
    const outcome = await createPr(thread, { draft: command.draft, dryRun: command.dryRun });
    console.log(outcome.detail);
    return outcome.prUrl || command.dryRun ? 0 : 1;
  }
  // status runs probes (cached 5 min); run reuses cached state for speed.
  const snapshots = await backendSnapshots({ refresh: command.name === 'status' });
  if (command.name === 'status') {
    console.log(section('Backend status', 'login, usage, and reset are separate signals'));
    const statusRows = snapshots.flatMap((snapshot) => snapshotRows(snapshot).map((row) => ({ row, loginStatus: snapshot.loginStatus })));
    const lines = table(['BACKEND', 'LOGIN', 'WINDOW / USAGE', 'RESETS', 'VIA / ACCOUNT'], statusRows.map(({ row }) => row));
    console.log(lines.map((line, index) => {
      if (index < 2) return line;
      const login = statusRows[index - 2]?.loginStatus;
      return login === 'active' ? ui.good(line) : login === 'logged-out' ? ui.bad(line) : ui.warn(line);
    }).join('\n'));
    console.log(ui.dim('\nUpcoming  Cursor CLI'));
    console.log(ui.dim('Upcoming  Bivia CLI'));
    console.log(ui.dim('Edit      scode backend set <id> --label NAME --account HINT'));
    return 0;
  }

  const priors = await getPriors();
  const { classification, selection } = await routeTask(command.brief, snapshots, command.backend, { priors });
  console.error(`${ui.brand('scode')} ${ui.dim('→')} ${ui.accent(selection.backend)}  ${selection.reason}`);
  const result = await dispatch({
    brief: command.brief,
    backend: selection.backend,
    cwd: command.cwd,
    dryRun: command.dryRun,
    allowFallback: true,
    selectionReason: selection.reason,
    classification: { ...classification },
    onStdout: () => {},
    onStderr: () => {},
    onDisplay: (text) => console.log(text),
  });
  if (!result.success) {
    console.error(`${ui.bad('failed')} ${result.backend}: ${result.errorClass ?? 'unknown error'}${result.exitCode === null ? '' : ` (exit ${result.exitCode})`}`);
  } else if (result.hasChanges && result.worktree) {
    console.error(`${ui.good('edits preserved')} ${result.worktree}`);
    console.error(ui.dim(`Continue interactively: scode session attach ${result.taskId}`));
  }
  return result.success ? 0 : result.exitCode ?? 1;
}
