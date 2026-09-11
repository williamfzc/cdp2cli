# cdp2cli

> Turn desktop apps built on web stacks (CEF / Electron / WebView2) into CLIs — the **method and discovery layer**.
> No official APIs: attach over CDP (Chrome DevTools Protocol), see through the requests the app actually sends, the
> bridge objects it exposes, and the page structure — then establish "how can this app be driven safely" and freeze
> it into interface contracts.

**This repository itself is not a CLI shipped to humans.** It is the upstream lab for building CLIs, producing three things:

1. **The general method** ([PLAYBOOK.md](./PLAYBOOK.md)) — how to attach, how to discover capabilities, how to split read/write, how to verify. App-agnostic.
2. **Per-app facts** ([profiles/](./profiles/), [contracts/](./contracts/), [tools/research/](./tools/research/)) — what an app looks like, which interfaces are verified, what the request/response contracts are, the forensic process and evidence.
3. **The basis for spinning off products** — from these facts, build one **standalone, installable, directly usable CLI** per app.

## The Two-Layer Model

```
cdp2cli (this repo)                     spun-off product CLI (standalone project)
─────────────────────              ──────────────────────────
PLAYBOOK      general method        single app, single-file binary
profiles/     app facts             self-managed lifecycle (start launches the app)
contracts/    verified contracts  ──►    executes read/write commands directly
tools/        forensic probes + evidence   go install / download and run
docs/         design & retrospectives
```

- **cdp2cli answers**: "What is the target app's capability surface? What can be read, what written? What do the
  arguments and returns look like? How do you stay safe?"
- **The spun-off CLI answers**: "Give me a `xxx <domain> list`, `xxx <domain> delete <id>` — a tool that just works."

The product CLI's shape: **single app, command-driven, self-managed lifecycle, single binary, full read/write.** It
consumes this repo's contracts and handles bringing the app up on a debug port with the real logged-in profile
itself; users never pass a port manually or set up an environment first.

## Current Status

- **ZCode (Electron 41, method-level contextBridge)**: fully converted by this method into the standalone Go CLI
  [zcodecli](https://github.com/williamfzc/zcode-cli) — status/start/stop self-managed lifecycle, chat
  list/show/new/send to drive the agent and collect the full reply, 12 read-only commands, README headed
  "Auto-generated with cdp2cli". It is the **living proof the method works**; this repo keeps its app facts
  ([profiles/zcode.md](./profiles/zcode.md)), first contract ([contracts/ssh-list.json](./contracts/ssh-list.json))
  and probe ([tools/research/probe-zcode.mjs](./tools/research/probe-zcode.mjs)) as format samples for new apps.
- **Route direction**: from a "fixed command tree" toward a "page state graph" (`inspect` / contextual `help` /
  `act`) — currently design only, see [docs/page-state-graph-design.md](./docs/page-state-graph-design.md).

## How to Use This Repo (for agents)

A new agent needs nothing else: with this repo alone it can convert a CEF/Electron desktop app into a CLI. Walk it:

1. **Read the method**: [PLAYBOOK.md](./PLAYBOOK.md)
   - §0 the attachment matrix (how to launch with the debug port and connect);
   - §1 the five-stage loop + **§1.⑥ the copy-paste forensic recipes** (enumerate every endpoint, capture real
     requests, in-page replay, fix write contracts statically, DOM identification; plus the full-coverage checklist
     for one app);
   - §2 the contract schema (each established interface becomes one `contracts/` file);
   - **§3.1 the build SOP for spinning a CLI off contracts** (project layout, CDP client, lifecycle, command
     templates, verification loop, build pitfalls).
2. **Look at the samples**: `profiles/` is the app-facts sample; `contracts/` the contract sample;
   `tools/research/README.md` indexes the probes (bare CDP, zero dependencies — change the port/regex and reuse);
   the spun-off ZCode Go CLI ([zcodecli](https://github.com/williamfzc/zcode-cli)) is the complete product reference.
3. **Produce**: establish contracts into `contracts/` by forensics first, then start a standalone project per §3.1
   and verify every command against the real running app.

**Completing the CLI for an established app**: go straight to §3.1 with `contracts/<app>-*.json` as the interface
source of truth; for new endpoints/domains use the §1.⑥ recipes.

## Safety (Plain Terms)

The targets are enterprise work apps, possibly within an audit scope, so:

- **Probing sends read requests only.** Write, delete, send, authorize, pair — not touched while establishing contracts.
- **Write interfaces may ship in the product CLI, but the user triggers them explicitly** — a write command in the
  CLI takes effect the moment it runs (same as clicking the button), so automation/agent autonomous flows must not
  call write commands on their own; IDs and resource numbers come only from real returns, never invented.
- **Authorization gates, device pairing, accepting agreements, batch operations are never automated commands** — a
  human clicks those in the real UI.
- The debug port is a local plaintext control plane (any local process can take over the logged-in session); close
  it when done.

## Repository Layout

```
PLAYBOOK.md      the general methodology (app-agnostic, the core asset)
profiles/        one facts sheet per target app (attachment, bridge surface, telemetry noise, measured pitfalls)
contracts/       verified interface contracts (endpoint, request body, response shape, evidence and verification status per command)
docs/            design docs, capability catalogs, exploration handoffs
tools/research/  bare-CDP forensic probes (zero-dependency .mjs) + evidence/ archives
cli/             methodology reference CLI (PLAYBOOK + contract samples packed via go:embed, readable offline by agents)
```
