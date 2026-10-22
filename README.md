---
type: Index
title: cdp2cli Agent Workflow and MCP Toolkit
description: Guide agents from desktop-app discovery and verification to independently maintained CLI and MCP products.
---

# cdp2cli

> Give an agent a repeatable way to turn a CEF / Electron / WebView2 application into a standalone CLI or MCP service.
> Attach over CDP, discover what the app actually exposes, establish safe interface contracts, and keep the generated
> service maintainable as the app changes.

**This repository is an agent-facing workflow guide and reusable toolkit, not an app-specific product.** It produces four things:

1. **The general method** ([PLAYBOOK.md](./PLAYBOOK.md)) — how to attach, how to discover capabilities, how to split read/write, how to verify. App-agnostic.
2. **Per-app facts** ([profiles/](./profiles/), [contracts/](./contracts/), [tools/research/](./tools/research/)) — what an app looks like, which interfaces are verified, what the request/response contracts are, the forensic process and evidence.
3. **The reusable MCP toolkit** ([`tools/mcp/`](./tools/mcp/)) — initialize an independent service from verified app
   and capability declarations, then check, add, and update capabilities without silently replacing a valid service.
4. **The basis for spinning off products** — from these facts, build one **standalone, installable, directly usable
   CLI or MCP service** per app.

## The Two-Layer Model

```
cdp2cli (this repo)                     spun-off product (standalone project)
─────────────────────              ──────────────────────────
PLAYBOOK      general method        single app, single-file binary
MCP_PLAYBOOK  one MCP service SOP    generated MCP service with its own files
profiles/     app facts             self-managed lifecycle (start launches the app)
contracts/    verified contracts  ──►    executes read/write commands directly
tools/mcp/    reusable MCP toolkit  ──►    service generation and runtime
tools/research/ forensic probes + evidence
docs/         design & retrospectives
```

- **cdp2cli answers**: "What is the target app's capability surface? What can be read, what written? What do the
  arguments and returns look like? How do you stay safe?"
- **The spun-off product answers**: "Give me a `xxx <domain> list`, `xxx <domain> delete <id>`, or an MCP tool that
  an agent can call — a standalone service that just works for this app."

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
- **Page-state graph direction**: from a "fixed command tree" toward a contextual page-state graph (`inspect` / `help` /
  `act`) — currently design only, see [docs/page-state-graph-design.md](./docs/page-state-graph-design.md).
- **MCP workflow (implemented)**: the reusable toolkit provides the first-service and ongoing capability workflow; the generated
  service is always a separate app-specific project. `inspect` is metadata-only and paginated; it does not turn
  unknown methods into usable capabilities or implement the proposed page-state graph. ZCode 3.16.2 discovery,
  generation, addition and update were checked against the real app; see the [verification record](./tools/research/evidence/2026-10-22-zcode-mcp/INDEX.md).

## Start here (for agents)

A new agent needs nothing else: with this repo alone it can investigate a CEF/Electron/WebView2 desktop app and choose
the CLI or MCP product route. Walk it:

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
3. **For an MCP service**, read [MCP_PLAYBOOK.md](./MCP_PLAYBOOK.md). It is the single SOP for first creation and
   ongoing capability changes. The compact entry points are:

   ```sh
   npm --prefix tools/mcp ci --ignore-scripts
   node tools/mcp/cli.mjs guide create
   node tools/mcp/cli.mjs guide extend
   node tools/mcp/cli.mjs inspect --app app.json --page-size 32 --offset 0
   node tools/mcp/cli.mjs init <service-dir> --app app.json --contract <contract.json>
   node tools/mcp/cli.mjs check <service-dir>
   node tools/mcp/cli.mjs add <service-dir> --contract <contract.json>
   node tools/mcp/cli.mjs update <service-dir> --contract <updated-contract.json>
   ```

   `inspect` reports paginated metadata and method candidates only. A candidate is not a verified capability and
   does not execute unknown methods. Read [MCP_PLAYBOOK.md](./MCP_PLAYBOOK.md) before generating or changing a service.
4. **Produce**: establish contracts into `contracts/` by forensics first, then start a standalone project per §3.1
   or an MCP service per [MCP_PLAYBOOK.md](./MCP_PLAYBOOK.md), and verify every command or capability against the
   real running app.

**Completing a CLI for an established app**: go straight to §3.1 with `contracts/<app>-*.json` as the interface
source of truth. **Creating or extending an MCP service**: use `MCP_PLAYBOOK.md`; `init` creates the first
standalone service, `add` publishes new verified capabilities, and `update` changes an existing name only after
compatibility checks. For new endpoints/domains use the §1.⑥ recipes.

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
MCP_PLAYBOOK.md  one agent SOP for creating and extending standalone MCP services
profiles/        one facts sheet per target app (attachment, bridge surface, telemetry noise, measured pitfalls)
contracts/       verified interface contracts (endpoint, request body, response shape, evidence and verification status per command)
docs/            design docs, capability catalogs, exploration handoffs
tools/research/  bare-CDP forensic probes (zero-dependency .mjs) + evidence/ archives
tools/mcp/       reusable MCP generation/runtime toolkit; generated services stay outside this repo
cli/             methodology reference CLI (PLAYBOOK + contract samples packed via go:embed, readable offline by agents)
```
