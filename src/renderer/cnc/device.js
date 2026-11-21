// Machine controller for GRBL-family firmware (GRBL 1.1, grblHAL, FluidNC).
// Lines are streamed with character counting: as many as fit in the controller's receive buffer
// are kept in flight, and each "ok" frees the room its line took.
import { cleanLines } from './gcode.js';
import { explainError, explainAlarm } from './grblcodes.js';

const enc = new TextEncoder();
const PAUSE = /M0*[016](?!\d)/; // M0 / M1 program pause and M6 tool change are handled here, not sent
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- transports
/** USB / serial port (Web Serial). */
export class SerialTransport {
  constructor(baud = 115200) { this.baud = baud; this.label = 'USB'; }
  static get supported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
  async open() {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: this.baud });
    this.writer = this.port.writable.getWriter();
    this.live = true;
    this._read();
  }
  async _read() {
    const dec = new TextDecoder();
    let err = null;
    try {
      this.reader = this.port.readable.getReader();
      for (;;) { const { value, done } = await this.reader.read(); if (done) break; if (this.ondata) this.ondata(dec.decode(value, { stream: true })); }
    } catch (e) { err = e; } finally {
      try { this.reader.releaseLock(); } catch { /* ignore */ }
      if (this.live && this.onclose) this.onclose(err);
    }
  }
  write(bytes) { return this.writer.write(bytes); }
  async close() {
    this.live = false;
    try { if (this.reader) await this.reader.cancel(); } catch { /* ignore */ }
    try { if (this.writer) this.writer.releaseLock(); } catch { /* ignore */ }
    try { if (this.port) await this.port.close(); } catch { /* ignore */ }
  }
}

/** Network controller that talks over a WebSocket (FluidNC, ESP3D, grblHAL web builds). */
export class WebSocketTransport {
  constructor(url) { this.url = /^wss?:\/\//.test(url) ? url : 'ws://' + url; this.label = this.url.replace(/^wss?:\/\//, ''); }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, ['arduino']);
      ws.binaryType = 'arraybuffer';
      const dec = new TextDecoder();
      let opened = false;
      ws.onopen = () => { opened = true; this.ws = ws; resolve(); };
      ws.onmessage = (e) => { if (this.ondata) this.ondata(typeof e.data === 'string' ? e.data : dec.decode(e.data, { stream: true })); };
      ws.onerror = () => { if (!opened) reject(new Error('Could not reach ' + this.label)); };
      ws.onclose = () => { if (opened && this.live !== false && this.onclose) this.onclose(null); };
    });
  }
  write(bytes) { if (this.ws && this.ws.readyState === 1) this.ws.send(bytes); }
  async close() { this.live = false; try { this.ws.close(); } catch { /* ignore */ } }
}

/** Network controller on a plain TCP port (grblHAL telnet, serial-to-network bridges). Desktop app only. */
export class TcpTransport {
  constructor(platform, host, port) { this.p = platform; this.host = host; this.port = port; this.label = `${host}:${port}`; }
  async open() {
    const dec = new TextDecoder();
    this.p.onTcpData((bytes) => { if (this.ondata && this.live) this.ondata(dec.decode(bytes, { stream: true })); });
    this.p.onTcpClose((msg) => { if (this.live && this.onclose) this.onclose(msg ? new Error(msg) : null); });
    const res = await this.p.tcpConnect(this.host, this.port);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not reach ' + this.label);
    this.live = true;
  }
  write(bytes) { return this.p.tcpWrite(bytes); }
  async close() { this.live = false; await this.p.tcpClose(); }
}

// ---------------------------------------------------------------- device
export class CncDevice {
  constructor() {
    this.listeners = {};
    this.connected = false;
    this._clear();
  }

  _clear() {
    this.status = { state: 'Disconnected', sub: '', mpos: [0, 0, 0], wpos: [0, 0, 0], wco: [0, 0, 0], feed: 0, speed: 0, ov: [100, 100, 100], pins: '', acc: '', known: false };
    this.inflight = [];
    this.manual = [];
    this.used = 0;
    this.rxSize = 127;
    this.settings = {};
    this.info = { version: '', options: '', banner: '' };
    this.lastProbe = null;
    this.alarm = null;
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, data) { for (const fn of this.listeners[evt] || []) fn(data); }

  async connect(transport) {
    if (this.connected) await this.disconnect();
    this._clear();
    this.transport = transport;
    this._in = '';
    transport.ondata = (text) => this._feed(text);
    transport.onclose = (err) => { if (this.connected) { this.emit('line', { text: 'Connection lost' + (err ? ': ' + (err.message || err) : ''), kind: 'error' }); this.disconnect(); } };
    this.status.state = 'Connecting';
    this.emit('status', this.status);
    await transport.open();
    this.connected = true;
    this.emit('connection', true);
    this.poll = setInterval(() => this.realtime('?'), 200);
    // boards that restart when the port opens announce themselves; the others are asked after a moment
    // (a controller that has already announced itself while the port was opening has its own query on the way)
    if (!this.info.banner) { clearTimeout(this._hello); this._hello = setTimeout(() => this._query(), 2500); }
    this._write('\r\n');
  }

  async disconnect() {
    clearInterval(this.poll);
    clearTimeout(this._hello);
    const was = this.connected;
    // never walk away from a machine that is still cutting: hold and reset it first
    if (was && this.transport && (this.job || ['Run', 'Jog', 'Home'].includes(this.status.state))) { this.realtime('!'); this.realtime(0x18); }
    this.connected = false;
    this._abort('Disconnected');
    try { if (this.transport) await this.transport.close(); } catch { /* ignore */ }
    this.transport = null;
    this._clear();
    if (was) this.emit('connection', false);
    this.emit('status', this.status);
  }

  _query() {
    if (!this.connected) return;
    this.send('$I', { echo: false }).catch(() => {});
    this.send('$$', { echo: false }).catch(() => {});
    this.send('$G', { echo: false }).catch(() => {});
  }

  _write(data) {
    if (!this.transport) return;
    try { const r = this.transport.write(typeof data === 'string' ? enc.encode(data) : data); if (r && r.catch) r.catch((err) => this.emit('line', { text: 'Write failed: ' + (err.message || err), kind: 'error' })); }
    catch (err) { this.emit('line', { text: 'Write failed: ' + (err.message || err), kind: 'error' }); }
  }

  /** Real-time command: a single character or byte the controller acts on at once. */
  realtime(c) { if (this.connected) this._write(typeof c === 'number' ? new Uint8Array([c]) : c); }

  _feed(text) {
    this._in += text;
    let idx;
    while ((idx = this._in.search(/[\r\n]/)) >= 0) {
      const line = this._in.slice(0, idx).trim();
      this._in = this._in.slice(idx + 1);
      if (line) this._onLine(line);
    }
  }

  _onLine(line) {
    if (line[0] === '<' && line.endsWith('>')) return this._parseStatus(line);
    if (line === 'ok' || line.startsWith('error')) {
      const item = this.inflight.shift();
      if (item) this.used -= item.len;
      if (line !== 'ok') {
        const code = parseInt(line.split(':')[1], 10);
        const why = explainError(code);
        this.emit('line', { text: `${line}: ${why}${item ? '  (' + item.line + ')' : ''}`, kind: 'error' });
        if (item && item.job && this.job && this.job.state === 'running') {
          this.job.errors.push({ code, line: item.line, n: item.n, why });
          this.realtime('!');
          this.job.state = 'held';
          this.emit('jobpause', { reason: 'error', code, why, line: item.line, n: item.n });
        }
      }
      if (item && line === 'ok') {
        // a setting that was just written is now the controller's value, wherever it was typed
        const set = /^\$(\d+)=(\S+)$/.exec(item.line);
        if (set) { this.settings[+set[1]] = set[2]; clearTimeout(this._setT); this._setT = setTimeout(() => this.emit('settings', this.settings), 60); }
      }
      if (item) {
        if (item.job && this.job) { this.job.acked += 1; this.job.idleSeen = 0; this.emit('progress', this.job); }
        if (item.resolve) item.resolve(line);
      }
      this._pump();
      this._jobTick();
      return;
    }
    if (line.startsWith('ALARM')) {
      const code = parseInt(line.split(':')[1], 10);
      this.alarm = { code, ...explainAlarm(code) };
      this.emit('line', { text: `${line}: ${this.alarm.what}`, kind: 'error' });
      this._abort('Alarm: ' + this.alarm.what);
      this.emit('alarm', this.alarm);
      return;
    }
    if (/^Grbl\s|^GrblHAL\s|^\[?FluidNC/i.test(line) && /\d/.test(line)) {
      // start-up banner: the controller has (re)started, so nothing in flight will ever be answered
      this.info.banner = line;
      this.emit('line', { text: line, kind: 'in' });
      this._abort('Controller reset');
      clearTimeout(this._hello);
      this._hello = setTimeout(() => this._query(), 400);
      return;
    }
    if (line[0] === '[') {
      const body = line.slice(1, -1);
      if (body.startsWith('PRB:')) {
        const [nums, ok] = body.slice(4).split(':');
        this.lastProbe = { mpos: nums.split(',').map(Number), ok: ok === '1' };
        this.emit('probe', this.lastProbe);
      } else if (body.startsWith('VER:')) this.info.version = body.slice(4).split(':')[0];
      else if (body.startsWith('OPT:')) {
        this.info.options = body.slice(4);
        const rx = parseInt(body.split(',')[2], 10);
        if (rx >= 64) this.rxSize = Math.min(rx - 1, 1023);
      } else if (body.startsWith('GC:')) { this.modal = body.slice(3); this.emit('modal', this.modal); }
      if (!body.startsWith('GC:')) this.emit('line', { text: line, kind: 'in' });
      if (body.startsWith('VER:') || body.startsWith('OPT:')) this.emit('info', this.info);
      return;
    }
    const set = /^\$(\d+)=([^\s(]+)/.exec(line);
    if (set) { this.settings[+set[1]] = set[2]; clearTimeout(this._setT); this._setT = setTimeout(() => this.emit('settings', this.settings), 60); return; }
    this.emit('line', { text: line, kind: 'in' });
  }

  _parseStatus(line) {
    const parts = line.slice(1, -1).split('|');
    const st = this.status;
    const [state, sub = ''] = parts[0].split(':');
    st.state = state; st.sub = sub; st.known = true;
    let m = null, w = null;
    st.pins = '';
    for (const p of parts.slice(1)) {
      const i = p.indexOf(':'), k = p.slice(0, i), v = p.slice(i + 1);
      if (k === 'MPos') m = v.split(',').map(Number);
      else if (k === 'WPos') w = v.split(',').map(Number);
      else if (k === 'WCO') st.wco = v.split(',').map(Number);
      else if (k === 'FS') { const a = v.split(',').map(Number); st.feed = a[0]; st.speed = a[1] || 0; }
      else if (k === 'F') st.feed = Number(v);
      else if (k === 'Ov') { st.ov = v.split(',').map(Number); if (!parts.some((x) => x.startsWith('A:'))) st.acc = ''; }
      else if (k === 'Pn') st.pins = v;
      else if (k === 'A') st.acc = v;
    }
    if (m) { st.mpos = m; st.wpos = m.map((x, i) => x - (st.wco[i] || 0)); }
    else if (w) { st.wpos = w; st.mpos = w.map((x, i) => x + (st.wco[i] || 0)); }
    if (state !== 'Alarm') this.alarm = null;
    // fresh "idle" reports since the last line was acknowledged: a move that has only just been queued is not "done"
    this.reports = (this.reports || 0) + 1;
    if (this.job) { if ((state === 'Idle' || state === 'Check') && !this.inflight.some((x) => x.job)) this.job.idleSeen += 1; else this.job.idleSeen = 0; }
    this.emit('status', st);
    this._jobTick();
  }

  // ---------------------------------------------------------------- sending
  _pump() {
    if (!this.connected) return;
    for (;;) {
      let item = this.manual[0], fromJob = false;
      if (!item) { item = this._nextJobLine(); fromJob = true; }
      if (!item) return;
      // "$" commands may write to the controller's memory, which can drop characters: send them alone
      const solo = item.line[0] === '$' && !item.line.startsWith('$J=');
      if (this.inflight.some((x) => x.solo) || (solo && this.inflight.length)) return;
      const len = item.line.length + 1;
      if (this.inflight.length && this.used + len > this.rxSize - 4) return;
      if (fromJob) this.job.next += 1; else this.manual.shift();
      this.used += len;
      this.inflight.push({ ...item, len, solo, job: fromJob });
      this._write(item.line + '\n');
      if (item.echo) this.emit('line', { text: item.line, kind: 'out' });
    }
  }

  /** Queue one command; resolves with the controller's reply ("ok", "error:N" or "aborted"). */
  send(line, { echo = true } = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    if (this.job && this.job.state === 'running') return Promise.reject(new Error('A job is running'));
    return new Promise((resolve) => { this.manual.push({ line: String(line).trim(), resolve, echo }); this._pump(); });
  }

  /** Send several lines in order and wait for them all. Stops at the first error. */
  async sendAll(lines, opts) {
    for (const line of lines) { const r = await this.send(line, opts); if (r !== 'ok') return r; }
    return 'ok';
  }

  /** Wait until the machine has stopped moving and has nothing left to do. */
  async idle(timeout = 120000) {
    const t0 = Date.now();
    let seen = 0;
    // two fresh reports in a row, so a move that has only just been queued is not missed
    const tick = (st) => { seen = st.state === 'Idle' || st.state === 'Check' ? seen + 1 : 0; };
    this.on('status', tick);
    try {
      for (;;) {
        if (!this.connected) return false;
        if (seen >= 2 && !this.inflight.length && !this.manual.length) return true;
        if (this.status.state === 'Alarm' || Date.now() - t0 > timeout) return false;
        await delay(30);
      }
    } finally { this.listeners.status = this.listeners.status.filter((f) => f !== tick); }
  }

  /** Run a probe move (for example "G38.2 Z-25 F100"). Resolves with { ok, mpos, wpos } or null. */
  async probe(line) {
    this.lastProbe = null;
    const reply = await this.send(line);
    if (reply !== 'ok' || !this.lastProbe) return null;
    return { ...this.lastProbe, wpos: this.lastProbe.mpos.map((v, i) => v - (this.status.wco[i] || 0)) };
  }

  // ---------------------------------------------------------------- jobs
  _nextJobLine() {
    const job = this.job;
    if (!job || job.state !== 'running' || job.waiting) return null;
    while (job.next < job.lines.length) {
      const l = job.lines[job.next];
      if (PAUSE.test(l.text) && l.text[0] !== '$') {
        const tool = /T(\d+)/.exec(l.text);
        job.waiting = { reason: /M0*6(?!\d)/.test(l.text) ? 'toolchange' : 'pause', tool: tool ? +tool[1] : null, comment: l.comment || '', n: l.n };
        return null;
      }
      return { line: l.text, n: l.n };
    }
    return null;
  }

  _jobTick() {
    const job = this.job;
    if (!job) return;
    const quiet = !this.inflight.some((x) => x.job) && (this.status.state === 'Idle' || this.status.state === 'Check');
    if (job.waiting && job.state === 'running' && quiet && job.idleSeen >= 2) {
      // everything before the pause has been cut: hand over to the operator
      const info = job.waiting;
      job.waiting = null;
      job.next += 1;
      job.acked += 1;
      job.state = 'paused';
      this.emit('progress', job);
      this.emit('jobpause', info);
      return;
    }
    if (job.state === 'running' && job.next >= job.lines.length && quiet && job.idleSeen >= 2) this._finish(null);
  }

  _finish(reason) {
    const job = this.job;
    if (!job) return;
    this.job = null;
    job.state = reason ? 'stopped' : 'done';
    job.ended = Date.now();
    this.emit('job', null);
    job.resolve({ done: !reason, reason, sent: job.acked, total: job.lines.length, errors: job.errors, seconds: (job.ended - job.started) / 1000 });
  }

  /**
   * Stream a program. `source` is G-code text or lines already prepared by cleanLines().
   * Resolves { done, reason, sent, total, errors, seconds }.
   */
  run(source, { preamble = [] } = {}) {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    if (this.job) return Promise.reject(new Error('A job is already running'));
    const lines = [...preamble.map((text) => ({ text, n: 0, comment: '' })), ...(typeof source === 'string' ? cleanLines(source) : source)];
    return new Promise((resolve) => {
      this.job = { lines, next: 0, acked: 0, errors: [], state: 'running', waiting: null, idleSeen: 0, started: Date.now(), resolve };
      this.emit('job', this.job);
      this.emit('progress', this.job);
      this._pump();
    });
  }

  /** Feed hold. The machine slows to a stop and keeps its place. */
  pause() {
    this.realtime('!');
    if (this.job && this.job.state === 'running') { this.job.state = 'held'; this.emit('progress', this.job); }
  }

  /** Carry on after a feed hold, a program pause or a tool change. */
  resume() {
    this.realtime('~');
    const job = this.job;
    if (job && (job.state === 'held' || job.state === 'paused')) { job.state = 'running'; job.idleSeen = 0; this.emit('progress', job); this._pump(); }
  }

  /** Stop now: slow to a halt, then reset the controller (spindle off, buffer emptied). */
  async stop() {
    if (!this.connected) return;
    const waiting = this.manual;
    this.manual = [];
    for (const w of waiting) if (w.resolve) w.resolve('aborted');
    if (this.job) this.job.state = 'stopping';
    this.realtime('!');
    // resetting a controller that is still moving loses its position: wait for fresh reports that say it has stopped
    const from = this.reports || 0;
    const still = () => (this.reports || 0) >= from + 2 && (['Idle', 'Check', 'Alarm', 'Sleep'].includes(this.status.state) || (this.status.state === 'Hold' && this.status.sub !== '1'));
    for (let i = 0; i < 80 && this.connected && !still(); i++) await delay(50);
    this.realtime(0x18);
    this._abort('Stopped');
  }

  _abort(reason) {
    const waiting = [...this.inflight, ...this.manual];
    this.inflight = [];
    this.manual = [];
    this.used = 0;
    for (const w of waiting) if (w.resolve) w.resolve('aborted');
    if (this.job) this._finish(reason);
  }

  // ---------------------------------------------------------------- everyday commands
  home() { return this.send('$H'); }
  unlock() { return this.send('$X'); }
  reset() { this.realtime(0x18); this._abort('Reset'); }
  /** Relative jog in mm. */
  jog(d, feed) {
    const words = ['X', 'Y', 'Z'].map((a, i) => (d[i] ? `${a}${+d[i].toFixed(4)}` : '')).join('');
    if (!words) return Promise.resolve('ok');
    return this.send(`$J=G91G21${words}F${Math.round(feed)}`, { echo: false });
  }
  /** Stop jogging, including jogs that are still waiting to be sent. */
  jogCancel() {
    const jogs = this.manual.filter((m) => m.line.startsWith('$J='));
    this.manual = this.manual.filter((m) => !m.line.startsWith('$J='));
    for (const j of jogs) if (j.resolve) j.resolve('aborted');
    this.realtime(0x85);
  }
  /** Is anything other than a jog waiting for, or in front of, the controller? */
  get busy() { return this.manual.some((m) => !m.line.startsWith('$J=')) || this.inflight.some((m) => !m.line.startsWith('$J=')); }
  /** Set the work position of the given axes at the current spot (default: make it zero). */
  setZero(axes = 'XYZ', value = 0) { return this.send(`G10 L20 P1 ${[...axes].map((a) => `${a}${value}`).join(' ')}`); }
  feedOverride(step) { this.realtime({ reset: 0x90, '+10': 0x91, '-10': 0x92, '+1': 0x93, '-1': 0x94 }[step]); }
  rapidOverride(pct) { this.realtime({ 100: 0x95, 50: 0x96, 25: 0x97 }[pct]); }
  spindleOverride(step) { this.realtime({ reset: 0x99, '+10': 0x9a, '-10': 0x9b, '+1': 0x9c, '-1': 0x9d }[step]); }
  toggleFlood() { this.realtime(0xa0); }
  toggleMist() { this.realtime(0xa1); }
}
