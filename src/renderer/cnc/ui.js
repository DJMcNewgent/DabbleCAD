// Small form helpers shared by the CNC panels and dialogs.
import { h, button } from '../ui/dom.js';

export const trim = (v, dp = 3) => String(+(+v).toFixed(dp));

/** Length and feed conversion for the chosen display units. Values are always stored in mm. */
export function unitsOf(units) {
  const inch = units === 'in';
  return {
    inch, name: inch ? 'in' : 'mm', feedName: inch ? 'in/min' : 'mm/min', k: inch ? 1 / 25.4 : 1, dp: inch ? 4 : 3, step: inch ? 0.01 : 0.5,
    show: (mm) => trim(mm * (inch ? 1 / 25.4 : 1), inch ? 4 : 3),
    feed: (mm) => trim(mm * (inch ? 1 / 25.4 : 1), inch ? 1 : 0),
  };
}

/**
 * One labelled number field. `k` converts the stored value for display (shown = stored * k).
 * key: a stable name so keyboard focus survives the panel being redrawn.
 */
export function numRow(label, value, onSet, { unit = '', step = 1, min = -1e9, max = 1e9, title = '', k = 1, dp = 3, key = '', disabled = false } = {}) {
  const input = h('input', { class: 'input', type: 'number', step, value: trim(value * k, dp), title, disabled });
  if (key) input.dataset.key = key;
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!isFinite(v)) { input.value = trim(value * k, dp); return; }
    onSet(Math.min(max, Math.max(min, v / k)));
  });
  input.addEventListener('focus', () => input.select());
  return h('label', { class: 'le-row', title }, h('span', {}, label), input, unit ? h('em', {}, unit) : null);
}

export function selectRow(label, value, options, onSet, { title = '', key = '' } = {}) {
  const sel = h('select', { class: 'select', title }, options.map(([v, text]) => h('option', { value: v }, text)));
  sel.value = value;
  if (key) sel.dataset.key = key;
  sel.addEventListener('keydown', (e) => e.stopPropagation());
  sel.addEventListener('change', () => onSet(sel.value));
  return h('label', { class: 'le-row', title }, h('span', {}, label), sel);
}

export function checkRow(label, value, onSet, title = '') {
  const cb = h('input', { type: 'checkbox', checked: !!value });
  cb.addEventListener('change', () => onSet(cb.checked));
  return h('label', { class: 'check', title }, cb, label);
}

export function textRow(label, value, onSet, { placeholder = '', key = '' } = {}) {
  const input = h('input', { class: 'input', type: 'text', value: value || '', placeholder, spellcheck: false });
  if (key) input.dataset.key = key;
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); });
  input.addEventListener('change', () => onSet(input.value));
  return h('label', { class: 'le-row' }, h('span', {}, label), input);
}

export const section = (title, body, open = true) => h('details', { class: 'laser-section', open }, h('summary', {}, title), body);
export const actions = (m, okLabel, onOk, extra = []) => h('div', { class: 'modal-actions' }, ...extra, button({ label: 'Cancel', cls: 'btn-outline', onClick: () => m.close() }), button({ label: okLabel, cls: 'btn-primary', onClick: onOk }));
export const quiet = (el) => el.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
