// Exercises agent discovery and ongoing modification against real local protocols.
// Uses controlled applications; no user data or real business writes are accessed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MockCdpServer, manifestFor } from './mock-cdp.mjs';
import { AppConnection } from '../src/connection.mjs';
import { initProject, addContracts, updateContracts } from '../cli.mjs';
import { Registry } from '../src/registry.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);
function contract(name = 'read_value', value = 42) {
  return { name, description: 'Read a controlled value.', sideEffect: 'read',
    verification: { status: 'verified', appVersion: '1.0', date: '2026-10-22', evidence: ['controlled application'] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false },
    execution: { kind: 'expression', expression: `async () => ({value:${value}})`, requiredMethods: ['readValue'] } };
}
const put = (file, value) => writeFile(file, JSON.stringify(value, null, 2));

test('agent guide comes from the canonical SOP and has focused create/extend views', async () => {
  const source = await readFile(path.join(root, '../../MCP_PLAYBOOK.md'), 'utf8');
  const all = await run(process.execPath, [path.join(root, 'cli.mjs'), 'guide', 'all']);
  assert.equal(all.stdout.trim(), source.trim());
  const create = await run(process.execPath, [path.join(root, 'cli.mjs'), 'guide', 'create']);
  const extend = await run(process.execPath, [path.join(root, 'cli.mjs'), 'guide', 'extend']);
  assert.match(create.stdout, /## Create a service/);
  assert.doesNotMatch(create.stdout, /## Extend or modify/);
  assert.match(extend.stdout, /## Extend or modify a service/);
  assert.match(extend.stdout, /--allow-breaking/);
});

test('CLI inspection pages candidate metadata without invoking application methods', async () => {
  const mock = await new MockCdpServer().start();
  const folder = await mkdtemp(path.join(tmpdir(), 'cdp2mcp-inspect-'));
  let calls = 0;
  mock.setBridge({ deleteEverything: () => { calls++; throw new Error('Must never run'); },
    getOther: () => { calls++; return 'must not read'; } });
  try {
    const appFile = path.join(folder, 'app.json');
    await put(appFile, manifestFor(mock));
    const pages = [];
    for (let offset = 0; offset < 3; offset++) {
      const { stdout } = await run(process.execPath, [path.join(root, 'cli.mjs'), 'inspect', '--app', appFile,
        '--page-size', '1', '--offset', String(offset)]);
      pages.push(JSON.parse(stdout));
    }
    assert.equal(calls, 0);
    assert(pages.every(p => p.methods.length === 1 && p.verification === 'unverified' && p.untrustedTargetContent));
    assert.equal(new Set(pages.map(p => p.methods[0].name)).size, 3);
    assert.equal(pages.at(-1).nextOffset, null);
    assert.equal(mock.activeSessionCount, 0);
  } finally { await mock.stop(); await rm(folder, { recursive: true, force: true }); }
});

test('localhost manifests accept a same-port numeric loopback debugger URL', async () => {
  const mock = await new MockCdpServer().start();
  const app = new AppConnection({ ...manifestFor(mock), endpoint: mock.endpoint.replace('127.0.0.1', 'localhost') });
  try { assert.deepEqual(await app.execute(contract(), {}), { value: 42 }); }
  finally { await app.close(); await mock.stop(); }
});

test('global-page adapters work without a dedicated application bridge', async () => {
  const mock = await new MockCdpServer().start();
  const app = new AppConnection({ ...manifestFor(mock), bridge: 'window' });
  const c = contract();
  c.execution.requiredMethods = [];
  c.execution.expression = 'async () => ({value: typeof window.mock === "object" ? 42 : 0})';
  try { assert.deepEqual(await app.execute(c, {}), { value: 42 }); }
  finally { await app.close(); await mock.stop(); }
});

test('excessive tiny WebSocket fragments are rejected even below the byte limit', async () => {
  const mock = await new MockCdpServer().start();
  mock.fragmentBytes = 1;
  const app = new AppConnection(manifestFor(mock, { limits: { ...manifestFor(mock).limits, requestTimeoutMs: 1000 } }));
  const c = contract();
  c.outputSchema.properties.value.type = 'string';
  c.execution.expression = 'async () => ({value: "x".repeat(1500)})';
  try {
    await assert.rejects(app.execute(c, {}), /limit|connection failed/);
    assert.equal(app.diagnostics().pendingRequests, 0);
    assert.equal(app.diagnostics().activeObjectGroups, 0);
  } finally { await app.close(); await mock.stop(); }
});

test('same running MCP process picks up versioned updates while other capabilities survive', async () => {
  const mock = await new MockCdpServer().start();
  const folder = await mkdtemp(path.join(tmpdir(), 'cdp2mcp-maintain-'));
  const project = path.join(folder, 'service');
  const client = new Client({ name: 'maintenance-test', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'server.mjs'), '--project', project] });
  try {
    const appFile = path.join(folder, 'app.json');
    const first = path.join(folder, 'first.json');
    const other = path.join(folder, 'other.json');
    await put(appFile, manifestFor(mock)); await put(first, contract()); await put(other, contract('other_value', 99));
    await initProject(project, appFile, [first]);
    await client.connect(transport);
    const value = async name => {
      const result = await client.callTool({ name, arguments: {} });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return result.structuredContent;
    };
    assert.deepEqual(await value('read_value'), { value: 42 });
    const overBudget = contract('large_catalog');
    overBudget.inputSchema.description = 'x'.repeat(32000);
    overBudget.outputSchema.description = 'x'.repeat(32000);
    const largeFile = path.join(folder, 'large.json');
    await put(largeFile, overBudget);
    await assert.rejects(addContracts(project, [largeFile]), /catalog.*budget/);
    assert.deepEqual(await value('read_value'), { value: 42 });
    await addContracts(project, [other]);
    for (let revision = 43; revision < 48; revision++) {
      await put(first, contract('read_value', revision));
      await updateContracts(project, [first]);
      assert.deepEqual(await value('read_value'), { value: revision });
      assert.deepEqual(await value('other_value'), { value: 99 });
      assert.equal((await readdir(path.join(project, 'contracts'))).length, 2);
    }
    const before = await readFile(path.join(project, 'capabilities.json'), 'utf8');
    const changed = contract('read_value', 100);
    changed.outputSchema.properties.value.type = 'string';
    await put(first, changed);
    await assert.rejects(updateContracts(project, [first]), /allow-breaking/);
    assert.equal(await readFile(path.join(project, 'capabilities.json'), 'utf8'), before);
    assert.deepEqual(await value('read_value'), { value: 47 });
    const registry = new Registry(project); await registry.refresh();
    assert.equal(registry.tools.size, 2);
  } finally { await client.close().catch(() => {}); await transport.close().catch(() => {});
    await mock.stop(); await rm(folder, { recursive: true, force: true }); }
});
