# scode

**Quota-aware routing for coding agents, with optional Bivia decisions.**

scode classifies tasks and selects an eligible coding CLI, then runs the task
without changing the vendor's tool. With Bivia configured, its fast decision
API helps classify and route each task; otherwise scode uses local rules.

![scode terminal interface](https://raw.githubusercontent.com/sivab193/scode/main/docs/shots/scode-linkedin.png)

## Get started

Requires Node.js 22+ and at least one authenticated coding-agent CLI.

```sh
npm install -g --no-fund --no-audit @sivab193/scode
scode
```

To try scode without a global install:

```sh
npx -y @sivab193/scode
npx -y @sivab193/scode status
npx -y @sivab193/scode doctor --quick
```

The first command opens the terminal UI. The other commands let you check
detected backends and your machine setup without adding `scode` to your PATH.
Use the package name, including `@sivab193/`; `npm install -g sivab193/scode`
does not refer to this npm package.

If a global npm install fails or your npm prefix is not in PATH, install under
your home directory instead:

```sh
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
npm install -g --no-fund --no-audit @sivab193/scode
```

For bash or a shell other than zsh, add `$HOME/.npm-global/bin` to that
shell's PATH instead.

### Run or install from source

Clone and run the checkout without linking it globally:

```sh
git clone https://github.com/sivab193/scode.git
cd scode
npm install --no-fund --no-audit
npm run build
npm start
```

Run individual source commands with `npm run dev --`:

```sh
npm run dev -- status
npm run dev -- doctor --quick
npm run dev -- run "review this change"
```

To expose the source checkout as `scode` and `jcode` on your PATH, link it
globally after building:

```sh
npm run build
npm link
```

After pulling source changes, rebuild and refresh the local global binary:

```sh
npm run update:local
```

Remove the local global link with:

```sh
npm unlink -g @sivab193/scode
```

### Uninstall

Global npm install:

```sh
npm uninstall -g @sivab193/scode
```

Home-directory npm install:

```sh
npm uninstall -g --prefix ~/.npm-global @sivab193/scode
```

The no-install `npx` commands keep scode out of the global npm installation;
they only use npm's temporary download cache.

## Use

```sh
scode run "review this change"
scode status
scode session list
scode backend list
scode doctor --quick
scode theme set ember
```

Running `scode` opens the interactive terminal UI. Choose from Ember
(red/black), Classic, Aurora, or Violet with `scode theme set <name>`.
In the TUI, click to pin a backend or select a job; stop a running job with
the Stop action or `s`. Tab and arrow keys work without a mouse. Press `x` to
switch between Task mode (isolated coding worktrees) and Chat mode (a continued
conversation in the current repo). You can dispatch more tasks while agents
are already running. Press `o` on a completed job to leave scode and continue
inside the vendor's unmodified interactive CLI. Short greetings such as `hi`,
`hello`, and `hey` automatically take the lightweight Chat path instead of
paying the worktree, prompt-pack, and code-graph setup cost.

The home screen shows compact token totals for today and the last seven days;
press `t` for per-backend and daily detail. For the full per-window limits
view — % left, a remaining bar with a pace tick, and reset countdowns —
run `scode usage` or press `u` in the TUI. Cursor CLI and Bivia CLI are listed
separately as upcoming integrations.

Backend rows separate login state, usage, reset time, and provider. Codex shows
its 5-hour and weekly windows independently, with both a local reset date and a
relative time; Kiro shows its calendar-month reset. Backends without a useful
reset show `—`. Add your own local label or account hint (an email or handle is
fine) without changing any vendor credential:

```sh
scode backend set codex-a --label "Codex personal" --account me@example.com
scode backend set codex-b --label "Codex school" --account me@school.edu --home ~/.codex-school
CODEX_HOME="$HOME/.codex-school" codex login
```

The second Codex account must have a distinct `CODEX_HOME`; otherwise scode
marks it as setup required rather than silently counting the first account
twice. scode stores only the path and display hint, never the vendor login
token.

OpenCode's free preset can be selected from the TUI by choosing OpenCode and
pressing `f`, or from the CLI:

```sh
scode backend set opencode --model free
```

Successful task worktrees with edits are preserved. List and resume them with:

```sh
scode session list
scode session attach <task-id>
```

For longer work, use a thread: its own branch, worktree, and backend
session across turns, with a one-command review and ship:

```sh
scode thread new "Add a login page"
scode thread continue 5e52e480 "Also add logout"
scode diff 5e52e480
scode pr 5e52e480
```

Zed's Agent panel can drive scode through ACP: run `scode zed-setup`,
paste the block into Zed's settings, and pick scode in the panel. One
Zed session is one thread. See [docs/threads.md](docs/threads.md) and
[docs/acp.md](docs/acp.md).

## Features

- Routes tasks across supported coding-agent CLIs based on task and quota.
- Uses Bivia for task classification and backend selection when configured.
- Runs concurrent tasks in separate Git worktrees and preserves completed edits.
- Threads give long tasks a branch, worktree, and session, with `scode diff` and one-button `scode pr`.
- Exposes the router to Zed through an ACP agent server.
- Extracts readable assistant replies from vendor JSON streams.
- Resumes jobs in each vendor's native interactive terminal UI.
- Tracks runs and token usage in a local ledger, with home-screen totals.
- Sends conversational greetings through the lightweight Chat path automatically.
- Supports scheduled jobs and MCP tools.

When enabled, Bivia receives the task brief and available backends' quota
summaries. See [Bivia routing](https://github.com/sivab193/scode/blob/main/docs/bivia-routing.md)
for setup, privacy, and local fallback behavior.

See the [full documentation](https://github.com/sivab193/scode/tree/main/docs) for setup and usage details.

[GitHub](https://github.com/sivab193/scode) · [npm](https://www.npmjs.com/package/@sivab193/scode) · [MIT License](LICENSE)
