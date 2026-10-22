// Exercises first-service generation and atomic incremental maintenance through the CLI.
// Uses isolated projects and never starts a desktop application.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_SOURCE = await readFile(join(ROOT, 'cli.mjs'), 'utf8');
const APP = {
  name: 'zcode', endpoint: 'http://127.0.0.1:9227', userAgentIncludes: 'ZCode/', targetUrlIncludes: '', bridge: 'window.zcode',
  limits: { requestTimeoutMs: 5000, connectTimeoutMs: 3000, maxQueue: 32, idleTimeoutMs: 30000, maxResponseBytes: 1048576 },
  supportedVersions: ['3.16.2'],
};

function contract(name, expression = '(async (args) => ({locale: await window.zcode.getSystemLocale()}))') {
  return {
    name, description: `Read ${name}.`, sideEffect: 'read',
    verification: { status: 'verified', appVersion: '3.16.2', date: '2026-10-22', evidence: ['offline test fixture'] },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { locale: { type: 'string', minLength: 1 } }, required: ['locale'], additionalProperties: false },
    execution: { kind: 'expression', expression, requiredMethods: ['getSystemLocale'] },
  };
}

async function command(toolRoot, args) {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [join(toolRoot, 'cli.mjs'), ...args], { cwd: toolRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'cdp2mcp-cli-'));
  await writeFile(join(root, 'cli.mjs'), CLI_SOURCE, { mode: 0o755 });
  await writeFile(join(root, 'server.mjs'), 'export {};\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'package-lock.json'), '{"name":"fixture","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"fixture","version":"1.0.0","bin":{"fixture":"cli.mjs"},"scripts":{"test":"node --test"}}}}\n');
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'project-files.mjs'), await readFile(join(ROOT, 'src', 'project-files.mjs')));
  await writeFile(join(root, 'src', 'registry.mjs'), `
export function validateProject(app, contracts) {
  if (app?.name !== 'zcode' || !Array.isArray(contracts) || contracts.length < 1) throw new Error('bad fixture');
  for (const contract of contracts) {
    if (!contract.execution?.expression?.includes('window.zcode')) throw new Error('bad expression');
  }
  return { app, contracts };
}
`);
  return root;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

test('init creates an independent project and check validates it', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const locale = join(input, 'locale.json');
  const window = join(input, 'window.json');
  await writeJson(app, APP);
  await writeJson(locale, contract('locale'));
  await writeJson(window, contract('window', '(async (args) => ({locale: await window.zcode.getSystemLocale()}))'));
  const destination = join(root, 'project');
  const created = await command(root, ['init', destination, '--app', app, '--contract', locale, '--contract', window]);
  assert.equal(created.code, 0, created.stderr);
  for (const path of ['src/registry.mjs', 'server.mjs', 'package.json', 'package-lock.json', 'README.md', 'mcp-config.json', 'app.json', 'capabilities.json', 'contracts/locale.json', 'contracts/window.json']) {
    await stat(join(destination, path));
  }
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'app.json'))), APP);
  const generatedPackage = JSON.parse(await readFile(join(destination, 'package.json')));
  assert.deepEqual(Object.keys(generatedPackage.scripts), ['start']);
  assert.equal(generatedPackage.bin, undefined);
  const generatedLock = JSON.parse(await readFile(join(destination, 'package-lock.json')));
  assert.equal(generatedLock.packages[''].bin, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'capabilities.json'))), { files: ['locale.json', 'window.json'] });
  const mcpConfig = JSON.parse(await readFile(join(destination, 'mcp-config.json')));
  assert.equal(mcpConfig.mcpServers.zcode.command, process.execPath);
  assert.deepEqual(mcpConfig.mcpServers.zcode.args, [join(destination, 'server.mjs')]);
  assert.match(await readFile(join(destination, 'README.md'), 'utf8'), /npm ci|node server\.mjs|cli\.mjs add|cli\.mjs update/);
  const checked = await command(root, ['check', destination]);
  assert.equal(checked.code, 0, checked.stderr);
  assert.match(checked.stdout, /valid: 2 contract/);
});

test('add is a no-op for identical contracts', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const locale = join(input, 'locale.json');
  await writeJson(app, APP);
  await writeJson(locale, contract('locale'));
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', locale])).code, 0);
  const before = await readFile(join(destination, 'contracts/locale.json'), 'utf8');
  const result = await command(root, ['add', destination, '--contract', locale, '--contract', locale]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /no changes/);
  assert.equal(await readFile(join(destination, 'contracts/locale.json'), 'utf8'), before);
  assert.deepEqual(await readdir(join(destination, 'contracts')), ['locale.json']);
});

test('a conflicting batch is rejected without partial changes', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const locale = join(input, 'locale.json');
  const newContract = join(input, 'new.json');
  const conflict = join(input, 'conflict.json');
  await writeJson(app, APP);
  await writeJson(locale, contract('locale'));
  await writeJson(newContract, contract('new_contract'));
  await writeJson(conflict, { ...contract('locale'), description: 'different' });
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', locale])).code, 0);
  const result = await command(root, ['add', destination, '--contract', newContract, '--contract', conflict]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /already exists with different content/);
  await assert.rejects(stat(join(destination, 'contracts/new_contract.json')));
  assert.deepEqual(await readdir(join(destination, 'contracts')), ['locale.json']);
});

test('init rejects path-shaped names and non-empty destinations', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const bad = join(input, 'bad.json');
  await writeJson(app, APP);
  await writeJson(bad, { ...contract('../escape') });
  const result = await command(root, ['init', join(root, 'project'), '--app', app, '--contract', bad]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /simple file name/);
  await assert.rejects(stat(join(root, 'escape.json')));

  const destination = join(root, 'occupied');
  const marker = join(destination, 'keep.txt');
  await mkdir(destination);
  await writeFile(marker, 'keep');
  const valid = join(input, 'valid.json');
  await writeJson(valid, contract('valid'));
  const occupied = await command(root, ['init', destination, '--app', app, '--contract', valid]);
  assert.notEqual(occupied.code, 0);
  assert.match(occupied.stderr, /not empty/);
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});

test('indexed projects hide orphan contract files until they are added', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  const orphan = join(input, 'orphan.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  await writeJson(orphan, contract('orphan'));
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed])).code, 0);
  await writeFile(join(destination, 'contracts/orphan.json'), await readFile(orphan));
  const hidden = await command(root, ['check', destination]);
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.match(hidden.stdout, /valid: 1 contract/);
  const added = await command(root, ['add', destination, '--contract', orphan]);
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'capabilities.json'))), { files: ['seed.json', 'orphan.json'] });
  const visible = await command(root, ['check', destination]);
  assert.equal(visible.code, 0, visible.stderr);
  assert.match(visible.stdout, /valid: 2 contract/);
});

test('add builds an index for a legacy project without one', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  const next = join(input, 'next.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  await writeJson(next, contract('next'));
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed])).code, 0);
  await rm(join(destination, 'capabilities.json'));
  const added = await command(root, ['add', destination, '--contract', next]);
  assert.equal(added.code, 0, added.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'capabilities.json'))), { files: ['seed.json', 'next.json'] });
});

test('legacy migration publishes old index before a failed new-file write', async (t) => {
  const root = await makeFixture();
  t.after(async () => {
    await chmod(join(root, 'project/contracts'), 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  const next = join(input, 'next.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  await writeJson(next, contract('next'));
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed])).code, 0);
  await rm(join(destination, 'capabilities.json'));
  await chmod(join(destination, 'contracts'), 0o555);
  const result = await command(root, ['add', destination, '--contract', next]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /EACCES|permission|denied|read-only/i);
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'capabilities.json'))), { files: ['seed.json'] });
  const check = await command(root, ['check', destination]);
  assert.equal(check.code, 0, check.stderr);
  assert.match(check.stdout, /valid: 1 contract/);
});

test('failed init keeps a pre-existing empty directory empty', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const bad = join(input, 'bad.json');
  const destination = join(root, 'empty');
  await writeJson(app, APP);
  await writeJson(bad, { ...contract('../bad') });
  await mkdir(destination);
  const result = await command(root, ['init', destination, '--app', app, '--contract', bad]);
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(destination), []);
});

test('generator rejects runtime-only switches', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await command(root, ['--allow-writes']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unknown command|unknown option/);
});

test('init and add reject more than 128 contracts before reading them', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  const missing = join(input, 'does-not-exist.json');
  const repeated = Array.from({ length: 129 }, () => ['--contract', missing]).flat();
  const init = await command(root, ['init', join(root, 'too-many'), '--app', app, ...repeated]);
  assert.notEqual(init.code, 0);
  assert.match(init.stderr, /too many contracts/);
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed])).code, 0);
  const add = await command(root, ['add', destination, ...repeated]);
  assert.notEqual(add.code, 0);
  assert.match(add.stderr, /too many contracts/);
  const update = await command(root, ['update', destination, ...repeated]);
  assert.notEqual(update.code, 0);
  assert.match(update.stderr, /too many contracts/);
});

test('concurrent adds keep both updates', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  const first = join(input, 'first.json');
  const second = join(input, 'second.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  await writeJson(first, contract('first'));
  await writeJson(second, contract('second'));
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed])).code, 0);
  const results = await Promise.all([
    command(root, ['add', destination, '--contract', first]),
    command(root, ['add', destination, '--contract', second]),
  ]);
  assert.deepEqual(results.map(result => result.code), [0, 0]);
  assert.deepEqual((await readdir(join(destination, 'contracts'))).sort(), ['first.json', 'second.json', 'seed.json']);
});

test('concurrent init publishes only one complete project', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const first = join(input, 'first.json');
  const second = join(input, 'second.json');
  await writeJson(app, APP);
  await writeJson(first, contract('first'));
  await writeJson(second, contract('second'));
  const destination = join(root, 'project');
  const results = await Promise.all([
    command(root, ['init', destination, '--app', app, '--contract', first]),
    command(root, ['init', destination, '--app', app, '--contract', second]),
  ]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  const check = await command(root, ['check', destination]);
  assert.equal(check.code, 0, check.stderr);
  const index = JSON.parse(await readFile(join(destination, 'capabilities.json')));
  assert.equal(index.files.length, 1);
  assert.match(index.files[0], /^(first|second)\.json$/);
  assert.deepEqual((await readdir(join(destination, 'contracts'))).sort(), index.files);
});

test('update publishes hashed versions, keeps other abilities, and add recognizes the new version', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  const other = join(input, 'other.json');
  const changed = join(input, 'changed.json');
  const changedAgain = join(input, 'changed-again.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  await writeJson(other, contract('other'));
  await writeJson(changed, { ...contract('seed'), description: 'Updated once.' });
  await writeJson(changedAgain, { ...contract('seed'), description: 'Updated twice.' });
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed, '--contract', other])).code, 0);

  const first = await command(root, ['update', destination, '--contract', changed]);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /update complete: 1 contract/);
  const firstIndex = JSON.parse(await readFile(join(destination, 'capabilities.json')));
  const firstVersion = firstIndex.files.find((file) => file.startsWith('seed--'));
  assert.match(firstVersion, /^seed--[0-9a-f]{16}\.json$/);
  assert.deepEqual(firstIndex.files.filter((file) => file.startsWith('other')), ['other.json']);
  await assert.rejects(stat(join(destination, 'contracts/seed.json')));
  await stat(join(destination, 'contracts', firstVersion));
  assert.equal((await command(root, ['add', destination, '--contract', changed])).stdout.includes('no changes'), true);
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'capabilities.json'))), firstIndex);

  const second = await command(root, ['update', destination, '--contract', changedAgain]);
  assert.equal(second.code, 0, second.stderr);
  const secondIndex = JSON.parse(await readFile(join(destination, 'capabilities.json')));
  const secondVersion = secondIndex.files.find((file) => file.startsWith('seed--'));
  assert.match(secondVersion, /^seed--[0-9a-f]{16}\.json$/);
  assert.notEqual(secondVersion, firstVersion);
  await assert.rejects(stat(join(destination, 'contracts', firstVersion)));
  await stat(join(destination, 'contracts', secondVersion));
  assert.deepEqual((await readdir(join(destination, 'contracts'))).sort(), ['other.json', secondVersion].sort());
  assert.equal((await command(root, ['check', destination])).code, 0);
});

test('update validates the whole batch and preserves the old index on rejection', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  const other = join(input, 'other.json');
  const changed = join(input, 'changed.json');
  const unknown = join(input, 'unknown.json');
  const invalid = join(input, 'invalid.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  await writeJson(other, contract('other'));
  await writeJson(changed, { ...contract('seed'), description: 'Should not publish.' });
  await writeJson(unknown, contract('new_name'));
  await writeJson(invalid, { ...contract('seed'), description: 'Bad expression', execution: { ...contract('seed').execution, expression: '(async () => 1)' } });
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed, '--contract', other])).code, 0);
  const before = await readFile(join(destination, 'capabilities.json'), 'utf8');

  const unknownResult = await command(root, ['update', destination, '--contract', changed, '--contract', unknown]);
  assert.notEqual(unknownResult.code, 0);
  assert.match(unknownResult.stderr, /cannot introduce new contract.*use add/);
  assert.equal(await readFile(join(destination, 'capabilities.json'), 'utf8'), before);
  assert.deepEqual((await readdir(join(destination, 'contracts'))).sort(), ['other.json', 'seed.json']);

  const invalidResult = await command(root, ['update', destination, '--contract', changed, '--contract', invalid]);
  assert.notEqual(invalidResult.code, 0);
  assert.match(invalidResult.stderr, /conflicting contracts|project validation failed/);
  assert.equal(await readFile(join(destination, 'capabilities.json'), 'utf8'), before);
  assert.deepEqual((await readdir(join(destination, 'contracts'))).sort(), ['other.json', 'seed.json']);
});

test('update guards shape changes unless explicitly allowed', async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await mkdtemp(join(root, 'inputs-'));
  const app = join(input, 'app.json');
  const seed = join(input, 'seed.json');
  const breaking = join(input, 'breaking.json');
  await writeJson(app, APP);
  await writeJson(seed, contract('seed'));
  await writeJson(breaking, { ...contract('seed'), sideEffect: 'write' });
  const destination = join(root, 'project');
  assert.equal((await command(root, ['init', destination, '--app', app, '--contract', seed])).code, 0);
  const rejected = await command(root, ['update', destination, '--contract', breaking]);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /requires --allow-breaking/);
  const allowed = await command(root, ['update', destination, '--contract', breaking, '--allow-breaking']);
  assert.equal(allowed.code, 0, allowed.stderr);
  const index = JSON.parse(await readFile(join(destination, 'capabilities.json')));
  assert.match(index.files[0], /^seed--[0-9a-f]{16}\.json$/);
});
