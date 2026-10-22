// Checks lifecycle, schemas and live capability changes against real local protocol peers.
// Controlled mock applications isolate failures without accessing user content.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { test, describe, before, after } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { AppConnection } from '../src/connection.mjs';
import { MockCdpServer, manifestFor } from './mock-cdp.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(packageRoot, 'server.mjs');

function contract(name = 'read_value', expression = 'async (args) => ({ value: 42 })', extra = {}) {
  return {
    name,
    description: `${name} test contract`,
    sideEffect: 'read',
    verification: { status: 'verified', appVersion: '1.0', date: '2026-10-22', evidence: ['mock'] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    execution: { kind: 'expression', expression, requiredMethods: ['readValue'] },
    ...extra,
  };
}

async function makeProject(mock, contracts = [contract()]) {
  const root = await mkdtemp(join(tmpdir(), 'cdp2mcp-'));
  await mkdir(join(root, 'contracts'));
  await writeFile(join(root, 'app.json'), JSON.stringify(manifestFor(mock), null, 2));
  for (const item of contracts) await writeFile(join(root, 'contracts', `${item.name}.json`), JSON.stringify(item, null, 2));
  return root;
}

async function putContract(project, item) {
  await writeFile(join(project, 'contracts', `${item.name}.json`), JSON.stringify(item, null, 2));
}

async function waitFor(check, timeout = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await wait(25);
  }
  throw new Error('Timed out waiting for condition');
}

async function directConnection(mock, overrides = {}) {
  const app = manifestFor(mock, overrides);
  return { app, connection: new AppConnection(app) };
}

async function startMcp(project, allowWrites = false) {
  const client = new Client({ name: 'cdp2mcp-tests', version: '1.0.0' }, { capabilities: {} });
  const args = [serverEntry, '--project', project];
  if (allowWrites) args.push('--allow-writes');
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: packageRoot });
  await client.connect(transport);
  return { client, transport };
}

function names(list) { return (list.tools ?? []).map(tool => tool.name); }
function valueOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.find(item => item.type === 'text')?.text;
  return text ? JSON.parse(text) : undefined;
}

describe('AppConnection against a real CDP HTTP/WebSocket peer', () => {
  let mock;
  before(async () => { mock = await new MockCdpServer().start(); });
  after(async () => { await mock.stop(); });

  test('discovers, attaches, evaluates the bridge, invokes the expression and releases the session', async () => {
    const { app, connection } = await directConnection(mock);
    const result = await connection.execute(contract(), {});
    assert.deepEqual(result, { value: 42 });
    const methods = mock.messages.map(message => message.method);
    assert.deepEqual(methods.slice(0, 7), [
      'Target.getTargets', 'Target.attachToTarget', 'Runtime.evaluate',
      'Runtime.evaluate', 'Runtime.callFunctionOn', 'Runtime.releaseObjectGroup',
      'Target.detachFromTarget',
    ]);
    assert.equal(mock.activeSessionCount, 0);
    assert.equal(mock.pending, 0);
    await connection.close();
  });

  test('validates a wrong returned schema as a protocol error and cleans up', async () => {
    const { connection } = await directConnection(mock);
    const bad = contract('wrong_value', 'async () => ({ value: "not-a-number" })');
    await assert.rejects(connection.execute(bad, {}), /schema|output|invalid|protocol/i);
    await waitFor(() => mock.activeSessionCount === 0);
    await connection.close();
  });

  test('does not let a missing bridge method destroy other verified capabilities', async () => {
    const { connection } = await directConnection(mock);
    const missing = contract('missing_method', 'async () => ({ value: 9 })', {
      execution: { kind: 'expression', expression: 'async () => ({ value: 9 })', requiredMethods: ['doesNotExist'] },
    });
    await assert.rejects(connection.execute(missing, {}), /capability|ready|method/i);
    assert.deepEqual(await connection.execute(contract(), {}), { value: 42 });
    await connection.close();
  });

  test('actively aborts an in-flight operation and releases the renderer', async () => {
    const { connection } = await directConnection(mock, {
      limits: { ...manifestFor(mock).limits, requestTimeoutMs: 1000 },
    });
    mock.setDelay(250, 'Runtime.callFunctionOn');
    mock.clearLogs();
    const controller = new AbortController();
    const operation = connection.execute(contract(), {}, { signal: controller.signal });
    await waitFor(() => mock.messages.some(message => message.method === 'Runtime.callFunctionOn'));
    controller.abort();
    await assert.rejects(operation, /cancel|abort|not replayed/i);
    mock.setDelay(0, 'Runtime.callFunctionOn');
    await waitFor(() => mock.activeSessionCount === 0 && mock.pending === 0);
    const diagnostics = connection.diagnostics();
    assert.equal(diagnostics.pendingRequests, 0);
    assert.equal(diagnostics.activeSessions, 0);
    assert.equal(diagnostics.activeObjectGroups, 0);
    await connection.close();
  });

  test('rejects an oversized renderer response and closes the debugger connection', async () => {
    const { connection } = await directConnection(mock, {
      limits: { ...manifestFor(mock).limits, maxResponseBytes: 1024 },
    });
    const large = contract('large_value', 'async () => ({ value: "x".repeat(2048) })', {
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    });
    await assert.rejects(connection.execute(large, {}), /size|large|limit|connection|closed|response/i);
    await waitFor(() => mock.activeSessionCount === 0 && mock.openConnectionCount === 0);
    assert.equal(connection.diagnostics().pendingRequests, 0);
    await connection.close();
  });

  test('rejects an unexpected application identity and an unsupported version', async () => {
    const wrongIdentity = await new MockCdpServer({ userAgent: 'OtherApp/1.0' }).start();
    try {
      const { connection } = await directConnection(wrongIdentity);
      const status = await connection.status();
      assert.equal(status.available, false);
      await connection.close();
    } finally { await wrongIdentity.stop(); }

    const wrongVersion = await new MockCdpServer({ userAgent: 'MockApp/2.0' }).start();
    try {
      const { connection } = await directConnection(wrongVersion);
      const status = await connection.status();
      assert.equal(status.available, false);
      await connection.close();
    } finally { await wrongVersion.stop(); }
  });

  test('passes hostile argument text by value without evaluating it as JavaScript', async () => {
    const { connection } = await directConnection(mock);
    const safe = contract('argument_length', 'async (args) => ({ value: args.value.length })', {
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    });
    const value = '`;globalThis.__injected = true; // ${process.exit()}';
    const result = await connection.execute(safe, { value });
    assert.deepEqual(result, { value: value.length });
    await connection.close();
  });

  test('closes the active socket and rejects active and queued work', async () => {
    const { connection } = await directConnection(mock, {
      limits: { ...manifestFor(mock).limits, requestTimeoutMs: 1000, maxQueue: 4 },
    });
    mock.setDelay(200, 'Runtime.callFunctionOn');
    const jobs = Array.from({ length: 4 }, (_, index) => connection.execute(contract(`close_${index}`), {}));
    await wait(20);
    await connection.close();
    const results = await Promise.allSettled(jobs);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(connection.diagnostics().pendingRequests, 0);
    assert.equal(connection.diagnostics().queuedRequests, 0);
    assert.equal(connection.diagnostics().activeRequests, 0);
    assert.equal(connection.diagnostics().activeSessions, 0);
    assert.equal(connection.diagnostics().activeObjectGroups, 0);
    mock.setDelay(0, 'Runtime.callFunctionOn');
  });

  test('times out an in-flight CDP request and leaves no session or pending request', async () => {
    const { connection } = await directConnection(mock, { limits: { ...manifestFor(mock).limits, requestTimeoutMs: 50 } });
    mock.setDelay(250, 'Runtime.callFunctionOn');
    await assert.rejects(connection.execute(contract(), {}), /timed out|timeout|abort/i);
    mock.setDelay(0, 'Runtime.callFunctionOn');
    await waitFor(() => mock.activeSessionCount === 0 && mock.openConnectionCount === 0 && mock.pending === 0);
    assert.equal(mock.pending, 0);
    await connection.close();
  });

  test('rejects excess work at the bounded queue and aborts queued work', async () => {
    const { connection } = await directConnection(mock, {
      limits: { ...manifestFor(mock).limits, requestTimeoutMs: 1000, maxQueue: 2 },
    });
    mock.setDelay(80, 'Runtime.callFunctionOn');
    const queuedAbort = new AbortController();
    const jobs = Array.from({ length: 7 }, (_, index) => connection.execute(contract(`read_${index}`), {}, {
      signal: index === 2 ? queuedAbort.signal : undefined,
    }));
    queuedAbort.abort();
    const results = await Promise.allSettled(jobs);
    mock.setDelay(0, 'Runtime.callFunctionOn');
    assert.ok(results.some(result => result.status === 'rejected' && /queue|abort|cancel/i.test(result.reason?.message ?? '')));
    assert.ok(results.filter(result => result.status === 'fulfilled').length >= 1);
    await waitFor(() => mock.activeSessionCount === 0 && mock.openConnectionCount === 0 && mock.pending === 0);
    await connection.close();
  });

  test('reports offline status and reconnects after the app returns', async () => {
    const { app, connection } = await directConnection(mock);
    const port = mock.port;
    await mock.stop();
    const offline = await connection.status();
    assert.equal(offline.available, false);
    mock.requestedPort = port;
    await mock.start();
    assert.equal(mock.port, port);
    const online = await connection.status();
    assert.equal(online.available, true);
    await connection.close();
  });
});

describe('MCP stdio server and dynamic contracts', () => {
  let mock;
  let project;
  let client;
  let transport;
  let listChanged = 0;

  before(async () => {
    mock = await new MockCdpServer().start();
    project = await makeProject(mock);
    ({ client, transport } = await startMcp(project));
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++; });
  });
  after(async () => {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    await rm(project, { recursive: true, force: true });
    await mock.stop();
  });

  test('exposes stable status tools and calls the verified contract', async () => {
    const listed = await client.listTools();
    assert.deepEqual(names(listed).sort(), ['app_status', 'read_value', 'service_diagnostics'].sort());
    const result = await client.callTool({ name: 'read_value', arguments: {} });
    assert.equal(result.isError, undefined);
    assert.deepEqual(valueOf(result), { value: 42 });
    const status = valueOf(await client.callTool({ name: 'app_status', arguments: {} }));
    assert.equal(status.available, true);
    const diagnostics = valueOf(await client.callTool({ name: 'service_diagnostics', arguments: {} }));
    assert.equal(typeof diagnostics.pendingRequests, 'number');
  });

  test('loads a new contract without breaking an old one and ignores an invalid addition', async () => {
    const double = contract('double_value', 'async (args) => ({ value: (args.value ?? 21) * 2 })', {
      inputSchema: { type: 'object', properties: { value: { type: 'number' } }, additionalProperties: false },
    });
    await putContract(project, double);
    const listed = await waitFor(async () => {
      const current = await client.listTools();
      return names(current).includes('double_value') ? current : undefined;
    });
    assert.ok(names(listed).includes('read_value'));
    await waitFor(() => listChanged > 0, 1000);
    assert.deepEqual(valueOf(await client.callTool({ name: 'double_value', arguments: { value: 9 } })), { value: 18 });
    await writeFile(join(project, 'contracts', 'invalid_contract.json'), JSON.stringify({
      ...contract('invalid_contract'), inputSchema: { type: 'definitely-not-a-schema' },
    }));
    await wait(100);
    const afterInvalid = await client.listTools();
    assert.ok(!names(afterInvalid).includes('invalid_contract'));
    const write = contract('write_value', 'async () => ({ value: 1 })', { sideEffect: 'write' });
    await putContract(project, write);
    await wait(100);
    const afterWrite = await client.listTools();
    assert.ok(!names(afterWrite).includes('write_value'));
    const disabledWrite = await client.callTool({ name: 'write_value', arguments: {} }).catch(() => ({ isError: true }));
    assert.equal(disabledWrite.isError, true);
    await rm(join(project, 'contracts', 'invalid_contract.json'), { force: true });
    await rm(join(project, 'contracts', 'invalid.json'), { force: true });
    await client.close();
    await transport.close().catch(() => {});
    ({ client, transport } = await startMcp(project, true));
    const withWrites = await waitFor(() => client.listTools().then(current => current));
    assert.ok(names(withWrites).includes('write_value'));
    assert.deepEqual(valueOf(await client.callTool({ name: 'write_value', arguments: {} })), { value: 1 });
    await writeFile(join(project, 'contracts', 'invalid.json'), '{ definitely not json');
    await wait(100);
    assert.deepEqual(valueOf(await client.callTool({ name: 'read_value', arguments: {} })), { value: 42 });
  });

  test('keeps the process usable after the application goes offline', async () => {
    const port = mock.port;
    await mock.stop();
    const result = await client.callTool({ name: 'read_value', arguments: {} });
    assert.equal(result.isError, true);
    const status = valueOf(await client.callTool({ name: 'app_status', arguments: {} }));
    assert.equal(status.available, false);
    mock.requestedPort = port;
    await mock.start();
    const recovered = await waitFor(async () => {
      const value = valueOf(await client.callTool({ name: 'read_value', arguments: {} }));
      return value?.value === 42 ? value : undefined;
    });
    assert.deepEqual(recovered, { value: 42 });
  });

  test('survives an MCP process restart with the same project', async () => {
    await rm(join(project, 'contracts', 'invalid_contract.json'), { force: true });
    await rm(join(project, 'contracts', 'invalid.json'), { force: true });
    await client.close();
    await transport.close().catch(() => {});
    ({ client, transport } = await startMcp(project));
    const listed = await client.listTools();
    assert.ok(names(listed).includes('read_value'));
    assert.deepEqual(valueOf(await client.callTool({ name: 'read_value', arguments: {} })), { value: 42 });
  });
});
