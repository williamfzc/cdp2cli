#!/usr/bin/env node
// Agent-facing discovery, generation and maintenance commands for MCP services.
// Publishes verified capability sets without replacing unrelated application code.

import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MAX_CONTRACTS, canonical, versionedContractFile, contractFilenameMatches, readJSONFile, listContractFiles, directoryEmpty } from './src/project-files.mjs';

const TOOL_ROOT = dirname(fileURLToPath(import.meta.url));
const RESERVED_NAMES = new Set(['app_status', 'service_diagnostics']);
const CONTRACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CAPABILITIES_FILE = 'capabilities.json';
const CAPABILITY_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:--[0-9a-f]{16})?\.json$/;

export const HELP = `Usage:
  node cli.mjs guide [all|create|extend]
  node cli.mjs inspect --app <manifest.json> [--page-size 50] [--offset 0]
  node cli.mjs init <destination> --app <manifest.json> --contract <contract.json> [--contract <contract.json> ...]
  node cli.mjs add <existing-project> --contract <contract.json> [--contract <contract.json> ...]
  node cli.mjs update <existing-project> --contract <contract.json> [--contract <contract.json> ...] [--allow-breaking]
  node cli.mjs check <project>
  node cli.mjs --help

Commands:
  guide  Read the agent workflow, including evidence and verification requirements.
  inspect Enumerate paginated candidate method descriptors without invoking them.
  init   Create a standalone project from an app manifest and one or more contracts.
  add    Add contracts to an existing project as one atomic update.
  update Replace existing contracts with versioned files; use --allow-breaking for schema or side-effect changes.
  check  Validate app.json and every contract in an existing project.

The generated project contains server.mjs, package.json, package-lock.json, src/, app.json,
and contracts/. Existing non-empty paths are never overwritten.`;

function fail(message) {
  throw new Error(message);
}

async function readJson(file, kind) {
  try { return (await readJSONFile(file)).value; }
  catch (error) { fail(`cannot read ${kind} ${file}: ${error.message}`); }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}


function validateContractName(name) {
  if (typeof name !== 'string' || !CONTRACT_NAME.test(name) || name === '.' || name === '..') {
    fail(`contract name must be a simple file name: ${String(name)}`);
  }
  if (RESERVED_NAMES.has(name)) {
    fail(`contract name is reserved: ${name}`);
  }
}

function inspectContract(contract, source) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    fail(`contract must be a JSON object: ${source}`);
  }
  validateContractName(contract.name);
  if (typeof contract.sideEffect !== 'undefined' && !['read', 'write'].includes(contract.sideEffect)) {
    fail(`contract ${contract.name} has invalid sideEffect; use read or write`);
  }
  return contract;
}

function inspectDestination(path, label) {
  const absolute = resolve(path);
  if (absolute === dirname(absolute)) {
    fail(`${label} path is too broad: ${path}`);
  }
  return absolute;
}

async function readProject(project, label = 'project') {
  const root = inspectDestination(project, label);
  const info = await lstat(root).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    fail(`${label} must be an existing directory: ${project}`);
  }
  const app = await readJson(join(root, 'app.json'), 'app manifest');
  const contractsRoot = join(root, 'contracts');
  const contractsInfo = await lstat(contractsRoot).catch(() => null);
  if (!contractsInfo || !contractsInfo.isDirectory() || contractsInfo.isSymbolicLink()) {
    fail(`project is missing contracts directory: ${project}`);
  }
  const indexFile = join(root, CAPABILITIES_FILE);
  const indexInfo = await lstat(indexFile).catch(() => null);
  let files;
  let hasIndex = Boolean(indexInfo);
  if (indexInfo) {
    if (!indexInfo.isFile() || indexInfo.isSymbolicLink()) fail('capabilities.json must be a regular file');
    const index = await readJson(indexFile, 'capability index');
    if (!index || typeof index !== 'object' || Array.isArray(index) || !Array.isArray(index.files)) {
      fail('capabilities.json must contain a files array');
    }
    if (index.files.length > MAX_CONTRACTS) fail('too many capability files');
    const seen = new Set();
    files = index.files.map((file) => {
      if (typeof file !== 'string' || !CAPABILITY_FILE.test(file) || file.includes('/') || file.includes('\\') || seen.has(file)) {
        fail(`invalid or duplicate capability index entry: ${String(file)}`);
      }
      seen.add(file);
      return file;
    });
  } else {
    files = await listContractFiles(contractsRoot);
  }
  const contracts = [];
  for (const file of files) {
    const contract = await readJson(join(contractsRoot, file), 'contract');
    inspectContract(contract, file);
    if (!contractFilenameMatches(file, contract)) {
      fail(`contract file name does not match contract.name: ${file}`);
    }
    contracts.push(contract);
  }
  return { root, app, contracts, files, hasIndex };
}

async function loadValidator() {
  const moduleUrl = pathToFileURL(join(TOOL_ROOT, 'src', 'registry.mjs')).href;
  let registry;
  try {
    registry = await import(moduleUrl);
  } catch (error) {
    fail(`cannot load project validator src/registry.mjs: ${error.message}`);
  }
  if (typeof registry.validateProject !== 'function') {
    fail('src/registry.mjs must export validateProject(app, contracts)');
  }
  return registry.validateProject;
}

async function validate(app, contracts) {
  const validateProject = await loadValidator();
  try {
    const result = await validateProject(app, contracts);
    if (result === false) fail('project validation failed');
  } catch (error) {
    fail(`project validation failed: ${error.message}`);
  }
}

async function copyToolFiles(destination) {
  const required = ['src', 'server.mjs', 'package.json', 'package-lock.json'];
  for (const name of required) {
    const source = join(TOOL_ROOT, name);
    const info = await lstat(source).catch(() => null);
    if (!info || (name === 'src' ? !info.isDirectory() : !info.isFile()) || info.isSymbolicLink()) {
      fail(`tool root is missing required ${name}`);
    }
    if (name === 'package.json') continue;
    if (name === 'package-lock.json') continue;
    await cp(source, join(destination, name), { recursive: name === 'src', dereference: false });
  }
  const packageJson = await readJson(join(TOOL_ROOT, 'package.json'), 'tool package');
  const packageLock = await readJson(join(TOOL_ROOT, 'package-lock.json'), 'tool package lock');
  delete packageJson.bin;
  packageJson.scripts = { start: packageJson.scripts?.start || 'node server.mjs' };
  await writeFile(join(destination, 'package.json'), jsonText(packageJson), { flag: 'wx' });
  packageLock.name = packageJson.name;
  packageLock.version = packageJson.version;
  if (packageLock.packages?.['']) {
    packageLock.packages[''] = { ...packageLock.packages[''], name: packageJson.name, version: packageJson.version };
    delete packageLock.packages[''].bin;
    delete packageLock.packages[''].scripts;
  }
  await writeFile(join(destination, 'package-lock.json'), jsonText(packageLock), { flag: 'wx' });
}

async function writeProjectData(destination, app, contracts) {
  await writeFile(join(destination, 'app.json'), jsonText(app), { flag: 'wx' });
  const contractsRoot = join(destination, 'contracts');
  await mkdir(contractsRoot);
  const files = [];
  for (const contract of contracts) {
    await writeFile(join(contractsRoot, `${contract.name}.json`), jsonText(contract), { flag: 'wx' });
    files.push(`${contract.name}.json`);
  }
  await writeFile(join(destination, CAPABILITIES_FILE), jsonText({ files }), { flag: 'wx' });
}

function generatedReadme(app, destination) {
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  return `---
type: Index
title: ${app.name} MCP service
description: Generated standalone application service and maintenance instructions.
---

# ${app.name} MCP service

Generated with [cdp2cli](https://github.com/williamfzc/cdp2cli). Install locked dependencies with \`npm ci --ignore-scripts\`.
Open the app with its local debugging endpoint enabled. The service attaches to the app; it never starts, restarts or quits it.

Import [mcp-config.json](./mcp-config.json) into your MCP client. Its Node and server paths are absolute; update them after moving this project.
The client starts \`node server.mjs\`; running it manually waits for MCP messages, not interactive terminal input.

## Maintain this service

Do not regenerate this directory. First verify new or changed app behavior, then use the generator's commands:

\`\`\`sh
node ${quote(join(TOOL_ROOT, 'cli.mjs'))} add ${quote(destination)} --contract /path/to/new-contract.json
node ${quote(join(TOOL_ROOT, 'cli.mjs'))} update ${quote(destination)} --contract /path/to/updated-contract.json
\`\`\`

Identical additions/updates are no-ops. Add rejects replacing an existing name; update only changes existing names.
Input/output schema or read/write classification changes require an intentional \`--allow-breaking\` update.
Contracts declare \`sideEffect: read|write\`; writes remain hidden and disabled unless the service starts with \`--allow-writes\`.
Instructions do not authorize the agent to perform business writes.
`;
}

async function writeGeneratedFiles(destination, finalDestination, app) {
  await writeFile(join(destination, 'README.md'), generatedReadme(app, finalDestination), { flag: 'wx' });
  await writeFile(join(destination, 'mcp-config.json'), jsonText({
    mcpServers: {
      [app.name]: {
        command: process.execPath,
        args: [join(finalDestination, 'server.mjs')],
      },
    },
  }), { flag: 'wx' });
}

async function prepareInitDestination(destination) {
  await mkdir(dirname(destination), { recursive: true });
  const info = await lstat(destination).catch(() => null);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`destination must be a real directory: ${destination}`);
  if (!await directoryEmpty(destination)) fail(`destination already exists and is not empty: ${destination}`);
}

async function atomicPublishInit(destination, stage) {
  const info = await lstat(destination).catch(() => null);
  if (!info) {
    await rename(stage, destination);
    return;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`destination must be a real directory: ${destination}`);
  if (!await directoryEmpty(destination)) fail(`destination became non-empty during init: ${destination}`);
  await rmdir(destination);
  try {
    await rename(stage, destination);
  } catch (error) {
    if (!await lstat(destination).catch(() => null)) await mkdir(destination).catch(() => {});
    throw error;
  }
}

async function withTemporaryProject(parent, action) {
  const stage = await mkdtemp(join(parent, '.cdp2mcp-stage-'));
  try {
    return await action(stage);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function withProjectLock(project, action) {
  const lock = join(dirname(project), `.${basename(project)}.cdp2mcp.lock`);
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await writeFile(lock, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) {
        fail(`project is busy: ${project}`);
      }
      await new Promise(resolveAfterDelay => setTimeout(resolveAfterDelay, 50));
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { force: true });
  }
}

async function publishCapabilitiesIndex(project, files) {
  const indexPath = join(project, CAPABILITIES_FILE);
  const tempPath = join(project, `.${CAPABILITIES_FILE}.${process.pid}-${Date.now()}.tmp`);
  try {
    await writeFile(tempPath, jsonText({ files }), { flag: 'wx' });
    await rename(tempPath, indexPath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function initProject(destinationArg, appFile, contractFiles) {
  if (!appFile) fail('init requires --app <manifest.json>');
  if (!contractFiles.length) fail('init requires at least one --contract <contract.json>');
  if (contractFiles.length > MAX_CONTRACTS) fail(`too many contracts (maximum ${MAX_CONTRACTS})`);
  const destination = inspectDestination(destinationArg, 'destination');
  const app = await readJson(resolve(appFile), 'app manifest');
  const contracts = [];
  const byName = new Map();
  for (const file of contractFiles) {
    const contract = inspectContract(await readJson(resolve(file), 'contract'), file);
    const previous = byName.get(contract.name);
    if (previous && canonical(previous) !== canonical(contract)) {
      fail(`batch contains conflicting contracts with the same name: ${contract.name}`);
    }
    if (!previous) {
      byName.set(contract.name, contract);
      contracts.push(contract);
    }
  }
  await validate(app, contracts);
  await prepareInitDestination(destination);
  return withProjectLock(destination, async () => {
    await prepareInitDestination(destination);
    await withTemporaryProject(dirname(destination), async (stage) => {
      await copyToolFiles(stage);
      await writeProjectData(stage, app, contracts);
      await writeGeneratedFiles(stage, destination, app);
      await atomicPublishInit(destination, stage);
    });
    return { destination, added: contracts.length };
  });
}

export async function addContracts(projectArg, contractFiles) {
  if (!contractFiles.length) fail('add requires at least one --contract <contract.json>');
  if (contractFiles.length > MAX_CONTRACTS) fail(`too many contracts (maximum ${MAX_CONTRACTS})`);
  const project = inspectDestination(projectArg, 'project');
  return withProjectLock(project, async () => {
    const existing = await readProject(project);
    const incoming = new Map();
    for (const file of contractFiles) {
      const contract = inspectContract(await readJson(resolve(file), 'contract'), file);
      const previous = incoming.get(contract.name);
      if (previous && canonical(previous) !== canonical(contract)) {
        fail(`batch contains conflicting contracts with the same name: ${contract.name}`);
      }
      incoming.set(contract.name, contract);
    }
    const existingByName = new Map(existing.contracts.map((contract) => [contract.name, contract]));
    for (const [name, contract] of incoming) {
      const old = existingByName.get(name);
      if (old && canonical(old) !== canonical(contract)) {
        fail(`contract already exists with different content: ${name}`);
      }
    }
    const newContracts = [...existing.contracts];
    let added = 0;
    for (const [name, contract] of incoming) {
      if (!existingByName.has(name)) {
        newContracts.push(contract);
        added += 1;
      }
    }
    if (added === 0) return { project, added: 0, noOp: true };
    await validate(existing.app, newContracts);
    // Legacy projects are visible through directory discovery. Publish their old
    // set first so newly written files remain invisible until the final index.
    if (!existing.hasIndex) await publishCapabilitiesIndex(project, existing.files);
    const createdFiles = [];
    try {
      for (const contract of newContracts.slice(existing.contracts.length)) {
        const file = `${contract.name}.json`;
        const path = join(project, 'contracts', file);
        try {
          await writeFile(path, jsonText(contract), { flag: 'wx' });
          createdFiles.push(path);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const orphan = inspectContract(await readJson(path, 'existing contract'), file);
          if (canonical(orphan) !== canonical(contract)) {
            fail(`contract file already exists with different content: ${file}`);
          }
        }
      }
      await publishCapabilitiesIndex(project, [...existing.files, ...newContracts.slice(existing.contracts.length).map(contract => `${contract.name}.json`)]);
    } catch (error) {
      for (const file of createdFiles) await rm(file, { force: true });
      throw error;
    }
    return { project, added, noOp: false };
  });
}

function contractShapeChanged(previous, next) {
  return canonical(previous.inputSchema) !== canonical(next.inputSchema) ||
    canonical(previous.outputSchema) !== canonical(next.outputSchema) ||
    canonical(previous.sideEffect) !== canonical(next.sideEffect);
}

export async function updateContracts(projectArg, contractFiles, allowBreaking = false) {
  if (!contractFiles.length) fail('update requires at least one --contract <contract.json>');
  if (contractFiles.length > MAX_CONTRACTS) fail(`too many contracts (maximum ${MAX_CONTRACTS})`);
  const project = inspectDestination(projectArg, 'project');
  return withProjectLock(project, async () => {
    const existing = await readProject(project);
    const incoming = new Map();
    for (const file of contractFiles) {
      const contract = inspectContract(await readJson(resolve(file), 'contract'), file);
      const previous = incoming.get(contract.name);
      if (previous && canonical(previous) !== canonical(contract)) {
        fail(`batch contains conflicting contracts with the same name: ${contract.name}`);
      }
      incoming.set(contract.name, contract);
    }
    const existingByName = new Map(existing.contracts.map((contract) => [contract.name, contract]));
    for (const name of incoming.keys()) {
      if (!existingByName.has(name)) fail(`update cannot introduce new contract: ${name}; use add`);
    }
    const changed = [];
    for (const [name, contract] of incoming) {
      const previous = existingByName.get(name);
      if (canonical(previous) === canonical(contract)) continue;
      if (!allowBreaking && contractShapeChanged(previous, contract)) {
        fail(`breaking contract change requires --allow-breaking: ${name}`);
      }
      changed.push({ name, previous, contract });
    }
    if (changed.length === 0) return { project, updated: 0, noOp: true };
    const updatedByName = new Map(changed.map(({ name, contract }) => [name, contract]));
    const nextContracts = existing.contracts.map((contract) => updatedByName.get(contract.name) ?? contract);
    await validate(existing.app, nextContracts);
    if (!existing.hasIndex) await publishCapabilitiesIndex(project, existing.files);
    const oldFileByName = new Map(existing.contracts.map((contract, index) => [contract.name, existing.files[index]]));
    const replacements = new Map(changed.map(({ name, contract }) => [name, versionedContractFile(contract)]));
    const nextFiles = existing.files.map((file, index) => replacements.get(existing.contracts[index].name) ?? file);
    const createdFiles = [];
    try {
      for (const { contract } of changed) {
        const file = versionedContractFile(contract);
        const path = join(project, 'contracts', file);
        try {
          await writeFile(path, jsonText(contract), { flag: 'wx' });
          createdFiles.push(path);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existingFile = inspectContract(await readJson(path, 'existing contract'), file);
          if (canonical(existingFile) !== canonical(contract)) {
            fail(`versioned contract file already exists with different content: ${file}`);
          }
        }
      }
      await publishCapabilitiesIndex(project, nextFiles);
    } catch (error) {
      for (const file of createdFiles) await rm(file, { force: true });
      throw error;
    }
    const cleanupPending = [];
    for (const { name } of changed) {
      const oldFile = oldFileByName.get(name);
      if (oldFile && oldFile !== replacements.get(name)) {
        try { await rm(join(project, 'contracts', oldFile), { force: true }); }
        catch { cleanupPending.push(oldFile); }
      }
    }
    // Publication has committed. A cleanup failure must not report a rolled-back update.
    return { project, updated: changed.length, noOp: false, cleanupPending };
  });
}

export async function checkProject(projectArg) {
  const project = await readProject(projectArg);
  await validate(project.app, project.contracts);
  return { project: project.root, contracts: project.contracts.length, valid: true };
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return { command: 'help' };
  const command = argv[0];
  if (!['init', 'add', 'update', 'check'].includes(command)) fail(`unknown command: ${command}`);
  const positional = [];
  const contracts = [];
  let app;
  let allowBreaking = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app') {
      app = argv[++index];
      if (!app) fail('--app requires a file path');
    } else if (arg === '--contract') {
      const file = argv[++index];
      if (!file) fail('--contract requires a file path');
      contracts.push(file);
    } else if (arg.startsWith('-')) {
      if (arg === '--allow-breaking') {
        allowBreaking = true;
      } else {
        fail(`unknown option: ${arg}`);
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) fail(`${command} requires exactly one project path`);
  if (command === 'check' && (app || contracts.length)) fail('check accepts only a project path');
  if (['add', 'update'].includes(command) && app) fail(`${command} does not accept --app`);
  if (command === 'init' && allowBreaking) fail('init does not accept --allow-breaking');
  if (command === 'add' && allowBreaking) fail('add does not accept --allow-breaking');
  if (command === 'check' && allowBreaking) fail('check does not accept --allow-breaking');
  return { command, path: positional[0], app, contracts, allowBreaking };
}

export async function run(argv = process.argv.slice(2), output = console) {
  if (argv[0] === 'guide' && !argv.includes('--help')) {
    if (argv.length > 2 || !['all', 'create', 'extend'].includes(argv[1] ?? 'all')) fail('Usage: guide [all|create|extend]');
    let text = await readFile(join(TOOL_ROOT, '../../MCP_PLAYBOOK.md'), 'utf8');
    const heading = { create: '## Create a service', extend: '## Extend or modify a service' }[argv[1]];
    if (heading) {
      const start = text.indexOf(heading);
      if (start < 0) fail('Requested workflow section is missing.');
      text = text.slice(start);
      const next = text.indexOf('\n## ', 1);
      if (next >= 0) text = text.slice(0, next);
    }
    output.log(text);
    return 0;
  }
  if (argv[0] === 'inspect' && !argv.includes('--help')) {
    const options = { pageSize: 50, offset: 0 };
    let app;
    for (let index = 1; index < argv.length; index++) {
      const key = argv[index];
      const value = argv[++index];
      if (value === undefined) fail(`${key} requires a value`);
      if (key === '--app') app = resolve(value);
      else if (key === '--page-size' && /^\d+$/.test(value)) options.pageSize = Number(value);
      else if (key === '--offset' && /^\d+$/.test(value)) options.offset = Number(value);
      else fail(`Invalid inspection option: ${key}`);
    }
    if (!app) fail('inspect requires --app <manifest.json>');
    const { inspectApplication } = await import('./src/inspection.mjs');
    output.log(JSON.stringify(await inspectApplication(app, options)));
    return 0;
  }
  const args = parseArgs(argv);
  if (args.command === 'help') {
    output.log(HELP);
    return 0;
  }
  let result;
  if (args.command === 'init') result = await initProject(args.path, args.app, args.contracts);
  if (args.command === 'add') result = await addContracts(args.path, args.contracts);
  if (args.command === 'update') result = await updateContracts(args.path, args.contracts, args.allowBreaking);
  if (args.command === 'check') result = await checkProject(args.path);
  if (args.command === 'check') output.log(`valid: ${result.contracts} contract(s)`);
  else if (result.noOp) output.log('no changes (all contracts already present)');
  else output.log(`${args.command} complete: ${result.added ?? result.updated} contract(s)`);
  if (result.cleanupPending?.length) output.error?.(`Update published; superseded files need cleanup: ${result.cleanupPending.join(', ')}`);
  return 0;
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => null) === await realpath(fileURLToPath(import.meta.url))) {
  run().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
