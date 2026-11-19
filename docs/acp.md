# Zed integration (ACP)

Zed's Agent panel speaks the Agent Client Protocol (ACP). `scode acp`
runs scode as an ACP agent over stdio, so Zed can drive scode's router
as if it were a coding agent — with Zed's own chat, diffs, and approvals
in front of it.

## Setup

```sh
scode zed-setup
```

Paste the printed `agent_servers` block into Zed's `settings.json`
(`~/.config/zed/settings.json`), then open the Agent Panel and pick
**scode** from the agent list. The command is the absolute path to the
scode entry point: Zed started from the Dock or Start menu does not read
your shell's `PATH`, so a bare `scode` may not resolve there.

```json
{
  "agent_servers": {
    "scode": {
      "type": "custom",
      "command": "/absolute/path/to/dist/index.js",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

No sign-in step: scode routes to the CLIs already installed and signed
in on your machine, the same as the terminal. If a backend is not logged
in, its turn fails with `auth` and Zed shows the failure.

## What a session is

One ACP session is one scode thread (same id). The first prompt creates
the thread — branch `scode/<id>-<slug>` plus worktree — from the prompt
text; later prompts continue it with session resume. Agent output streams
back as message chunks; routing notes arrive as thought chunks. Stopping
a prompt in Zed sends `session/cancel`, which aborts the running
dispatch — the vendor CLI is killed, the turn is recorded as cancelled,
and cancelled runs do not count against the backend in `scode learn`.

Threads created from Zed are ordinary threads: `scode thread list`,
`scode diff`, and `scode pr` all work on them from the terminal.

## Protocol surface (ACP v1)

Implemented: `initialize` (protocol version 1), `session/new`,
`session/prompt`, `session/cancel`. Everything else answers JSON-RPC
`-32601` (method not found) — no modes, no model picker, no session
loading, no auth methods. scode does not advertise what it cannot do.

stdout carries only JSON-RPC frames; diagnostics go to stderr. When the
client disconnects (stdin closes), running turns are aborted and the
process exits — a turn never outlives the ACP process.

## Opening a thread in Zed

```sh
scode zed 5e52e480
```

Opens the thread's worktree in Zed (needs the `zed` CLI). Review the
change in Zed's git panel, then ship it with `scode pr` from the
terminal.
