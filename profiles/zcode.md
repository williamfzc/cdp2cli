---
type: Profile
title: ZCode Application Profile
description: Measured facts for ZCode 3.11.2 on Electron 41 - CDP attachment, method-level contextBridge surface, IPC channel inventory, frozen bridge objects, adapter priorities and red lines. From static asar analysis and live CDP probing on 2026-09-08.
---

# Profile: ZCode — Controlled Experiment Target (Electron Route)

> Every field below was measured on-device on 2026-09-08 (static asar analysis + live CDP probing). Do not update from memory.

## Basics

- App: ZCode 3.11.2 (build 89817f5b, built 2026-09-04), `/Applications/ZCode.app`, bundle id `dev.zcode.app`
- Platform: macOS arm64
- Runtime: **Electron 41.0.3** (Chrome 146.0.7680.80, V8 14.6), `app.asar` 293MB
- Package: `@zcode/desktop`, main entry `out/main/index.js` (1.5MB, ESM)
- Process model: main process + **host process** (local HTTP/RPC service, no window, 1.3MB) + scheduler process
- User data: `~/Library/Application Support/ZCode/` (standard Chromium profile, includes `session/`)
- Crash logs: `~/.zcode/v2/crash/` (live + archive)

## Attachment

```bash
# Single-instance lock: must quit before relaunching with args
osascript -e 'quit app "ZCode"'
# Launching the bare binary exits immediately (detach exception); must use open -a
open -a ZCode --args --remote-debugging-port=9227
curl -s http://127.0.0.1:9227/json/version
```

Note: `--version` is treated as a launch (prints nothing); do not use it to detect the version.

## Key Targets (measured via /json)

| type | url | notes |
|---|---|---|
| page | `file:///.../app.asar/out/renderer/index.html?restoreSession=true&...` | main window, **file:// scheme** loads the renderer straight from the asar |
| worker ×4 | (empty url/title) | Web Workers; autoAttach does not walk back to already-running workers |

- **No background page / service worker / OOPIF** — only page + worker targets
- All scripts load locally (`file://`), no remote scripts

## Bridge Surface

### Main preload (`out/preload/index.cjs`, ~508KB)

- `window.zcode`: **120 methods**, method-level contextBridge exposure (not a channel event bus)
- `window.__ZCODE_DEVICE_ID__`: device unique ID
- `window.ArmsEventBridge`: `send()` method, ARMS event reporting
- `window.ArmsRumBrowser` / `window.RumSDK`: RUM monitoring SDKs
- `window.WebView`: WebView constructor
- `window.__fetch__`: wrapped fetch

### Other preloads (5)

| preload | exposed object | purpose |
|---|---|---|
| `cuaPermissionPanel.cjs` | `window.cuaPermissionPanel` (4 methods) | CUA permission drag-and-drop guidance |
| `processMonitor.cjs` | `window.processMonitor` (1 method) | process metrics `getProcessMetrics()` |
| `embeddedBrowserJavaScriptDialog.cjs` | overrides alert/confirm | embedded browser JS dialogs |
| `codingPlanWebview.cjs` | webview injection | purchase callbacks (zai/bigmodel only), openExternal (http/https only) |
| `browserVideoRecorder.cjs` | no API | MessagePort forwarding (140-byte stub) |

### IPC channels (123, all prefixed `zcode:`)

- **invoke (request-response), 68**: ~25 reads (get-/list-/is-/can-/select-), ~43 writes
- **send (one-way), 18**: log, sync-*, open-external, report-*, etc.
- **on (main→renderer events), 37**: new-task, settings-changed, update-*, browser-view-*, etc.
- Naming convention: method camelCase → channel `zcode:kebab-case` (e.g. `selectFile` → `zcode:select-file`)

### Security configuration

| setting | value |
|---|---|
| contextIsolation | true |
| nodeIntegration | false |
| sandbox | true |
| nodeIntegrationInSubFrames | true (for webview) |
| preload format | CJS (required by sandbox) |

→ The renderer has no `window.process` / `window.require` / `window.electron`; pure sandbox.

## Frontend Stack

React 19.2.4 + Vite build, custom routing (not react-router), service-layer state management
(fileService / gitService / terminalService / zcodeTaskService).
react-intl i18n, Lucide icons, KaTeX, Monaco editor, PDF.js.
The RPC layer is the internal package `@zcode/rpc` (chunked frame protocol).

## Custom Protocols

| scheme | privileges | purpose |
|---|---|---|
| `zcode-media` | standard + secure + stream | local media file preview, `zcode-media://local/preview?path=...`, has path authorization checks |
| `rum-event` | supportFetchAPI + corsEnabled | ARMS RUM telemetry channel (renderer fetch → main-process interception → Aliyun) |

## Deep Links (zcode://)

| route | handling |
|---|---|
| `zcode://workspace/open?path=<dir>` | open workspace |
| `zcode://oauth/callback?code=&state=` | OAuth callback (appId=zcode, token endpoint `https://zcode.z.ai/api/v1/oauth/token`) |
| `zcode://payment/...` | payment callbacks |

## Capability Surface (navigation DOM enumeration, 2026-09-08)

New task / search / automation / plugin marketplace / groups / projects / task list / mobile remote control /
model picker (GLM-5.3-Flash) / mode picker (full access) / add context / quick commands (weekly report summary,
error fix, PPT creation) / idle-time tasks

Rich `data-testid` attributes (e.g. `plugin-store-sidebar-open`, `v4-composer-send`); strongly locatable.

## Telemetry Noise Domains (Network filter list)

`cdn-zcode.z.ai` (plugin icons/update CDN) · `*.aliyuncs.com` (ARMS RUM + OTel trace, over the rum-event protocol
rather than HTTP) · `api.z.ai` · `zcode.z.ai` · `bigmodel.cn` · `chat.z.ai` · `cdn.zcode-ai.com`

At idle, **zero HTTP/WS traffic** — telemetry goes over IPC (`zcode:report-arms-custom-event`) + the rum-event
protocol, producing no HTTP requests.

## Verified Behavior

- CDP attachment: `open -a ZCode --args --remote-debugging-port=9227` works; launching the bare binary exits immediately
- The bridge surface is **method-level direct calls** (`window.zcode.selectFile()` internally runs
  `ipcRenderer.invoke('zcode:select-file')`), not a channel event bus
- **contextBridge objects are frozen**: all 120 `window.zcode` methods are `writable=false, configurable=false`;
  the classic "wrap bridge methods to capture IPC calls" approach is **not feasible** (measured again on the second
  probe; only 2 RUM SDK methods are replaceable). `Page.addScriptToEvaluateOnNewDocument` injection itself works,
  but the hook targets cannot be replaced
- Channel-name discovery does not depend on runtime hooks: enumerating `window.zcode` method names + the
  `zcode:kebab-case` convention maps them all; static grep of minified code also extracts the channel enums
  (channel names are constant strings, not passed via variables — static extraction hits reliably)
- Trigger experiment: clicking [Plugin Marketplace] → 25 CDN requests (`cdn-zcode.z.ai` plugin icons); pure frontend
  route switching triggered no zcode IPC
- Script inventory: 262 scripts, 15 over 30KB, largest 4.5MB (styles CSS-in-JS), all local
- Alternative direction for capturing IPC calls (unverified): set a CDP breakpoint on `ipcRenderer.invoke/send` in
  `node:electron/js2c/sandbox_bundle`, read args via `Debugger.evaluateOnCallFrame`

## Adapter Priority (app-specific)

Primary `ipc-invoke` (channel names map from `window.zcode` method names, or static grep enumeration), secondary
`request-replay` (CDN/public-resource class), fallback `ui-flow`. Method-level bridging means **channel discovery
needs no runtime hook** — enumerating `window.zcode` methods + the naming convention yields the full list. But
**runtime IPC capture cannot rely on method wrapping** (objects are frozen); use CDP breakpoints or alternatives.

## Red Lines (this app)

- `window.zcode` carries many write methods (saveFile, executeDesktopCommand, quitAndInstallUpdate, etc.); when
  automating, call only get-/list-/is-/can- read methods
- `executeDesktopCommand` executes arbitrary desktop commands — **never touch**
- `zcode-media://` has path authorization checks but is still a local file access surface; do not probe it proactively
- Port 9227: quit as soon as you are done
- ARMS RUM + OpenTelemetry are running (Aliyun); operations are being collected

## Generality Verdict (2026-09-08)

- New app = new profile + contracts; PLAYBOOK and probes need no structural changes. Verdict: passed.
- Corollary of this app's method-level bridging: channel discovery needs no runtime hook; but frozen contextBridge
  means runtime IPC capture cannot rely on method wrapping — CDP breakpoints are the alternative (folded into
  PLAYBOOK §1 ③/④).
- From this profile, the standalone product CLI [zcodecli](https://github.com/williamfzc/zcode-cli) was spun off:
  status/start/stop, chat list/show/new/send (drives the agent and collects the full reply) and 12 read-only commands.
