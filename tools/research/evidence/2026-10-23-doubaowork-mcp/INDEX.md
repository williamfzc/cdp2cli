# 2026-10-23 DoubaoWork read capabilities over MCP

First MCP-route conversion pass for **DoubaoWork** (豆包工作版, `/Applications/DoubaoWork.app`,
bundle 2.33.5, CEF 147.0.7727.149). Chat-list and skills domains were previously established by the
maintainers' local forensics on 2.27.6 (2026-09-09, spun off as the `doubaoworkctl` Go CLI); this
record re-establishes the surface on 2.33.5, freezes the capability samples for the MCP toolkit,
generates and smoke-tests the standalone service, and records one regression and several
environment facts.

All probing was read-only. UI navigation clicks (sidebar) were used only to trigger and capture the
app's own requests. No write, pairing or authorization action was sent; the cron write contracts
from the local forensics were not executed.

## What was verified (live app, 2026-10-23)

| Check | Result | Record |
| --- | --- | --- |
| `chat_list` ×2 (frozen contract expression) | CONSISTENT — 15 conversations, stable `data-testid` rule from 2026-09 still valid on 2.33.5 | `verification.json` |
| `skills_list` ×2 | CONSISTENT — code 0, 105 skills, bounded fields | `verification.json` |
| `skills_exposed` ×2 | CONSISTENT — code 0, 1 slot, root scope | `verification.json` |
| Standalone service (`cli.mjs init`, 3 contracts, `check` valid) | PASS — MCP smoke: all three tools answered end to end (15 / 105 / 1) | this INDEX |
| Lifecycle: app down → offline report → relaunch → recovery | PASS — offline reported in 12 ms (`isError` payload, no hang); after relaunch the service returned the same 15-conversation baseline (poll 0 briefly showed 20 while the sidebar was still settling — live-DOM counts need a settled page) | `lifecycle.json` |
| Finite retained memory (warmup 12 + 120 measured calls) | PASS — 0.20 MB heap growth against a 16 MB budget | `memory.json` |
| Regression: scheduled tasks (定时任务 → renamed 自动任务) | **cron read regressed verified → unresolved on 2.33.5** (710010202 on the 2026-09 body, with and without the app's query string; zero `/alice/job_cron/*` in 28 captured POSTs across view re-entry) | `cron-regression.json` |

Capability samples: [tools/mcp/examples/doubaowork/](../../../mcp/examples/doubaowork/)
(`app.json`, `chat_list.json`, `skills_list.json`, `skills_exposed.json`). The standalone service
was generated with `tools/mcp/cli.mjs init` outside this repository and validated with
`cli.mjs check`.

## Key findings

- **The CEF UA carries no DoubaoWork token** (`Mozilla/5.0 ... Chrome/147.0.0.0 Safari/537.36`), so
  the manifest anchors identity on `userAgentIncludes: "Chrome/"` + engine version `147.0.0.0` and
  on `targetUrlIncludes: doubaowork-chat/chat`. The bundle version (2.33.5) is not visible over CDP.
- **The app is quit-guarded.** With a resident instance: AppleScript quit is refused (`-128 user
  cancelled`), SIGTERM to the launcher and to the CEF browser process is ignored; only SIGKILL ends
  it. Cold start then needs the debug port flags re-supplied. Unattended lifecycle automation must
  plan for SIGKILL + cold relaunch rather than graceful quit.
- **Single-instance forwarding swallows the debug port.** A resident background instance accepts
  forwarded argv and drops `--remote-debugging-port`; the port only opens on a true cold start.
- **The 2026-09 request-replay adapter family still works where the endpoint schema is unchanged**
  (skills domain replays succeed bare with the app's query string), but `plugin/list_by_user`
  returns 623010003 on bare replay while the app's own call succeeds — risk-control-gated endpoints
  (mssdk family, like the drive domain) are not replayable.
- Instrument notes carried over and re-confirmed: main-page `Page.reload` should be avoided; one
  DevTools client at a time; probes exit gracefully.

## Instruments

`work/` (untracked scratch): `probe.mjs` (four-domain first probe), `cron-netcap.mjs` /
`cron-netcap2.mjs` (CDP Network capture with in-page nav clicks), `cron-retry.mjs` (controlled
replay variants), `cron-dom.mjs` / `check-nav.mjs` (view-state checks), `plugin-probe.mjs`,
`verify.mjs` (×2 battery), `lifecycle2.mjs`, `memory.mjs`.
