---
type: Index
title: Agent-facing MCP Toolkit
description: Inspect candidate application surfaces and create, extend or update independent MCP services from verified contracts.
---

# MCP toolkit

This is shared generation/runtime tooling, not a ZCode product or an MCP wrapper around shell commands. It builds an
independent application service that owns one bounded CDP connection. Application-specific code belongs in reviewed
capability declarations and generated projects outside this repository.

Start with the single workflow in [MCP_PLAYBOOK.md](../../MCP_PLAYBOOK.md). Its first-service and maintenance sections
are also available through the CLI:

```sh
npm ci --ignore-scripts
node cli.mjs guide create
node cli.mjs guide extend
node cli.mjs --help
```

Run these commands from `tools/mcp/`. Node.js 22 or newer is required. Nothing here installs a global command, changes
an agent's configuration, or starts the desktop app automatically.

## Inspect before verifying

```sh
node cli.mjs inspect --app examples/zcode/app.json --page-size 30 --offset 0
```

The app must already expose its local debug endpoint. Inspection reads own-property descriptors, skips accessor getters,
and returns bounded, paginated candidate metadata. It does not execute candidate methods, infer side effects, or publish
tools. App-derived strings are marked as untrusted target content. Page ambiguity and unverified app versions stop the
operation. Follow the workflow to establish contracts; names alone are insufficient evidence.

The ZCode example is verified for 3.16.2; it is not a profile for other applications. For a CEF/WebView2 page without a
dedicated bridge, a manifest may use `bridge: "window"`; request-replay and DOM expressions still require their own
evidence and live verification.

## Create, extend and modify

```sh
node cli.mjs init /path/to/app-service \
  --app examples/zcode/app.json \
  --contract examples/zcode/locale.json \
  --contract examples/zcode/window.json
node cli.mjs check /path/to/app-service
node cli.mjs add /path/to/app-service --contract examples/zcode/desktop_activity.json
node cli.mjs update /path/to/app-service --contract /path/to/reverified-locale.json
```

Install locked dependencies in the generated directory, then give its `mcp-config.json` to a supporting client. The
generated README explains how to keep maintaining that project. Generated configs contain absolute local paths and
should be regenerated/edited after moving a project, not committed as universal settings.

`init` refuses non-empty destinations. `add` only adds new names; identical additions are no-ops. `update` changes
existing names using content-addressed files and a single index publication. Schema/read-write changes require an
intentional `--allow-breaking` update. Superseded files are removed after successful publication; a cleanup warning means
the new version is already published and names the remaining files, not that publication rolled back.

Batch validation or pre-publication failures preserve the old index. Legacy projects without an index first receive
an old-capabilities-only index. Interrupted unpublished files stay invisible. Writers use an exclusive project lock;
after a killed writer, confirm it has exited before removing its named `.cdp2mcp.lock` file. Never remove a live writer's
lock. An invalid manual update leaves the running service's last valid snapshot active and appears in
`service_diagnostics`; fix it before restarting, because a new process has no previous in-memory snapshot.

Each contract must explicitly declare `sideEffect: read|write`; writes are hidden and rejected unless the service starts
with `--allow-writes`. That switch does not replace user authorization for a business write. Adapter expressions are
trusted local code and receive input values as separate arguments, not interpolated JavaScript.

This maintenance interface applies to services produced with these app/contract formats. It does not automatically
rewrite arbitrary independently implemented MCP servers or migrate their unrelated handlers.

## Verify

```sh
npm test
npm run test:memory
```

Tests speak actual HTTP/WebSocket CDP and MCP stdio to controlled peers; they exercise errors, cancellation, version
identity, schema checks, bounded input/output, queued work, shutdown and live capability changes. They do not establish
that another real application's private interface is stable. The memory test warms the runtime, performs 5,000 calls,
reconnects 12 times and rebuilds capability validation 100 times, checking retained heap and resource counters.

For a verified, idle ZCode instance and an independently generated project:

```sh
node test/live.mjs --project=/absolute/path/to/app-service
node test/live.mjs --project=/absolute/path/to/app-service --lifecycle
```

The second command refreshes, quits and reopens ZCode. Do not use it while the app is doing work. Neither command sends
messages or modifies business records. Real-provider scope and sanitized measurements are archived in
[the ZCode evidence record](../research/evidence/2026-10-22-zcode-mcp/INDEX.md).
