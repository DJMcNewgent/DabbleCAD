// GRBL-compatible laser controller over a serial port (Web Serial).
// Lines are streamed one at a time and each waits for the controller's "ok".

export class LaserDevice {
  constructor() {
    this.port = null;
    this.connected = false;
    this.queue = [];
    this.pending = null;
    this.job = null;
    this.status = { state: 'Disconnected', mpos: null, wpos: null };
    this.listeners = {};
    this.wco = [0, 0, 0];
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, data) { for (const fn of this.listeners[evt] || []) fn(data); }
  get supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }

  async connect(baudRate = 115200) {
    if (!this.supported) throw new Error('Serial ports are not available in this environment');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    this.port = port;
    this.connected = true;
    this.writer = port.writable.getWriter();
    this.encoder = new TextEncoder();
    this._readLoop();
    this.poll = setInterval(() => { if (this.connected) this._raw('?'); }, 400);
    this.status = { state: 'Connecting', mpos: null, wpos: null };
    this.emit('connection', true);
    this.emit('status', this.status);
    setTimeout(() => { if (this.connected) this._raw('\r\n'); }, 300);
  }

  async disconnect() {
    clearInterval(this.poll);
    // never walk away from a machine that is still working: hold it and reset it (beam off) first
    if (this.connected && this.job) { await this._raw('!'); await this._raw('\x18'); }
    this.connected = false;
    this._abortJob('Disconnected');
    try { if (this.reader) await this.reader.cancel(); } catch { /* ignore */ }
    try { if (this.writer) this.writer.releaseLock(); } catch { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch { /* ignore */ }
    this.port = null;
    this.queue = [];
    this.pending = null;
    this.status = { state: 'Disconnected', mpos: null, wpos: null };
    this.emit('connection', false);
    this.emit('status', this.status);
  }

  async _readLoop() {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      this.reader = this.port.readable.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.search(/\r?\n/)) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(buf[idx] === '\r' ? idx + 2 : idx + 1);
          if (line) this._onLine(line);
        }
      }
    } catch (err) {
      if (this.connected) this.emit('line', { text: 'Connection lost: ' + (err.message || err), kind: 'error' });
    } finally {
      try { this.reader.releaseLock(); } catch { /* ignore */ }
      if (this.connected) this.disconnect();
    }
  }

  _onLine(line) {
    if (line.startsWith('<') && line.endsWith('>')) { this._parseStatus(line); return; }
    if (line === 'ok' || line.startsWith('error')) {
      const p = this.pending;
      this.pending = null;
      if (line !== 'ok') this.emit('line', { text: `${line}${p ? '  (' + p.line + ')' : ''}`, kind: 'error' });
      if (p) p.resolve(line);
      this._pump();
      return;
    }
    if (line.startsWith('ALARM')) { this.emit('line', { text: line, kind: 'error' }); this._abortJob(line); return; }
    if (/^Grbl \d/i.test(line)) {
      // start-up banner: the controller has just reset, so nothing in flight will ever be acknowledged
      this.emit('line', { text: line, kind: 'in' });
      if (this.job || this.pending || this.queue.length) { this.emit('line', { text: 'Controller reset', kind: 'error' }); this._abortJob('Controller reset'); }
      return;
    }
    this.emit('line', { text: line, kind: 'in' });
  }

  _parseStatus(line) {
    const parts = line.slice(1, -1).split('|');
    const st = { state: parts[0], mpos: null, wpos: null };
    for (const p of parts.slice(1)) {
      const [k, v] = p.split(':');
      const nums = (v || '').split(',').map(Number);
      if (k === 'MPos') st.mpos = nums;
      else if (k === 'WPos') st.wpos = nums;
      else if (k === 'WCO') this.wco = nums;
    }
    if (st.mpos && !st.wpos) st.wpos = st.mpos.map((v, i) => v - (this.wco[i] || 0));
    if (st.wpos && !st.mpos) st.mpos = st.wpos.map((v, i) => v + (this.wco[i] || 0));
    this.status = st;
    this.emit('status', st);
  }

  async _raw(text) {
    if (!this.connected || !this.writer) return;
    try { await this.writer.write(this.encoder.encode(text)); } catch (err) {
      this.emit('line', { text: 'Write failed: ' + (err.message || err), kind: 'error' });
      // a line that never reached the controller will never be answered: end the job rather than wait for ever
      if (this.job || this.pending) this._abortJob('Write failed');
    }
  }

  _pump() {
    if (this.pending || !this.queue.length || !this.connected) return;
    this.pending = this.queue.shift();
    this._raw(this.pending.line + '\n');
    if (this.pending.echo) this.emit('line', { text: this.pending.line, kind: 'out' });
  }

  /** Queue one command line; resolves with the controller's reply ("ok" / "error:N"). */
  send(line, echo = true) {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve) => { this.queue.push({ line, resolve, echo }); this._pump(); });
  }

  /** Stream a whole program. Resolves { done, sent, total, reason }. */
  async run(gcode, onProgress) {
    if (this.job) throw new Error('A job is already running');
    const lines = gcode.split('\n').map((l) => l.replace(/;.*$/, '').trim()).filter(Boolean);
    const job = { total: lines.length, sent: 0, aborted: null, started: Date.now() };
    this.job = job;
    this.emit('job', job);
    for (const line of lines) {
      if (job.aborted) break;
      const reply = await this.send(line, false);
      if (job.aborted) break;
      job.sent += 1;
      if (reply !== 'ok') job.errors = (job.errors || 0) + 1;
      if (onProgress && (job.sent % 20 === 0 || job.sent === job.total)) onProgress(job);
    }
    this.job = null;
    this.emit('job', null);
    return { done: !job.aborted, sent: job.sent, total: job.total, reason: job.aborted, errors: job.errors || 0 };
  }

  _abortJob(reason) {
    if (this.job) this.job.aborted = reason;
    const waiting = [this.pending, ...this.queue].filter(Boolean);
    this.queue = [];
    this.pending = null;
    for (const w of waiting) w.resolve('aborted');
  }

  pause() { this._raw('!'); }
  resume() { this._raw('~'); }
  /** Stop immediately: feed hold, then soft reset (laser off), then clear the queue. */
  async stop() {
    this._abortJob('Stopped');
    await this._raw('!');
    await new Promise((r) => setTimeout(r, 120));
    await this._raw('\x18');
    setTimeout(() => { if (this.connected) this.send('M5', false).catch(() => {}); }, 800);
  }

  home() { return this.send('$H'); }
  unlock() { return this.send('$X'); }
  jog(dx, dy, feed) { return this.send(`$J=G91 G21 X${dx} Y${dy} F${feed}`, false); }
  jogCancel() { this._raw('\x85'); }
}
