---
type: Concept
title: Page State Graph Design
description: Design for replacing the fixed command tree with a page state graph - Page/Action/Transition model, a stateless CLI over app-authoritative state, and the inspect/help/act protocol. Direction only, not implemented.
---

# Page State Graph and the Stateless CLI Design

> This is a **direction design, not implemented**. `zcodectl` in the text refers to the research-phase JS prototype
> (repo `src/`, retired and deleted); verified contracts are in [`contracts/`](../contracts/), and the deliverable is
> the standalone product CLI spun off the contracts. The `inspect / help / act` and state-graph persistence
> described here are roadmap, not current capability.

## 1. Core Conclusion

cdp2cli's final product should not be a fixed one/two/three-level command tree, but should be generated from the
app's **page state graph**.

- Pages, stable regions, and overlays are state nodes.
- Operations on a page are Actions.
- State changes triggered by operations are Transitions.
- The CLI's page paths allow any depth; the action comes last.
- The app is the sole authority on current state; the CLI itself can be stateless.

Page containment organizes commands and help; page transitions drive actual navigation. The two must be stored
separately: containment can approach a tree; transitions must be a graph allowing multiple entries, cycles,
branches, and cross-region jumps.

## 2. Why a Three-Level Command Tree Is Not Enough

Real desktop apps commonly show:

- The same page is reachable from settings, a project menu, and the command palette.
- Pages contain tabs, drawers, popups, menus, and system windows.
- One action may jump to a sibling region, an external window, or back to an old state.
- Transition results depend on login, permissions, data, experiment flags, and the current selection.

So "currently on the third-level page" is not a reliable state description. A stable description includes:

```json
{
  "window": "main",
  "page": "settings",
  "regions": ["remote", "ssh"],
  "overlays": ["ssh-editor"],
  "selection": {"sshAlias": "dev"}
}
```

The topmost overlay usually decides the currently executable actions. The method lookup order is in principle:
topmost overlay → current local region → current main page → global actions.

## 3. Three Core Objects

### Page / State Node

A page state re-identifiable across visits — not just a URL. At minimum:

- a stable `node_id` and its official command address;
- window, page, region, overlay, and selection context;
- entry methods and known entrances;
- positive recognition conditions and exclusions;
- currently available actions;
- reachable neighbor nodes;
- recognition evidence, applicable versions, and confidence.

### Action

An operation hosted on a state. At minimum:

- a stable `action_id`;
- owning state and preconditions;
- argument sources and result contract;
- risk classification;
- execution adapter;
- the expected target state, or the allowed target state set;
- repeat verification and no-side-effect evidence.

### Transition

State changes observed during exploration:

```text
before_state -- action(params) --> after_state
```

An edge must store the source node, action, argument constraints, target node, trigger conditions, observation
evidence, and verification count. Transitions are never inferred from DOM containment alone.

## 4. What inspect Does

`inspect` does not divine "which topology level" from how the UI looks. Three steps:

1. **Capture the scene**: read the current window, URL/route, DOM, a11y, selected tab, overlay stack, visible
   components, bridge state, and necessary screenshot features.
2. **Recognize the node**: compare the scene's facts against the recognition rules in the state-node library to get
   a `node_id`.
3. **Query the topology**: use `node_id` to look up known entrances, neighbor nodes, current actions, and possible
   transitions.

That is:

```text
live scene → recognition rules → node_id → topology relations and actions
```

The current page only answers "which node am I"; the topology database answers "which nodes is this one connected to".

### Recognition Rule Example

```text
node_id: settings.remote.ssh.editor

must satisfy:
- main window present
- settings region visible
- SSH list region present
- editor dialog present
- dialog has alias, host, port inputs
- save and cancel buttons visible

must not satisfy:
- delete-confirmation dialog on top
- system file picker active
```

Recognition rules must not contain concrete user data, or editing different records would wrongly split into
different nodes.

### Recognition Results

- `certain`: exactly one node clearly matches; continue.
- `ambiguous`: several nodes could match; stop the action and return candidates plus the missing distinguishing
  evidence.
- `unknown`: no known node matches; stop the action and return raw observations; enter the exploration flow.

Never substitute the CLI's last recorded position for real recognition.

### Readiness Wait

When recognition returns `unknown`, or the scene is clearly not ready (target just rebuilt, document not finished
loading, skeleton screens/loading indicators still present), do not immediately declare failure — first enter a
**bounded readiness wait**:

```text
recognition fails → poll readiness criteria (bounded wait) → only after timeout report unknown
```

Readiness criteria are listed explicitly, e.g.: target process and debug port stable, document `readyState`
complete, loading indicators gone, expected recognition features present. The wait window has a hard cap; on
timeout, report "not ready" honestly, and never dress a post-wait guess up as recognition. Probes and CLI command
execution share the same readiness criteria; "waiting" is the default response to an unloaded state, and "acting"
happens only after readiness is judged.

## 5. How the Topology Forms

The topology accumulates as the agent explores — it is never computed statically from one page.

Every safe exploration runs:

```text
inspect before
→ choose an allowed safe action
→ execute the action
→ wait for the UI to settle
→ inspect after
→ save before/action/after
→ attempt replay and verify
```

The first visit to an unknown page only creates a temporary node, saving the previous state and the action that
caused it as a temporary edge. Only after repeated visits, stable recognition features, and path replay does it
promote to a formal node.

If the app lands on an unknown page at startup with no preceding action, record it only as "a new, not-yet-located
node" — never fabricate its relations to other nodes.

## 6. The Stateless CLI Protocol

The proposed minimal protocol:

```bash
<cli> inspect
<cli> help
<cli> help --all
<cli> act <action-id> [parameters]
<cli> <page-path...> <action> [parameters]
```

- `inspect`: capture live, recognize the current node, return topology adjacency and current actions.
- `help`: built on `inspect`, showing only the commands actually available in the current state.
- `help --all`: the full catalog of modeled, verified pages and commands.
- `act`: execute an action on the current state; re-recognize before and after.
- Full page-path commands: the stable, scriptable official business entry; page paths are unlimited in depth.

The command address form:

```text
<cli> <page-path...> <action> [parameters]
```

Even when a page has several entrances, pick exactly one stable official address; other entrances are stored only as
Transitions, never generating duplicate command sets.

## 7. The Action Execution Loop

Every action execution must complete:

```text
live inspect
→ check node_id and action preconditions
→ execute the action
→ wait for stability
→ inspect again
→ check the actual target state against the allowed set
→ return the result and the new state
```

A summary of the first observation may be passed into the action as optimistic concurrency protection. If the real
state has changed before execution, stop — never continue operating off a stale page.

On `ambiguous`, `unknown`, a topmost risk overlay, unmet preconditions, or a target-state mismatch: stop, with a
diagnosable result.

### Overlay Handling and Authorization

The topmost overlay is part of the state, and "handling the overlay" is itself an Action under the same side-effect
classification:

- `dismiss` (close prompts, cancel dialogs, go back up): no business side effect; may be configured to run
  automatically;
- `agree / authorize` (accept terms, authorize, pair, confirm login): blocked by default;
- other overlay actions classify as read / write / unknown normally.

Automatic handling is bounded by the operator's explicit authorization: grants are whitelisted per overlay type
(e.g. "allow auto-dismissing update prompts"); overlays not whitelisted always stop, reporting overlay content and
candidate actions to the operator. In this semantics, "stop" is an authorization-checkable checkpoint, not the end
of exploration.

The probing stage runs a stricter version of the same rule: click candidates are filtered at **generation time**
against consent/authorization surfaces (e.g. "by using this you agree" text, elements whose click fires
risk-control/authorization endpoints) — they never enter the candidate list to be judged at runtime.

## 8. What Is Persisted

Long-term storage needs:

- the state-node library;
- each node's recognition rules;
- Action definitions and result contracts;
- the Transition graph;
- exploration coverage, blocked reasons, unreachable reasons;
- app versions and repeat-verification evidence.

"Where the CLI was last" is never persisted as authoritative state. Atomic resources like connection ports and
target processes join ordinary task state; success, failure, and cancellation must all clean up and verify
restoration.

## 9. Framework Boundary

The framework defines the state capture, recognition, action, transition, risk, and verification protocols, but
binds to none of:

- Playwright;
- a particular agent;
- a particular app;
- vendor-specific CLIs or other external materials;
- one fixed probe script.

CDP, accessibility, visual observation, native window control, and static analysis are all replaceable adapters.
CDP can be the core observation-and-execution base for Chromium-class apps, but must not assume it covers system
file pickers, menu bars, permission dialogs, keychains, or other native UI.

## 10. Current Implementation Boundary

Today `zcodectl` has:

- `status`, `start`, `stop` lifecycle;
- `explore` read-only enumeration;
- `ssh list`, the first repeat-verified read-only business command;
- human-readable and JSON output;
- command manifests and automated tests.

Not yet implemented:

- the state-node library and recognition rules;
- page state graph and Transition persistence;
- `inspect`, contextual `help`, generic `act`;
- unknown/ambiguous state handlers;
- the readiness-wait window and overlay-handling authorization model;
- automatic CLI generation for arbitrary-depth page paths;
- unified state capture across CDP, macOS Accessibility, vision, and native windows.

This document is therefore the next stage's product architecture; do not describe `inspect` or page topology as
currently available.
