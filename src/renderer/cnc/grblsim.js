// A pretend GRBL 1.1 controller. It speaks the same serial protocol as the real thing, so the
// whole Machine panel can be tried (and tested) with nothing plugged in.

const enc = new TextEncoder();
const WORD = /([A-Z])(-?\d*\.?\d+)/g;
const DEFAULTS = {
  0: 10, 1: 25, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 10: 1, 11: 0.01, 12: 0.002, 13: 0, 20: 0, 21: 0, 22: 0, 23: 0, 24: 25, 25: 500, 26: 250, 27: 1,
  30: 24000, 31: 0, 32: 0, 100: 80, 101: 80, 102: 400, 110: 5000, 111: 5000, 112: 1500, 120: 500, 121: 500, 122: 200, 130: 600, 131: 600, 132: 100,
};

export class GrblSim {
  /** speed: 1 = real time; a very large value finishes every move at once (used by the tests). */
  constructor(opts = {}) {
    this.speed = opts.speed ?? 1;
    this.settings = { ...DEFAULTS, ...(opts.settings || {}) };
    // where a probe move makes contact, in machine coordinates (moving towards the value)
    this.probeAt = { x: null, y: null, z: -30, ...(opts.probeAt || {}) };
    this.ondata = null;
    this.onclose = null;
    this.label = 'Demo machine';
    this.cutLength = 0;
    this.executed = 0;
    this.history = [];
    this._out = '';
    this._buf = '';
    this.mpos = [0, 0, 0];
    this.g54 = [0, 0, 0];
    this.g92 = [0, 0, 0];
  }

  async open() {
    this._last = performance.now();
    this.timer = setInterval(() => this._tick(), 40);
    this._boot(false);
  }
  async close() { clearInterval(this.timer); this.timer = null; }

  _say(text) {
    this._out += text + '\r\n';
    if (this._flushing) return;
    this._flushing = true;
    queueMicrotask(() => { this._flushing = false; const t = this._out; this._out = ''; if (this.ondata && this.timer) this.ondata(t); });
  }

  _boot(wasMoving) {
    this.queue = [];
    this.rxq = [];
    this.holding = false;
    this.check = false;
    this.modal = { unit: 1, abs: true, motion: 0, feed: 0, spindle: 5, speed: 0, mist: false, flood: false, tool: 0 };
    this.ov = [100, 100, 100];
    this.reports = 0;
    this.state = 'Idle';
    this._say("\r\nGrbl 1.1h ['$' for help]");
    if (wasMoving) { this.state = 'Alarm'; this._say('ALARM:3'); this._say("[MSG:'$H'|'$X' to unlock]"); }
    else if (this.settings[22] && !this.homed) { this.state = 'Alarm'; this._say("[MSG:'$H'|'$X' to unlock]"); }
  }

  get wco() { return [0, 1, 2].map((k) => this.g54[k] + this.g92[k]); }
  get moving() { return this.queue.some((q) => q.type === 'move' || q.type === 'home'); }

  write(bytes) {
    const data = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
    for (const c of data) {
      if (c === 0x3f) { this._status(); continue; }
      // a real machine takes a moment to slow down: it reports Hold:1 until it has stopped
      if (c === 0x21) { if (this.queue.length && this.state !== 'Alarm') { this.decel = this.moving && !this.holding ? 3 : 0; this.holding = true; } continue; }
      if (c === 0x7e) { this.holding = false; this.decel = 0; if (this.queue[0] && this.queue[0].type === 'pause') this.queue.shift(); this._drain(); continue; }
      if (c === 0x18) { const moving = this.moving && (!this.holding || this.decel > 0); this.decel = 0; this._buf = ''; this._boot(moving); continue; }
      if (c === 0x85) { if (this.queue.some((q) => q.jog)) { this.queue = this.queue.filter((q) => !q.jog); this.holding = false; this._drain(); } continue; }
      if (c >= 0x90 && c <= 0x94) { this.ov[0] = Math.max(10, Math.min(200, c === 0x90 ? 100 : this.ov[0] + [0, 10, -10, 1, -1][c - 0x90])); continue; }
      if (c >= 0x95 && c <= 0x97) { this.ov[1] = [100, 50, 25][c - 0x95]; continue; }
      if (c >= 0x99 && c <= 0x9d) { this.ov[2] = Math.max(10, Math.min(200, c === 0x99 ? 100 : this.ov[2] + [0, 10, -10, 1, -1][c - 0x99])); continue; }
      if (c === 0xa0) { this.modal.flood = !this.modal.flood; continue; }
      if (c === 0xa1) { this.modal.mist = !this.modal.mist; continue; }
      if (c >= 0x80) continue;
      if (c === 10 || c === 13) { const line = this._buf; this._buf = ''; if (line.trim()) { this.rxq.push(line); this._drain(); } continue; }
      this._buf += String.fromCharCode(c);
    }
  }

  /** Take waiting lines into the planner while it has room (16 blocks, like the real thing). */
  _drain() {
    while (this.rxq.length && this.queue.length < 16) {
      const line = this.rxq.shift();
      const res = this._line(line);
      if (res !== null) this._say(res);
    }
  }

  _status() {
    this.reports += 1;
    const f = (v) => v.toFixed(3);
    let st = this.state;
    if (this.state !== 'Alarm' && this.state !== 'Sleep') {
      if (this.holding && this.decel > 0) { st = 'Hold:1'; this.decel -= 1; }
      else if (this.holding || (this.queue[0] && this.queue[0].type === 'pause')) st = 'Hold:0';
      else if (this.queue.some((q) => q.type === 'home')) st = 'Home';
      else if (this.queue.some((q) => q.jog)) st = 'Jog';
      else if (this.queue.length) st = 'Run';
      else st = this.check ? 'Check' : 'Idle';
    }
    const cur = this.queue[0];
    const feed = cur && cur.type === 'move' && !this.holding ? Math.round(cur.rate * (cur.rapid ? this.ov[1] : this.ov[0]) / 100) : 0;
    let s = `<${st}|MPos:${this.mpos.map(f).join(',')}|Bf:${15 - Math.min(15, this.queue.length)},127|FS:${feed},${this.modal.spindle === 5 ? 0 : Math.round(this.modal.speed * this.ov[2] / 100)}`;
    if (this.reports % 2) s += `|WCO:${this.wco.map(f).join(',')}`; else s += `|Ov:${this.ov.join(',')}`;
    const acc = (this.modal.spindle === 3 ? 'S' : this.modal.spindle === 4 ? 'C' : '') + (this.modal.flood ? 'F' : '') + (this.modal.mist ? 'M' : '');
    if (acc && this.reports % 2 === 0) s += `|A:${acc}`;
    this._say(s + '>');
  }

  _alarm(code) {
    this.queue = []; this.rxq = []; this.holding = false; this.state = 'Alarm';
    this._say('ALARM:' + code);
    this._say('[MSG:Reset to continue]');
  }

  _system(line) {
    const up = line.toUpperCase();
    if (up === '$$') { for (const k of Object.keys(this.settings).map(Number).sort((a, b) => a - b)) this._say(`$${k}=${this.settings[k]}`); return 'ok'; }
    if (up === '$I') { this._say('[VER:1.1h.20190825:DabbleCAD demo]'); this._say('[OPT:V,15,128]'); return 'ok'; }
    if (up === '$G') { const m = this.modal; this._say(`[GC:G${m.motion} G54 G17 ${m.unit === 1 ? 'G21' : 'G20'} ${m.abs ? 'G90' : 'G91'} G94 M${m.spindle} ${m.flood ? 'M8' : m.mist ? 'M7' : 'M9'} T${m.tool} F${m.feed} S${m.speed}]`); return 'ok'; }
    if (up === '$#') { this._say(`[G54:${this.g54.map((v) => v.toFixed(3)).join(',')}]`); this._say(`[G92:${this.g92.map((v) => v.toFixed(3)).join(',')}]`); this._say(`[PRB:${(this.lastProbe || [0, 0, 0]).map((v) => v.toFixed(3)).join(',')}:${this.lastProbe ? 1 : 0}]`); return 'ok'; }
    if (up === '$X') { if (this.state === 'Alarm') { this.state = 'Idle'; this._say('[MSG:Caution: Unlocked]'); } return 'ok'; }
    if (up === '$C') { if (this.queue.length) return 'error:8'; this.check = !this.check; this._say(this.check ? '[MSG:Enabled]' : '[MSG:Disabled]'); return 'ok'; }
    if (up === '$H') {
      if (!this.settings[22]) return 'error:5';
      this.state = 'Idle';
      this.queue.push({ type: 'home', left: 2.5 });
      return null; // "ok" comes once homing has finished
    }
    if (up === '$SLP') { this.state = 'Sleep'; this._say('[MSG:Sleeping]'); return 'ok'; }
    if (up === '$N' || up.startsWith('$N') || up.startsWith('$RST=')) return 'ok';
    if (up.startsWith('$J=')) {
      if (this.state === 'Alarm') return 'error:9';
      if (this.queue.some((q) => !q.jog)) return 'error:8';
      return this._gcode(up.slice(3), true);
    }
    const set = /^\$(\d+)=(-?\d*\.?\d+)$/.exec(up);
    if (set) { if (this.queue.length) return 'error:8'; if (!(+set[1] in this.settings)) return 'error:3'; if (+set[2] < 0) return 'error:4'; this.settings[+set[1]] = +set[2]; return 'ok'; }
    return 'error:3';
  }

  _line(raw) {
    let line = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '').trim();
    if (!line) return 'ok';
    if (line[0] === '$') return this._system(line.replace(/\s+/g, ''));
    if (this.state === 'Alarm') return 'error:9';
    if (this.state === 'Sleep') return 'error:9';
    return this._gcode(line.replace(/\s+/g, '').toUpperCase(), false);
  }

  _gcode(line, jog) {
    const m = this.modal;
    const w = {}, g = [], mm = [];
    let consumed = 0;
    WORD.lastIndex = 0;
    for (let x; (x = WORD.exec(line));) {
      consumed += x[0].length;
      const v = parseFloat(x[2]);
      if (x[1] === 'G') g.push(v); else if (x[1] === 'M') mm.push(v); else if (x[1] === 'N') continue; else { if (x[1] in w) return 'error:25'; w[x[1]] = v; }
    }
    if (consumed !== line.length) return 'error:2';
    let abs = m.abs, unit = m.unit, motion = jog ? 1 : m.motion, machine = false, probe = 0, nonModal = null;
    for (const code of g) {
      if (code === 0 || code === 1) motion = code;
      else if (code === 2 || code === 3) motion = code;
      else if (code === 38.2 || code === 38.3 || code === 38.4 || code === 38.5) { motion = 38; probe = code; }
      else if (code === 20) unit = 25.4; else if (code === 21) unit = 1;
      else if (code === 90) abs = true; else if (code === 91) abs = false;
      else if (code === 53) machine = true;
      else if (code === 4 || code === 10 || code === 28 || code === 30 || code === 92 || code === 92.1) nonModal = code;
      else if ([17, 40, 49, 54, 80, 94, 61].includes(code)) { if (code === 80) motion = 80; }
      else return 'error:20';
    }
    if (jog && (g.some((c) => ![20, 21, 90, 91, 53].includes(c)) || mm.length || w.F == null)) return w.F == null ? 'error:22' : 'error:16';
    for (const code of mm) {
      if (code === 3 || code === 4 || code === 5) m.spindle = code;
      else if (code === 7) m.mist = true; else if (code === 8) m.flood = true; else if (code === 9) { m.mist = false; m.flood = false; }
      else if (code === 0 || code === 1) this.queue.push({ type: 'pause' });
      else if (code === 2 || code === 30) { m.spindle = 5; m.mist = m.flood = false; m.motion = 1; }
      else return 'error:20';
    }
    if (!jog) { m.abs = abs; m.unit = unit; if (motion !== 38) m.motion = motion; }
    if (w.S != null) m.speed = w.S;
    if (w.T != null) m.tool = w.T;
    if (w.F != null && !jog) m.feed = w.F * unit;
    const axes = ['X', 'Y', 'Z'];
    const hasAxis = axes.some((a) => w[a] != null);
    const wco = this.wco;
    const end = this._planEnd();
    if (nonModal === 4) { if (w.P == null) return 'error:28'; this.queue.push({ type: 'dwell', left: w.P }); this._instant(); return 'ok'; }
    if (nonModal === 10) {
      if (w.L !== 2 && w.L !== 20) return 'error:28';
      for (let k = 0; k < 3; k++) if (w[axes[k]] != null) this.g54[k] = w.L === 20 ? end[k] - this.g92[k] - w[axes[k]] * unit : w[axes[k]] * unit;
      return 'ok';
    }
    if (nonModal === 92) { for (let k = 0; k < 3; k++) if (w[axes[k]] != null) this.g92[k] = end[k] - this.g54[k] - w[axes[k]] * unit; return 'ok'; }
    if (nonModal === 92.1) { this.g92 = [0, 0, 0]; return 'ok'; }
    if (nonModal === 28 || nonModal === 30) return 'ok';
    if (!hasAxis) return motion === 38 ? 'error:26' : 'ok';
    if (motion === 80) return 'error:31';
    if (motion === 2 || motion === 3) { if (w.I == null && w.J == null && w.R == null) return 'error:35'; }
    const feed = jog ? w.F * unit : m.feed;
    if (motion !== 0 && !(feed > 0)) return 'error:22';
    const to = [0, 1, 2].map((k) => { const v = w[axes[k]]; if (v == null) return end[k]; return machine ? v * unit : abs ? v * unit + wco[k] : end[k] + v * unit; });
    if (this.settings[20] && this.homed) {
      const out = to.some((v, k) => v > 1e-6 || v < -this.settings[130 + k] - 1e-6);
      if (out) { if (jog) return 'error:15'; this._alarm(2); return null; }
    }
    if (this.check) return 'ok';
    const maxRate = Math.min(this.settings[110], this.settings[111]);
    this.queue.push({ type: 'move', from: [...end], to, rate: motion === 0 ? maxRate : Math.min(feed, maxRate), rapid: motion === 0, jog, probe, cut: motion !== 0 && !jog });
    this.executed += 1;
    if (this.history.length < 20000) this.history.push(to.map((v, k) => +(v - wco[k]).toFixed(4)));
    if (probe) { this._instant(); return null; } // the reply follows the probe result
    this._instant();
    return 'ok';
  }

  /** Where the machine will be once everything already planned has run. */
  _planEnd() {
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].type === 'move') return this.queue[i].to;
    return this.mpos;
  }

  /** In "instant" mode there is no waiting: finish whatever is queued right now. */
  _instant() {
    if (this.speed < 1e5 || this.holding) return false;
    this._advance(1e9);
    return true;
  }

  _tick() {
    const now = performance.now(), dt = ((now - this._last) / 1000) * this.speed;
    this._last = now;
    this._advance(dt);
  }

  _advance(dt) {
    let guard = 0;
    while (dt > 0 && this.queue.length && !this.holding && guard++ < 100000) {
      const q = this.queue[0];
      if (q.type === 'pause') break;
      if (q.type === 'dwell' || q.type === 'home') {
        if (q.left > dt) { q.left -= dt; dt = 0; break; }
        dt -= q.left;
        this.queue.shift();
        if (q.type === 'home') { const p = -this.settings[27]; this.mpos = [p, p, p]; this.homed = true; this._say('ok'); }
        this._drain();
        continue;
      }
      const v = (q.rate * (q.rapid ? this.ov[1] : this.ov[0])) / 100 / 60;
      let target = q.to, contact = false;
      if (q.probe) {
        // contact happens where the move crosses the probe plane on the axis it mostly travels along
        const d = [0, 1, 2].map((k) => q.to[k] - q.from[k]);
        const k = Math.abs(d[2]) >= Math.abs(d[0]) && Math.abs(d[2]) >= Math.abs(d[1]) ? 2 : Math.abs(d[0]) >= Math.abs(d[1]) ? 0 : 1;
        // one plane, or [low, high] for something to touch in either direction (the walls of a hole)
        const at = this.probeAt['xyz'[k]];
        const plane = Array.isArray(at) ? (d[k] < 0 ? at[0] : at[1]) : at;
        if (plane != null && d[k] !== 0) { const t = (plane - q.from[k]) / d[k]; if (t >= 0 && t <= 1) { target = [0, 1, 2].map((i) => q.from[i] + d[i] * t); contact = true; } }
      }
      const rem = Math.hypot(target[0] - this.mpos[0], target[1] - this.mpos[1], target[2] - this.mpos[2]);
      const step = v * dt;
      if (step >= rem || rem < 1e-9) {
        if (q.cut) this.cutLength += rem;
        this.mpos = [...target];
        dt -= v > 0 ? rem / v : 0;
        this.queue.shift();
        if (q.probe) {
          if (contact) { this.lastProbe = [...this.mpos]; this._say(`[PRB:${this.mpos.map((x) => x.toFixed(3)).join(',')}:1]`); this._say('ok'); }
          else if (q.probe === 38.2 || q.probe === 38.4) { this._alarm(5); return; }
          else { this._say(`[PRB:${this.mpos.map((x) => x.toFixed(3)).join(',')}:0]`); this._say('ok'); }
        }
        this._drain();
      } else {
        const k = step / rem;
        if (q.cut) this.cutLength += step;
        this.mpos = this.mpos.map((p, i) => p + (target[i] - p) * k);
        dt = 0;
      }
    }
  }
}
