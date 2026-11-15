// Design library: thumbnails of every saved design, like a home screen.
import { h, clear, button, icon, popupMenu, confirmDialog } from './dom.js';
import { platform, isDesktop } from '../platform.js';

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export class Dashboard {
  constructor(app) {
    this.app = app;
    this.grid = h('div', { class: 'dash-grid' });
    this.closeBtn = button({ label: 'Back to design', icon: 'chevronRight', cls: 'btn-outline', onClick: () => this.hide() });
    this.el = h('div', { class: 'dashboard' },
      h('div', { class: 'dash-head' },
        h('div', { class: 'logo', style: { cursor: 'default' } }, app.logoMark(), h('span', { class: 'logo-name' }, 'DabbleCAD')),
        h('span', { class: 'spacer' }),
        button({ label: 'Open file…', icon: 'folder', cls: 'btn-outline', title: 'Open a .dabble file from disk', onClick: () => app.openFile() }),
        isDesktop ? button({ label: 'Library folder', cls: 'btn-outline', onClick: () => platform.openDesignsFolder() }) : null,
        this.closeBtn),
      h('div', { class: 'dash-body' }, h('h2', { class: 'dash-title' }, 'Your designs'), this.grid));
    document.body.append(this.el);
  }

  get isOpen() { return this.el.classList.contains('open'); }

  async show() {
    if (!(await this.app.confirmLeave())) return false;
    this.el.classList.add('open');
    await this.refresh();
    return true;
  }

  hide() { this.el.classList.remove('open'); }

  async refresh() {
    const list = await platform.listDesigns();
    clear(this.grid);
    const create = h('div', { class: 'dash-card dash-new' }, icon('plus', 34), 'Create new design');
    create.addEventListener('click', async () => { if (await this.app.newDesign()) this.hide(); });
    this.grid.append(create);
    for (const meta of list) {
      const more = button({ icon: 'list', title: 'More', cls: 'btn-ghost', onClick: (e) => {
        e.stopPropagation();
        popupMenu([
          { label: 'Open', icon: 'pencil', onClick: () => open() },
          { label: 'Duplicate', icon: 'duplicate', onClick: async () => { await this.app.duplicateDesign(meta.id); this.refresh(); } },
          { label: 'Rename', icon: 'pencil', onClick: async () => {
            const name = await this.app.prompt('Rename design', 'Name', meta.name);
            if (name) { await this.app.renameDesign(meta.id, name); this.refresh(); }
          } },
          'sep',
          { label: 'Delete', icon: 'trash', onClick: async () => {
            if (await confirmDialog('Delete design', `“${meta.name}” will be permanently deleted.`, 'Delete', true)) {
              if (await this.app.deleteDesign(meta.id)) this.refresh();
            }
          } },
        ], more);
      } });
      const open = async () => { if (await this.app.openDesign(meta.id)) this.hide(); };
      const card = h('div', { class: 'dash-card' + (meta.id === this.app.designId ? ' current' : '') },
        h('div', { class: 'dash-thumb', style: meta.thumb ? { backgroundImage: `url(${meta.thumb})` } : {} }),
        h('div', { class: 'dash-meta' }, h('div', {}, h('b', {}, meta.name || 'Untitled'), h('small', {}, `${ago(meta.modified)}${meta.shapes != null ? ' · ' + meta.shapes + ' shapes' : ''}`)), more));
      card.addEventListener('click', open);
      this.grid.append(card);
    }
  }
}
