// Machine tab: connect to the controller, set zero, jog, probe and run the job.
import { h, clear, button, icon, toast, popupMenu, promptDialog, modal } from '../ui/dom.js';
import { platform } from '../platform.js';
import { SerialTransport, WebSocketTransport, TcpTransport } from './device.js';
import { GrblSim } from './grblsim.js';
import { parseGcode, cleanLines, resumeLines, formatTime } from './gcode.js';
import { STATE_HELP } from './grblcodes.js';
import { PathView3D } from './view3d.js';
import * as wizards from './wizards.js';

const AXES = ['X', 'Y', 'Z'];
const STEPS = { mm: [0.1, 1, 10, 100], in: [0.001, 0.01, 0.1, 1] };

export class MachinePanel {
  constructor(ws, root) {
    this.ws = ws;
    this.root = root;
    this.dev = ws.device;
    this.program = null;
    this.active = false;
    this.history = [];
    this.hIndex = 0;
    this.pause = null;
    this._build();
    this._bind();
    document.addEventListener('keyup', (e) => { if (this._keyJog && e.key === this._keyJog) { this._keyJog = null; this.dev.jogCancel(); } });
    window.addEventListener('blur', () => { if (this._keyJog || this._holdJog) { this._keyJog = null; this._holdJog = false; this.dev.jogCancel(); } });
  }

  get u() { return this.ws.u; }
  get cfg() { return this.ws.cfg; }

  // ---------------------------------------------------------------- layout
  _build() {
    const sec = (title, body, cls = '') => h('div', { class: 'cm-box ' + cls }, title ? h('div', { class: 'cm-box-title' }, title) : null, body);
    // connection
    this.connBtn = button({ label: 'Connect', icon: 'plug', cls: 'btn-primary', title: 'Connect to your CNC machine', onClick: () => this.connectMenu() });
    this.stateEl = h('div', { class: 'cm-state', dataset: { state: 'Disconnected' } }, 'Not connected');
    this.fwEl = h('div', { class: 'cm-fw' });
    // position read-out
    this.dro = {};
    const droBody = h('div', { class: 'cm-dro' });
    for (const [i, a] of AXES.entries()) {
      const work = h('span', { class: 'cm-dro-work' }, '0.000'), mach = h('span', { class: 'cm-dro-mach' }, '');
      this.dro[a] = { work, mach };
      droBody.append(h('div', { class: 'cm-dro-row ax-' + a.toLowerCase() }, h('b', {}, a), work, mach,
        button({ label: 'Zero', cls: 'btn-outline', title: `Make this spot ${a}0`, onClick: () => this.zero(a) }),
        i < 2 ? button({ icon: 'target', cls: 'btn-ghost', title: `Go to ${a}0`, onClick: () => this.cmd(`G90 G0 ${a}0`) }) : h('span', { class: 'cm-dro-pad' })));
    }
    this.unitEl = h('span', { class: 'cm-unit' }, 'mm');
    droBody.append(h('div', { class: 'lz-row' },
      button({ label: 'Zero XY', cls: 'btn-outline', title: 'Make this spot X0 Y0', onClick: () => this.zero('XY') }),
      button({ label: 'Zero all', cls: 'btn-outline', title: 'Make this spot X0 Y0 Z0', onClick: () => this.zero('XYZ') }),
      button({ label: 'Go to XY zero', cls: 'btn-outline', title: 'Move to X0 Y0 at the current height', onClick: () => this.cmd('G90 G0 X0 Y0') })));
    // jog
    this.stepSeg = h('div', { class: 'segmented cm-steps' });
    this.jogFeed = h('input', { class: 'input', type: 'number', min: 1, step: 100, title: 'Jog speed' });
    this.jogFeed.addEventListener('change', () => { const v = parseFloat(this.jogFeed.value); if (v > 0) this.ws.saveCfg({ jogFeed: v / this.u.k }); });
    this.jogFeed.addEventListener('keydown', (e) => e.stopPropagation());
    const jb = (ic, title, d) => {
      const b = button({ icon: ic, title });
      b.addEventListener('pointerdown', (e) => { if (e.button === 0) this.jogStart(d); });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => this.jogEnd());
      return b;
    };
    const pad = h('div', { class: 'jog-pad cm-jog-xy' },
      jb('arrowUpLeft', 'Back and left', [-1, 1, 0]), jb('arrowUp', 'Away from you (Y+)', [0, 1, 0]), jb('arrowUpRight', 'Back and right', [1, 1, 0]),
      jb('arrowLeft', 'Left (X−)', [-1, 0, 0]), button({ icon: 'stop', title: 'Stop jogging', onClick: () => this.dev.jogCancel() }), jb('arrowRight', 'Right (X+)', [1, 0, 0]),
      jb('arrowDownLeft', 'Forward and left', [-1, -1, 0]), jb('arrowDown', 'Towards you (Y−)', [0, -1, 0]), jb('arrowDownRight', 'Forward and right', [1, -1, 0]));
    const zpad = h('div', { class: 'cm-jog-z' }, jb('arrowUp', 'Up (Z+)', [0, 0, 1]), h('b', {}, 'Z'), jb('arrowDown', 'Down (Z−)', [0, 0, -1]));
    this.jogUnit = h('em', {}, 'mm/min');
    const jogBody = h('div', {}, h('div', { class: 'cm-jog' }, pad, zpad,
      h('div', { class: 'cm-jog-opts' }, h('small', {}, 'Step'), this.stepSeg, h('small', {}, 'Speed'), h('div', { class: 'cm-jog-feed' }, this.jogFeed, this.jogUnit))),
    h('div', { class: 'insp-note' }, 'Arrow keys jog X and Y; Page Up and Page Down jog Z.'));
    // machine actions
    const act = h('div', { class: 'lz-row' },
      button({ label: 'Home', icon: 'home', cls: 'btn-outline', title: 'Find the limit switches ($H)', onClick: () => this.home() }),
      button({ label: 'Unlock', icon: 'unlock', cls: 'btn-outline', title: 'Clear an alarm ($X)', onClick: () => this.unlock() }),
      button({ label: 'Reset', cls: 'btn-outline', title: 'Restart the controller. Stops everything.', onClick: () => { if (this.need(true)) this.dev.reset(); } }));
    // job
    this.jobName = h('div', { class: 'cm-job-name' }, 'No job loaded');
    this.jobInfo = h('div', { class: 'insp-note' }, 'Use "Send to machine" in the Design tab, or open a G-code file.');
    this.bar = h('div', { class: 'laser-progress' }, h('i'));
    this.runBtn = button({ label: 'Start', icon: 'play', cls: 'btn-primary', title: 'Run the job', onClick: () => this.start() });
    this.pauseBtn = button({ label: 'Pause', icon: 'pause', cls: 'btn-outline', title: 'Pause or carry on', onClick: () => this.pauseResume() });
    this.stopBtn = button({ label: 'Stop', icon: 'stop', cls: 'btn-danger', title: 'Stop now and turn the spindle off', onClick: () => this.stop() });
    const jobBody = h('div', {}, this.jobName, this.jobInfo, this.bar,
      h('div', { class: 'lz-row' }, this.runBtn, this.pauseBtn, this.stopBtn),
      h('div', { class: 'lz-row' },
        button({ label: 'Open G-code file', icon: 'folder', cls: 'btn-outline', onClick: () => this.openFile() }),
        (() => { const b = button({ label: 'More', cls: 'btn-outline', onClick: () => popupMenu([
          { label: 'Start from a line…', disabled: !this.program, onClick: () => this.startFromLine() },
          { label: 'Trace the outline of the job (spindle off)', disabled: !this.program, onClick: () => this.traceOutline() },
          { label: (this.dev.status.state === 'Check' ? 'Leave' : 'Enter') + ' check mode (test the file without moving)', onClick: () => this.cmd('$C') },
          { label: 'Reload from the Design tab', onClick: () => this.ws.sendToMachine() },
        ], b) }); return b; })()));
    // overrides and spindle
    this.ovEls = {};
    const ovRow = (key, label, btns) => { const val = h('b', {}, '100%'); this.ovEls[key] = val; return h('div', { class: 'cm-ov' }, h('span', {}, label), val, ...btns.map(([text, title, fn]) => button({ label: text, cls: 'btn-outline', title, onClick: fn }))); };
    const rpm = h('input', { class: 'input', type: 'number', value: 12000, min: 0, step: 500, title: 'Spindle speed' });
    rpm.addEventListener('keydown', (e) => e.stopPropagation());
    this.spindleBtn = button({ label: 'Spindle', cls: 'btn-outline', title: 'Turn the spindle on or off', onClick: () => this.cmd(this.dev.status.acc.includes('S') || this.dev.status.acc.includes('C') ? 'M5' : `M3 S${parseFloat(rpm.value) || 0}`) });
    this.floodBtn = button({ label: 'Flood', cls: 'btn-outline', title: 'Coolant / dust extraction output (M8)', onClick: () => { if (this.need(true)) this.dev.toggleFlood(); } });
    this.mistBtn = button({ label: 'Mist', cls: 'btn-outline', title: 'Mist output (M7)', onClick: () => { if (this.need(true)) this.dev.toggleMist(); } });
    const ovBody = h('div', {},
      ovRow('feed', 'Feed', [['−10', 'Slow the cut down by 10%', () => this.dev.feedOverride('-10')], ['100', 'Back to the programmed speed', () => this.dev.feedOverride('reset')], ['+10', 'Speed the cut up by 10%', () => this.dev.feedOverride('+10')]]),
      ovRow('rapid', 'Rapids', [['25', 'Rapid moves at 25%', () => this.dev.rapidOverride(25)], ['50', 'Rapid moves at 50%', () => this.dev.rapidOverride(50)], ['100', 'Rapid moves at full speed', () => this.dev.rapidOverride(100)]]),
      ovRow('spindle', 'Spindle', [['−10', 'Spindle 10% slower', () => this.dev.spindleOverride('-10')], ['100', 'Back to the programmed speed', () => this.dev.spindleOverride('reset')], ['+10', 'Spindle 10% faster', () => this.dev.spindleOverride('+10')]]),
      h('div', { class: 'lz-row cm-spindle' }, this.spindleBtn, rpm, h('em', {}, 'RPM'), this.floodBtn, this.mistBtn));
    this.side = h('div', { class: 'cm-side' },
      sec('', h('div', { class: 'cm-conn' }, this.connBtn, h('div', { style: { flex: 1, minWidth: 0 } }, this.stateEl, this.fwEl)), 'cm-box-conn'),
      sec(h('span', {}, 'Position ', this.unitEl), droBody), sec('Move', h('div', {}, jogBody, act)), sec('Job', jobBody), sec('While cutting', ovBody));
    this.side.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') e.stopPropagation(); });

    // viewer
    this.viewHost = h('div', { class: 'cm-view' });
    this.banner = h('div', { class: 'cm-banner' });
    this.viewHost.append(this.banner, h('div', { class: 'cm-view-btns' },
      button({ label: 'Top', cls: 'btn-outline', onClick: () => this.view && this.view.view('top') }), button({ label: '3D', cls: 'btn-outline', onClick: () => this.view && this.view.view('iso') })));
    // tabs under the viewer
    this.tabBar = h('div', { class: 'cm-tabbar', role: 'tablist' });
    this.tabBody = h('div', { class: 'cm-tabbody' });
    this.consoleLog = h('div', { class: 'laser-console-log cm-console' });
    this.consoleInput = h('input', { class: 'input', type: 'text', placeholder: 'Type a command, for example $$ or G0 X10 Y10, then Enter', spellcheck: false });
    this.consoleInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowUp' && this.history.length) { this.hIndex = Math.max(0, this.hIndex - 1); this.consoleInput.value = this.history[this.hIndex] || ''; e.preventDefault(); return; }
      if (e.key === 'ArrowDown') { this.hIndex = Math.min(this.history.length, this.hIndex + 1); this.consoleInput.value = this.history[this.hIndex] || ''; e.preventDefault(); return; }
      if (e.key !== 'Enter' || !this.consoleInput.value.trim()) return;
      const line = this.consoleInput.value.trim();
      this.consoleInput.value = '';
      this.history.push(line); this.hIndex = this.history.length;
      // clearing an alarm by hand gets the same tidy-up as the Unlock and Home buttons
      if (/^\$X$/i.test(line)) this.unlock(); else if (/^\$H$/i.test(line)) this.home(); else this.cmd(line);
    });
    this.panes = {
      console: ['Console', () => h('div', { class: 'cm-pane-console' }, this.consoleLog, this.consoleInput)],
      macros: ['Macros', () => wizards.macrosPane(this)],
      probe: ['Probe', () => wizards.probePane(this)],
      tools: ['Wizards', () => wizards.toolsPane(this)],
      firmware: ['Controller settings', () => wizards.firmwarePane(this)],
      pins: ['Diagnostics', () => wizards.pinsPane(this)],
    };
    this.tabBtns = {};
    for (const [id, [label]] of Object.entries(this.panes)) { const b = h('button', { class: 'cm-tab', type: 'button', role: 'tab' }, label); b.addEventListener('click', () => this.showTab(id)); this.tabBtns[id] = b; this.tabBar.append(b); }
    this.root.append(h('div', { class: 'cm-left' }, this.viewHost, h('div', { class: 'cm-tabs' }, this.tabBar, this.tabBody)), this.side);
    this.showTab('console');
    this._renderSteps();
    this._renderButtons();
  }

  showTab(id) {
    this.tab = id;
    for (const [k, b] of Object.entries(this.tabBtns)) b.classList.toggle('on', k === id);
    clear(this.tabBody).append(this.panes[id][1]());
    if (id === 'console') this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
  }

  _renderSteps() {
    const u = this.u, list = STEPS[u.inch ? 'in' : 'mm'];
    clear(this.stepSeg);
    if (!list.includes(this.step) && this.step !== 0) this.step = list[2];
    for (const s of [...list, 0]) {
      const b = button({ label: s ? String(s) : 'Hold', title: s ? `Move ${s} ${u.name} per click` : 'Keep moving for as long as the button is held', onClick: () => { this.step = s; this._renderSteps(); } });
      if (s === this.step) b.classList.add('active');
      this.stepSeg.append(b);
    }
    this.jogFeed.value = u.feed(this.cfg.jogFeed);
    this.jogUnit.textContent = u.feedName;
    this.unitEl.textContent = u.name;
    this._unitsShown = u.name;
  }

  setActive(on) {
    this.active = on;
    if (!on) return;
    if (!this.view) { this.view = new PathView3D(this.viewHost, { antialias: this.ws.app.settings.antialias !== false }); this._showProgram(true); }
    if (this._unitsShown !== this.u.name) this._renderSteps();
    this.view.setTheme();
    this.view.resize();
    this._status(this.dev.status);
  }

  // ---------------------------------------------------------------- controller events
  _bind() {
    const d = this.dev;
    d.on('line', (l) => this.log(l.text, l.kind));
    d.on('connection', (on) => {
      clear(this.connBtn).append(icon('plug'), h('span', { class: 'btn-label' }, on ? 'Disconnect' : 'Connect'));
      this.connBtn.classList.toggle('btn-primary', !on); this.connBtn.classList.toggle('btn-outline', on);
      this.log(on ? `Connected to ${d.transport ? d.transport.label : 'the machine'}` : 'Disconnected', 'info');
      if (!on) { this.pause = null; this.fwEl.textContent = ''; }
      this._renderButtons(); this._renderBanner();
      if (this.tab !== 'console') this.showTab(this.tab);
    });
    d.on('status', (st) => this._status(st));
    d.on('info', (info) => { this.fwEl.textContent = info.version ? `GRBL ${info.version}` : ''; });
    d.on('settings', () => { if (this.tab === 'firmware' || this.tab === 'tools') this.showTab(this.tab); });
    d.on('alarm', () => { this._renderBanner(); this._renderButtons(); });
    d.on('job', () => this._renderButtons());
    d.on('progress', (job) => this._progress(job));
    d.on('jobpause', (info) => { this.pause = info; this._renderBanner(); this._renderButtons(); });
    platform.onSerialPorts((ports) => {
      if (!this.ws.active) return;
      if (!ports.length) { toast('No serial ports were found. Check the USB cable and that the machine is switched on.', 'warn', 5000); platform.chooseSerialPort(''); return; }
      let chosen = false;
      popupMenu(ports.map((p) => ({ label: `${p.label}${p.name && p.name !== p.label ? ' (' + p.name + ')' : ''}`, icon: 'plug', onClick: () => { chosen = true; platform.chooseSerialPort(p.id); } })), this.connBtn);
      const watch = setInterval(() => { if (!document.querySelector('.menu')) { clearInterval(watch); if (!chosen) platform.chooseSerialPort(''); } }, 200);
    });
  }

  _status(st) {
    if (!this.active) return;
    const u = this.u;
    const label = STATE_HELP[st.state] || st.state;
    if (this.stateEl.textContent !== label) this.stateEl.textContent = label;
    this.stateEl.dataset.state = st.state;
    for (const [i, a] of AXES.entries()) {
      this.dro[a].work.textContent = (st.wpos[i] * u.k).toFixed(u.inch ? 4 : 3);
      this.dro[a].mach.textContent = this.dev.connected ? 'machine ' + (st.mpos[i] * u.k).toFixed(u.inch ? 3 : 2) : '';
    }
    this.ovEls.feed.textContent = st.ov[0] + '%'; this.ovEls.rapid.textContent = st.ov[1] + '%'; this.ovEls.spindle.textContent = st.ov[2] + '%';
    this.spindleBtn.classList.toggle('active', /[SC]/.test(st.acc)); this.floodBtn.classList.toggle('active', st.acc.includes('F')); this.mistBtn.classList.toggle('active', st.acc.includes('M'));
    if (this.view) this.view.setTool(this.dev.connected && st.known ? st.wpos : null, null);
    if (this._lastState !== st.state) { this._lastState = st.state; this._renderBanner(); this._renderButtons(); if (this.tab === 'pins') this.showTab('pins'); }
    else if (this.tab === 'pins' && this._pins !== st.pins) this.showTab('pins');
    this._pins = st.pins;
    if (this.ws.mode === 'design') this.ws.redraw();
  }

  _renderButtons() {
    const d = this.dev, job = d.job, held = d.status.state === 'Hold' || (job && (job.state === 'held' || job.state === 'paused'));
    this.runBtn.classList.toggle('disabled', !d.connected || !!job || !this.program);
    this.pauseBtn.classList.toggle('disabled', !d.connected || (!job && d.status.state !== 'Hold' && d.status.state !== 'Run'));
    clear(this.pauseBtn).append(icon(held ? 'play' : 'pause'), h('span', { class: 'btn-label' }, held ? 'Resume' : 'Pause'));
    this.stopBtn.classList.toggle('disabled', !d.connected);
  }

  _renderBanner() {
    const b = clear(this.banner), d = this.dev;
    b.className = 'cm-banner';
    const show = (cls, title, text, ...btns) => { b.classList.add('open', cls); b.append(h('div', { class: 'cm-banner-text' }, h('b', {}, title), text ? h('span', {}, text) : null), ...btns); };
    if (!d.connected) return;
    if (d.status.state === 'Alarm') {
      const a = d.alarm;
      return show('alarm', a ? a.what : 'The machine is locked.', a ? a.fix : 'Home the machine, or press Unlock if you know where it is.',
        button({ label: 'Unlock', cls: 'btn-outline', onClick: () => this.unlock() }), button({ label: 'Home', cls: 'btn-outline', onClick: () => this.home() }));
    }
    const p = this.pause;
    if (p && d.job && (d.job.state === 'paused' || d.job.state === 'held')) {
      if (p.reason === 'error') return show('alarm', `The controller did not accept line ${p.n}.`, `${p.why} (${p.line})`,
        button({ label: 'Carry on', cls: 'btn-outline', onClick: () => this.pauseResume() }), button({ label: 'Stop', cls: 'btn-danger', onClick: () => this.stop() }));
      const what = p.reason === 'toolchange' ? `Change the bit${p.tool != null ? ' to T' + p.tool : ''}.` : 'The job is waiting for you.';
      return show('wait', what, `${p.comment ? p.comment + ' ' : ''}${/[SC]/.test(d.status.acc) ? 'The spindle is still ON: keep clear of the bit.' : 'The spindle is off.'} You can jog, probe and set Z zero now. Press Resume to carry on.`,
        button({ label: 'Probe Z', cls: 'btn-outline', onClick: () => this.showTab('probe') }), button({ label: 'Resume', icon: 'play', cls: 'btn-primary', onClick: () => this.pauseResume() }));
    }
    if (d.status.state === 'Hold') return show('wait', 'Paused.', 'The machine is holding its place.', button({ label: 'Resume', icon: 'play', cls: 'btn-primary', onClick: () => this.pauseResume() }));
    if (d.status.state === 'Door') return show('alarm', 'The safety door is open.', 'Close it, then press Resume.', button({ label: 'Resume', cls: 'btn-outline', onClick: () => this.dev.resume() }));
    if (d.status.state === 'Check') return show('wait', 'Check mode is on.', 'The controller reads G-code without moving. Run the job to test the file, then leave check mode.', button({ label: 'Leave check mode', cls: 'btn-outline', onClick: () => this.cmd('$C') }));
  }

  log(text, kind = 'in') {
    const row = h('div', { class: 'lc-' + kind }, (kind === 'out' ? '> ' : '') + text);
    this.consoleLog.append(row);
    while (this.consoleLog.children.length > 500) this.consoleLog.firstChild.remove();
    this.consoleLog.scrollTop = this.consoleLog.scrollHeight;
  }

  // ---------------------------------------------------------------- connecting
  connectMenu() {
    if (this.dev.connected) return this.disconnect();
    popupMenu([
      { label: 'USB cable (serial port)…', icon: 'plug', disabled: !SerialTransport.supported, onClick: () => this.connect(new SerialTransport(this.cfg.baud || 115200)) },
      { label: 'Network (Wi-Fi or Ethernet)…', onClick: () => this.connectNetwork() },
      'sep',
      { label: 'Demo machine (no hardware needed)', icon: 'play', onClick: () => this.connect(new GrblSim({ speed: 1 })) },
    ], this.connBtn);
  }

  async connectNetwork() {
    const addr = await promptDialog('Connect over the network', 'Address, for example 192.168.1.50:23, or ws://192.168.1.50:81 for FluidNC', this.cfg.network || '');
    if (!addr || !addr.trim()) return;
    const a = addr.trim();
    this.ws.saveCfg({ network: a });
    if (/^wss?:\/\//i.test(a) || !platform.tcpConnect) return this.connect(new WebSocketTransport(a));
    const m = /^([^:\/\s]+)(?::(\d+))?$/.exec(a);
    if (!m) return toast('That address does not look right. Use something like 192.168.1.50:23', 'warn', 5000);
    return this.connect(new TcpTransport(platform, m[1], m[2] ? +m[2] : 23));
  }

  async connect(transport) {
    try { await this.dev.connect(transport); return true; }
    catch (err) {
      await this.dev.disconnect();
      if (!/No port selected|cancel/i.test(String(err.message || err))) toast('Could not connect: ' + (err.message || err), 'error', 5000);
      return false;
    }
  }

  /** Disconnect. A machine that is still moving is brought to a stop first. */
  async disconnect() {
    if (this.dev.job || ['Run', 'Jog', 'Home'].includes(this.dev.status.state)) await this.dev.stop();
    return this.dev.disconnect();
  }

  /**
   * Run something that speaks millimetres (probing, macros) whatever the last job left behind:
   * an inch job leaves the controller reading inches. The units are put back afterwards.
   */
  async inMm(fn) {
    const d = this.dev;
    if (!this.need()) return null;
    await d.send('$G', { echo: false }).catch(() => {});
    if (/\bG20\b/.test(d.modal || '')) { this._inchAfter = true; await d.send('G21', { echo: false }).catch(() => {}); }
    try { return await fn(); } finally { if (!d.alarm && d.status.state !== 'Alarm') await this._restoreModes(); }
  }
  /** Back to absolute moves, and to inches if that is what the job was using. */
  async _restoreModes() {
    const d = this.dev;
    if (!d.connected) return;
    await d.send('G90', { echo: false }).catch(() => {});
    if (this._inchAfter) { this._inchAfter = false; await d.send('G20', { echo: false }).catch(() => {}); }
  }

  /** Is the machine connected (and, unless duringJob, free to take commands)? */
  need(duringJob = false) {
    if (!this.dev.connected) { toast('Connect to the machine first.', 'warn'); return false; }
    if (!duringJob && this.dev.job && this.dev.job.state === 'running') { toast('A job is running. Pause or stop it first.', 'warn'); return false; }
    return true;
  }
  cmd(line) { if (!this.need()) return Promise.resolve(null); return this.dev.send(line).catch((err) => { this.log(err.message, 'error'); return null; }); }
  /** Clear an alarm. An interrupted probe can leave the controller in relative mode, so put it back to absolute. */
  async unlock() { const r = await this.cmd('$X'); if (r === 'ok') await this._restoreModes(); return r; }
  zero(axes) { return this.cmd(`G10 L20 P1 ${[...axes].map((a) => a + '0').join(' ')}`); }
  home() {
    if (!this.need()) return;
    if (this.dev.settings[22] === '0') return toast('Homing is switched off on this controller. Turn on "Homing cycle" ($22) under Controller settings if the machine has limit switches.', 'warn', 7000);
    // homing also clears an alarm, so tidy up after an interrupted probe here too
    return this.cmd('$H').then((r) => { if (r === 'ok') return this._restoreModes(); return undefined; });
  }

  // ---------------------------------------------------------------- jogging
  _jogFeed() { return Math.max(1, this.cfg.jogFeed || 1000); }
  jogStart(d) {
    if (!this.need()) return;
    // a jog queued behind homing, a probe or a dwell would start later, with nobody holding the button
    if (this.dev.busy) return;
    const feed = d[2] && !d[0] && !d[1] ? Math.min(this._jogFeed(), 1000) : this._jogFeed();
    if (this.step) { const s = this.step / this.u.k; this.dev.jog(d.map((v) => v * s), feed).catch(() => {}); return; }
    // hold to move: ask for a long move and cancel it on release
    this._holdJog = true;
    this.dev.jog(d.map((v) => v * this._holdReach(d)), feed).catch(() => {});
  }
  /** How far a held jog may ask to go. With soft limits on, the controller refuses a move that would leave the machine. */
  _holdReach(d) {
    const s = this.dev.settings, m = this.dev.status.mpos;
    if (s[20] !== '1') return 2000;
    let reach = 2000;
    for (let i = 0; i < 3; i++) {
      if (!d[i]) continue;
      const max = parseFloat(s[130 + i]) || 0;
      reach = Math.min(reach, Math.max(0, (d[i] > 0 ? -m[i] : m[i] + max) - 1));
    }
    return reach;
  }
  jogEnd() { if (this._holdJog) { this._holdJog = false; this.dev.jogCancel(); } }

  key(e) {
    const map = { ArrowLeft: [-1, 0, 0], ArrowRight: [1, 0, 0], ArrowUp: [0, 1, 0], ArrowDown: [0, -1, 0], PageUp: [0, 0, 1], PageDown: [0, 0, -1] };
    if (e.key === 'Escape') { this.dev.jogCancel(); return; }
    const d = map[e.key];
    if (!d || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    if (!this.dev.connected) return;
    if (this.step) {
      // a held key repeats faster than the machine moves: only take the next step once the last has gone
      if (e.repeat && (this.dev.manual.length || this.dev.inflight.length)) return;
      if (!this.dev.job || this.dev.job.state !== 'running') this.jogStart(d);
      return;
    }
    if (e.repeat || this._keyJog) return;
    this._keyJog = e.key;
    this.jogStart(d);
    this._holdJog = false;
  }

  // ---------------------------------------------------------------- job
  loadProgram(p) {
    const parsed = parseGcode(p.text);
    const lines = cleanLines(p.text);
    const moveLine = Int32Array.from(parsed.moves, (m) => m.n);
    this.program = { ...p, parsed, lines, moveLine };
    const u = this.u, st = parsed.stats;
    this.jobName.textContent = p.name;
    this.jobInfo.textContent = isFinite(st.min[0])
      ? `${lines.length.toLocaleString()} lines · about ${formatTime(st.time)} · X ${u.show(st.min[0])} to ${u.show(st.max[0])}, Y ${u.show(st.min[1])} to ${u.show(st.max[1])}, deepest Z ${u.show(st.min[2])} ${u.name}`
      : `${lines.length.toLocaleString()} lines`;
    this.bar.firstChild.style.width = '0%';
    this._showProgram(true);
    this._renderButtons();
  }

  _showProgram(resetView) {
    if (!this.view) return;
    const p = this.program;
    if (!p) { this.view.setStock(this.ws.stock()); this.view.setPath([]); if (resetView) this.view.view('iso'); return; }
    const st = p.parsed.stats;
    const stock = p.stock || (isFinite(st.min[0]) ? { x0: st.min[0], y0: st.min[1], w: Math.max(1, st.max[0] - st.min[0]), h: Math.max(1, st.max[1] - st.min[1]), t: Math.max(1, -st.min[2]) } : this.ws.stock());
    this.view.setStock(stock);
    this.view.setPath(p.parsed.moves);
    if (resetView) this.view.view('iso');
  }

  async openFile() {
    const files = await platform.openDialog({ title: 'Open G-code', filters: [{ name: 'G-code', extensions: ['gcode', 'nc', 'gc', 'tap', 'ngc', 'cnc', 'txt'] }] });
    if (!files.length) return;
    this.loadProgram({ name: files[0].name, text: new TextDecoder().decode(files[0].data) });
    toast('Loaded ' + files[0].name);
  }

  _progress(job) {
    const p = this.program;
    const f = job.lines.length ? job.acked / job.lines.length : 0;
    this.bar.firstChild.style.width = `${(f * 100).toFixed(1)}%`;
    const elapsed = (Date.now() - job.started) / 1000;
    const left = f > 0.03 ? (elapsed * (1 - f)) / f : p ? p.parsed.stats.time : 0;
    this.jobInfo.textContent = `Line ${job.acked.toLocaleString()} of ${job.lines.length.toLocaleString()} · ${formatTime(elapsed)} gone · about ${formatTime(left)} left`;
    if (p && this.view && job.acked > 0) {
      const n = job.lines[Math.min(job.acked, job.lines.length) - 1].n;
      // binary search: how many moves come from lines up to this one
      let lo = 0, hi = p.moveLine.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (p.moveLine[mid] <= n) lo = mid + 1; else hi = mid; }
      this.view.setProgress(lo);
    }
    this._renderButtons();
  }

  /** A short checklist before the spindle starts. Resolves true to go ahead. */
  _preflight() {
    return new Promise((resolve) => {
      let ok = false;
      const m = modal({ title: 'Ready to cut?', width: 470, onClose: () => resolve(ok) });
      const j = this.ws.job, p = this.program;
      const items = p.fromDesign ? [
        `The first bit is in the spindle: ${(/T1: ([^)]*)\)/.exec(p.text) || [0, 'see the Design tab'])[1]}.`,
        `X0 Y0 is at the ${{ bl: 'front left corner', br: 'front right corner', tl: 'back left corner', tr: 'back right corner', c: 'centre' }[j.xyZero]} of the material.`,
        `Z0 is ${j.zZero === 'bed' ? 'on the machine bed' : 'on top of the material'}.`,
        'The material is clamped down and the clamps are clear of the cuts.',
      ] : ['The right bit is in the spindle.', 'X, Y and Z zero are set where this file expects them.', 'The material is clamped down and the clamps are clear of the cuts.'];
      m.body.append(h('ul', { class: 'cm-checklist' }, items.map((t) => h('li', {}, t))),
        h('p', { class: 'modal-text' }, 'Keep a hand near Stop for the first moves. If the bit is heading the wrong way, stop and check your zero.'),
        h('div', { class: 'modal-actions' }, button({ label: 'Not yet', cls: 'btn-outline', onClick: () => m.close() }), button({ label: 'Start cutting', icon: 'play', cls: 'btn-primary', onClick: () => { ok = true; m.close(); } })));
    });
  }

  async start({ confirm = true, preamble = [], lines = null } = {}) {
    if (!this.program) return toast('Load a job first: use "Send to machine" in the Design tab, or open a G-code file.', 'warn', 5000);
    if (!this.need()) return null;
    if (this.dev.status.state === 'Alarm') { toast('The machine is locked. Home it or press Unlock first.', 'warn', 5000); return null; }
    if (confirm && !(await this._preflight())) return null;
    if (!this.need()) return null;
    this.pause = null;
    this.view.setProgress(0);
    this.log(`Starting ${this.program.name}`, 'info');
    const res = await this.dev.run(lines || this.program.lines, { preamble });
    this.pause = null;
    this._renderBanner(); this._renderButtons();
    if (res.done) {
      this.bar.firstChild.style.width = '100%';
      this.jobInfo.textContent = `Finished in ${formatTime(res.seconds)}${res.errors.length ? ` with ${res.errors.length} line${res.errors.length === 1 ? '' : 's'} the controller did not accept` : ''}`;
      this.log(this.jobInfo.textContent, res.errors.length ? 'error' : 'info');
      if (this.active) toast(res.errors.length ? 'The job finished, but some lines were not accepted. See the console.' : 'Job finished', res.errors.length ? 'warn' : 'info', 4000);
    } else {
      this.jobInfo.textContent = `Stopped at line ${res.sent.toLocaleString()} of ${res.total.toLocaleString()}: ${res.reason}`;
      this.log(this.jobInfo.textContent, 'error');
    }
    return res;
  }

  async startFromLine() {
    if (!this.program || !this.need()) return;
    const total = this.program.lines.length;
    const v = await promptDialog('Start from a line', `Line to start from (1 to ${total}). The spindle is started and the bit is brought back down at that point first.`, '1');
    const n = parseInt(v, 10);
    if (!(n >= 1 && n <= total)) return;
    const r = resumeLines(this.program.text, n - 1, this.cfg.safeZ);
    return this.start({ preamble: r.lines, lines: r.rest });
  }

  /** Run around the outside of the job high above the material, so you can see where it will cut. */
  async traceOutline() {
    if (!this.program || !this.need()) return;
    const s = this.program.parsed.stats;
    if (!isFinite(s.min[0])) return;
    const f = Math.round(this._jogFeed()), p = (v) => +v.toFixed(3);
    await this.inMm(() => this.dev.sendAll(['G90', `G0 X${p(s.min[0])} Y${p(s.min[1])}`, `G1 X${p(s.max[0])} F${f}`, `G1 Y${p(s.max[1])}`, `G1 X${p(s.min[0])}`, `G1 Y${p(s.min[1])}`]).catch(() => {}));
  }

  pauseResume() {
    const d = this.dev;
    if (!this.need(true)) return;
    const job = d.job;
    if (d.status.state === 'Hold' || (job && (job.state === 'held' || job.state === 'paused'))) { this.pause = null; d.resume(); }
    else d.pause();
    this._renderBanner(); this._renderButtons();
  }

  async stop() {
    if (!this.dev.connected) return;
    this.log('Stop', 'error');
    this.pause = null;
    await this.dev.stop();
    this._renderBanner(); this._renderButtons();
  }
}
