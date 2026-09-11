---
type: Concept
title: Agent-Led Exploration Design
description: Decision record for cdp2cli - agent-led active exploration is the default route, runtime recording only a fallback; exploration levels from static discovery to controlled read-only verification, with the first-command closure as proof.
---

# Agent-Led Exploration Design

> **Status (2026-09-09)**: the reference implementation in this document, `zcodectl`, was the research-phase JS
> prototype (repo `src/`), now retired and deleted. The method itself still holds; the verified interface contracts
> moved to [`contracts/`](../contracts/), and the deliverable is the standalone product CLI spun off the contracts
> (e.g. the Go `zcodecli` for ZCode). `src/manifests/...` paths in the text correspond to today's `contracts/...`.

## 1. Decision

cdp2cli takes the route: **agent-led active exploration first, runtime recording only as an on-demand fallback.**

The architecture also moves from a fixed command tree to the page state graph: the CLI aligns with the app's
pages/states rather than a preset `app > domain > action` hierarchy; page path depth is variable. The page state
graph and `inspect / help / act` remain next-stage design and a proposed protocol — not implemented yet.

"Recording" is not a product goal, nor a mandatory step for every app. The product goal is to find a repeatable,
verifiable, safely executable app capability and freeze it into a CLI. Evidence may come from bridge objects, static
code, page structure, direct return values, UI state, network responses, or runtime observation; when evidence is
sufficient, do not record extra just for process completeness.

## 2. Main Flow

1. **Inventory**: enumerate page entries, bridge objects, static channels, deep links, visible states.
2. **Classify**: split candidate capabilities into read-only, write, unknown.
3. **Derive**: combine names, call sites, argument sources, and result consumption into candidate commands.
4. **Probe**: execute minimal calls or side-effect-free page operations only for confirmed read-only candidates.
5. **Attribute**: check return values, errors, before/after page state, and necessary network evidence.
6. **Verify**: repeat, confirming a stable result shape and no unexpected state change.
7. **Freeze**: save method contracts, evidence, version, regression samples; generate the CLI.

Only when steps 3–6 lack evidence, enter supplementary observation: Network, WebSocket, replaceable IPC entries, or
debug breakpoints. After supplementary observation, return to the same verification bar.

## 3. Exploration Levels

### A. Static discovery

Read-only; no business capability executed:

- Enumerate windows, pages, workers, and routes.
- Enumerate DOM/a11y entries and bridge objects.
- Read method property descriptors.
- Extract channels, argument objects, and call sites from the app bundle and loaded scripts.

This level can run automatically, but its output can only be called "candidate capabilities"; never ship a CLI from
it directly.

### B. Safe read-only probing

May run automatically, but all of the following must hold:

- Explicit read-only evidence, not just the method name.
- Empty inputs, or inputs from current app state and verified return values.
- Baseline state saved before the call.
- Return values, errors, and state diffs checked after the call.
- Timeouts, attempt counts, and stop conditions set.

### C. Supplementary observation

Enabled when a bridge method's meaning, argument boundaries, or result attribution are unclear:

- Narrow-scope Network / WebSocket listening.
- Call observers installed on replaceable entries.
- Static call sites for frozen contextBridge objects; debug breakpoints are a candidate only — never marked
  supported before actual verification.
- Single-variable differential experiments on the same read-only capability.

### D. Controlled writes

Not part of default automatic exploration. Only with explicit user authorization, a recoverable environment, and
defined rollback and acceptance does an isolated flow begin. A command supporting `dry-run` never makes unknown side
effects safe.

## 4. Blocking Rules

These candidates are blocked by default, never auto-called:

- Name or call sites contain save, set, create, delete, install, update, execute, send, authorize, log in, quit,
  open external, and similar behaviors.
- Arguments would require guessing local paths, accounts, resource IDs, recipients, workspaces, or business objects.
- The method both reads and modifies state.
- Call sites unlocatable, return values unconsumed, or error handling hinting at side effects.
- The app shows confirmation dialogs, permission requests, file pickers, payment, publishing, or external jumps.
- The target is a batch operation, or affects shared systems, remote data, or other users.

Any candidate not provably read-only becomes `unknown` and is handled as a write.

## 5. Reachability

Each candidate capability records four dimensions:

- **Discoverable**: locatable from pages, bridge objects, static code, or routes.
- **Invocable**: executable via bridge, request, or a stable a11y flow.
- **Verifiable**: a return value or observable state proves it did the expected thing.
- **Publishable**: explicitly read-only, reliable argument sources, and past repeated verification.

Only when all four hold does it enter the official CLI. Discoverable-but-unverifiable capabilities stay research
candidates, never dressed up as supported.

## 6. Minimum Release Bar

An auto-generated CLI command must satisfy:

- Method semantics confirmed by two independent kinds of evidence, or one call producing an unambiguous result.
- Every argument has an explicit source and type; no guessed values.
- Side effect is read-only.
- At least two successful repeats in the same environment.
- Return shape matches the saved contract.
- No undeclared state change before/after the call.
- Clear errors on failure; no trying dangerous alternatives.
- Re-verified after app version changes; the command is withdrawn until it passes.

## 7. Task States

Connection, exploration, verification, publication all enter ordinary task states — no hidden state machine that
only applies to device/app connections:

- `pending`: waiting to start.
- `connecting`: establishing the temporary debug connection.
- `discovering`: read-only inventory of candidate capabilities.
- `probing`: executing safe read-only probes.
- `observing`: collecting runtime evidence on demand.
- `verifying`: repeating calls and checking contracts.
- `ready`: the release bar is met.
- `blocked`: stopped for permissions, risk, insufficient evidence, or a future `inspect` returning
  `ambiguous / unknown`; only a `certain` recognition result may proceed to actions.
- `failed`: connection, call, or verification failed.
- `completed`: artifact generated and environment restored.

Debug ports, target processes, CDP sessions and other atomic connection resources are just resources a task holds;
their creation, holding and release must be recorded along with the ordinary task states above — no separate hidden
state. Success, failure, or cancellation must all enter cleanup and verify the port closed and the app restored.

## 8. Framework Boundary

The framework only defines:

- Data structures for candidate capabilities and evidence.
- Risk classification and blocking rules.
- Abstract interfaces for exploration, invocation, observation, verification.
- Task states, resource lifecycle, and the release bar.

The framework does not bind Playwright, a vendor-specific CLI, a particular agent, app, or debug script. CDP
clients, desktop controllers, static analyzers, external CLIs all plug in as replaceable adapters.

The page state graph protocol and data structures are likewise app-agnostic; state capture, recognition, Action,
Transition, risk, and verification interfaces are framework-level generality, while a specific app's recognition
rules and topology belong to that app's profile. The framework defines shape and behavior only; no app's page names,
DOM features, or transition paths are hardcoded into the generic layer.

This design adds no legacy-compat fields or dual-track logic. The repo is still in research: it uses the new page
state graph and evidence-verification model directly; the old fixed-command-tree descriptions are updated in place,
no legacy layer kept.

## 9. What ZCode Proves — and What It Does Not

Proven:

- Bridge methods, static channels, and page capability can be enumerated without recording user operations.
- An AI can operate read-only page entries and observe results.
- contextBridge freezing does not block capability discovery, but blocks direct method wrapping for call recording.
- Recording therefore cannot be a universal prerequisite.
- One ZCode read-only method went from candidate through repeated verification to an official command
  (`zcodectl ssh list`, see §10).

Not yet proven:

- (None — the first-command loop is complete; no open unproven item blocks the main flow. Add items as needed when
  extending to more commands.)

Next step: pick a read-only method with a clear return and no business arguments, and close the first `zcodectl`
command loop.

> 2026-09-08 update: the first-command loop is complete; see §10 below.

## 10. First-Command Closure Record

The first command that went from candidate capability through repeated verification to a frozen CLI command.

### Basics

| field | value |
|---|---|
| CLI command | `zcodectl ssh list` |
| `window.zcode` method | `window.zcode.listSSHConfigAliases` |
| IPC channel | `zcode:list-ssh-config-aliases` |
| invocation | CDP `Runtime.evaluate({expression: 'await window.zcode.listSSHConfigAliases()', returnByValue: true})` |
| adapter | `ipc-invoke` |
| arguments | zero (reads Host aliases from the local `~/.ssh/config`) |
| side effect | `read` |
| manifest path | `src/manifests/ssh-list.json` |
| exploration date | 2026-09-08 |
| app version | ZCode 3.11.2 (build 89817f5b) |

### Return Shape

An array; each element has the following fields (from `src/manifests/ssh-list.json`'s `verification.contract`):

| field | type | notes |
|---|---|---|
| `alias` | string | SSH Host alias |
| `host` | string | host address |
| `port` | number | port |
| `username` | string | username |
| `privateKeyPath` | string \| null | private key path, null if none |
| `source` | string | config source |

Both verifications returned 6 records with an identical field set (`schema_consistent: true`).

### Verification Record

| dimension | result |
|---|---|
| repeat count | 2 (`repeat_count: 2`) |
| run 1 | array, length 6, fields `[alias, host, port, username, privateKeyPath, source]` |
| run 2 | array, length 6, same fields (`schema_consistent: true`) |
| no-side-effect evidence | page URL identical before/after (`file://.../index.html`); `window.zcode` continuously available; `readyState` moving interactive → complete is the page's natural load finishing, not a call side effect (`url_unchanged: true`, `window_zcode_available: true`) |
| semantic confirmation | the return value is the SSH config alias list, matching Host entries in `~/.ssh/config`; the method name `listSSHConfigAliases` is unambiguous |
| argument source | zero-argument call, nothing to guess |
| evidence types | bridge-enumeration + successful-read-call + repeat-verification (three kinds) |

### Key Decisions

- **Invocation**: method-level wrap hooks are infeasible due to contextBridge freezing (all 120 `window.zcode`
  methods `writable=false, configurable=false`); use CDP `Runtime.evaluate` to call `window.zcode` methods directly.
- **Channel-name source**: the camelCase method → `zcode:kebab-case` channel naming convention, statically mappable,
  no runtime hook needed.
- **Why this command**: the first candidate was `models list`, but measurement showed no model-list methods exist on
  `window.zcode` (getModels/listModels/getAvailableModels all absent). `listSSHConfigAliases` is the read-only array
  method with the clearest return shape and richest data: zero arguments, explicit fields (6), identical results
  across two verifications, cross-checkable against the local `~/.ssh/config`, zero side effects.

### Why the Closure Matters

The first-command closure proves the agent-led exploration route can not only discover capabilities but reliably
produce repeatable CLI commands. Later command extensions follow the same flow: candidate → classify → minimal
read-only probe → repeated verification → manifest freeze → CLI release.

## 11. Next Stage: Page State Graph and the Stateless CLI

Today `zcodectl` has proven the loop "discover one read-only capability and freeze it into a command", but not page
recognition in complex apps, overlay states, multi-entry transitions, or automatic page-path generation.

The next stage adopts the page-centric model:

- Pages, stable regions, and overlays form state nodes;
- On-page operations form Actions;
- `before_state -- action --> after_state` forms Transitions;
- Page paths allow any depth — no one/two/three-level limit;
- The live app is the sole authority on current state; the CLI itself stays stateless;
- `inspect` captures the scene, matches a known `node_id`, then queries the topology by that ID; it must not infer
  topological position from page appearance;
- Unknown or ambiguous states stop the action and enter supplementary exploration;
- Every action declares prerequisite states and is re-recognized before and after execution;
- State nodes, recognition rules, actions, and transition edges are persisted; "which page the CLI was last on" is not.

Full design in [page-state-graph-design.md](./page-state-graph-design.md). The capability is not implemented; it is
not part of today's `zcodectl` command surface.
