#!/usr/bin/env node
// Generated-service entry point; defaults to app.json beside this file.
// Lifecycle remains separate from the user's desktop application.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startService } from './src/service.mjs';

let directory = dirname(fileURLToPath(import.meta.url));
let allowWrites = false;
try {
  const args = process.argv.slice(2);
  while (args.length) {
    const option = args.shift();
    if (option === '--project' && args.length) directory = resolve(args.shift());
    else if (option === '--allow-writes') allowWrites = true;
    else throw new Error('Usage: node server.mjs [--project directory] [--allow-writes]');
  }
  await startService(directory, { allowWrites });
} catch (error) { console.error(error.message); process.exitCode = 1; }
