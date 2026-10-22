// Local CDP HTTP/WebSocket peer with controllable responses and renderer contexts.
// Supports integration and retained-memory tests without a real desktop app.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import WebSocket, { WebSocketServer } from 'ws';

/**
 * A deliberately small CDP server used by the integration tests. It speaks
 * the same HTTP discovery and WebSocket protocol as Chromium's remote
 * debugger, while keeping the renderer bridge in this process. No browser or
 * application data is involved.
 */
export class MockCdpServer {
  constructor(options = {}) {
    this.requestedPort = options.port ?? 0;
    this.userAgent = options.userAgent ?? 'MockApp/1.0 Chrome/130';
    this.bridgeName = options.bridgeName ?? 'mock';
    this.pageUrl = options.pageUrl ?? 'http://mock.local/';
    this.targetId = options.targetId ?? 'mock-page';
    this.bridge = { readValue: async () => ({ value: 42 }) };
    this.delay = 0;
    this.delayByMethod = new Map();
    this.hangMethods = new Set();
    this.dropMethods = new Set();
    this.sessions = new Map();
    this.sockets = new Set();
    this.messages = [];
    this.attachments = [];
    this.detaches = [];
    this.pending = 0;
    this.port = undefined;
    this.http = undefined;
    this.wss = undefined;
    this.generation = 0;
    this.objectContexts = new Map();
    this.maxPayload = options.maxPayload ?? 1024 * 1024;
    this.maxLogEntries = options.maxLogEntries ?? 2000;
    this.closeWaiters = [];
  }

  get endpoint() {
    if (!this.port) throw new Error('Mock CDP server has not started');
    return `http://127.0.0.1:${this.port}`;
  }

  get webSocketDebuggerUrl() {
    if (!this.port) throw new Error('Mock CDP server has not started');
    return `ws://127.0.0.1:${this.port}/devtools/browser/${this.id}`;
  }

  get activeSessionCount() { return this.sessions.size; }
  get openConnectionCount() { return this.sockets.size; }

  stats() {
    return {
      pending: this.pending,
      activeSessions: this.sessions.size,
      openConnections: this.sockets.size,
      attaches: this.attachments.length,
      detaches: this.detaches.length,
      messages: this.messages.length,
    };
  }

  clearLogs() {
    this.messages.length = 0;
    this.attachments.length = 0;
    this.detaches.length = 0;
  }

  setBridge(bridge) {
    this.bridge = { ...this.bridge, ...bridge };
  }

  setDelay(delay, method) {
    if (method) this.delayByMethod.set(method, delay);
    else this.delay = delay;
  }

  setHang(method, enabled = true) {
    if (enabled) this.hangMethods.add(method);
    else this.hangMethods.delete(method);
  }

  setDrop(method, enabled = true) {
    if (enabled) this.dropMethods.add(method);
    else this.dropMethods.delete(method);
  }

  async start() {
    if (this.http) return this;
    this.id = randomUUID();
    this.http = createServer((request, response) => this.#httpRequest(request, response));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayload });
    this.http.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/devtools/browser/')) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, ws => this.#connection(ws));
    });
    this.http.listen(this.requestedPort, '127.0.0.1');
    await once(this.http, 'listening');
    this.port = this.http.address().port;
    return this;
  }

  async stop() {
    if (!this.http) return;
    for (const socket of this.sockets) socket.close();
    this.sessions.clear();
    this.objectContexts.clear();
    this.wss.close();
    this.http.close();
    await once(this.http, 'close').catch(() => {});
    await this.waitForClose();
    this.sockets.clear();
    this.http = undefined;
    this.wss = undefined;
  }

  async waitForClose(timeout = 1000) {
    if (!this.sockets.size) return;
    await new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        this.closeWaiters = this.closeWaiters.filter(waiter => waiter !== done);
        resolve();
      };
      timer = setTimeout(done, timeout);
      this.closeWaiters.push(done);
    });
  }

  #httpRequest(request, response) {
    const headers = { 'content-type': 'application/json; charset=utf-8' };
    if (request.url === '/json/version') {
      response.writeHead(200, headers);
      response.end(JSON.stringify({
        Browser: this.userAgent,
        'User-Agent': this.userAgent,
        webSocketDebuggerUrl: this.webSocketDebuggerUrl,
      }));
      return;
    }
    if (request.url === '/json/list') {
      response.writeHead(200, headers);
      response.end(JSON.stringify([{
        id: this.targetId,
        type: 'page',
        url: this.pageUrl,
        title: 'Mock App',
        webSocketDebuggerUrl: this.webSocketDebuggerUrl,
      }]));
      return;
    }
    response.writeHead(404, headers);
    response.end(JSON.stringify({ error: 'not found' }));
  }

  #connection(socket) {
    this.sockets.add(socket);
    socket.on('message', data => {
      let request;
      try { request = JSON.parse(data.toString()); }
      catch { socket.close(1003, 'invalid JSON'); return; }
      this.#request(socket, request);
    });
    socket.on('close', () => {
      this.sockets.delete(socket);
      for (const [sessionId, session] of this.sessions) {
        if (session.socket === socket) this.sessions.delete(sessionId);
      }
      if (!this.sockets.size) for (const done of this.closeWaiters.splice(0)) done();
    });
  }

  #request(socket, request) {
    this.messages.push({ ...request, receivedAt: Date.now() });
    if (this.messages.length > this.maxLogEntries) this.messages.splice(0, this.messages.length - this.maxLogEntries);
    const { id, method } = request;
    if (this.dropMethods.has(method)) {
      this.dropMethods.delete(method);
      socket.close(1011, `dropped ${method}`);
      return;
    }
    if (this.hangMethods.has(method)) return;
    this.pending++;
    const delay = this.delayByMethod.get(method) ?? this.delay;
    setTimeout(async () => {
      try {
        const result = await this.#dispatch(socket, request);
        if (socket.readyState === WebSocket.OPEN) {
          const message = JSON.stringify({ id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
          if (this.fragmentBytes && method === 'Runtime.callFunctionOn') {
            const data = Buffer.from(message);
            for (let offset = 0; offset < data.length; offset += this.fragmentBytes) {
              const end = Math.min(offset + this.fragmentBytes, data.length);
              socket.send(data.subarray(offset, end), { binary: false, fin: end === data.length });
            }
          } else socket.send(message);
        }
      } catch (error) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ id, error: { code: -32000, message: error.message } }));
        }
      } finally {
        this.pending--;
      }
    }, delay);
  }

  async #dispatch(socket, request) {
    const { method, params = {} } = request;
    if (method === 'Target.getTargets') {
      return { targetInfos: [{ targetId: this.targetId, type: 'page', url: this.pageUrl }] };
    }
    if (method === 'Target.attachToTarget') {
      const sessionId = `mock-session-${++this.generation}`;
      this.sessions.set(sessionId, { socket, targetId: params.targetId });
      this.attachments.push(sessionId);
      return { sessionId };
    }
    if (method === 'Target.detachFromTarget') {
      this.sessions.delete(params.sessionId);
      this.detaches.push(params.sessionId);
      return {};
    }
    if (method === 'Runtime.evaluate') return this.#evaluate(params);
    if (method === 'Runtime.callFunctionOn') return this.#callFunction(params);
    if (method === 'Runtime.releaseObjectGroup') {
      for (const [objectId, object] of this.objectContexts) {
        if (!params.objectGroup || object.group === params.objectGroup) this.objectContexts.delete(objectId);
      }
      return {};
    }
    throw new Error(`Unsupported CDP method: ${method}`);
  }

  #context() {
    const bridge = {};
    for (const [name, value] of Object.entries(this.bridge)) {
      bridge[name] = typeof value === 'function' ? (...args) => value(...args) : value;
    }
    const window = { [this.bridgeName]: bridge };
    return vm.createContext({ window, globalThis: window, console });
  }

  async #evaluate(params) {
    const { expression } = params;
    if (typeof expression !== 'string') throw new Error('Runtime.evaluate requires an expression');
    const context = this.#context();
    const value = await vm.runInContext(expression, context);
    if (params.returnByValue === false && value && typeof value === 'object') {
      const objectId = `mock-object-${++this.generation}`;
      this.objectContexts.set(objectId, { context, group: params.objectGroup });
      return { result: { type: 'object', objectId, description: 'globalThis' } };
    }
    return { result: { type: value === null ? 'object' : typeof value, value } };
  }

  async #callFunction(params) {
    if (typeof params.functionDeclaration !== 'string') throw new Error('Runtime.callFunctionOn requires functionDeclaration');
    const context = this.objectContexts.get(params.objectId)?.context ?? this.#context();
    const fn = vm.runInContext(`(${params.functionDeclaration})`, context);
    if (typeof fn !== 'function') throw new Error('functionDeclaration did not produce a function');
    const values = (params.arguments ?? []).map(argument => argument.value);
    const value = await fn(...values);
    return { result: { type: value === null ? 'object' : typeof value, value } };
  }
}

export function manifestFor(mock, overrides = {}) {
  return {
    name: 'mock',
    endpoint: mock.endpoint,
    userAgentIncludes: 'MockApp/',
    bridge: 'window.mock',
    limits: {
      requestTimeoutMs: 300,
      connectTimeoutMs: 500,
      maxQueue: 4,
      idleTimeoutMs: 100,
      maxResponseBytes: 65536,
    },
    supportedVersions: ['1.0'],
    ...overrides,
  };
}
