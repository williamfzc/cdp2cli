---
type: Method
title: Turning Web-Stack Desktop Apps into CLIs
description: App-agnostic method for turning CEF/Electron/WebView2 desktop apps into CLIs over CDP - runtime detection and attachment, capability discovery with read-first probing, the contract schema, and the build SOP for spinning off a standalone product CLI.
---

# PLAYBOOK — A General Method for Turning Web-Stack Desktop Apps into CLIs

App-agnostic. The method solves one problem: **without official APIs, how to establish
how a CEF/Electron/WebView2 desktop app can be driven, and freeze the conclusions
into something used to build it a standalone CLI.**

A new target app = add one `profiles/<app>.md` + contracts in `contracts/`; the method itself does not change.

This repository is the **discovery layer**: the method (this file), app facts (`profiles/`), verified interface
contracts (`contracts/`), forensic probes and evidence (`tools/research/`). The CLI actually handed to users is a
**standalone project spun off from these facts** (single app, single binary, self-managed lifecycle), not in this repo.

## 0. Runtime Detection and the Attachment Matrix

Detect the runtime first, then attach per the table. Detection cues: main binary size (Electron mains are usually
>100MB, CEF/shell loaders only ~1MB), framework names under `Contents/Frameworks/`, and whether the Application
Support directory is a Chromium profile layout (`Default` + `Local State`).

| Runtime | Identification | Attachment | Extra dividend |
|---|---|---|---|
| Electron | `Electron Framework.framework` / `app.asar` | `App --remote-debugging-port=9222` | asar can be unpacked (`npx asar extract`); contextBridge is enumerable |
| CEF | renamed framework (e.g. `Xxx Framework.framework`) + Chromium profile directory | same (verified: renaming does not matter) | no asar; pure runtime route |
| NW.js | same as Electron | same | — |
| WebView2 (Win) | WebView2Loader | env var `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` | — |
| Tauri (Win) | system WebView2 | same as WebView2 | — |
| Tauri (macOS) | WKWebView | **no CDP**; WebKit inspector protocol (`ios-webkit-debug-proxy` can bridge) | out of range; degrade |

Verify attachment: `curl -s http://127.0.0.1:9222/json/version` and `/json` (lists all targets:
page / OOPIF iframe / background page / service worker).

Note: many apps ship a top-level binary that is a **single-instance launcher** — when an instance is already running
it forwards the args and swallows `--remote-debugging-port`. To launch with the debug port you usually must quit the
app first and relaunch, explicitly passing `--user-data-dir` pointing at the real logged-in profile, or business APIs
will have no login session.

## 1. The Five-Stage Loop (active exploration first)

The default route is not "record user operations first": propose candidate interfaces from multi-source evidence and
verify them with minimal **read-only** experiments. Network / WS / IPC hooks / debug breakpoints are supplements,
used only when meaning, parameter boundaries, or result attribution are unclear.

### ① Capability discovery (multi-source merge)
- **Bridge object enumeration**: inspect non-standard `window.*` objects, contextBridge methods and property
  descriptors; method names and parameter clues are usually closer to the final CLI than page buttons.
- **Navigation DOM / a11y enumeration**: `querySelectorAll('a,button,[role="tab"],li')` filtered to visible short
  text yields the user-understandable capability surface.
- **Static code / chunks**: Electron first: unpack the asar and read preload/main; at runtime collect `scriptParsed`
  via `Debugger.enable`, then pull chunk sources with `Debugger.getScriptSource` and extract endpoint URLs, request
  body fields, enum values. When minified code passes values through variables, static regexes often fail — force
  the chunk to load by navigating to the page, then scan the source.
- **Deep-link routing**: enumerate custom schemes from target URLs, protocol registrations, and code constants.

### ② Read/write classification
Classify every candidate capability as `read` / `write` / `unknown`:
- `read`: get/list/is/can/status/version etc.; name, call sites, and return values all support a no-side-effect judgment.
- `write`: save/set/create/delete/install/execute/send/openExternal etc.
- `unknown`: insufficient evidence or mixed side effects; treat as write.

**During probing, send real requests only to `read` candidates.** Minimal experiment for a read-only candidate:
zero arguments first; arguments only from real current page state — never guess paths, accounts, resource IDs.
Write endpoints are not really sent during probing — their contracts are fixed from static call sites, packet
capture, and read-only structural cross-confirmation.

### ③ Active exploration and attribution
- Call confirmed read-only methods, or do side-effect-free page navigation.
- Record before/after: return values, errors, DOM/URL, Network/WS activity. Evidence is archived per
  [tools/research/README.md](tools/research/README.md) (probe output, key screenshots, failure records).
- Page-style exploration additionally stores a `before-state / action / after-state` triple, feeding the future
  page state graph.
- Semantics are confirmed by three parties: "result shape + how call sites consume it + what changes in the UI" —
  never guessed from a method name alone.
- If arguments are unclear, run controlled variants: change one argument at a time, values from currently visible state.
- Whatever cannot be confirmed without side effects is marked `unresolved` — do not force requests out.

### ④ Supplementary observation (on demand)
Use only when active exploration cannot answer "what was called, with what arguments, and to whom does the result belong":
- **Network / WS**: listen on the relevant sessions, filtering telemetry noise.
- **Event bus hook**: wrap replaceable emit/invoke/on entries to capture channel names and arguments.
- **Method-level bridge observation**: check property descriptors first; wrap only if replaceable. contextBridge
  objects may be frozen — in that case never pretend the hook succeeded; fall back to static call sites or breakpoints.
- A hook must be verified installed in the real context with an observable marker; an injected script is not a
  captured call.

### ⑤ Freezing into contracts
As soon as one interface is established, write one contract (`contracts/`, schema in §2): purpose, endpoint/channel,
request body, return shape, read or write, evidence, verification status. Bar:
- Semantics have two kinds of evidence confirming each other, or one call yields an unambiguous result;
- Argument sources are explicit, not guessed;
- Read interfaces repeated at least twice with identical shape;
- A write interface's request contract comes from static call sites / packet capture / read-only cross-confirmation;
  the real write response is backfilled after the product CLI's first execution.

Contracts are the requirement docs for spinning the product CLI. Redaction: user content verbatim (conversations,
document names, task prompts) is not archived; keep structure, counts, key sets; endpoints, resource IDs, request
shapes are kept.

### ⑥ Copy-paste forensic recipes (bare CDP, zero dependencies, Node >= 22)

The five recipes below are the repeated moves for chewing an app down to full contracts. They all run on the
browser-level WebSocket (the `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/version`):
`Target.setAutoAttach({autoAttach:true,flatten:true})` attaches every target, then `Runtime.evaluate`
(`returnByValue:true, awaitPromise:true`) runs JS in a target session, `Debugger.getScriptSource` pulls sources,
`Network.*` captures requests. For an all-in-one bare-CDP probe sample see
[tools/research/probe-zcode.mjs](tools/research/probe-zcode.mjs) (attachment, bridge-surface enumeration, script
inventory, traffic watch, replaceability tests); archival conventions in
[tools/research/README.md](tools/research/README.md).

**Recipe 1: enumerate every business endpoint (decides "how big is the capability surface")**
Navigate to every feature page (click the sidebar) to force lazy chunks out; pull the source of each
`/static/js/*.js` and regex out endpoint literals:
```js
// run over every collected chunk source src
const re = /["'`](\/(?:shop|im|drive|office)\/[a-zA-Z0-9_\/{}.-]+)["'`]/g;  // change domain prefixes per target app
// also note the gateway method name / request body type name within the first ~80 chars of an endpoint
// → gives you the request body fields
```

**Recipe 2: capture the app's real requests (decides "how to call it")**
Enable `Network.enable` on the business sessions; in `Network.requestWillBeSent` filter telemetry noise
(telemetry/collection/risk-control domains and static assets; list per app), recording
`method + host + pathname + postData`. Read-only navigation (clicking different sidebar items) makes the app send
its list requests by itself.

**Recipe 3: in-page same-origin replay (decides "what it returns")**
fetch from the main page session; cookies ride along with the browser, equivalent to the app's own request:
```js
const r = await fetch(URL, { method:'POST', headers:{'content-type':'application/json'},
  body: JSON.stringify(BODY), credentials:'include' });
const j = await r.json();   // inspect the shape of j.code / j.data
```
Replay first with the **app's real body** (captured in Recipe 2); if an empty body succeeds, go zero-arg; if an
empty body errors with "system error", a required argument is missing — go back to Recipe 1 call sites or Recipe 2
for the real body. Repeat reads twice to confirm a stable shape.

**Recipe 4: fix write endpoints statically**
Write endpoints (create/delete/pause…) are **not really sent** during probing. From chunks, find the interface
method / request body type definitions to extract body fields, and find their call sites to extract object
assembly (enums, required context); response unwrapping shows data fields and success flags.
The real write response is backfilled on the product CLI's first execution.

**Recipe 5: DOM-shaped data (when there is no HTTP interface)**
Some surfaces (e.g. the sidebar conversation list) are read straight from the DOM:
`querySelectorAll('[data-testid=...]')` for stable identification rules, resource IDs extracted from `href`.
That is the ui-flow adapter.

**Full-coverage checklist for one app** (check coverage against the recipes; anything uncovered is honestly marked
unresolved):
- [ ] Full endpoint list (Recipe 1) clustered into feature domains
- [ ] Every feature domain's list/read requests captured (Recipe 2) or statically located (Recipe 1)
- [ ] Every replayable read interface has a stable response shape (Recipe 3) and a written `contracts/` entry
- [ ] Write endpoints' request bodies / enums / required context fixed statically (Recipe 4)
- [ ] Interface-less surfaces have DOM identification rules (Recipe 5)
- [ ] Special protocols (e.g. custom cmd encoding that errors on replay), authorization gates, pairing flows marked
      blocked/unresolved with reasons

## 2. Contract Schema

One JSON per command (`contracts/`):

```yaml
method: job_list                    # CLI subcommand name
adapter: request-replay             # ipc-invoke | request-replay | ui-flow
target:                             # adapter execution details
  url: https://example.com/api/v1/job/list
  httpMethod: POST
  requestBody: { size: 100, sort_order: 1 }
params:
  schema: {}                        # from static call sites, return values, or controlled variants
side_effect: read                   # read | write
evidence: [static-callsite, successful-read-call, repeat-verification]
verification:
  status: verified-read | static-contract-only   # the latter when a write endpoint lacks live confirmation
  repeat_count: 2
  contract: { ... }                 # key points of the return shape
app_version: 1.0.0                  # app upgrades trigger re-verification
```

`adapter` is how the call executes, independent of how the evidence was obtained. Write contracts additionally
record the full request body fields, enum values (e.g. numeric enums like schedule type / day of week), and the
sources of required context fields (e.g. a resource-origin id).

## 3. The Two-Layer Product

```
Discovery layer (this repo)            Product CLI (standalone project, spun off contracts)
──────────────────────────             ─────────────────────────────────────────────────
PLAYBOOK     general method             single app, single-file binary (Go etc.)
profiles/    app facts                  self-managed lifecycle: start launches the app with the debug port
contracts/   verified contracts   ──►   read commands + write commands, executed directly
tools/       forensic probes+evidence   --json structured output
docs/        design & retrospectives    go install / download and run
```

Product CLI conventions:
- **Self-managed lifecycle**: `start` quits the current instance and relaunches with the debug port on the real
  logged-in profile (foreground, Ctrl-C cleans up); business commands only connect to a ready instance — if not up,
  error with diagnostics and a hint to run `start` first. Fixed debug port by default.
- **Read commands query directly; write commands are allowed in** (see "the write / agent-driving boundary" below).
  For coding-type apps, read-only is not enough — the goal is **driving the agent to do work**: new session, send
  prompt, collect the full reply (streamed replies collected to the end).
- **Self-contained skill**: the agent guide ships inside the binary (`skill` top-level command, go:embed); distribute
  the CLI only — no separate skill package for users/agents to install; cdp2cli's method is used at build time only,
  the artifact has zero external dependencies.
- **README marks provenance**: a spun-off CLI must state at the top of its README that it was converted with cdp2cli
  (e.g. "Auto-generated with [cdp2cli]"), with target app, version, verification date.
- All commands support `--json` (single-line JSON; errors `{"error":...}` to stderr, non-zero exit).
- On contract mismatch (return shape does not match) stop and error — the app version may have changed; never print
  half-parsed results.

**The write / agent-driving boundary (confirm with the user before starting)**
At the start of a conversion, confirm with the user: **is this CLI allowed to write / be agent-driven?** Once the
user confirms, write commands and session driving are target features, built normally (executed directly, equivalent
to operating in the app; no dry-run gate). Even when writes are allowed, two classes remain:
- **Become commands (after confirmation)**: business writes (create/delete/pause resources), session-level agent
  driving (chat new/send, collect replies) — these are core product capabilities. Arguments/resource IDs only come
  from real returns, never invented; agents running write commands still presuppose user authorization.
- **Never built (even when writes are allowed)**: authorization gates / accepting agreements, device pairing,
  unattended batch operations, install/update, payment/OAuth — irreversible or privilege-escalating actions; only a
  human in the real UI does these.

### 3.1 Build SOP: spinning a CLI off the contracts

Goal: taking `profiles/<app>.md` + `contracts/*.json` + `tools/research/evidence/`, produce the app's CLI in a
**standalone new project**. Language is open (a Go single binary is the current convenience choice; see
[zcodecli](https://github.com/williamfzc/zcode-cli)); no Playwright dependency — a WebSocket client + in-page fetch
is enough.

**Project layout (single responsibility per file; copy the layout)**
```
main.go        argument parsing + command dispatch (--json/--port global flags; <domain> <action> [args/flags])
cdp.go         CDP client: connect webSocketDebuggerUrl → Target.setAutoAttach(flatten)
               → find session by URL predicate → Runtime.evaluate (gorilla/websocket suffices)
lifecycle.go   status/start/stop: osascript quit, spawn launcher with --remote-debugging-port +
               --user-data-dir=<real profile>, poll /json/version until the port is up
session.go     connect the main page session (URL predicate in profile); in-page same-origin fetch replay (request-replay)
commands.go    one command per contract: connect → replay → validate return shape → print (table or --json)
skill.go       `skill` command printing the agent guide
```

**Command surface** (one-to-one with contracts): `status/start/stop` lifecycle; `explore` read-only enumeration;
`<domain> list/get/...` read commands; `<domain> create/pause/delete/...` write commands (executed directly).
The generic pattern for request-replay commands: connect main page → inside `Runtime.evaluate`,
`fetch(url,{method:'POST',body:JSON.stringify(body),credentials:'include'})` → return `{httpStatus, body}` →
validate the business success code and data shape against the contract, or exit non-zero with a contract-mismatch
error.

**Lifecycle points**: many apps' top-level binary is a single-instance launcher (swallows debug args while running)
— `start` first osascript-quit, waits for the port to close, then spawns the launcher with explicit
`--user-data-dir` pointing at the real logged-in profile (business APIs then have the login session); fixed port by
default. Business commands never silently restart; they only connect to a ready instance, and if not ready, error
with "run start first" diagnostics.

**Verification loop**: after adding each command, first pass `make build`/compile, then run it once against the real
running debug instance (`start` first): read commands — check return counts/key sets match the contract; write
commands — test the argument-validation paths (missing ID errors, no request sent); real writes only run when the
user explicitly asks. Once a new app gets CDP/lifecycle/one read-only command working, every following command
reuses the same template.

**Build pitfall (measured)**: macOS Mach-O binaries from Go 1.22's built-in linker can lack `LC_UUID` and dyld
refuses to run them (`missing LC_UUID load command`); avoid it with `-ldflags="-linkmode=external"` (external
linker; put it in the Makefile).

**Command-surface completeness**: the goal is not a read-only browser. For a coding-type app, reach at least:
list sessions, view history, create a session and send a prompt, continue in a session, receive the agent's full
reply (streamed replies collected to the end). Pure read-only enumeration (status/config lists) is only the base
layer. Before starting, confirm write permission with the user per "the write / agent-driving boundary"; once
confirmed, build out business writes + session driving fully.

**Completion criteria**: every verified-read contract has a command whose real-device returns match; write commands
assemble request bodies per the contract and error on missing arguments; `status/start/stop` manages the app;
`--json` works on every command; `skill` is self-contained (embedded); a coding-type app's chat list/show/new/send
run on the real device (new/send receive the full reply); the README's top has the "Auto-generated with cdp2cli"
mark + app version/verification date, plus install instructions and the run-`start`-first note.

## 4. Known Pitfalls and Safety Notes

**Pitfalls**
- Single-instance lock: relaunching with debug args while the app runs does nothing (the launcher swallows them);
  quit first, then launch with args.
- A method name is only a clue; a get/list prefix does not make it safe. Look at call sites, return-value
  consumption, state changes.
- When minified code passes values through variables, static analysis is often not enough — only then escalate to
  runtime observation; do not make hooks a prerequisite for every app.
- contextBridge methods may be non-writable/non-redefinable; record wrap failures honestly, and never mistake a
  successful injection for a successful capture.
- Business APIs may run over a background-page long connection; watching only the current page loses evidence.
- SPA route switches rebuild the rendering context; temporarily injected observers die (use
  `addScriptToEvaluateOnNewDocument`).
- No traffic at idle does not mean no capability; trigger in a controlled way before judging.
- Some CEF builds accept only one DevTools WebSocket client: the later handshake succeeds but messages are silently
  dropped; probes must exit gracefully.
- OOPIFs (cross-origin iframes) may not support evaluate over the browser socket + flatten; connect to their own
  page socket directly.

**Safety (plain terms)**
- **During probing, send read requests only**; write/delete/send/authorize/pairing is not touched while establishing
  contracts. Before a conversion starts, confirm with the user "may this CLI write / be agent-driven?"; only after
  confirmation are write commands and session driving built normally.
- Arguments (resource IDs, bot_id, etc.) come only from current app state or verified returns — never invented;
  agents running write commands presuppose user authorization.
- Even when writes are allowed: authorization gates, device pairing, accepting agreements, install/update,
  payment/OAuth, unattended batch operations are never automated commands — only a human clicks those in the real UI.
- The debug port is a local plaintext control plane (any local process can take over the logged-in session); close
  it when done.
- Anti-automation SaaS, DRM-protected apps, environments without debug interfaces are out of range.

## 5. Page State Graph (direction, not yet built)

Beyond a fixed command tree, the long-term direction is aligning the CLI with the app's **page state graph**: core
entities are Page (re-identifiable state nodes), Action (actions with prerequisite states), Transition (edges the
actions trigger between states). Proposed protocol: `inspect` (capture the scene → match node_id → query topology),
contextual `help`, generic `act`; recognition results are certain/ambiguous/unknown, and ambiguity stops. Full
design in [docs/page-state-graph-design.md](docs/page-state-graph-design.md) — a design today, not an existing
capability.

## 6. Generality Boundary

The method's generality is adjudicated: **switching apps only ever adds a profile + contracts; the method itself
does not change.** Wherever you get stuck, that is a missing section of the method — fold it back into this file.
The Electron route has been walked end to end with a verifiable standalone CLI produced: ZCode (method-level
contextBridge, see [profiles/zcode.md](profiles/zcode.md)) →
[zcodecli](https://github.com/williamfzc/zcode-cli).
