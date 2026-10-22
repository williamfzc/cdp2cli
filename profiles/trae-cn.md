---
type: Profile
title: Trae CN (cn.trae.app)
description: App facts for the Trae CN desktop app — attachment, task-service surface, verified MCP capability, measured pitfalls (auto-update, display-sleep exit).
---

# Trae CN

Trae CN (`/Applications/Trae CN.app`, bundle 3.4.3 measured / 3.4.4 after the overnight auto-update,
engine `1.107.1`, Electron 39, UA marker `TraeCN/` — no space). A separate app from the
international Trae documented in [trae.md](./trae.md); module layouts and behavior differ.

## Attachment

- Launch: `open -a '/Applications/Trae CN.app' --args --remote-debugging-port=9232 --new-window <folder>`
  (or run the binary directly). One workbench page at `/workbench/workbench.html`; keep exactly one
  window so CDP target selection stays unambiguous.
- Retarget the window without restarting: `Contents/Resources/app/bin/trae-cn --reuse-window <folder>`
  — the debug port and login survive the switch.
- Manifest sample: [tools/mcp/examples/trae-cn/app.json](../tools/mcp/examples/trae-cn/app.json)
  (`requestTimeoutMs` 45 000 — real tasks outrun shorter budgets).
- Login is manual; every task operation except `status` stops with `LOGIN_REQUIRED` while signed out.

## Task-service surface (verified 2026-10-23)

Reached through the app's own chat module imported inside the renderer
(`@byted-icube/ai-modules-chat` → `__webpack_require__` → `v2Apis`; domain stores `68064`,
`chatSessionService` `98958`, session-list service `48996` via container `32143`, legacy session
service `85356`). Frozen as the capability sample
[tools/mcp/examples/trae-cn/task_session.json](../tools/mcp/examples/trae-cn/task_session.json)
(`task_session`, `sideEffect: write`): operations `status / agents / create / send / stop / get /
list / history / editor`.

- Session status is a two-way numeric enum: active `{1,2,3,8,9,10}`, terminal `{4,5,6}`
  (Finished/Stopped/Failed), cancellable `{1,2,3,8}`; backend string statuses map separately
  (completed→Finished, cancelled→Stopped, in_progress/streaming→Running, queuing→Pending,
  paused→Waiting).
- Write gates, in order: login → requested workspace must be the open folder → session must belong
  to the open project → `send` refuses busy/streaming sessions → `stop` requires the last user
  message id (`STALE_TASK` on mismatch, `TASK_IDENTITY_UNAVAILABLE` when paginated) and a
  cancellable state. Verified live: send→Finished with exact marker replies, a real file-creation
  task, and stop→`Stopped`.
- `get` prefers the live in-page store; after an app restart older messages are only in backend
  history — pass `refresh:true` for historical certainty (`TASK_NOT_IN_PAGE` otherwise).

See [the evidence record](../tools/research/evidence/2026-10-23-trae-mcp-tasks/INDEX.md) for the
full verification matrix (service restart, workbench reload, quit/relaunch lifecycle, memory,
16/16 mocked-dependency unit tests).

## Measured pitfalls

- **Auto-update replaces the app under you.** Squirrel staged and installed 3.4.3 → 3.4.4
  overnight; the running instance was asked to quit for the install. Re-verify after updates.
- **3.4.4 exits on its own shortly after launch while the display is asleep** (graceful quit, no
  crash dumps; 3.4.3 survived display sleep). Keeping the display awake (`caffeinate -u`) makes the
  same launch recipe stable. Unattended deployments need a display-wake assertion or must tolerate
  short-lived instances — the service offline-report + recovery path covers both.
- `ps -axo comm=` does not reliably expose the Electron path; count instances via `args=` matching
  the binary path and debug port.
- When the app is offline, the MCP layer surfaces a JSON-RPC error (`McpError Application
  unavailable`) rather than `isError:true` — clients must handle both shapes.

## Unresolved

- Multi-window selection, the `editor` operation against real editors, other Trae CN releases, and
  continuous multi-day operation remain unverified.
- The international Trae's task surface (see [trae.md](./trae.md) unresolved list) is a separate
  question; do not transfer CN findings to it without measurement.
