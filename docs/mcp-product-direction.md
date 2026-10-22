---
type: Concept
title: Agent-Facing MCP Product Direction
description: Product direction for cdp2cli's reusable MCP generation/runtime toolkit and the standalone services it creates for verified local desktop application capabilities.
---

# Agent-Facing MCP Product Direction

## Goal

cdp2cli should help an agent take a verified CEF, Electron, or WebView2 capability and turn it into a maintainable
standalone MCP service. The repository provides the workflow guide, evidence and contract conventions, and reusable
generation/runtime tooling. The generated service belongs to one application and is published outside this repository.

The product loop is:

```text
establish evidence → declare a capability → create a service → verify with the real app
                                          ↓
                                add or update → re-verify → publish atomically
```

The same loop must support the first service and later changes. A service should remain useful when its application
changes, while refusing an unverified or incompatible contract by default.

## Non-goals

- Do not put an app-specific CLI or generated service into this repository.
- Do not turn `inspect` into an automatic application graph builder.
- Do not treat method names, page text, or static candidates as verified capabilities.
- Do not automatically invoke unknown methods, guessed arguments, writes, authorization, pairing, installation,
  payment, login, or unattended batch operations.
- Do not rewrite an arbitrary existing MCP server without an explicit integration contract and lifecycle owner.
- Do not archive user conversations, credentials, or arbitrary page content as evidence.

The toolkit can expose bridge, request-replay, and DOM adapters through trusted local expressions. Those expressions are
part of the generated service's reviewed capability files; they are not a sandbox for model or website content.

## First service: `init`

The first service begins with an app manifest and at least one verified capability contract:

```sh
node tools/mcp/cli.mjs init <service-dir> \
  --app <app.json> \
  --contract <contract.json>
```

The manifest identifies the local debugging endpoint, application marker, target page filter, bridge path, supported
versions, and resource limits. `bridge: "window"` is valid for a CEF target with no dedicated bridge; it means that
the capability expression operates against the page global and does not prove that any method exists or is safe.

The capability contract records the name, description, input and output schemas, `sideEffect` (`read` or `write`),
trusted expression adapter, required bridge methods, app version, verification date, and evidence references.

`init` validates the complete batch and publishes a new independent service. It refuses a non-empty destination. The
generated service has its own `app.json`, `capabilities.json`, contracts, runtime files, package metadata, and README.

## New capability: `add`

Use `add` when the capability has a new name:

```sh
node tools/mcp/cli.mjs add <service-dir> \
  --contract <new-contract.json>
```

The agent must first discover and verify the capability against the running application. `add` then validates the full
existing and new set before publishing. It preserves the old set, treats identical repeats as no-ops, and rejects a
conflicting declaration with the same name. The capability index is the publication boundary, so an unlisted orphan
file is not visible to the running service.

## Existing capability change: `update`

Use `update` when the capability name remains the same:

```sh
node tools/mcp/cli.mjs update <service-dir> \
  --contract <updated-contract.json>
```

The default rejects changes to input schema, output schema, or `sideEffect`. These fields define what callers can rely
on and whether an operation can change the application. `--allow-breaking` is required for an intentional change after
the agent has recorded the reason, updated evidence, and completed real-app verification.

The update writes the new contract to a versioned file, validates the complete index, swaps the index once, and removes
the previous file only after publication succeeds. A failed update keeps the previous valid service and its index.
`update` does not add a new capability name; use `add` for that.

## Runtime contract

The generated service is a local MCP server for one app. It selects one matching page, checks the application identity
and supported version, checks required bridge methods, runs the trusted adapter expression with arguments kept
separate, validates the result, and returns structured MCP output.

The service defaults to read-only exposure. Write capabilities need an explicit service startup option and a verified
write contract. The service owns its debugger connections, renderer sessions, queues, timers, response buffers,
validators, and temporary state. It does not own the desktop application's process and must not silently restart it.

Every operation has bounded request and connection time, queue admission, idle connection lifetime, and response size.
Each renderer session and remote object group is released on success, timeout, cancellation, and failure. The service
does not automatically replay a business operation after a timeout or a disconnected client.

## Completion standard

A first or changed service is complete when:

1. `check` passes for the complete published project.
2. A real MCP client discovers the service and the expected tools.
3. Each new or changed capability has a real application verification record with the matching version.
4. Affected existing capabilities still pass their checks.
5. Schema, side-effect, page-selection, timeout, and contract-mismatch failures stop clearly.
6. The update is atomic and the old valid snapshot remains usable if validation or publication fails.
7. Resource cleanup is observed for normal completion, cancellation, application exit, and reconnect.
8. Evidence contains structure and verification facts without user content or credentials.

The current verifiable scope is the generated ZCode MCP service path and its recorded unit/CLI, memory, and live
verification lanes. Exact test counts are maintained in the evidence record rather than repeated here. The current
handoff is [`tools/research/evidence/2026-10-22-zcode-mcp/INDEX.md`](../tools/research/evidence/2026-10-22-zcode-mcp/INDEX.md).

This scope demonstrates the generation/runtime path for a verified application. It does not establish automatic support
for every CEF, Electron, or WebView2 application, complete application graphs, or arbitrary unknown writes.
