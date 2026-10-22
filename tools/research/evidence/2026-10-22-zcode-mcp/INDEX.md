---
type: Index
title: ZCode MCP Generation and Maintenance Verification
description: Sanitized evidence for agent-led inspection, independent service generation, incremental addition and update, lifecycle recovery and bounded memory on ZCode 3.16.2.
---

# ZCode MCP verification — 2026-10-22

Target: local ZCode 3.16.2 on macOS; Electron 41 / Chromium 146. The app was operated only for read-only inspection and
service acceptance. No prompts were sent, sessions created, permissions granted, or business records modified. Generated
app products remain outside the repository. REA was studied as a reference; no REA code was executed or copied into the runtime.

## Records

| Record | What was actually measured |
| --- | --- |
| [inspection.json](./inspection.json) | Two descriptor-only pages, 131 candidate methods, explicit unverified status and own-data-property coverage |
| [live.json](./live.json) | Eight real-application checks through an actual MCP client, including creation, addition, update and lifecycle recovery |
| [memory.json](./memory.json) | Node/ws versions, 100 warm-up calls, 5,000 measured calls, 100 validator-registry rebuilds, 12 reconnects and resource counters |
| [verification.json](./verification.json) | Local gates, dependency audit and source-file fingerprints |

## Timeline and findings

1. Read the existing cdp2cli profile, contracts and reference CLI. Kept the historical 3.11.2 SSH contract unchanged;
   new MCP examples describe the separately observed 3.16.2 surface.
2. Used `inspect --app ... --page-size 100 --offset ...` on the real application. It returned 131 own data-property
   method candidates in two pages and skipped no accessors. The discovery operation did not call those candidate methods.
   Candidate names and descriptors were not promoted to verified tools automatically.
3. Generated a new independent service from the locale and window contracts, installed its locked dependencies and
   connected a real MCP stdio client. Both capabilities returned their declared shapes.
4. Added `desktop_activity` while that same service was running. The new tool appeared, its read succeeded, and locale
   and window reads still worked. Repeating the exact addition left the publication index unchanged.
5. Updated the existing locale adapter without changing its public schema or name. The running client observed the
   maintained declaration, the revised tool read succeeded and both other capabilities still worked. Only three current
   capability files remained; the superseded version was removed after index publication.
6. Ran 100 sequential locale reads and 12 simultaneous window reads. The service reused its connection, and pending
   requests, queued requests, active sessions and remote object groups were zero after completion.
7. Refreshed the real renderer, quit/reopened the real app and stopped the MCP service. Reads recovered after refresh
   and application restart; an offline app produced an explicit error; stopping MCP left the app running.
8. Ran the controlled-peer failure suite and retained-memory test. These use real HTTP/WebSocket and MCP protocols,
   but are not evidence of CEF/WebView2 or arbitrary third-party app compatibility.

### Version difference caught by live validation

`getDesktopSessionActivity()` in 3.16.2 returns `runningAgentSessionCount`. The older CLI record also described
`runningRepoWikiTaskCount`; that field was absent in the current live result. The first schema check rejected the
outdated assumption. The new example retains the actually returned count and does not synthesize the missing value.

### Negative setup result

An `open -a` launch returned success without leaving a usable debug endpoint during a final acceptance attempt. The
service correctly remained offline. The existing lifecycle CLI established a ready debug-enabled app. The real-app
test now waits for actual app-process exit before reopening; a closed debug port alone is not treated as proof that
the old single-instance launcher has exited. The runtime itself never restarts the user's application.

### Resource and dependency review

The local suite includes cancellation, late/oversized responses, stalled output readers, queue admission, result-schema
mismatch, wrong app/version, same-port loopback aliases, repeated updates and rejection of a catalog exceeding its
response budget. Excessive tiny fragments are rejected independently of the byte limit.

The dependency audit identified ws advisories for [fragment-induced memory exhaustion](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)
and [typed-array close-reason disclosure](https://github.com/advisories/GHSA-58qx-3vcg-4xpx). The toolkit locks ws 8.22.0,
configures fragment/buffer limits, and the subsequent production-dependency audit reported zero known vulnerabilities.

The stress test samples retained heap after collection, not just total process RSS. All temporary resource counters and
the capability cache are clear after shutdown. Heap/RSS need not return to their starting values because V8 and the
allocator retain reusable memory. These finite tests did not show unbounded growth in the exercised paths; they do not
establish multi-day behavior or absence of leaks inside an arbitrary application's own methods.

## Scope

Verified live: this installed ZCode version, descriptor inspection and three read capabilities. Verified with controlled
peers: general argument passing, no-dedicated-bridge expressions, update behavior and failure/resource paths. Not verified
live: other apps, Windows WebView2, business writes, long-running task cancellation, native system dialogs, or migration
of unrelated independently implemented MCP servers. The proposed page-state graph remains design-only.
