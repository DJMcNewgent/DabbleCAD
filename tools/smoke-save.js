// Save/navigation regressions, run inside Electron with --smoke=tools/smoke-save.js.
const app = window.dabble, ed = app.editor, ws = app.laser;
const lib = window.dabbleLib, native = window.dabbleNative;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fails = [];
let checks = 0;
const check = (name, ok) => { checks++; if (!ok) fails.push(name); };
const savedText = async (id) => await hasDesign(id) ? native.loadDesign(id) : null;
const hasDesign = async (id) => (await native.listDesigns()).some((m) => m.id === id);
const saveDialog = () => [...document.querySelectorAll('.modal')].find((m) => m.querySelector('.modal-title')?.textContent === 'Save changes?');
const settle = async (promise) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Navigation did not finish (possibly a second save prompt)')), 5000); })]);
  } finally { clearTimeout(timer); }
};
const choose = async (operation, choice, label) => {
  const pending = operation();
  await wait(40);
  const dialog = saveDialog();
  check(label + ': prompt shown', !!dialog);
  if (dialog) {
    if (choice === 'Escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === choice).click();
  }
  return settle(pending);
};

app.settings.autosave = false;
const seed = async () => {
  app.dashboard.hide();
  // Reset only this isolated smoke profile between cases, without testing navigation here.
  await app._loadDoc(lib.doc.newDoc(), lib.doc.uid('d'));
  ed.addNode(lib.doc.makeShape('box', lib.shapes.defaultParams('box')));
  ws.add([lib.laser.model.makeRect(0, 10, 10, 20, 20)], false);
  ws.commit();
  if (!(await app.flushSave(true))) throw new Error('Could not save the test fixture');
  const id = app.designId, before = await savedText(id);
  ed.addNode(lib.doc.makeShape('sphere', lib.shapes.defaultParams('sphere')));
  ws.add([lib.laser.model.makeEllipse(1, 40, 40, 10, 10)], false);
  ws.commit();
  return { id, before, edited: lib.doc.serializeDoc(ed.doc) };
};

for (const destination of ['dashboard', 'delete']) {
  for (const choice of ['Cancel', 'Don\u2019t save', 'Save']) {
    const state = await seed(), label = destination + '/' + choice;
    const flush = app.flushSave;
    const writes = [];
    app.flushSave = async function (force) {
      const dirty = this.dirty, id = this.designId;
      const ok = await flush.call(this, force);
      if (dirty && ok) writes.push({ id, text: await savedText(id) });
      return ok;
    };
    let result;
    try {
      result = await choose(() => destination === 'dashboard' ? app.dashboard.show() : app.deleteDesign(state.id), choice, label);
    } finally { app.flushSave = flush; }
    const cancelled = choice === 'Cancel';
    check(label + ': result', result === !cancelled);
    check(label + ': saved only on Save', writes.length === (choice === 'Save' ? 1 : 0));
    if (choice === 'Save') check(label + ': 3D and laser edits persisted before leaving', writes[0]?.id === state.id && writes[0]?.text === state.edited);
    if (destination === 'dashboard' || cancelled) {
      check(label + ': current design retained', app.designId === state.id && lib.doc.serializeDoc(ed.doc) === state.edited);
      check(label + ': saved file contents', await savedText(state.id) === (choice === 'Save' ? state.edited : state.before));
      check(label + ': dirty state', app.dirty === (choice !== 'Save'));
      check(label + ': dashboard visibility', app.dashboard.isOpen === (destination === 'dashboard' && !cancelled));
    } else {
      check(label + ': old design deleted', !(await hasDesign(state.id)));
      check(label + ': empty replacement', app.designId !== state.id && !app.dirty && ed.doc.nodes.length === 0 && ws.doc.shapes.length === 0);
      check(label + ': no second prompt', !saveDialog());
    }
  }
}

// Dismissing the dialog is also cancellation.
{
  const state = await seed();
  check('Escape: cancelled', await choose(() => app.dashboard.show(), 'Escape', 'Escape') === false);
  check('Escape: untouched', !app.dashboard.isOpen && app.designId === state.id && app.dirty && await savedText(state.id) === state.before);
}

// Deleting a different saved design must not save, replace or prompt for the current one.
{
  const other = await seed(), current = await seed();
  check('delete other: completed', await settle(app.deleteDesign(other.id)) === true);
  check('delete other: removed only target', !(await hasDesign(other.id)) && await hasDesign(current.id));
  check('delete other: current edits retained', app.designId === current.id && app.dirty && lib.doc.serializeDoc(ed.doc) === current.edited);
  check('delete other: current disk unchanged', await savedText(current.id) === current.before && !saveDialog());
}

// A failed save must prevent either transition, with auto-save on as well as off.
for (const autosave of [false, true]) {
  for (const destination of ['dashboard', 'delete']) {
    const state = await seed(), label = 'save failure/' + autosave + '/' + destination;
    const snapshot = app.viewport.snapshot;
    app.settings.autosave = autosave;
    app.viewport.snapshot = () => { throw new Error('Simulated snapshot failure'); };
    let result;
    try {
      const operation = () => destination === 'dashboard' ? app.dashboard.show() : app.deleteDesign(state.id);
      result = autosave ? await settle(operation()) : await choose(operation, 'Save', label);
    } finally {
      app.viewport.snapshot = snapshot;
      app.settings.autosave = false;
    }
    check(label + ': prevented', result === false && !app.dashboard.isOpen && !saveDialog());
    check(label + ': edits retained', app.designId === state.id && app.dirty && lib.doc.serializeDoc(ed.doc) === state.edited);
    check(label + ': disk unchanged', await hasDesign(state.id) && await savedText(state.id) === state.before);
    check(label + ': error visible', app.saveState.textContent === 'Could not save');
  }
}

if (fails.length) throw new Error(fails.join('\n'));
return { checks, fails };
