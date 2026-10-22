// Bounded CDP execution with explicit connection, queue and renderer ownership.
// Every call releases its session/object group; failed business calls are never replayed.
import WebSocket from 'ws';
import { validateApp, validateContract, MAX_CONTRACTS } from './registry.mjs';

const defaults = { requestTimeoutMs: 5000, connectTimeoutMs: 3000, maxQueue: 32,
  idleTimeoutMs: 30000, maxResponseBytes: 1048576 };
const abortError = signal => signal?.reason instanceof Error && signal.reason.name !== 'AbortError'
  ? signal.reason : new Error('Operation cancelled; it was not replayed.');

export class AppConnection {
  constructor(app) {
    validateApp(app);
    this.app = structuredClone(app);
    this.limits = { ...defaults, ...app.limits };
    this.endpoint = new URL(app.endpoint);
    this.pending = new Map();
    this.waiting = [];
    this.validators = new Map();
    this.nextId = 0;
    this.connections = 0;
    this.activeSessions = 0;
    this.activeObjectGroups = 0;
    this.closed = false;
    this.active = null;
    this.lifetime = new AbortController();
  }

  diagnostics() {
    return { connected: this.socket?.readyState === WebSocket.OPEN,
      pendingRequests: this.pending.size, queuedRequests: this.waiting.length,
      activeRequests: this.active ? 1 : 0, activeSessions: this.activeSessions,
      activeObjectGroups: this.activeObjectGroups, connections: this.connections,
      cachedContracts: this.validators.size, closed: this.closed };
  }

  enqueue(operation, signal) {
    if (this.closed) return Promise.reject(new Error('Service is closed.'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active && this.waiting.length >= this.limits.maxQueue) return Promise.reject(new Error('Service busy: request queue is full.'));
    clearTimeout(this.idleTimer);
    return new Promise((resolve, reject) => {
      const item = { operation, resolve, reject, signal };
      item.abort = () => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return; // The active operation owns its abort listener.
        this.waiting.splice(index, 1);
        clearTimeout(item.queueTimer);
        signal.removeEventListener('abort', item.abort);
        reject(abortError());
      };
      signal?.addEventListener('abort', item.abort, { once: true });
      item.queueTimer = setTimeout(() => {
        const index = this.waiting.indexOf(item);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        signal?.removeEventListener('abort', item.abort);
        reject(new Error('Queue wait timed out.'));
      }, this.limits.requestTimeoutMs);
      item.queueTimer.unref();
      this.waiting.push(item);
      this.drain();
    });
  }

  drain() {
    if (this.active || !this.waiting.length || this.closed) return;
    const item = this.waiting.shift();
    clearTimeout(item.queueTimer);
    this.active = item;
    item.signal?.removeEventListener('abort', item.abort);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Operation timed out; it was not replayed.')), this.limits.requestTimeoutMs);
    const signal = AbortSignal.any([...(item.signal ? [item.signal] : []), this.lifetime.signal, deadline.signal]);
    this.activeDone = (async () => {
      try { if (signal.aborted) throw abortError(); item.resolve(await item.operation(signal)); }
      catch (error) { item.reject(error); }
      finally {
        clearTimeout(timer);
        this.active = null;
        this.activeDone = null;
        if (this.waiting.length) this.drain();
        else if (!this.closed) {
          this.idleTimer = setTimeout(() => this.drop(new Error('Idle connection released.')), this.limits.idleTimeoutMs);
          this.idleTimer.unref();
        }
      }
    })();
  }

  drop(reason = new Error('Application disconnected; the operation was not replayed.'), socket = this.socket) {
    if (!socket || socket !== this.socket) return;
    this.socket = null;
    clearTimeout(this.idleTimer);
    for (const request of this.pending.values()) request.fail(reason);
    this.pending.clear();
    this.activeSessions = 0;
    this.activeObjectGroups = 0;
    socket.removeAllListeners();
    // terminate releases a peer that never completes a WebSocket close handshake.
    socket.on('error', () => {});
    socket.terminate();
  }

  async versionInfo(signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.connectTimeoutMs);
    const combined = AbortSignal.any([signal, controller.signal]);
    let reader;
    try {
      const response = await fetch(new URL('/json/version', this.endpoint), { signal: combined, redirect: 'error' });
      if (!response.ok) throw new Error('Unexpected version response.');
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > Math.min(this.limits.maxResponseBytes, 65536)) throw new Error('Application version response too large.');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString());
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      throw new Error(`Application unavailable: ${error.message}`);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }

  async ensure(signal) {
    if (signal.aborted) throw abortError(signal);
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const info = await this.versionInfo(signal);
    const marker = this.app.userAgentIncludes;
    const ua = info['User-Agent'];
    if (typeof ua !== 'string' || !ua.includes(marker)) throw new Error('The debug port belongs to a different application.');
    this.version = ua.slice(ua.indexOf(marker) + marker.length).split(/[\s;)]+/)[0];
    if (this.app.supportedVersions && !this.app.supportedVersions.includes(this.version)) throw new Error('Application version is unverified; verify adapters before updating supportedVersions.');
    const address = new URL(info.webSocketDebuggerUrl);
    const port = url => url.port || (url.protocol === 'http:' || url.protocol === 'ws:' ? '80' : '443');
    if (address.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) ||
        port(address) !== port(this.endpoint) || address.username || address.password) {
      throw new Error('Application supplied an unexpected debugger endpoint.');
    }
    if (signal.aborted) throw abortError(signal);
    const socket = new WebSocket(address, { maxPayload: this.limits.maxResponseBytes,
      handshakeTimeout: this.limits.connectTimeoutMs, perMessageDeflate: false,
      maxFragments: 1024, maxBufferedChunks: 4096 });
    this.socket = socket;
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); }
      catch { this.drop(new Error('Malformed debugger response.'), socket); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      if (message.error) request.fail(new Error('Application rejected the operation; its page or capabilities may have changed.'));
      else request.succeed(message.result);
    });
    socket.on('error', () => this.drop(new Error('Application connection failed or exceeded its response limit.'), socket));
    socket.on('close', () => this.drop(undefined, socket));
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        socket.off('open', open); socket.off('error', fail); socket.off('close', fail);
      };
      const open = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('Application connection failed.')); };
      const abort = () => { cleanup(); this.drop(abortError(signal), socket); reject(abortError(signal)); };
      const timer = setTimeout(() => { cleanup(); this.drop(new Error('Connection timed out.'), socket); reject(new Error('Connection timed out.')); }, this.limits.connectTimeoutMs);
      socket.once('open', open); socket.once('error', fail); socket.once('close', fail);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    this.connections++;
  }

  call(method, params, sessionId, signal) {
    const socket = this.socket;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Application disconnected.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const fail = error => { cleanup(); reject(error); };
      const succeed = value => { cleanup(); resolve(value); };
      const abort = () => { fail(abortError(signal)); this.drop(abortError(signal), socket); };
      const timer = setTimeout(() => {
        const error = new Error('Application request timed out; it was not replayed.');
        fail(error); this.drop(error, socket);
      }, this.limits.requestTimeoutMs);
      this.pending.set(id, { fail, succeed });
      signal?.addEventListener('abort', abort, { once: true });
      const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      if (Buffer.byteLength(payload) > this.limits.maxResponseBytes) { fail(new Error('Request exceeds configured size limit.')); return; }
      socket.send(payload, error => { if (error) { fail(new Error('Failed to send application request.')); this.drop(undefined, socket); } });
    });
  }

  async withPage(contract, args, signal) {
    await this.ensure(signal);
    if (contract?.verification && contract.verification.appVersion !== this.version) {
      throw new Error('This capability was verified against a different application version.');
    }
    const { targetInfos } = await this.call('Target.getTargets', {}, undefined, signal);
    if (!Array.isArray(targetInfos)) throw new Error('Unexpected application page list.');
    const pages = targetInfos.filter(t => t.type === 'page' && typeof t.url === 'string' && !t.url.startsWith('devtools:') && t.url.includes(this.app.targetUrlIncludes ?? ''));
    if (pages.length > 1) throw new Error('Multiple application pages match; narrow targetUrlIncludes before executing a capability.');
    for (const target of pages.slice(0, 32)) {
      const { sessionId } = await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined, signal);
      this.activeSessions++;
      const group = `cdp2mcp-${this.nextId}`;
      try {
        const methods = contract?.execution.requiredMethods ?? [];
        const expression = `Boolean(${this.app.bridge}) && ${JSON.stringify(methods)}.every(k => typeof ${this.app.bridge}[k] === 'function')`;
        const probe = await this.call('Runtime.evaluate', { expression, returnByValue: true, objectGroup: group }, sessionId, signal);
        this.activeObjectGroups++;
        if (probe.exceptionDetails || probe.result?.value !== true) continue;
        if (!contract) return { available: true, version: this.version, connections: this.connections };
        const global = await this.call('Runtime.evaluate', { expression: 'globalThis', returnByValue: false, objectGroup: group }, sessionId, signal);
        const objectId = global.result?.objectId;
        if (!objectId) throw new Error('Application execution context is not ready.');
        const result = await this.call('Runtime.callFunctionOn', {
          objectId, functionDeclaration: `async function(args) { return await (${contract.execution.expression})(args); }`,
          arguments: [{ value: args }], awaitPromise: true, returnByValue: true, objectGroup: group,
        }, sessionId, signal);
        if (result.exceptionDetails) throw new Error('Application capability failed; no automatic retry was performed.');
        if (!result.result || !Object.hasOwn(result.result, 'value')) throw new Error('Application returned a non-JSON result.');
        return result.result.value;
      } finally {
        if (this.socket?.readyState === WebSocket.OPEN) {
          try {
            // Cleanup has its own deadline even if the caller has cancelled.
            await this.call('Runtime.releaseObjectGroup', { objectGroup: group }, sessionId);
            this.activeObjectGroups = Math.max(0, this.activeObjectGroups - 1);
            await this.call('Target.detachFromTarget', { sessionId });
            this.activeSessions = Math.max(0, this.activeSessions - 1);
          } catch { this.drop(new Error('Renderer cleanup failed; connection released.')); }
        }
      }
    }
    throw new Error('Application page or required capability is not ready.');
  }

  execute(contract, args = {}, { signal, validators } = {}) {
    try {
      if (this.closed) throw new Error('Service is closed.');
      if (!validators) {
        const signature = JSON.stringify(contract);
        let cached = this.validators.get(contract.name);
        if (!cached || cached.signature !== signature) {
          if (!cached && this.validators.size >= MAX_CONTRACTS) throw new Error('Too many cached capabilities.');
          cached = { ...validateContract(contract), signature };
          this.validators.set(contract.name, cached);
        }
        validators = cached;
      }
      if (!validators.input(args)) throw new Error('Invalid capability arguments.');
      if (Buffer.byteLength(JSON.stringify(args)) > this.limits.maxResponseBytes) throw new Error('Arguments exceed the configured size limit.');
    } catch (error) { return Promise.reject(error); }
    return this.enqueue(async combined => {
      const value = await this.withPage(contract, args, combined);
      if (!validators.output(value)) throw new Error('Application output schema does not match the verified capability.');
      return value;
    }, signal);
  }

  status({ signal } = {}) {
    return this.enqueue(combined => this.withPage(null, {}, combined), signal)
      .catch(error => ({ available: false, reason: error.message, connections: this.connections }));
  }

  inspect({ offset = 0, pageSize = 50, signal } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 ||
        !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return Promise.reject(new Error('Inspection requires offset 0..100000 and pageSize 1..100.'));
    }
    const expression = `async (args) => {
      const bridge = ${this.app.bridge};
      const keys = Object.getOwnPropertyNames(bridge);
      const examined = keys.slice(0, 4096);
      const methods = [];
      let accessorProperties = 0;
      for (const name of examined) {
        const descriptor = Object.getOwnPropertyDescriptor(bridge, name);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) { accessorProperties++; continue; }
        if (typeof descriptor.value !== 'function') continue;
        methods.push({ name, arity: descriptor.value.length,
          writable: Boolean(descriptor.writable), configurable: Boolean(descriptor.configurable) });
      }
      methods.sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      return { kind: 'candidate-methods', verification: 'unverified',
        coverage: keys.length > examined.length ? 'partial' : 'own-data-properties',
        examinedProperties: examined.length, totalProperties: keys.length,
        skippedAccessors: accessorProperties, totalCandidates: methods.length,
        offset: args.offset, pageSize: args.pageSize,
        methods: methods.slice(args.offset, args.offset + args.pageSize),
        nextOffset: args.offset + args.pageSize < methods.length ? args.offset + args.pageSize : null };
    }`;
    return this.enqueue(async combined => {
      const value = await this.withPage({ execution: { requiredMethods: [], expression } }, { offset, pageSize }, combined);
      return { ...value, appVersion: this.version, bridge: this.app.bridge,
        source: 'live own-property descriptors; no candidate methods or accessor getters invoked',
        untrustedTargetContent: true };
    }, signal);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.lifetime.abort();
    for (const item of this.waiting.splice(0)) {
      clearTimeout(item.queueTimer);
      item.signal?.removeEventListener('abort', item.abort);
      item.reject(new Error('Service is closed.'));
    }
    this.drop(new Error('Service is closed.'));
    await this.activeDone;
    this.validators.clear();
  }
}
