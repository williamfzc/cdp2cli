// Validates local app adapters and atomically publishes complete capability sets.
// Adapter expressions are trusted local code, never generated from model inputs.
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import Ajv from 'ajv';
import { MAX_CONTRACTS, contractFilenameMatches, readJSONFile as readJSON, listContractFiles } from './project-files.mjs';
export { MAX_CONTRACTS, MAX_FILE_BYTES } from './project-files.mjs';

export const RESERVED = new Set(['app_status', 'service_diagnostics']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const namePattern = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;


export function compileSchema(schema) {
  if (!object(schema)) throw new Error('A JSON schema object is required.');
  if (JSON.stringify(schema).length > 32768) throw new Error('Schema exceeds 32 KiB.');
  // References to external schemas are unsupported: project files are self-contained.
  const inspect = value => {
    if (!object(value) && !Array.isArray(value)) return;
    if (object(value) && (value.$async || (value.$ref && !value.$ref.startsWith('#/')))) {
      throw new Error('Async or external schema references are unsupported.');
    }
    for (const child of Object.values(value)) inspect(child);
  };
  inspect(schema);
  // A separate compiler avoids retaining schemas from old registry snapshots.
  return new Ajv({ strict: true, allErrors: false, validateFormats: false, addUsedSchema: false }).compile(schema);
}

export function validateApp(app) {
  if (!object(app) || !namePattern.test(app.name)) throw new Error('Invalid application name.');
  const url = new URL(app.endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Application endpoint must be an HTTP loopback origin.');
  }
  if (typeof app.userAgentIncludes !== 'string' || !app.userAgentIncludes || app.userAgentIncludes.length > 128) {
    throw new Error('Application identity marker is required.');
  }
  if (typeof app.bridge !== 'string' || !/^window(?:\.[A-Za-z_$][\w$]*)*$/.test(app.bridge)) {
    throw new Error('A bridge path such as window.zcode is required.');
  }
  if (app.targetUrlIncludes !== undefined && typeof app.targetUrlIncludes !== 'string') throw new Error('Invalid target URL filter.');
  if (app.supportedVersions !== undefined && (!Array.isArray(app.supportedVersions) || !app.supportedVersions.length ||
      app.supportedVersions.some(v => typeof v !== 'string' || !v || v.length > 64))) throw new Error('Invalid supported versions.');
  const bounds = {
    requestTimeoutMs: [10, 60000], connectTimeoutMs: [10, 30000], maxQueue: [0, 1024],
    idleTimeoutMs: [10, 300000], maxResponseBytes: [1024, 16777216],
  };
  if (app.limits !== undefined && !object(app.limits)) throw new Error('Invalid application limits.');
  for (const [key, value] of Object.entries(app.limits ?? {})) {
    if (!bounds[key] || !Number.isSafeInteger(value) || value < bounds[key][0] || value > bounds[key][1]) {
      throw new Error(`Invalid limit: ${key}`);
    }
  }
  return app;
}

export function validateContract(contract) {
  if (!object(contract) || !namePattern.test(contract.name) || RESERVED.has(contract.name)) throw new Error('Invalid or reserved capability name.');
  if (typeof contract.description !== 'string' || !contract.description.trim() || contract.description.length > 2048) throw new Error('Capability description is required.');
  if (!['read', 'write'].includes(contract.sideEffect)) throw new Error('Capability must declare read or write.');
  const v = contract.verification;
  if (!object(v) || v.status !== 'verified' || typeof v.appVersion !== 'string' || !v.appVersion ||
      typeof v.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.date) ||
      !Array.isArray(v.evidence) || !v.evidence.length || v.evidence.some(x => typeof x !== 'string' || !x)) {
    throw new Error('Only verified capabilities with version, date and evidence may be installed.');
  }
  if (contract.inputSchema?.type !== 'object') throw new Error('Capability inputs must be an object schema.');
  const input = compileSchema(contract.inputSchema);
  const output = compileSchema(contract.outputSchema);
  const e = contract.execution;
  if (!object(e) || e.kind !== 'expression' || typeof e.expression !== 'string' || e.expression.length > 65536) {
    throw new Error('A local expression adapter is required.');
  }
  new Script(`(${e.expression})`); // Parse only; never execute adapter code on the server.
  if (!Array.isArray(e.requiredMethods) || e.requiredMethods.length > 64 ||
      e.requiredMethods.some(m => typeof m !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(m))) {
    throw new Error('Invalid required bridge methods.');
  }
  return { contract, input, output };
}

export function validateProject(app, contracts) {
  validateApp(app);
  if (!Array.isArray(contracts) || contracts.length > MAX_CONTRACTS) throw new Error('Too many capabilities.');
  const seen = new Set();
  const entries = contracts.map(contract => {
    if (seen.has(contract.name)) throw new Error(`Duplicate capability: ${contract.name}`);
    seen.add(contract.name);
    if (app.supportedVersions && !app.supportedVersions.includes(contract.verification?.appVersion)) {
      throw new Error(`Capability ${contract.name} was verified against an unsupported application version.`);
    }
    return validateContract(contract);
  });
  const bytes = Buffer.byteLength(JSON.stringify({ tools: contracts.map(toolDefinition) })) + 4096;
  if (bytes > (app.limits?.maxResponseBytes ?? 1048576)) {
    throw new Error('Tool catalog exceeds the response budget; reduce schemas or choose an explicit larger bound.');
  }
  return entries;
}

export function toolDefinition(c) {
  return { name: c.name, description: c.description, inputSchema: c.inputSchema,
    outputSchema: c.outputSchema.type === 'object' ? c.outputSchema : {
      type: 'object', properties: { result: c.outputSchema }, required: ['result'], additionalProperties: false,
    }, annotations: { readOnlyHint: c.sideEffect === 'read', destructiveHint: c.sideEffect === 'write' },
  };
}

export async function readProject(directory) {
  const app = await readJSON(path.join(directory, 'app.json'));
  const folder = path.join(directory, 'contracts');
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Contracts must be a real directory.');
  let names;
  try {
    const index = await readJSON(path.join(directory, 'capabilities.json'));
    names = index.value.files;
    if (!Array.isArray(names) || names.some(name => typeof name !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_.-]{0,82}\.json$/.test(name)) || new Set(names).size !== names.length) {
      throw new Error('Invalid capability publication index.');
    }
    names = [...names].sort();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    names = await listContractFiles(folder);
  }
  if (names.length > MAX_CONTRACTS) throw new Error('Too many capability files.');
  const entries = [];
  for (const name of names) {
    const entry = await readJSON(path.join(folder, name));
    if (!contractFilenameMatches(name, entry.value)) throw new Error('Capability file name or revision digest does not match its content.');
    entries.push(entry);
  }
  const hash = createHash('sha256').update(app.text);
  for (const entry of entries) hash.update('\0').update(entry.text);
  return { app: app.value, contracts: entries.map(e => e.value), digest: hash.digest('hex') };
}

export class Registry {
  constructor(directory) { this.directory = directory; this.lastError = null; }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.load().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async load() {
    try {
      const project = await readProject(this.directory);
      if (project.digest === this.digest) { this.lastError = null; return false; }
      if (project.digest === this.rejectedDigest) return false;
      try {
        if (this.app && JSON.stringify(project.app) !== JSON.stringify(this.app)) throw new Error('Application settings changed; restart the service to apply them.');
        const entries = validateProject(project.app, project.contracts);
        this.app = project.app;
        this.tools = new Map(entries.map(e => [e.contract.name, e]));
        this.digest = project.digest;
        this.rejectedDigest = null;
        this.lastError = null;
        return true;
      } catch (error) { this.rejectedDigest = project.digest; throw error; }
    } catch (error) {
      this.lastError = error.message;
      if (!this.tools) throw error;
      return false; // An invalid update never replaces the last known good capability set.
    }
  }
}
