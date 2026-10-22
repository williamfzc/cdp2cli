// Owns bounded project-file reads and the immutable capability filename format.
// Both publication commands and runtime reload use this single representation.
import { lstat, open, opendir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 262144;
export const MAX_CONTRACTS = 128;

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function versionedContractFile(contract) {
  const digest = createHash('sha256').update(canonical(contract)).digest('hex').slice(0, 16);
  return `${contract.name}--${digest}.json`;
}

export function contractFilenameMatches(filename, contract) {
  return filename === `${contract.name}.json` || filename === versionedContractFile(contract);
}

export async function readJSONFile(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Project files must be regular JSON files under 256 KiB.');
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error('Project file is no longer a bounded regular file.');
    // Allocate only the observed size plus one byte to detect growth without an unbounded read.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_FILE_BYTES) throw new Error('Project file too large (maximum 256 KiB).');
    if (length > opened.size) throw new Error('Project file changed while reading; retry after it is stable.');
    const text = buffer.toString('utf8', 0, length);
    return { text, value: JSON.parse(text) };
  } finally { await handle.close(); }
}

export async function listContractFiles(folder) {
  const names = [];
  for await (const entry of await opendir(folder)) {
    if (!entry.name.endsWith('.json')) continue;
    names.push(entry.name);
    if (names.length > MAX_CONTRACTS) throw new Error('Too many capability files.');
  }
  return names.sort();
}

export async function directoryEmpty(folder) {
  const directory = await opendir(folder);
  try { return await directory.read() === null; }
  finally { await directory.close(); }
}
