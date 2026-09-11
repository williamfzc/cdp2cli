# Probing Scripts (research-phase scratch)

Bare CDP over the Node global WebSocket (Node >= 22, zero dependencies). Run each script on the port the app
profile specifies; never assume all targets share one port.

| file | purpose | generality |
|---|---|---|
| probe-zcode.mjs | all-in-one ZCode (Electron) probe: target structure, bridge objects and property descriptors, DOM capability surface, script inventory, traffic watch, plus a live test that core methods cannot be wrapped | **high; attachment + bridge-surface enumeration template** (port/object names per app) |

Recipe-level usage (full endpoint sweep, in-page same-origin replay, static discovery of write endpoints,
click-diff verification) is given in [PLAYBOOK §1.⑥](../../PLAYBOOK.md); write a fresh probe per target app.
New probes are archived under the conventions below.

## Discipline for CEF-class targets

Pitfalls measured the hard way are frozen into [PLAYBOOK §4](../../PLAYBOOK.md) (single DevTools WebSocket client,
OOPIF needs its own socket, graceful exit, etc.); not repeated here.

## Archival conventions (exploration evidence)

Every exploration session on a target app archives under `evidence/<date>-<app>/` so later CLI building and
retrospectives can trace it. Probes should write results **to files**, not just stdout; key states (authorization
gates, abnormal UI, before/after shots) go to `shots/` via CDP `Page.captureScreenshot`.

Directory contents:

| content | notes |
|---|---|
| `INDEX.md` | timeline retrospective of the session: what was tried, success/failure, key findings, red-line stop events; each entry links evidence files and the corresponding probe |
| probe output JSON | raw results written to disk by probes (`--json` output, request/IPC captures, contract verification summaries) |
| `shots/*.png` | screenshots of key states (states that could not be captured are reconstructed in text in INDEX) |
| failures and dead ends | negative results are evidence too: why a road is closed often saves the next person more time than the path that worked |

Redaction rules match contracts: user content verbatim (conversation titles, messages, document names, task
prompts) is never archived; keep structure, counts, and key sets; endpoints, resource IDs, and request shapes are
kept — those are what a retrospective needs most.
