# Phase 0 verification — Windows laptop

Date: 2026-11-18 (America/New_York)

This report records observed results. A command being installed is not counted
as a pass, and an exit code of zero is not counted as task success when the
response is empty or reports denied work.

## Summary

Phase 0 is **blocked**. Codex dispatch and its quota probe pass, and
Antigravity's exact headless JSON command passes. Kiro is installed and its
stream format works, but the account is at its monthly usage limit. Copilot,
OpenCode, and Caveman are not installed. No common MCP smoke server is
configured. Claude is intentionally skipped until Claude Pro is confirmed on
or after the expected 2026-11-30 availability date.

Phase 1 must not start until the required smoke checks pass.

## Backend command checks

| Backend | Observed version | Result | Evidence / blocker |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.163.0` | PASS with runtime caveat | `codex exec --json` returned a real streamed answer through scode. A file-writing task failed inside the nested Windows app sandbox even though the no-tool task passed; investigate before claiming tool-capable nested runs. |
| Kiro | `3.1.0` | BLOCKED: quota | `kiro-cli chat --no-interactive --trust-all-tools --output-format stream-json` emitted valid ACP events, then returned `UsageLimitReachedError` for the monthly limit. `/usage` returned the same limit error. |
| Antigravity (`agy`) | `1.5.11` | PASS | Exact `agy -p "..." --output-format json` returned the requested text, conversation id, duration, and token usage. A separate plan-mode run exited zero with an empty response after a denied command; the adapter must treat empty/denied results as capability failure. |
| Copilot | not installed | BLOCKED: missing CLI | Cannot verify JSONL or exit-code-3 quota behavior. |
| OpenCode | not installed | BLOCKED: missing CLI | Cannot verify v2 command or free-model provider. |
| Claude | `2.1.301` | SKIPPED by policy | Installed, but no prompt was sent. Claude remains disabled until Pro is confirmed and smoke-tested. Installed version is also below the handoff's cited `2.1.302+` behavior boundary. |

## Quota checks

- Codex app-server `account/rateLimits/read`: PASS for the currently
  authenticated default account. It returned real 5-hour and weekly windows
  with reset timestamps without consuming model quota.
- A second Codex account home is not configured through
  `SCODE_CODEX_A_HOME`/`SCODE_CODEX_B_HOME`, so the required two-account check
  is blocked.
- Kiro `/usage`: BLOCKED by the same monthly hard-limit response.
- Antigravity community quota reader: not installed; reactive structured usage
  works and is the current fallback.
- Copilot exit-code-3 signal: blocked because the CLI is missing.
- Claude status-line limits: skipped with the Claude adapter.

No account IDs, tokens, request IDs, or credentials are stored in this report.

## MCP checks

- The repository's `scode-tools` MCP server passes its standalone initialize +
  tools/list smoke test. It is not wired into each vendor CLI yet.
- Codex lists enabled local MCP servers, but the nested smoke run could not
  launch the Windows registered-core helper. This is not a portable vendor MCP
  pass.
- Kiro's MCP inventory contains empty default/workspace groups.
- Antigravity reports no MCP servers configured.
- Claude reports no MCP servers configured and remains skipped.
- Copilot and OpenCode are unavailable.

Result: the "one MCP server loads in every backend" criterion is not met.

## Caveman

Caveman is not installed, so wrapping `codex exec` and measuring token use on
versus off are blocked. Auto and telemetry settings were not changed or faked.

## iTerm2 reference decision

[iTerm2](https://github.com/gnachman/iTerm2) is useful as an architecture
reference for long-lived session servers, reconnect/restore behavior, tmux
control-mode integration, status components, and regex output triggers. Those
ideas may inform a later portable `scode attach`/daemon and reactive failure
detectors. iTerm2 itself is macOS-native and GPLv3, so its source will not be
copied into this MIT-licensed TypeScript project.

## Required unblocks

1. Install/authenticate Copilot CLI version 1.0.28 or newer.
2. Install/configure OpenCode v2 with a free-model provider.
3. Wait for Kiro's monthly quota reset (or use another authenticated Kiro
   account explicitly supplied by the owner).
4. Configure the second Codex account home, if two-account routing is desired.
5. Configure one harmless portable MCP smoke server across the enabled CLIs.
6. Install Caveman for its Phase 0 compatibility measurement, with telemetry
   and Auto disabled before use.
7. Confirm Claude Pro after 2026-11-30, then update Claude Code if needed and
   run its prompt and status-line quota tests.
