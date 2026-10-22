---
type: Profile
title: Trae Desktop Read-only MCP Surface
description: Measured Trae 2.9.1 desktop and 1.104.3 engine identity, read-only renderer adapters, connection constraints and unresolved AI/editor capabilities.
---

# Trae

Verified on macOS with the installed **Trae 2.9.1** app. The debugging User-Agent and renderer product configuration
identify the embedded editor engine as **1.104.3**. These are different version fields: the MCP compatibility gate checks
`Trae/1.104.3`, not the desktop bundle version. Trae CN 3.4.3 is a separate installed application and was not tested.

## Attachment and identity

Launch a stopped app with its local debug endpoint:

```sh
open -a /Applications/Trae.app --args --remote-debugging-port=9231
```

Adding this flag to an already running instance may not enable debugging. Do not kill or restart an app doing user
work. This investigation started and closed its own instance. The endpoint is local only; the generated service does
not own or automatically start the desktop application.

The measured page is the `vscode-file:` workbench at a URL ending in `/workbench/workbench.html`. The initial isolated
profile instead showed `/setup/setup.html`; the workbench adapters deliberately do not match that onboarding page.
`window.vscode` exists in the main workbench. The manifest uses `window.icubeWorkspace` as its readiness gate because
the preload bridge appears before workspace metadata is initialized during startup. With multiple matching workbench windows the runtime refuses ambiguity;
this profile does not claim multi-window selection support.

## Verified capabilities

The declarations are in [the Trae example directory](../tools/mcp/examples/trae/):

| Capability | Read path | Result boundary |
| --- | --- | --- |
| `environment` | `vscode.context.configuration().product`, `vscode.process` version/platform fields, document language | Selected identity/runtime fields only; no environment variables, user IDs or launch arguments |
| `workspace` | `window.icubeWorkspace.folders` | Current renderer's folder names, URI schemes and paths, bounded to 128; no file contents |
| `window_state` | `vscode:isWindowMaximized` and `vscode:getWindowPosition`, with this renderer's configuration window ID | Live maximized state and window geometry; no window mutation |

Preload exposure was cross-checked in `out/vs/base/parts/sandbox/electron-browser/preload.js`; configuration consumers
in `out/vs/code/electron-browser/workbench/workbench.js`; window IPC handlers in `out/main.js`. Only the explicitly
listed read channels were executed. The service does not expose an arbitrary IPC or command executor.

Workspace folders are renderer metadata. Changes that replace/reload the workbench require re-reading the new page;
this does not claim an independently live extension-host document or task model.

## Unresolved

- AI task submission, stopping a task, conversation history and result retrieval have not been established.
- Editor contents have not been established. Two bundled CLI file-open attempts returned success, but the observed
  workbench still exposed zero editor/tab nodes. Do not publish an empty DOM result as proof that no files are open.
- Standard VS Code extension-host APIs are present in bundled declarations; that does not make them directly callable
  from the renderer bridge. Installing an extension was not part of this investigation.
- The isolated first-launch profile stopped at onboarding. No login, terms acceptance or setup completion was automated.
- Other releases, Trae CN, multiple workbench windows and continuous multi-day use remain unverified.

See [the evidence record](../tools/research/evidence/2026-10-22-trae-mcp/INDEX.md) for actual checks and negative results.
