---
type: Concept
title: REA Design Notes for cdp2cli
description: Bounded design notes from REA's public workflow, contract, lifecycle, and MCP documentation, translated into cdp2cli decisions without importing REA's provider graph or implementation.
---

# REA Design Notes for cdp2cli

These notes record what cdp2cli adopts from [morluto/rea](https://github.com/morluto/rea) and what it deliberately
does not adopt. REA is a reference for agent-facing reverse-engineering workflows and MCP contract discipline. It is
not a dependency, provider, or source of app-specific capability data for cdp2cli.

## Sources

- [REA README](https://github.com/morluto/rea/blob/main/README.md) — local analysis, evidence-backed findings, and
  JavaScript/Electron coverage.
- [REA agent skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md) —
  target-first routing, summary-first analysis, retained evidence, and observation/unknown discipline.
- [MCP tool design](https://github.com/morluto/rea/blob/main/docs/tool-design.md) — tool shapes, strict contracts,
  lifecycle ownership, cleanup, cancellation, and resource budgeting.
- [MCP runtime contracts](https://github.com/morluto/rea/blob/main/docs/mcp-contracts.md) — evidence, paging, target
  scope, untrusted target content, cancellation, transport limits, and schema presentation.
- [Guided MCP prompts](https://github.com/morluto/rea/blob/main/docs/mcp-prompts.md) — provider-neutral prompt views
  and session-aware completion. REA's current repository has no `docs/prompts.md`; this is the corresponding file.
- [REA architecture](https://github.com/morluto/rea/blob/main/docs/architecture.mermaid) — a layered reference for
  separating contracts, application workflows, providers, process ownership, and tests.

## Adopted decisions

### 1. Start with the target and return a small useful view

REA routes an ASAR or extracted JavaScript tree to static application analysis and routes an already-running Electron
target to runtime observation. It starts large work with a summary and retains the complete source for later pages.

cdp2cli adopts the same order for MCP services:

1. Identify the app and the exact page or debugging target.
2. Return bounded metadata and method candidates from `inspect`.
3. Establish a capability through the existing read-first forensic method.
4. Generate, trace, compare, or modify only after a verified contract exists.

`inspect` in cdp2cli is deliberately narrower than REA's broader application analysis. It reports pagination metadata
and candidates; it does not execute unknown methods or claim a complete application graph.

### 2. Keep facts, inferences, and unknowns separate

REA keeps evidence identity, source locations, coverage, limitations, and unresolved questions alongside findings. This
fits cdp2cli's existing contract and evidence discipline. A capability candidate remains a candidate until its argument
source, side effect, return shape, and version are verified.

The generated service therefore publishes only verified contracts. Unresolved bridge calls, ambiguous pages, unsupported
runtime paths, and result-shape mismatches stop the workflow instead of becoming guessed MCP tools.

### 3. Prefer narrow primitives and explicit workflows

REA distinguishes inspect, search/list, trace, compare, workflow, and observe/capture shapes. cdp2cli adopts that
separation at the product boundary: discovery and inspection remain reusable, while `init`, `add`, and `update` are
explicit service-publication workflows. The runtime does not combine discovery, unknown execution, and mutation into a
single generic operation.

### 4. Make ownership and cleanup part of the result

REA treats target selection, readiness, active work, process exit, and resource release as separate facts. It retains
cleanup failures for retry and does not treat a client timeout as proof that application work stopped.

cdp2cli adopts this for debugger connections, renderer sessions, remote object groups, queues, timers, validators,
temporary files, and generated-service publication. Every operation releases its owned resources in success, timeout,
cancellation, reconnect, and application-exit paths. The service never claims to own the desktop application process.

### 5. Enforce memory and transport bounds before expensive work

REA's documented approach is to measure and bound the whole result path: response framing, structured and text forms,
retained evidence, paging, serialization expansion, temporary files, and concurrent work. It returns a resource-limit
result before constructing an oversized response and preserves the complete record for a later view or export.

cdp2cli adopts the principle, not REA's numeric limits. App manifests carry request, connection, queue, idle, and
response limits. The MCP runtime must enforce them before unbounded parsing or serialization, page large metadata, and
release renderer objects after each call. The generated service must not retain request/result history indefinitely.

### 6. Mark target content as untrusted data

REA marks scripts, page text, decompiled output, logs, captures, and file listings as target-derived content that may
contain fake instructions. cdp2cli adopts the same boundary: application content can describe a capability but cannot
authorize a tool call, alter service files, or override the workflow.

## Not adopted

### REA's broad provider and evidence graph

REA supports many native, managed, browser, firmware, mobile, and artifact providers. cdp2cli stays focused on
CEF/Electron/WebView2 attachment, bridge/request-replay/DOM adapters, verified contracts, and standalone product
generation. We do not copy REA's provider registry, deep binary sessions, or broad application graph into this repo.

### Automatic reverse engineering of unknown applications

REA's workflow is a useful reference for agent investigation, but cdp2cli does not promise that an unknown application
can be fully decomposed or safely written without an evidence and verification pass. Static names, a `window` object,
or a method-shaped candidate are insufficient.

### REA's retained Evidence ledger and bundle protocol

cdp2cli keeps its existing profile, contract, probe, and evidence archive formats. It may use stable evidence paths and
pagination metadata, but it does not import REA's Evidence IDs, bundle schemas, provider snapshots, or session protocol.

### REA's server-wide transport and schema profiles

REA documents provider-specific response budgets, compact schema profiles, and HTTP session behavior. cdp2cli adopts the
underlying bounded-result principle, while keeping the generated service's smaller local limits and schemas. Exact
implementation limits belong to the toolkit and its verification records, not this research note.

## cdp2cli boundary

REA helps answer how an agent should investigate and report uncertain findings. cdp2cli answers how verified findings
become a standalone CLI or MCP service and how that service changes safely over time. The dividing line is deliberate:

```text
REA reference discipline → cdp2cli evidence and verification → standalone app service
```

The current cdp2cli MCP evidence handoff is [`tools/research/evidence/2026-10-22-zcode-mcp/INDEX.md`](../tools/research/evidence/2026-10-22-zcode-mcp/INDEX.md).
