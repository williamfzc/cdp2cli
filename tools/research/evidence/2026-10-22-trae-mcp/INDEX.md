---
type: Index
title: Trae Standalone MCP Trial
description: Sanitized evidence for real Trae reads, generated-service maintenance, lifecycle recovery and finite retained-memory checks, with unsupported AI/editor operations explicitly excluded.
---

# Trae MCP trial — 2026-10-22

Target: installed Trae desktop 2.9.1 on macOS. The measured editor engine is 1.104.3 (Electron 37.6.1, Chromium
138.0.7204.251); this is the value used by the runtime's User-Agent/version gate. Trae CN was not launched.

## Records

- [inspection.json](./inspection.json): identity, interface key sets, static-source fingerprints and negative results.
- [acceptance.json](./acceptance.json): checks performed by a real MCP client using the generated configuration;
  app return values were checked in memory and discarded. Only shapes, counts, diagnostics and memory samples remain.
- [memory.json](./memory.json): 50 warm-up and 1,000 measured real-app reads, heap after collection, and resource
  counters after each batch and shutdown.
- [verification.json](./verification.json): completed gates and exact declaration fingerprints.
- [Profile and unresolved scope](../../../../profiles/trae.md).
- [Verified declarations](../../../mcp/examples/trae/).

## Investigation and results

1. An isolated first-launch profile connected successfully but showed onboarding. No setup completion, acceptance,
   login, pairing or authorization action was attempted. That owned test process was terminated.
2. Started the normal installed Trae with the local debug flag. Its workbench exposed `window.vscode`, renderer
   workspace metadata, and the configuration object described by the bundled preload and workbench sources.
3. Cross-checked the two window-read IPC handlers in the bundled main source before invoking them. Verified engine
   identity/runtime fields, a nonempty workspace folder set, maximized state and positive window dimensions.
4. Generated an independent service outside the repository with `environment` and `workspace`, installed its locked
   dependencies, and connected a real MCP client through its generated `mcp-config.json`.
5. Added `window_state` while the same service ran, then updated the existing environment description. All three
   capabilities remained callable. A separate complete-project `check` passed with three verified declarations.
6. Performed 200 sequential and 12 simultaneous client reads. Each sampled diagnostics snapshot had no outstanding
   requests, sessions or remote object groups. Idle release and subsequent reconnect, actual renderer refresh, app
   exit/restart recovery, and service-only shutdown are recorded in the acceptance report.
7. Separately ran 1,050 real-app reads using the shared connection runtime. Every batch released temporary resources;
   collected retained heap stayed within the finite 16 MiB growth budget. Shutdown cleared the validator cache.

## Negative and unresolved findings

The first app-restart check failed because `window.vscode` existed before the workspace object was initialized. The
manifest now gates availability on `window.icubeWorkspace`; application identity still comes from the Trae User-Agent.
The complete restart check was rerun after this correction. No generic runtime change or automatic business-operation
retry was introduced.


The bundled CLI returned success for two attempts to open an owned temporary text file, but the observed workbench
still had zero `.monaco-editor` and editor-tab nodes. The cause was not established. No editor-content capability was
published and no empty DOM result was presented as evidence that the user's editor had no open files.

AI prompts, task creation/cancellation, chat histories and task-result retrieval remain unverified. No tasks were
submitted, account settings changed, extensions installed, or project files edited. Window reload and application
restart were limited to the instance started for this investigation. The temporary text fixture was outside the
user's project and contained no user content. No screenshots or full configurations were archived because the normal
workbench could contain user project information.

The workspace adapter reads this renderer's folder metadata, not the extension host's document model. Multiple
matching windows are rejected by the shared runtime. Other releases, Trae CN, remote workspaces, onboarding, writes,
and continuous multi-day execution were not validated. Finite memory checks do not establish that Trae itself has no
leaks or that a future adapter's methods can be safely abandoned after cancellation.

App-specific generated service files remain outside cdp2cli; the repository records only the facts, declarations and
sanitized evidence. The shared generator/runtime required no code change for this second application.
