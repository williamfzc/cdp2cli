// Adds bounded output buffering to the official MCP stdio transport.
// A stalled client is disconnected instead of accumulating responses/listeners.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export class BoundedStdioTransport extends StdioServerTransport {
  constructor(stdin, stdout, { maxBytes = 1048576, maxFrames = 34, timeoutMs = 5000 } = {}) {
    super(stdin, stdout, { maxBufferSize: maxBytes });
    this.output = stdout;
    this.maxBytes = maxBytes;
    this.maxFrames = maxFrames;
    this.timeoutMs = timeoutMs;
    this.frames = [];
    this.bufferedBytes = 0;
    this.sending = false;
    this.stopped = false;
    this.outputError = () => { this.close().catch(() => {}); };
    this.output.on('error', this.outputError);
    this.output.once('close', () => this.output.off('error', this.outputError));
  }

  send(message) {
    if (this.stopped) return Promise.reject(new Error('Transport closed.'));
    const text = JSON.stringify(message) + '\n';
    const bytes = Buffer.byteLength(text);
    if (bytes > this.maxBytes || this.frames.length >= this.maxFrames || this.bufferedBytes + bytes > this.maxBytes * 2) {
      this.close().catch(() => {});
      return Promise.reject(new Error('MCP output buffer limit reached; client disconnected.'));
    }
    return new Promise((resolve, reject) => {
      this.frames.push({ text, bytes, resolve, reject });
      this.bufferedBytes += bytes;
      this.flush();
    });
  }

  flush() {
    if (this.sending || !this.frames.length || this.stopped) return;
    this.sending = true;
    const frame = this.frames[0];
    this.outputTimer = setTimeout(() => this.close().catch(() => {}), this.timeoutMs);
    this.outputTimer.unref();
    this.output.write(frame.text, error => {
      if (this.stopped) return;
      clearTimeout(this.outputTimer);
      this.frames.shift();
      this.bufferedBytes -= frame.bytes;
      this.sending = false;
      if (error) { frame.reject(error); this.close().catch(() => {}); }
      else { frame.resolve(); this.flush(); }
    });
  }

  async close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.outputTimer);
    for (const frame of this.frames.splice(0)) frame.reject(new Error('MCP transport closed.'));
    this.bufferedBytes = 0;
    this.sending = false;
    // Own the stdio stream: destruction frees a write blocked by a departed client.
    this.output.destroy();
    await super.close();
  }
}
