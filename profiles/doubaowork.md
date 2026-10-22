---
type: Profile
title: DoubaoWork (豆包工作版)
description: App facts for the DoubaoWork desktop app — attachment on a quit-guarded CEF shell, verified read capabilities, the 2.33.5 cron regression, and replay/risk-control boundaries.
---

# DoubaoWork

DoubaoWork（豆包工作版），`/Applications/DoubaoWork.app`，bundle `com.work.pc.doubao`，2.33.5 measured
2026-10-23 (2.27.6 in the 2026-09 forensics). CEF shell: a ~1 MB native launcher plus
`Helpers/DoubaoWork Browser.app` (Chromium 147.0.7727.149); no asar, runtime-only route. Real
logged-in profile at `~/Library/Application Support/DoubaoWork/`.

## Attachment

- **Cold start is mandatory**: a resident instance forwards argv to the single instance and drops
  `--remote-debugging-port`. Cold start:
  `open -a /Applications/DoubaoWork.app --args --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir="$HOME/Library/Application Support/DoubaoWork"`
- **The app is quit-guarded**: AppleScript quit is refused (`-128`), SIGTERM is ignored by both the
  launcher and the CEF browser process; only SIGKILL ends a resident instance. Closing the debug
  port means SIGKILL + (optionally) a normal relaunch.
- The CEF UA carries **no app token** (`... Chrome/147.0.0.0 Safari/537.36`): the manifest anchors
  on `Chrome/` + engine version and `targetUrlIncludes: doubaowork-chat/chat`. The bundle version is
  not visible over CDP; check `Info.plist` out-of-band.
- Targets: main window `doubaowork://doubaowork-chat/chat` (SPA, Garfish micro-frontend sandbox),
  background page `chrome://doubaowork-background/` (business long-connection). One DevTools client
  at a time; avoid `Page.reload` on the main page (kills the client). Manifest sample:
  [tools/mcp/examples/doubaowork/app.json](../tools/mcp/examples/doubaowork/app.json).

## Verified capabilities (2026-10-23, live 2.33.5)

| Capability | Adapter | Result boundary |
| --- | --- | --- |
| `chat_list` | DOM enumeration (`[data-testid="conversation-list-v2-item"]`, id from `/chat/<id>` href) | Sidebar conversation titles + ids, ≤200; live-DOM — read a settled page |
| `skills_list` | request-replay `POST /alice/office/skills/list_user_and_featured` (`runtime_type` 2) | Bounded skill descriptors, ≤200, no skill content |
| `skills_exposed` | request-replay `POST /alice/office/skills/get_exposed` (root scope) | Slot configuration only |

×2 repeat-verified with frozen contract expressions; standalone service generated, checked and
smoke-tested (see [the evidence record](../tools/research/evidence/2026-10-23-doubaowork-mcp/INDEX.md)
for the battery, lifecycle and memory records).

## Measured boundaries and regressions

- **Scheduled tasks regressed on 2.33.5** (nav renamed 定时任务 → 自动任务): the 2026-09
  `POST /alice/job_cron/list {size,sort_order}` contract returns `710010202 common invalid param`
  (with and without the app's query string), and no `/alice/job_cron/*` request appears on the main
  page across view re-entry — the list loads from preloaded/cached state or a non-HTTP channel.
  Read capability currently **unresolved**; recovery paths in
  [cron-regression.json](../tools/research/evidence/2026-10-23-doubaowork-mcp/cron-regression.json).
  The 2026-09 cron write contracts (pause/resume/run/delete/create) were never executed against a
  live app and are **not** published as MCP capabilities.
- **Risk-control-gated endpoints are not replayable**: `plugin/list_by_user` succeeds from the app
  but returns `623010003` on same-context replay (mssdk family, same gate as the drive domain).
- `/im/*` message APIs use custom cmd encoding (`cmd`/`uplink_body`, e.g. 1110/3100); plain JSON
  replay is not applicable. Message reading remains unresolved.
- Drive domain stays blocked (authorization gate; a human accepts the terms in the real UI).
- Telemetry noise for capture filtering: `mcs.doubao.com`, `opt.doubao.com`, `*/collect/*`.

## Unresolved

- Cron domain re-derivation on 2.33.5 (see regression record); partner-chat and project listing
  APIs; message content reading; multi-window and multi-day operation. Editor/DOM surfaces beyond
  the conversation list were not established.
