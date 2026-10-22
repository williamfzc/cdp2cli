// Measures retained heap across calls, reconnects and validation-registry changes.
// Verifies bounded ownership after each batch and final shutdown.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { AppConnection } from '../src/connection.mjs';
import { Registry } from '../src/registry.mjs';
import { MockCdpServer, manifestFor } from './mock-cdp.mjs';

const contract = {
  name: 'read_value',
  description: 'bounded-memory read',
  sideEffect: 'read',
  verification: { status: 'verified', appVersion: '1.0', date: '2026-10-22', evidence: ['mock'] },
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
  execution: { kind: 'expression', expression: 'async () => ({ value: 42 })', requiredMethods: ['readValue'] },
};

function sample(connection, label) {
  global.gc();
  const memory = process.memoryUsage();
  return { label, heapUsed: memory.heapUsed, rss: memory.rss, diagnostics: connection.diagnostics() };
}

test('repeated calls and reconnects have bounded retained heap', { skip: typeof global.gc !== 'function' }, async () => {
  const mock = await new MockCdpServer().start();
  const connection = new AppConnection(manifestFor(mock, {
    limits: { ...manifestFor(mock).limits, requestTimeoutMs: 1000, maxQueue: 8 },
  }));
  const samples = [];
  let failure;
  const registrySamples = [];
  let registryRoot;
  try {
    // Warm up module caches and the first WebSocket connection before sampling.
    for (let index = 0; index < 100; index++) await connection.execute(contract, {});
    mock.clearLogs();
    samples.push(sample(connection, 'warmup'));
    for (let batch = 0; batch < 5; batch++) {
      for (let index = 0; index < 1000; index++) {
        const result = await connection.execute(contract, {});
        assert.equal(result.value, 42);
      }
      mock.clearLogs();
      await wait(10);
      samples.push(sample(connection, `batch-${batch + 1}`));
      const diagnostics = connection.diagnostics();
      assert.equal(diagnostics.pendingRequests, 0);
      assert.equal(diagnostics.queuedRequests, 0);
      assert.equal(diagnostics.activeRequests, 0);
      assert.equal(diagnostics.activeSessions, 0);
      assert.equal(diagnostics.activeObjectGroups, 0);
      const listeners = connection.socket ? connection.socket.eventNames().reduce((total, event) => total + connection.socket.listenerCount(event), 0) : 0;
      assert.ok(listeners <= 8, `unexpectedly many WebSocket listeners: ${listeners}`);
    }
    const baseline = samples[0].heapUsed;
    const afterCalls = samples.at(-1).heapUsed;
    assert.ok(afterCalls - baseline < 16 * 1024 * 1024, `retained heap grew ${(afterCalls - baseline) / 1024 / 1024} MiB after 5000 calls`);

    // Rebuild one live registry entry 100 times in this same process. Each
    // update changes metadata and schema descriptions, so the registry must
    // replace its compiled snapshot without retaining every historical AJV
    // validator.
    registryRoot = await mkdtemp(join(tmpdir(), 'cdp2mcp-registry-'));
    await mkdir(join(registryRoot, 'contracts'));
    await writeFile(join(registryRoot, 'app.json'), `${JSON.stringify(manifestFor(mock), null, 2)}\n`);
    await writeFile(join(registryRoot, 'capabilities.json'), `${JSON.stringify({ files: ['read_value.json'] }, null, 2)}\n`);
    const registryContract = revision => ({ ...contract,
      description: `revision ${revision}`,
      outputSchema: { ...contract.outputSchema, description: `schema revision ${revision}` },
    });
    await writeFile(join(registryRoot, 'contracts', 'read_value.json'), `${JSON.stringify(registryContract(0), null, 2)}\n`);
    const registry = new Registry(registryRoot);
    await registry.refresh();
    assert.equal(registry.tools.size, 1);
    for (let revision = 1; revision <= 100; revision++) {
      await writeFile(join(registryRoot, 'contracts', 'read_value.json'), `${JSON.stringify(registryContract(revision), null, 2)}\n`);
      await registry.refresh();
      assert.equal(registry.tools.size, 1);
      if (revision % 20 === 0) registrySamples.push(sample(connection, `registry-${revision}`));
    }
    const registryGrowth = registrySamples.at(-1).heapUsed - registrySamples[0].heapUsed;
    assert.ok(registryGrowth < 8 * 1024 * 1024, `registry heap grew ${registryGrowth / 1024 / 1024} MiB across 100 refreshes`);

    const port = mock.port;
    for (let loop = 0; loop < 12; loop++) {
      await mock.stop();
      await mock.waitForClose();
      mock.requestedPort = port;
      await mock.start();
      const result = await connection.execute(contract, {});
      assert.equal(result.value, 42);
      const diagnostics = connection.diagnostics();
      assert.equal(diagnostics.activeSessions, 0);
      assert.equal(diagnostics.activeObjectGroups, 0);
      assert.equal(diagnostics.pendingRequests, 0);
    }
    samples.push(sample(connection, 'after-reconnects'));
    const afterReconnects = samples.at(-1).heapUsed;
    assert.ok(afterReconnects - baseline < 20 * 1024 * 1024, `retained heap grew ${(afterReconnects - baseline) / 1024 / 1024} MiB after reconnects`);
  } catch (error) {
    failure = error;
  } finally {
    await connection.close().catch(error => { failure ??= error; });
    await mock.waitForClose();
    await mock.stop().catch(error => { failure ??= error; });
    samples.push(sample(connection, 'final'));
    const finalDiagnostics = connection.diagnostics();
    assert.equal(finalDiagnostics.pendingRequests, 0);
    assert.equal(finalDiagnostics.queuedRequests, 0);
    assert.equal(finalDiagnostics.activeRequests, 0);
    assert.equal(finalDiagnostics.activeSessions, 0);
    assert.equal(finalDiagnostics.activeObjectGroups, 0);
    assert.equal(mock.activeSessionCount, 0);
    assert.equal(mock.pending, 0);
    const reportPath = process.env.CDP2MCP_REPORT;
    if (registryRoot) await rm(registryRoot, { recursive: true, force: true }).catch(error => { failure ??= error; });
    if (reportPath) await writeFile(reportPath, `${JSON.stringify({ runtime: {node: process.version, ws: createRequire(import.meta.url)('ws/package.json').version}, samples, registrySamples, calls: 5100, reconnects: 12, registryRefreshes: 100 }, null, 2)}\n`);
  }
  if (failure) throw failure;
});
