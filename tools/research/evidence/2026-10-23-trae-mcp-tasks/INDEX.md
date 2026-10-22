# 2026-10-23 Trae CN task driving over MCP

Follow-up to [2026-10-22-trae-mcp](../2026-10-22-trae-mcp/): the same method applied to **Trae CN**
(bundle 3.4.3 measured, engine 1.107.1) to establish the AI task surface — create sessions, send
prompts, stop tasks, read results and history — behind explicit safety gates, then verify the
service across service restarts, workbench reloads and a full application quit/relaunch.

All task operations ran in one owned sandbox workspace (`work/trae-mcp-sandbox`, containing only a
README and MCP acceptance markers) and one owned session created through the service itself. No
user conversations, other workspaces or settings were touched. Probes stayed read-only until the
explicitly bounded acceptance tasks below.

## What was verified (live app)

| Check | Result | Record |
| --- | --- | --- |
| `status` login/folders/engine, `agents`, `create`, `send`, `get` to terminal, `history`, `list` over MCP | PASS — marker reply exactly `TRAE_MCP_OK` | `first-task.json` |
| Real coding task through MCP: create `mcp-proof.txt` with exact content in the sandbox | PASS — Write tool ran, status Finished, reply `FILE_CREATED`, file bytes exact | `file-task.json` |
| Stop a running task; stale-messageId guard first | PASS — wrong id rejected `STALE_TASK` (nothing stopped), right id accepted, terminal state `Stopped` | `stop.json` |
| Results survive a service-process restart and a workbench reload | PASS — history identical across processes; marker recovered after `location.reload()` | `recover.json` |
| Full application quit → offline report → relaunch → recovery | PASS — offline reported in 11 ms (`Application unavailable`), service recovered with marker reply and correct workspace | `lifecycle.json` |
| Finite retained-memory check (warmup 20 + 300 measured calls) | PASS — 0.32 MB heap growth against a 16 MB budget | `memory.json` |
| Adapter unit tests, mocked page dependencies (`testContext`), `node --test` | PASS — 16/16 | `unit.json` |

The adapter is frozen as the capability sample
[tools/mcp/examples/trae-cn/task_session.json](../../../mcp/examples/trae-cn/task_session.json)
(`task_session`, `sideEffect: write`) with the app manifest
[tools/mcp/examples/trae-cn/app.json](../../../mcp/examples/trae-cn/app.json).

## Key findings

- **Task services are reachable through the app's own chat module.** The adapter imports
  `@byted-icube/ai-modules-chat/dist/index.mjs` inside the workbench renderer, resolves
  `__webpack_require__`, then `v2Apis`: domain stores/session services from module `68064`,
  `chatSessionService` proxy from `98958`, the session-list service from `48996` via the container
  (`32143`), and the legacy session service from `85356` via `Symbol.for('aiAgent.ISessionService')`.
  Session status is a two-way enum: active `{1,2,3,8,9,10}`, terminal `{4,5,6}` (Finished/Stopped/
  Failed), cancellable `{1,2,3,8}`; backend string statuses map separately (completed→Finished,
  cancelled→Stopped, in_progress/streaming→Running, queuing→Pending, paused→Waiting).
- **Guards that made writes safe to verify**: login gate → open-workspace match for create/send/stop
  → session-project identity for send/stop → busy/streaming rejection for send → last-user-message
  identity for stop (`STALE_TASK` refuses stale ids; paginated history refuses with
  `TASK_IDENTITY_UNAVAILABLE` rather than guessing). The acceptance server additionally confined
  writes to sessions it created itself (cap 4) and to the sandbox workspace path.
- **`get` prefers the live in-page store; historical certainty needs `refresh:true`.** After an app
  restart the restored session's live store does not contain older messages; a `get` by old
  messageId without `refresh` returns `TASK_NOT_IN_PAGE`. Recovery flows must pass `refresh:true`.
- **`requestTimeoutMs` 45 000** — real tasks outrun the default 5–10 s request budget.
- **Workspace switch without killing the app**: `/Applications/Trae CN.app/Contents/Resources/app/
  bin/trae-cn --reuse-window <folder>` retargets the single workbench window (the debug port and
  login survive). The UA marker is `TraeCN/` (no space).

## Negative results and environment pitfalls

- **Trae CN auto-updated 3.4.3 → 3.4.4 overnight** (Squirrel staged 23:34, installed 00:16). The
  long-running 3.4.3 instance (21:19 → ~00:14, including through display sleep) ended when the
  updater applied the install.
- **3.4.4 exits on its own shortly after launch while the display is asleep.** Five overnight
  instances quit within ~0:30–3:45 min (graceful `window-all-closed` / `will-quit` paths, no crash
  dumps). With the display kept awake (`caffeinate -u`), the same launch recipe stayed up and the
  full lifecycle verification passed. Unattended service deployments on 3.4.4 need a display-wake
  assertion or must tolerate short-lived app instances; the offline-report + recovery path handles
  both.
- `ps -axo comm=` did not reliably show the Electron path for instance counting; match on
  `args=` with the binary path and port instead.
- MCP protocol note: when the handler throws (app offline), the SDK surfaces a JSON-RPC error
  (`McpError -32603 Application unavailable`) rather than `isError:true` — clients must treat both
  shapes as the offline report.

## Instruments

`work/` (untracked scratch): `trae-cn-build/browser.mjs` (adapter, embedded verbatim in the
capability sample), `test-server.mjs` (scope-restricted acceptance server), `first-task.mjs`,
`file-task.mjs`, `stop-task.mjs`, `recover.mjs`, `lifecycle-cn.mjs`, `memory-tasks.mjs`,
`adapter.test.mjs`; sandbox `work/trae-mcp-sandbox`. The standalone service was generated with
`tools/mcp/cli.mjs init` outside this repository and validated with `cli.mjs check`.
