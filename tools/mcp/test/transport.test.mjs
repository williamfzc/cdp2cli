// Verifies that a stalled or oversized MCP stream cannot retain unbounded output.
// Uses real Node streams without launching a desktop application.
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { BoundedStdioTransport } from '../src/transport.mjs';

test('bounded transport serializes and drains ordinary output', async () => {
  const input = new PassThrough();
  let output = '';
  const sink = new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } });
  const transport = new BoundedStdioTransport(input, sink);
  await transport.start();
  await Promise.all([1, 2, 3].map(id => transport.send({ jsonrpc: '2.0', id, result: {} })));
  assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line).id), [1, 2, 3]);
  assert.equal(transport.bufferedBytes, 0);
  assert.equal(transport.frames.length, 0);
  await transport.close();
  assert.equal(input.listenerCount('data'), 0);
});

test('a stalled reader times out without accumulating drain listeners', async () => {
  const input = new PassThrough();
  const sink = new Writable({ write() {} });
  const transport = new BoundedStdioTransport(input, sink, { timeoutMs: 25 });
  await transport.start();
  const promise = transport.send({ jsonrpc: '2.0', id: 1, result: {} });
  // Keep the test alive while the production timeout is intentionally unref'ed.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(promise, /closed/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(transport.frames.length, 0);
  assert.equal(transport.bufferedBytes, 0);
  assert.equal(sink.listenerCount('drain'), 0);
  assert.equal(input.listenerCount('data'), 0);
  sink.destroy();
});

test('frame limit rejects overload and releases every queued response', async () => {
  const input = new PassThrough();
  const sink = new Writable({ write() {} });
  const transport = new BoundedStdioTransport(input, sink, { maxFrames: 2 });
  await transport.start();
  const jobs = [1, 2, 3].map(id => transport.send({ jsonrpc: '2.0', id, result: {} }));
  const settled = await Promise.allSettled(jobs);
  assert(settled.every(item => item.status === 'rejected'));
  assert.equal(transport.frames.length, 0);
  assert.equal(transport.bufferedBytes, 0);
  sink.destroy();
});

test('oversized input closes transport and clears its read buffer', async () => {
  const input = new PassThrough();
  const sink = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const transport = new BoundedStdioTransport(input, sink, { maxBytes: 1024 });
  let closed = false;
  transport.onclose = () => { closed = true; };
  transport.onerror = () => {};
  await transport.start();
  input.write('x'.repeat(2048));
  assert.equal(closed, true);
  assert.equal(input.listenerCount('data'), 0);
});
