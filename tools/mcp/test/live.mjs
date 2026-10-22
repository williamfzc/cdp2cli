// Real ZCode acceptance test: generate first, then add a capability while MCP runs.
// Optional --lifecycle refreshes, quits and reopens the idle test application.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AppConnection } from '../src/connection.mjs';

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projectArg = process.argv.find(arg => arg.startsWith('--project='))?.slice(10);
if (!projectArg) throw new Error('Generate an independent service first, then pass --project=/absolute/path.');
const project = resolve(projectArg);
const checks = [];
const client = new Client({ name: 'cdp2mcp-live-check', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(project, 'server.mjs')] });
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return result.structuredContent;
}
async function check(name, fn) { const detail = await fn(); checks.push({ name, passed: true, ...(detail ? { detail } : {}) }); console.log(`PASS ${name}`); }
async function ready(available) {
  const end = Date.now() + 45000;
  let last;
  while (Date.now() < end) {
    const state = await call('app_status');
    last = state;
    if (state.available === available) return state;
    await wait(300);
  }
  throw new Error(`Application availability did not become ${available}: ${last?.reason ?? 'unknown'}`);
}
async function waitForAppExit() {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    try { await run('pgrep', ['-x', 'ZCode']); }
    catch (error) { if (error.code === 1) return; throw error; }
    await wait(100);
  }
  throw new Error('ZCode did not exit; refusing to force-kill it.');
}
try {
  await client.connect(transport);
  await ready(true);
  await check('Freshly generated standalone service reads real ZCode', async () => {
    assert.equal(typeof (await call('locale')).locale, 'string');
    assert.equal(typeof (await call('window')).maximized, 'boolean');
    return { version: (await call('app_status')).version };
  });
  await check('New capability is installed into the running service', async () => {
    await run(process.execPath, [join(root, 'cli.mjs'), 'add', project, '--contract', join(root, 'examples/zcode/desktop_activity.json')]);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert(names.includes('desktop_activity'));
    const activity = await call('desktop_activity');
    assert(Number.isInteger(activity.runningAgentSessionCount));
    await call('locale'); await call('window');
    return { capabilityNames: names, resultFields: Object.keys(activity) };
  });
  await check('Repeated addition changes nothing', async () => {
    const before = await readFile(join(project, 'capabilities.json'), 'utf8');
    const { stdout } = await run(process.execPath, [join(root, 'cli.mjs'), 'add', project, '--contract', join(root, 'examples/zcode/desktop_activity.json')]);
    assert.match(stdout, /no changes/);
    assert.equal(await readFile(join(project, 'capabilities.json'), 'utf8'), before);
  });
  await check('Existing capability is updated in the same running service', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'cdp2mcp-live-update-'));
    try {
      const original = JSON.parse(await readFile(join(root, 'examples/zcode/locale.json'), 'utf8'));
      original.description = 'Read the system language from ZCode (maintained adapter).';
      original.execution.expression = `async (args) => await (${original.execution.expression})(args)`;
      const source = join(temporary, 'locale.json');
      await writeFile(source, JSON.stringify(original));
      await run(process.execPath, [join(root, 'cli.mjs'), 'update', project, '--contract', source]);
      const tools = (await client.listTools()).tools;
      assert.equal(tools.find(t => t.name === 'locale').description, original.description);
      assert.equal(typeof (await call('locale')).locale, 'string');
      await call('window'); await call('desktop_activity');
      const files = await readdir(join(project, 'contracts'));
      assert.equal(files.length, 3);
      assert(files.some(name => /^locale--[a-f0-9]{16}\.json$/.test(name)));
      return { updated: 'locale', otherCapabilitiesStillWork: true, publishedFiles: files.length };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
  await check('One hundred reads and twelve simultaneous reads release temporary resources', async () => {
    const baseline = await call('service_diagnostics');
    for (let i = 0; i < 100; i++) await call('locale');
    const values = await Promise.all(Array.from({ length: 12 }, () => call('window')));
    assert(values.every(value => typeof value.maximized === 'boolean'));
    const after = await call('service_diagnostics');
    for (const key of ['pendingRequests', 'queuedRequests', 'activeRequests', 'activeSessions', 'activeObjectGroups']) assert.equal(after[key], 0, key);
    assert.equal(after.connections, baseline.connections);
    return { sequential: 100, concurrent: 12, remainingTemporaryResources: 0 };
  });
  if (process.argv.includes('--lifecycle')) {
    await check('Actual page reload is followed by successful reads', async () => {
      const app = JSON.parse(await readFile(join(project, 'app.json'), 'utf8'));
      const direct = new AppConnection(app);
      const signal = new AbortController().signal;
      try {
        await direct.ensure(signal);
        const { targetInfos } = await direct.call('Target.getTargets', {}, undefined, signal);
        const target = targetInfos.find(t => t.type === 'page' && !t.url.startsWith('devtools:'));
        const { sessionId } = await direct.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined, signal);
        await direct.call('Page.reload', {}, sessionId, signal);
      } finally { await direct.close(); }
      await wait(500); await ready(true); await call('locale'); await call('desktop_activity');
    });
    await check('Same MCP service survives app exit and restart', async () => {
      const before = await call('app_status');
      await run('osascript', ['-e', 'quit app "ZCode"'], { timeout: 25000 });
      await waitForAppExit();
      await ready(false);
      assert.equal((await client.callTool({ name: 'locale', arguments: {} })).isError, true);
      await run('open', ['-a', 'ZCode', '--args', '--remote-debugging-port=9227'], { timeout: 10000 });
      const after = await ready(true);
      assert(after.connections > before.connections);
      await call('locale'); await call('window'); await call('desktop_activity');
    });
  }
  await check('Stopping the MCP service leaves the application running', async () => {
    await client.close();
    assert((await fetch('http://127.0.0.1:9227/json/version', { signal: AbortSignal.timeout(2000) })).ok);
  });
  const reportFile = process.env.CDP2MCP_REPORT ?? join(root, 'live-verification.json');
  await writeFile(reportFile, JSON.stringify({ date: new Date().toISOString(), checks }, null, 2));
} finally { await client.close().catch(() => {}); await transport.close().catch(() => {}); }
