import { api, q } from './api.js';
import { createEditor } from './editor.js';
import { createTree } from './tree.js';
import { createPdfViewer } from './pdfview.js';
import { createTerminalPanel } from './terminal.js';

const $ = (id) => document.getElementById(id);

const app = {
  root: null,
  settings: null,
  tree: null,
  file: null,      // { path, mtime }
  dirty: false,
  showAll: false,
  compiling: false,
  problems: [],
  rawLog: '',
  ws: null,
  workspace: { path: '', projects: [] },
  inWorkspace: false,
  recent: [],
  view: 'home',
};

// ---------------------------------------------------------------------------
// UI helpers
let toastTimer;
function toast(msg, { error = false, ms = 2600 } = {}) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// Minimal modal: resolves with the value of the button pressed (null on Escape / backdrop).
function modal({ title, body = '', input = null, buttons }) {
  return new Promise((resolve) => {
    const m = $('modal');
    $('modal-title').textContent = title;
    const b = $('modal-body');
    b.innerHTML = body;
    let inp = null;
    if (input) {
      inp = document.createElement('input');
      inp.type = 'text';
      inp.value = input.value || '';
      inp.placeholder = input.placeholder || '';
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); finish(buttons.find((x) => x.primary)?.value ?? buttons[0].value); }
      });
      b.appendChild(inp);
    }
    const bb = $('modal-buttons');
    bb.innerHTML = '';
    const finish = (v) => { m.hidden = true; document.removeEventListener('keydown', onKey); resolve(v === undefined ? null : (inp && v !== null ? { value: inp.value.trim(), choice: v } : v)); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    for (const btn of buttons) {
      const el = document.createElement('button');
      el.className = `btn ${btn.primary ? 'primary' : ''} ${btn.danger ? 'danger' : ''}`;
      el.textContent = btn.label;
      el.onclick = () => finish(btn.value);
      bb.appendChild(el);
    }
    m.onclick = (e) => { if (e.target === m) finish(null); };
    document.addEventListener('keydown', onKey);
    m.hidden = false;
    if (inp) { inp.focus(); inp.select(); }
  });
}

function closeMenus() {
  $('project-dropdown').hidden = true;
  $('more-dropdown').hidden = true;
  $('context-menu').hidden = true;
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.project-menu, .more-menu, .context-menu')) closeMenus();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

// ---------------------------------------------------------------------------
// Editor
const editor = createEditor($('editor'), {
  onSave: () => saveFile(),
  onCompile: () => compileNow(),
  onSyncForward: () => syncForward(),
  onChange: () => setDirty(true),
});

function setDirty(d) {
  if (!app.file) d = false;
  app.dirty = d;
  $('dirty-dot').hidden = !d;
  document.title = `${d ? '• ' : ''}${app.file ? app.file.path.split('/').pop() : 'local-leaf'}${app.root ? ` — ${app.root.split('/').pop()}` : ''}`;
}

async function openFile(path, { line, column } = {}) {
  if (app.file?.path === path && !line) return;
  if (app.dirty) await saveFile();
  try {
    const data = await api('GET', `/api/file?path=${q(path)}`);
    $('disk-banner').hidden = true;
    if (data.binary) {
      app.file = { path, mtime: data.mtime, binary: true };
      $('editor').hidden = true;
      const pv = $('preview');
      pv.hidden = false;
      const ext = path.split('.').pop().toLowerCase();
      if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'bmp', 'webp'].includes(ext)) {
        pv.innerHTML = `<img src="/api/raw?path=${q(path)}&t=${Date.now()}" alt="${path}" />`;
      } else {
        pv.innerHTML = `<div class="msg">Binary file (${(data.size / 1024).toFixed(1)} KB)<br><a href="/api/raw?path=${q(path)}" target="_blank">Open in new tab</a></div>`;
      }
    } else {
      app.file = { path, mtime: data.mtime };
      $('editor').hidden = false;
      $('preview').hidden = true;
      editor.setText(data.content, { preserve: false });
      if (path.endsWith('.bib')) collectBibKeys(data.content);
    }
    $('file-name').textContent = path;
    setDirty(false);
    tree.expandTo(path);
    tree.select(path);
    reportActiveFile(path);
    if (line) editor.gotoLine(line, column);
    else editor.focus();
  } catch (e) {
    toast(`Could not open ${path}: ${e.message}`, { error: true });
  }
}

// Tell the server which file is selected so the compile target can follow it.
async function reportActiveFile(path) {
  try {
    const r = await api('PUT', '/api/active', { file: path });
    updateTargetBadge(r);
  } catch { /* ignore */ }
}
function updateTargetBadge(r) {
  const el = $('compile-target');
  if (!r?.target) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle('standalone', !!r.standalone);
  el.textContent = r.standalone ? '▶ compiles this file' : `▶ compiles ${r.target}`;
  el.title = r.standalone ? 'This file has its own \\documentclass, so Compile builds it directly' : `This file is included from ${r.target}, which is what gets compiled`;
  $('compile-btn').title = `Compile ${r.target} (⌘↩)`;
}

async function saveFile() {
  if (!app.file || app.file.binary || !app.dirty) return;
  try {
    const r = await api('PUT', `/api/file?path=${q(app.file.path)}`, editor.getText(), { text: true });
    app.file.mtime = r.mtime;
    setDirty(false);
    $('disk-banner').hidden = true;
    refreshGitSoon();
  } catch (e) {
    toast(`Save failed: ${e.message}`, { error: true });
  }
}

async function reloadFromDisk() {
  if (!app.file || app.file.binary) return;
  const data = await api('GET', `/api/file?path=${q(app.file.path)}`);
  app.file.mtime = data.mtime;
  const wasDirty = app.dirty;
  editor.setText(data.content);
  setDirty(false);
  $('disk-banner').hidden = true;
  if (wasDirty) toast('Reloaded from disk');
}

function collectBibKeys(text) {
  const keys = [...text.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]);
  window.__bibKeys = [...new Set([...(window.__bibKeys || []), ...keys])];
}

async function preloadBibKeys(nodes) {
  window.__bibKeys = [];
  const bibs = [];
  const walk = (ns) => ns.forEach((n) => (n.type === 'dir' ? walk(n.children) : n.ext === '.bib' && bibs.push(n.path)));
  walk(nodes || []);
  for (const b of bibs.slice(0, 10)) {
    try { collectBibKeys((await api('GET', `/api/file?path=${q(b)}`)).content || ''); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Tree
const tree = createTree($('tree'), {
  onOpen: (n) => openFile(n.path),
  onContext: (e, n) => showContextMenu(e, n),
  onUpload: (files, dir) => uploadFiles(files, dir),
});

async function refreshTree() {
  if (!app.root) return;
  try {
    const t = await api('GET', `/api/tree?all=${app.showAll ? 1 : 0}`);
    app.tree = t;
    tree.set(t);
  } catch { /* ignore */ }
}
let treeTimer;
const refreshTreeSoon = () => { clearTimeout(treeTimer); treeTimer = setTimeout(refreshTree, 200); };

function showContextMenu(e, node) {
  closeMenus();
  const m = $('context-menu');
  m.innerHTML = '';
  const add = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.onclick = () => { m.hidden = true; fn(); };
    m.appendChild(b);
  };
  const sep = () => { const d = document.createElement('div'); d.className = 'sep'; m.appendChild(d); };
  const dir = !node ? '' : node.type === 'dir' ? node.path : node.path.split('/').slice(0, -1).join('/');
  if (node?.type === 'file') {
    add('Open', () => openFile(node.path));
    if (node.ext === '.tex') add('Set as main file', () => updateSettings({ main: node.path }));
    sep();
  }
  add('New file…', () => newFile(dir));
  add('New folder…', () => newFolder(dir));
  add('Upload files…', () => { $('upload-input').dataset.dir = dir; $('upload-input').click(); });
  if (node) {
    sep();
    add('Rename…', () => renameNode(node));
    add('Reveal in Finder', () => api('POST', '/api/projects/reveal', { path: node.path }));
    add('Move to Trash', () => deleteNode(node), 'danger');
  }
  m.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  m.style.top = `${Math.min(e.clientY, window.innerHeight - m.children.length * 30 - 20)}px`;
  m.hidden = false;
}

const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);

async function newFile(dir = '') {
  const name = prompt(`New file name${dir ? ` in ${dir}/` : ''}:`, 'untitled.tex');
  if (!name) return;
  const path = joinPath(dir, name.trim());
  try {
    const r = await api('POST', '/api/file/create', { path, type: 'file' });
    tree.set(r.tree);
    await openFile(path);
  } catch (e) { toast(e.message, { error: true }); }
}
async function newFolder(dir = '') {
  const name = prompt(`New folder name${dir ? ` in ${dir}/` : ''}:`);
  if (!name) return;
  try {
    const r = await api('POST', '/api/file/create', { path: joinPath(dir, name.trim()), type: 'dir' });
    tree.set(r.tree);
  } catch (e) { toast(e.message, { error: true }); }
}
async function renameNode(node) {
  const to = prompt('Rename to (path relative to project):', node.path);
  if (!to || to === node.path) return;
  try {
    const r = await api('POST', '/api/file/rename', { from: node.path, to: to.trim() });
    tree.set(r.tree);
    if (app.file?.path === node.path) { app.file.path = to.trim(); $('file-name').textContent = app.file.path; tree.select(app.file.path); }
    else if (app.file?.path.startsWith(node.path + '/')) { app.file.path = to.trim() + app.file.path.slice(node.path.length); $('file-name').textContent = app.file.path; }
  } catch (e) { toast(e.message, { error: true }); }
}
async function deleteNode(node) {
  if (!confirm(`Move "${node.path}" to the Trash?`)) return;
  try {
    const r = await api('DELETE', `/api/file?path=${q(node.path)}`);
    tree.set(r.tree);
    if (app.file && (app.file.path === node.path || app.file.path.startsWith(node.path + '/'))) closeFile();
    toast('Moved to Trash');
  } catch (e) { toast(e.message, { error: true }); }
}
function closeFile() {
  app.file = null;
  $('compile-target').hidden = true;
  editor.setText('', { preserve: false });
  $('file-name').textContent = 'No file open';
  $('editor').hidden = false;
  $('preview').hidden = true;
  setDirty(false);
}

async function uploadFiles(files, dir = '') {
  for (const f of files) {
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(f); });
    try {
      const r = await api('POST', '/api/file/upload', { path: joinPath(dir, f.name), data });
      tree.set(r.tree);
    } catch (e) { toast(`Upload failed: ${e.message}`, { error: true }); }
  }
  toast(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
}
$('upload-input').addEventListener('change', (e) => {
  const dir = e.target.dataset.dir || '';
  if (e.target.files.length) uploadFiles([...e.target.files], dir);
  e.target.value = '';
  e.target.dataset.dir = '';
});
$('upload-btn').onclick = () => { $('upload-input').dataset.dir = ''; $('upload-input').click(); };
$('new-file-btn').onclick = () => newFile('');
$('new-folder-btn').onclick = () => newFolder('');

// ---------------------------------------------------------------------------
// PDF
const pdf = createPdfViewer($('pdf-container'), {
  onInverseSync: async ({ page, x, y }) => {
    try {
      const r = await api('POST', '/api/synctex/inverse', { page, x, y });
      if (!r) return toast('No source position found for that spot');
      await openFile(r.file, { line: r.line, column: r.column });
      if (app.file?.path === r.file) editor.gotoLine(r.line, r.column);
    } catch (e) { toast(`SyncTeX: ${e.message}`, { error: true }); }
  },
  onPageChange: (s) => ($('page-indicator').textContent = s),
});
$('zoom-in').onclick = () => pdf.zoomIn();
$('zoom-out').onclick = () => pdf.zoomOut();
$('zoom-fit').onclick = () => pdf.fit();

async function reloadPdf() {
  try {
    await pdf.load(`/api/pdf?t=${Date.now()}`);
    $('pdf-empty').hidden = true;
    $('pdf-container').classList.remove('stale');
    $('pdf-status').textContent = '';
  } catch (e) {
    if (!pdf.hasDoc) $('pdf-empty').hidden = false;
  }
}

async function syncForward() {
  if (!app.file || app.file.binary) return;
  const { line, column } = editor.cursor();
  try {
    const r = await api('POST', '/api/synctex/forward', { file: app.file.path, line, column });
    if (!r) return toast('No PDF position for this line (compile first?)');
    pdf.highlight(r);
  } catch (e) { toast(`SyncTeX: ${e.message}`, { error: true }); }
}
$('sync-fwd-btn').onclick = syncForward;

// ---------------------------------------------------------------------------
// Compile & problems
function setCompiling(on) {
  app.compiling = on;
  $('compile-btn').querySelector('.spinner').hidden = !on;
  $('compile-btn').querySelector('.label').textContent = on ? 'Compiling' : 'Compile';
  $('compile-btn').disabled = on;
  $('stop-btn').hidden = !on;
  if (on) {
    setSummary('Compiling…', 'busy');
    $('pdf-container').classList.add('stale');
  }
}
function setSummary(text, cls = '') {
  const el = $('problems-summary');
  el.textContent = text;
  el.className = cls;
}

async function compileNow() {
  if (app.dirty) await saveFile();
  if (!app.settings?.main && !app.file) return toast('Set a main file first', { error: true });
  if (app.compiling) return;
  try { await api('POST', '/api/compile'); } catch (e) { toast(e.message, { error: true }); }
}
$('compile-btn').onclick = compileNow;
$('stop-btn').onclick = () => api('POST', '/api/compile/stop');

function renderProblems(result) {
  const list = $('problems-list');
  list.innerHTML = '';
  const problems = result?.errors || [];
  app.problems = problems;
  const nErr = problems.filter((p) => p.type === 'error').length;
  const nWarn = problems.filter((p) => p.type === 'warning').length;
  const nInfo = problems.length - nErr - nWarn;
  if (!result) { setSummary('Ready'); return; }
  const parts = [];
  if (nErr) parts.push(`${nErr} error${nErr > 1 ? 's' : ''}`);
  if (nWarn) parts.push(`${nWarn} warning${nWarn > 1 ? 's' : ''}`);
  if (nInfo) parts.push(`${nInfo} note${nInfo > 1 ? 's' : ''}`);
  const when = new Date(result.at).toLocaleTimeString();
  if (result.ok) setSummary(`Compiled ${result.main} at ${when}${parts.length ? ` · ${parts.join(', ')}` : ''}`, 'ok');
  else setSummary(`Compile failed · ${parts.join(', ') || 'see log'}`, 'error');
  if (!problems.length) {
    list.innerHTML = `<div class="problem ok"><span class="tag">ok</span><span class="msg">No problems. Nice.</span></div>`;
  }
  const order = { error: 0, warning: 1, info: 2 };
  for (const p of [...problems].sort((a, b) => order[a.type] - order[b.type])) {
    const row = document.createElement('div');
    row.className = `problem ${p.type}`;
    const loc = p.file ? `${p.file}${p.line ? `:${p.line}` : ''}` : '';
    row.innerHTML = `<span class="tag">${p.type}</span><span class="loc">${loc}</span><span class="msg"></span>`;
    row.querySelector('.msg').textContent = p.message;
    if (p.context) {
      const c = document.createElement('span');
      c.className = 'ctx';
      c.textContent = p.context;
      row.querySelector('.msg').appendChild(c);
    }
    if (p.file) row.onclick = () => openFile(p.file, { line: p.line || 1 });
    list.appendChild(row);
  }
}

$('problems-head').onclick = (e) => { if (!e.target.closest('.pane-actions')) toggleProblems(); };
$('problems-toggle').onclick = toggleProblems;
function toggleProblems(force) {
  const el = $('problems');
  const collapse = force ?? !el.classList.contains('collapsed');
  el.classList.toggle('collapsed', collapse);
  $('problems-toggle').textContent = collapse ? '▴' : '▾';
  if (!collapse) requestAnimationFrame(() => termPanel.fit());
}
let panelTab = 'list';
function showProblemsTab(tab) {
  panelTab = tab;
  $('problems-list').hidden = tab !== 'list';
  $('raw-log').hidden = tab !== 'log';
  $('term-panel').hidden = tab !== 'term';
  $('term-actions').hidden = tab !== 'term';
  $('problems-summary').hidden = tab === 'term';
  for (const t of ['list', 'log', 'term']) $(`problems-tab-${t}`).classList.toggle('active', tab === t);
  toggleProblems(false);
  if (tab === 'log') $('raw-log').scrollTop = $('raw-log').scrollHeight;
  if (tab === 'term') {
    if ($('problems').offsetHeight < 200) setPanelHeight(Math.max(260, Math.round(window.innerHeight * 0.35)));
    requestAnimationFrame(() => { termPanel.fit(); });
  }
}
function setPanelHeight(h) {
  h = Math.max(30, Math.min(h, window.innerHeight - 120));
  document.documentElement.style.setProperty('--problems-h', `${h}px`);
  try { localStorage.setItem('ll.panelH', String(h)); } catch { /* ignore */ }
  termPanel.fit();
}
try { const h = Number(localStorage.getItem('ll.panelH')); if (h > 30) document.documentElement.style.setProperty('--problems-h', `${h}px`); } catch { /* ignore */ }
$('problems-tab-list').onclick = () => showProblemsTab('list');
$('problems-tab-log').onclick = () => showProblemsTab('log');
$('problems-tab-term').onclick = () => showProblemsTab('term');
$('panel-gutter').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startY = e.clientY;
  const startH = $('problems').getBoundingClientRect().height;
  $('panel-gutter').classList.add('active');
  document.body.style.cursor = 'row-resize';
  const move = (ev) => setPanelHeight(startH + (startY - ev.clientY));
  const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); $('panel-gutter').classList.remove('active'); document.body.style.cursor = ''; termPanel.fit(); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

// ---- integrated terminal ----
const termPanel = createTerminalPanel({
  host: $('term-host'), tabs: $('term-tabs'), api,
  onCountChange: (n) => { $('term-count').hidden = !n; $('term-count').textContent = n; $('term-empty').hidden = n > 0; },
});
async function newTerminal({ claude = false } = {}) {
  if (!app.root) return toast('Open a project first', { error: true });
  showProblemsTab('term');
  try { await termPanel.open({ claude }); } catch (e) { toast(e.message, { error: true, ms: 6000 }); }
}
function toggleTerminal() {
  const collapsed = $('problems').classList.contains('collapsed');
  if (panelTab === 'term' && !collapsed) { toggleProblems(true); editor.focus(); }
  else { showProblemsTab('term'); if (!termPanel.count) newTerminal(); else termPanel.activate(termPanel.active); }
}
$('term-new').onclick = () => newTerminal();
$('term-claude').onclick = () => newTerminal({ claude: true });
$('term-empty-new').onclick = (e) => { e.preventDefault(); newTerminal(); };
$('term-empty-claude').onclick = (e) => { e.preventDefault(); newTerminal({ claude: true }); };
$('terminal-btn').onclick = toggleTerminal;
document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerminal(); } });

// ---------------------------------------------------------------------------
// Settings & project
async function updateSettings(patch) {
  try {
    app.settings = await api('PATCH', '/api/settings', patch);
    applySettings();
    if (app.file && !app.file.binary) reportActiveFile(app.file.path);
  } catch (e) { toast(e.message, { error: true }); }
}
function applySettings(candidates) {
  const s = app.settings || {};
  const sel = $('main-select');
  if (candidates) {
    sel.innerHTML = '';
    const opts = [...new Set([...(s.main ? [s.main] : []), ...candidates])];
    if (!opts.length) sel.innerHTML = '<option value="">(no .tex with \\documentclass)</option>';
    for (const c of opts) { const o = document.createElement('option'); o.value = c; o.textContent = c; sel.appendChild(o); }
  } else if (s.main && ![...sel.options].some((o) => o.value === s.main)) {
    const o = document.createElement('option'); o.value = s.main; o.textContent = s.main; sel.prepend(o);
  }
  sel.value = s.main || '';
  $('engine-select').value = s.engine || 'pdflatex';
  $('auto-toggle').checked = !!s.autoCompile;
  tree.setMain(s.main);
}
$('main-select').onchange = (e) => updateSettings({ main: e.target.value });
$('engine-select').onchange = (e) => updateSettings({ engine: e.target.value });
$('auto-toggle').onchange = (e) => updateSettings({ autoCompile: e.target.checked });

const isInWorkspace = (p) => app.workspace.path && (p === app.workspace.path || p.startsWith(app.workspace.path + '/'));

function projectItem(r, { showPath, removable, active }) {
  const item = document.createElement('div');
  item.className = 'item';
  const b = document.createElement('button');
  b.className = 'main' + (active ? ' active' : '');
  b.innerHTML = `<span></span><span class="path"></span>`;
  b.children[0].textContent = r.name || r.path.split('/').pop();
  b.children[1].textContent = showPath ? r.path : (r.main ? r.main : 'no main file yet');
  b.title = r.path;
  b.onclick = () => { closeMenus(); openProject(r.path); };
  item.appendChild(b);
  if (removable) {
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Remove from recent';
    x.onclick = async (e) => { e.stopPropagation(); await api('POST', '/api/projects/forget', { path: r.path }); refreshProjectLists(); };
    item.appendChild(x);
  }
  return item;
}

function renderProjectMenu({ recent = [], workspace }) {
  if (workspace) app.workspace = workspace;
  const projects = app.workspace.projects || [];
  const external = recent.filter((r) => !isInWorkspace(r.path));
  const dd = $('project-dropdown');
  dd.innerHTML = '';
  const head = (t) => { const h = document.createElement('div'); h.className = 'head'; h.textContent = t; dd.appendChild(h); };
  const action = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { closeMenus(); fn(); }; dd.appendChild(b); };
  head('Projects folder');
  if (!projects.length) dd.insertAdjacentHTML('beforeend', '<div class="empty">Nothing in projects/ yet</div>');
  for (const p of projects) dd.appendChild(projectItem(p, { active: p.path === app.root }));
  const sep = () => { const d = document.createElement('div'); d.className = 'sep'; dd.appendChild(d); };
  sep();
  action('＋ New project…', newProject);
  action('Open or import folder…', pickProject);
  action('Upload folder…', () => $('folder-input').click());
  action('Upload .zip…', () => $('zip-input').click());
  action('Import from Overleaf…', importFromOverleaf);
  if (external.length) {
    sep();
    head('Other recent');
    for (const r of external) dd.appendChild(projectItem(r, { showPath: true, removable: true, active: r.path === app.root }));
  }

  app.recent = recent;
  renderHome();
  updateWorkspaceMenu();
}

// ---------------------------------------------------------------------------
// Home / project manager view
function fmtWhen(ms) {
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 14) return `${days} d ago`;
  return new Date(ms).toLocaleDateString();
}

function renderHome() {
  const filter = ($('home-search').value || '').trim().toLowerCase();
  const projects = (app.workspace.projects || []).filter((p) => !filter || p.name.toLowerCase().includes(filter));
  const external = (app.recent || []).filter((r) => !isInWorkspace(r.path) && (!filter || r.path.toLowerCase().includes(filter)));
  $('home-path').textContent = app.workspace.path ? app.workspace.path.replace(/^\/Users\/[^/]+/, '~') : '';
  $('home-continue').hidden = !app.root;
  if (app.root) $('home-continue-name').textContent = app.root.split('/').pop();

  const grid = $('home-grid');
  grid.innerHTML = '';
  if (!projects.length) {
    const e = document.createElement('div');
    e.className = 'home-empty';
    e.textContent = filter ? 'No projects match.' : 'No projects yet. Create one, upload a folder or zip, or import from Overleaf.';
    grid.appendChild(e);
  }
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'card' + (p.path === app.root ? ' current' : '');
    card.innerHTML = `<div class="card-name"></div><div class="card-main"></div><div class="card-meta"><span class="when"></span><span class="card-badge"></span></div><button class="card-menu" title="Project actions">⋯</button>`;
    card.querySelector('.card-name').textContent = p.name;
    card.querySelector('.card-main').textContent = p.main || 'no main file yet';
    card.querySelector('.when').textContent = `edited ${fmtWhen(p.modified)}`;
    card.querySelector('.card-badge').textContent = p.path === app.root ? 'open' : '';
    card.onclick = (e) => { if (!e.target.closest('.card-menu')) openProject(p.path); };
    card.querySelector('.card-menu').onclick = (e) => { e.stopPropagation(); projectCardMenu(e, p); };
    card.oncontextmenu = (e) => { e.preventDefault(); projectCardMenu(e, p); };
    grid.appendChild(card);
  }
  if (!filter) {
    const add = document.createElement('div');
    add.className = 'card add';
    add.textContent = '＋ New project';
    add.onclick = newProject;
    grid.appendChild(add);
  }

  const rec = $('home-recent');
  rec.innerHTML = '';
  if (external.length) {
    const h = document.createElement('h2');
    h.textContent = 'Other folders opened in place';
    rec.appendChild(h);
    for (const r of external) {
      const row = document.createElement('div');
      row.className = 'recent-row';
      row.innerHTML = `<div class="info"><div class="name"></div><div class="path"></div></div>`;
      row.querySelector('.name').textContent = r.path.split('/').pop() + (r.path === app.root ? '  · open' : '');
      row.querySelector('.path').textContent = r.path;
      row.querySelector('.info').onclick = () => openProject(r.path);
      const mk = (label, fn, cls = '') => { const b = document.createElement('button'); b.className = `btn ${cls}`; b.textContent = label; b.onclick = fn; return b; };
      row.appendChild(mk('Copy in', () => importFolder(r.path, 'copy')));
      row.appendChild(mk('Move in', async () => {
        const ok = await modal({ title: 'Move into projects folder?', body: `<code>${r.path}</code>`, buttons: [{ label: 'Cancel', value: null }, { label: 'Move', value: 'move', primary: true }] });
        if (ok) importFolder(r.path, 'move');
      }));
      row.appendChild(mk('×', async () => { await api('POST', '/api/projects/forget', { path: r.path }); refreshProjectLists(); }, 'subtle'));
      rec.appendChild(row);
    }
  }
}

function projectCardMenu(e, p) {
  closeMenus();
  const m = $('context-menu');
  m.innerHTML = '';
  const add = (label, fn, cls = '') => { const b = document.createElement('button'); b.textContent = label; b.className = cls; b.onclick = () => { m.hidden = true; fn(); }; m.appendChild(b); };
  add('Open', () => openProject(p.path));
  add('Reveal in Finder', () => api('POST', '/api/workspace/reveal', { path: p.path }));
  add('Open in editor with terminal', async () => { await openProject(p.path); newTerminal(); });
  add('Open in editor with Claude Code', async () => { await openProject(p.path); newTerminal({ claude: true }); });
  add('Rename…', () => renameProject(p));
  const sep = document.createElement('div'); sep.className = 'sep'; m.appendChild(sep);
  add('Move to Trash', () => trashProject(p), 'danger');
  m.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  m.style.top = `${Math.min(e.clientY, window.innerHeight - 160)}px`;
  m.hidden = false;
}

async function renameProject(p) {
  const r = await modal({ title: `Rename "${p.name}"`, body: 'The folder in <code>projects/</code> is renamed.', input: { value: p.name }, buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'rename', primary: true }] });
  if (!r?.value || r.value === p.name) return;
  try {
    const res = await api('POST', '/api/workspace/rename', { path: p.path, name: r.value });
    if (res.project) { await applyProject(res.project); showHome(); }
    else refreshProjectLists();
    toast(`Renamed to ${r.value}`);
  } catch (e) { toast(e.message, { error: true }); }
}

async function trashProject(p) {
  const ok = await modal({
    title: `Move "${p.name}" to the Trash?`,
    body: `<code>${p.path}</code><div class="hint">The folder goes to the macOS Trash, so you can get it back from Finder.</div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Move to Trash', value: 'trash', danger: true }],
  });
  if (!ok) return;
  try {
    await api('POST', '/api/workspace/trash', { path: p.path });
    if (app.root === p.path) closeProjectView();
    refreshProjectLists();
    toast(`Moved ${p.name} to Trash`);
  } catch (e) { toast(e.message, { error: true }); }
}

// View switching: 'home' (project manager) or 'editor'. The server keeps the project open either way.
function showHome() {
  app.view = 'home';
  document.body.classList.add('view-home');
  $('home').hidden = false;
  if (location.hash !== '#home') history.pushState(null, '', '#home');
  refreshProjectLists();
  $('home-search').focus();
}
function showEditor() {
  if (!app.root) return showHome();
  app.view = 'editor';
  document.body.classList.remove('view-home');
  $('home').hidden = true;
  if (location.hash !== '#editor') history.pushState(null, '', '#editor');
  editor.focus();
}
window.addEventListener('popstate', () => { if (location.hash === '#home' || !app.root) { if (app.view !== 'home') showHome(); } else if (app.view !== 'editor') showEditor(); });
$('brand-btn').onclick = showHome;
$('home-btn').onclick = showHome;
$('home-continue-btn').onclick = showEditor;
$('home-new').onclick = newProject;
$('home-open').onclick = pickProject;
$('home-upload').onclick = () => $('folder-input').click();
$('home-zip').onclick = () => $('zip-input').click();
$('home-reveal').onclick = (e) => { e.preventDefault(); api('POST', '/api/projects/reveal-workspace'); };
$('home-change-ws').onclick = async (e) => {
  e.preventDefault();
  try {
    const r = await api('POST', '/api/workspace/path', {});
    if (r.cancelled) return;
    toast(`Projects folder is now ${r.path}`);
    if (app.root && !r.path.startsWith(app.root)) { /* keep editing */ }
    refreshProjectLists();
  } catch (err) { toast(err.message, { error: true }); }
};
$('home-search').addEventListener('input', renderHome);

function updateWorkspaceMenu() {
  app.inWorkspace = !!app.root && isInWorkspace(app.root);
  document.querySelectorAll('#more-dropdown .ws-external').forEach((b) => (b.hidden = !app.root || app.inWorkspace));
  document.querySelectorAll('#more-dropdown .ws-internal').forEach((b) => (b.hidden = !app.root || !app.inWorkspace));
}

async function refreshProjectLists() {
  try { const st = await api('GET', '/api/state'); renderProjectMenu({ recent: st.recent, workspace: st.workspace }); } catch { /* ignore */ }
}

// ---- workspace actions ----
async function newProject() {
  const r = await modal({
    title: 'New project',
    body: 'Creates a folder in <code>projects/</code> with a starter <code>main.tex</code>.',
    input: { placeholder: 'project-name' },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'create', primary: true }],
  });
  if (!r?.value) return;
  try {
    const p = await api('POST', '/api/workspace/create', { name: r.value });
    await applyProject(p);
    toast(`Created ${p.name}`);
  } catch (e) { toast(e.message, { error: true }); }
}

async function importFolder(path, mode) {
  try {
    const p = await api('POST', '/api/workspace/import', { path, mode });
    await applyProject(p);
    toast(`${mode === 'move' ? 'Moved' : 'Copied'} into projects/${p.name}`);
  } catch (e) { toast(`Import failed: ${e.message}`, { error: true }); }
}

async function askImport(path) {
  const name = path.split('/').pop();
  const choice = await modal({
    title: `Import "${name}"?`,
    body: `<code>${path}</code><div class="hint">Copy or move it into this repo's <code>projects/</code> folder so it shows up in the project list, or open it where it is.</div>`,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Open in place', value: 'open' },
      { label: 'Move into projects', value: 'move' },
      { label: 'Copy into projects', value: 'copy', primary: true },
    ],
  });
  if (!choice) return;
  if (choice === 'open') return openProject(path);
  return importFolder(path, choice);
}

async function uploadFolder(files) {
  files = [...files].filter((f) => f.webkitRelativePath && !/(^|\/)(\.git|node_modules|\.DS_Store)(\/|$)/.test(f.webkitRelativePath) && !/\.(aux|log|fls|fdb_latexmk|synctex\.gz|out|toc|bbl|blg)$/i.test(f.name));
  if (!files.length) return toast('No files to upload', { error: true });
  const project = files[0].webkitRelativePath.split('/')[0];
  toast(`Uploading ${files.length} files into projects/${project}…`, { ms: 60000 });
  let root = null;
  for (const f of files) {
    const rel = f.webkitRelativePath.split('/').slice(1).join('/');
    const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(f); });
    try {
      const r = await api('POST', '/api/workspace/upload-file', { project, path: rel, data });
      root = r.root;
    } catch (e) { toast(`Upload failed on ${rel}: ${e.message}`, { error: true }); return; }
  }
  toast(`Uploaded ${files.length} files`);
  if (root) openProject(root);
}

async function uploadZip(file) {
  toast(`Extracting ${file.name}…`, { ms: 60000 });
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(file); });
  try {
    const p = await api('POST', '/api/workspace/import-zip', { name: file.name, data });
    await applyProject(p);
    toast(`Imported ${p.name}`);
  } catch (e) { toast(`Zip import failed: ${e.message}`, { error: true }); }
}

// ---- Overleaf ----
async function setOverleafToken({ force = false } = {}) {
  let has = false;
  try { has = (await api('GET', '/api/overleaf/token')).set; } catch { /* ignore */ }
  if (has && !force) return true;
  const r = await modal({
    title: has ? 'Replace Overleaf git token' : 'Overleaf git token',
    body: `Overleaf's git access needs a personal token (paid plans only). Generate one at
      <a href="https://www.overleaf.com/user/settings" target="_blank" rel="noopener">overleaf.com/user/settings</a>
      under <b>Git integration</b> and paste it here. It is stored only on this Mac, in <code>~/.local-leaf</code>.
      <div class="hint">On a free plan, use <b>Menu → Download → Source</b> in Overleaf and then <b>Upload .zip…</b> here instead.</div>`,
    input: { placeholder: 'olp_…' },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save token', value: 'save', primary: true }],
  });
  if (!r?.value) return false;
  try {
    await api('POST', '/api/overleaf/token', { token: r.value });
    toast('Overleaf token saved');
    return true;
  } catch (e) { toast(e.message, { error: true }); return false; }
}

async function importFromOverleaf() {
  if (!(await setOverleafToken())) return;
  const r = await modal({
    title: 'Import from Overleaf',
    body: `Paste the project URL from your browser's address bar (<code>https://www.overleaf.com/project/…</code>).
      The project is cloned into <code>projects/</code> and detached from Overleaf: it becomes part of this
      local-leaf repository, so committing and pushing from the Git panel sends it to your own GitHub repo.`,
    input: { placeholder: 'https://www.overleaf.com/project/64f1…' },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Import', value: 'import', primary: true }],
  });
  if (!r?.value) return;
  toast('Cloning from Overleaf…', { ms: 60000 });
  try {
    const p = await api('POST', '/api/overleaf/import', { project: r.value });
    await applyProject(p);
    toast(p.overleaf?.joinedRepo === false ? `Imported ${p.name} from Overleaf and detached it` : `Imported ${p.name} from Overleaf; it is now part of this repo. Commit and push from the Git panel.`, { ms: 6000 });
  } catch (e) {
    toast(e.message, { error: true, ms: 8000 });
  }
}
$('home-overleaf').onclick = importFromOverleaf;

async function trashCurrentProject() {
  const name = app.root.split('/').pop();
  const ok = await modal({
    title: `Move "${name}" to the Trash?`,
    body: `<code>${app.root}</code><div class="hint">The folder goes to the macOS Trash, so you can get it back from Finder.</div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Move to Trash', value: 'trash', danger: true }],
  });
  if (!ok) return;
  try {
    await api('POST', '/api/workspace/trash', { path: app.root });
    closeProjectView();
    toast(`Moved ${name} to Trash`);
  } catch (e) { toast(e.message, { error: true }); }
}

// The server closed (or lost) the project: clear the editor and go to the project manager.
function closeProjectView() {
  app.root = null; app.settings = null;
  closeFile();
  tree.set([]);
  pdf.clear();
  $('pdf-empty').hidden = false;
  renderProblems(null);
  $('project-name').textContent = 'No project';
  document.body.classList.add('no-project');
  gitUi.status = null; renderGit();
  document.title = 'local-leaf';
  showHome();
}

$('folder-input').addEventListener('change', (e) => { if (e.target.files.length) uploadFolder(e.target.files); e.target.value = ''; });
$('zip-input').addEventListener('change', (e) => { if (e.target.files[0]) uploadZip(e.target.files[0]); e.target.value = ''; });


async function applyProject(p) {
  app.root = p.root;
  app.settings = p.settings;
  app.tree = p.tree;
  closeFile();
  $('project-name').textContent = p.name;
  document.body.classList.remove('no-project');
  showEditor();
  tree.set(p.tree);
  applySettings(p.candidates);
  renderProblems(null);
  $('raw-log').textContent = '';
  pdf.clear();
  $('pdf-empty').hidden = false;
  $('pdf-container').classList.remove('stale');
  document.title = `local-leaf — ${p.name}`;
  preloadBibKeys(p.tree);
  document.body.classList.remove('no-project');
  gitUi.message = '';
  refreshGit();
  if (p.settings.main) {
    await openFile(p.settings.main);
    reloadPdf();
  }
  await refreshProjectLists();
}

async function openProject(path) {
  try {
    const p = await api('POST', '/api/projects/open', { path });
    await applyProject(p);
    toast(`Opened ${p.name}`);
  } catch (e) { toast(`Could not open project: ${e.message}`, { error: true }); }
}
async function pickProject() {
  try {
    const r = await api('POST', '/api/projects/pick-path');
    if (r.cancelled) return;
    if (r.inWorkspace) return openProject(r.path);
    await askImport(r.path);
  } catch (e) { toast(`Could not open project: ${e.message}`, { error: true }); }
}
$('open-btn').onclick = pickProject;
$('project-btn').onclick = (e) => { e.stopPropagation(); const dd = $('project-dropdown'); const was = dd.hidden; closeMenus(); dd.hidden = !was; };
$('more-btn').onclick = (e) => { e.stopPropagation(); const dd = $('more-dropdown'); const was = dd.hidden; closeMenus(); dd.hidden = !was; };
$('more-dropdown').addEventListener('click', async (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  closeMenus();
  if (action === 'clean') { const r = await api('POST', '/api/compile/clean'); toast(r.ok ? 'Auxiliary files removed' : 'Clean failed', { error: !r.ok }); refreshTree(); }
  if (action === 'raw-log') showProblemsTab('log');
  if (action === 'reveal') api('POST', '/api/projects/reveal', { path: '.' });
  if (action === 'show-all') { app.showAll = !app.showAll; e.target.textContent = (app.showAll ? 'Hide' : 'Show') + ' hidden & aux files'; refreshTree(); }
  if (action === 'ws-copy') importFolder(app.root, 'copy');
  if (action === 'ws-move') {
    const ok = await modal({ title: 'Move project into projects folder?', body: `<code>${app.root}</code><div class="hint">The folder is moved (not copied) to <code>${app.workspace.path}/${app.root.split('/').pop()}</code>.</div>`, buttons: [{ label: 'Cancel', value: null }, { label: 'Move', value: 'move', primary: true }] });
    if (ok) importFolder(app.root, 'move');
  }
  if (action === 'ws-trash') trashCurrentProject();
  if (action === 'ws-reveal') api('POST', '/api/projects/reveal-workspace');
  if (action === 'overleaf-token') setOverleafToken({ force: true });
  if (action === 'ext-terminal') openTerminal();
  if (action === 'ext-claude') openTerminal({ claude: true });
  if (action === 'shortcuts') modal({
    title: 'Keyboard shortcuts',
    body: `<table class="shortcuts-table">
      <tr><td><kbd>⌘S</kbd></td><td>Save</td><td><kbd>⌘↩</kbd></td><td>Compile</td></tr>
      <tr><td><kbd>⌘B</kbd></td><td>Bold <code>\\textbf{}</code></td><td><kbd>⌘I</kbd></td><td>Italic <code>\\textit{}</code></td></tr>
      <tr><td><kbd>⌘E</kbd></td><td>Emphasis <code>\\emph{}</code></td><td><kbd>⌘⇧T</kbd></td><td>Typewriter <code>\\texttt{}</code></td></tr>
      <tr><td><kbd>⌘⇧M</kbd></td><td>Inline math <code>$…$</code></td><td><kbd>⌘⇧E</kbd></td><td>Equation environment</td></tr>
      <tr><td><kbd>⌘⇧I</kbd></td><td>Itemize environment</td><td><kbd>⌘/</kbd></td><td>Toggle <code>%</code> comment</td></tr>
      <tr><td><kbd>⌘U</kbd></td><td>Uppercase</td><td><kbd>⌘⇧U</kbd></td><td>Lowercase</td></tr>
      <tr><td><kbd>⌘D</kbd></td><td>Delete line</td><td><kbd>⌘⇧D</kbd></td><td>Duplicate line</td></tr>
      <tr><td><kbd>⌘F</kbd></td><td>Find / replace</td><td><kbd>⌥G</kbd></td><td>Go to line</td></tr>
      <tr><td><kbd>⌘⇧J</kbd></td><td>Cursor → PDF</td><td><kbd>⌘-click PDF</kbd></td><td>PDF → source</td></tr>
      <tr><td><kbd>⌃\`</kbd></td><td>Toggle terminal</td><td><kbd>Esc</kbd></td><td>Close menus</td></tr>
    </table><div class="hint">With text selected, the formatting shortcuts wrap the selection. On a PC keyboard, ⌘ is Ctrl.</div>`,
    buttons: [{ label: 'Close', value: 'ok', primary: true }],
  });
});

// ---------------------------------------------------------------------------
// External Terminal.app launcher (the integrated terminal is the default; this is the escape hatch)
async function openTerminal({ claude = false, path } = {}) {
  try {
    const r = await api('POST', '/api/terminal/open', { claude, path });
    toast(`${claude ? 'Claude Code' : 'Terminal'} opened in ${r.app}`);
  } catch (e) { toast(e.message, { error: true }); }
}

// ---------------------------------------------------------------------------
// WebSocket live updates
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  app.ws = ws;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case 'fs': onFsEvent(msg); break;
      case 'compile:start': setCompiling(true); app.rawLog = ''; $('raw-log').textContent = ''; break;
      case 'compile:output': app.rawLog += msg.chunk; if (!$('raw-log').hidden) { $('raw-log').textContent = app.rawLog; $('raw-log').scrollTop = $('raw-log').scrollHeight; } break;
      case 'compile:done':
        setCompiling(false);
        $('raw-log').textContent = app.rawLog;
        renderProblems(msg);
        if (msg.pdf) reloadPdf();
        else $('pdf-container').classList.remove('stale');
        if (!msg.ok && $('problems').classList.contains('collapsed')) toggleProblems(false);
        break;
      case 'settings': app.settings = msg.settings; applySettings(); break;
      case 'project:closed': if (app.root) closeProjectView(); break;
      case 'project:opened':
        // Another tab, the CLI or Claude Code opened a project: follow it.
        if (msg.root !== app.root) {
          api('GET', '/api/state').then((st) => st.root && applyProject({ root: st.root, name: st.name, settings: st.settings, tree: st.tree, candidates: st.candidates, inWorkspace: st.inWorkspace })).catch(() => {});
        }
        break;
    }
  };
  ws.onclose = () => setTimeout(connectWs, 1500);
}

async function onFsEvent(ev) {
  if (!ev.isAux) { refreshTreeSoon(); refreshGitSoon(); }
  if (!app.file || app.file.binary) return;
  if (ev.path !== app.file.path) return;
  if (ev.event === 'unlink') {
    $('disk-banner-text').textContent = 'This file was deleted or moved on disk.';
    $('disk-reload').hidden = true;
    $('disk-banner').hidden = false;
    return;
  }
  if (ev.event === 'change' || ev.event === 'add') {
    if (!app.dirty) {
      await reloadFromDisk();
    } else {
      const data = await api('GET', `/api/file?path=${q(app.file.path)}`);
      if (data.content === editor.getText()) { app.file.mtime = data.mtime; setDirty(false); return; }
      $('disk-banner-text').textContent = 'This file changed on disk while you have unsaved edits.';
      $('disk-reload').hidden = false;
      $('disk-banner').hidden = false;
    }
  }
}
$('disk-reload').onclick = () => reloadFromDisk();
$('disk-keep').onclick = () => { $('disk-banner').hidden = true; };

// ---------------------------------------------------------------------------
// Git panel (each project is its own repository)
const gitUi = { status: null, log: [], busy: false, message: '' };

function gitToggle(force) {
  const el = $('git-pane');
  const collapse = force ?? !el.classList.contains('collapsed');
  el.classList.toggle('collapsed', collapse);
  $('git-toggle').textContent = collapse ? '▴' : '▾';
  try { localStorage.setItem('ll.gitCollapsed', collapse ? '1' : '0'); } catch { /* ignore */ }
}
$('git-head').onclick = (e) => { if (!e.target.closest('.pane-actions')) gitToggle(); };
$('git-toggle').onclick = () => gitToggle();
$('git-refresh').onclick = () => refreshGit();
try { if (localStorage.getItem('ll.gitCollapsed') === '1') gitToggle(true); } catch { /* ignore */ }

let gitTimer;
const refreshGitSoon = () => { clearTimeout(gitTimer); gitTimer = setTimeout(refreshGit, 600); };

async function refreshGit() {
  if (!app.root) { gitUi.status = null; renderGit(); return; }
  try {
    gitUi.status = await api('GET', '/api/git/status');
    gitUi.log = gitUi.status.repo && gitUi.status.hasCommits ? await api('GET', '/api/git/log?n=6') : [];
  } catch (e) {
    gitUi.status = { repo: false, error: e.message };
  }
  renderGit();
}

async function gitAction(label, fn, { successToast } = {}) {
  if (gitUi.busy) return;
  gitUi.busy = true;
  renderGit();
  try {
    const r = await fn();
    if (r?.status) gitUi.status = r.status; else if (r?.repo !== undefined) gitUi.status = r;
    if (successToast) toast(typeof successToast === 'function' ? successToast(r) : successToast);
  } catch (e) {
    toast(`${label} failed: ${e.message}`, { error: true, ms: 6000 });
  } finally {
    gitUi.busy = false;
    await refreshGit();
  }
}

function renderGit() {
  const body = $('git-body');
  const st = gitUi.status;
  $('git-branch').textContent = st?.repo ? st.branch : '';
  body.classList.toggle('busy', gitUi.busy);
  body.innerHTML = '';
  if (!app.root) return;
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, fn, cls = '', title = '') => { const b = el('button', `btn ${cls}`, label); b.onclick = fn; if (title) b.title = title; return b; };

  if (!st) { body.appendChild(el('div', 'muted', 'Loading…')); return; }
  if (st.error) { body.appendChild(el('div', 'muted', st.error)); return; }

  if (!st.repo) {
    body.appendChild(el('div', 'muted', 'Not a git repository yet.'));
    body.appendChild(btn('Initialize repository', () => gitAction('Init', () => api('POST', '/api/git/init'), { successToast: 'Repository created with an initial commit' }), 'primary'));
    return;
  }

  if (st.mode === 'scoped') {
    body.appendChild(el('div', 'muted', `Versioned inside the ${st.repoName} repository (${st.subpath}). Commits here only include this project's files.`));
  }

  // Sync row
  const sync = el('div', 'row');
  const info = el('span', 'sync');
  if (st.remotes.length) {
    info.innerHTML = st.upstream
      ? `<b>↑${st.ahead}</b> to push · <b>↓${st.behind}</b> to pull`
      : 'Branch not pushed yet';
  } else {
    info.textContent = 'No remote';
  }
  sync.appendChild(info);
  const spacer = el('span'); spacer.style.flex = '1'; sync.appendChild(spacer);
  if (st.remotes.length) {
    sync.appendChild(btn('Pull', () => gitAction('Pull', () => api('POST', '/api/git/pull'), { successToast: (r) => r.output.split('\n').pop() || 'Pulled' }), '', 'git pull'));
    sync.appendChild(btn(st.upstream ? `Push${st.ahead ? ` (${st.ahead})` : ''}` : 'Push branch', () => gitAction('Push', () => api('POST', '/api/git/push'), { successToast: 'Pushed' }), st.ahead || !st.upstream ? 'primary' : '', 'git push'));
  } else if (st.mode === 'scoped') {
    sync.appendChild(btn('Add remote…', addRemote));
  } else {
    sync.appendChild(btn('Publish to GitHub…', publishToGitHub, 'primary'));
    sync.appendChild(btn('Add remote…', addRemote));
  }
  body.appendChild(sync);
  if (st.remotes[0]) {
    const r = el('div', 'remote');
    const url = st.remotes[0].url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
    if (/^https?:/.test(url)) { const a = el('a', '', st.remotes[0].url); a.href = url; a.target = '_blank'; r.appendChild(a); }
    else r.textContent = st.remotes[0].url;
    body.appendChild(r);
  }

  // Changes
  body.appendChild(el('h5', '', `Changes${st.changes.length ? ` (${st.changes.length})` : ''}`));
  if (!st.changes.length) body.appendChild(el('div', 'muted', 'Working tree clean'));
  else {
    const list = el('div', 'git-changes');
    for (const c of st.changes) {
      const row = el('div', 'git-change');
      row.title = c.path;
      row.appendChild(el('span', `code ${c.code}`, c.code));
      row.appendChild(el('span', 'path', c.path));
      if (!c.code.includes('D')) row.onclick = () => openFile(c.path);
      list.appendChild(row);
    }
    body.appendChild(list);
  }

  // Commit box
  const ta = el('textarea');
  ta.placeholder = st.changes.length ? 'Commit message' : 'Nothing to commit';
  ta.value = gitUi.message;
  ta.disabled = !st.changes.length;
  ta.oninput = () => (gitUi.message = ta.value);
  ta.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doCommit(false); };
  body.appendChild(ta);
  const doCommit = async (andPush) => {
    const message = gitUi.message.trim();
    if (!message) return toast('Enter a commit message', { error: true });
    if (app.dirty) await saveFile();
    await gitAction('Commit', async () => {
      const r = await api('POST', '/api/git/commit', { message });
      gitUi.message = '';
      if (andPush) return api('POST', '/api/git/push');
      return r;
    }, { successToast: andPush ? 'Committed and pushed' : 'Committed' });
  };
  const crow = el('div', 'row');
  crow.appendChild(btn('Commit all', () => doCommit(false), st.changes.length ? 'primary' : '', 'Stage everything and commit (⌘↩ in the message box)'));
  if (st.remotes.length) crow.appendChild(btn('Commit & push', () => doCommit(true)));
  body.appendChild(crow);

  // Recent commits
  if (gitUi.log.length) {
    body.appendChild(el('h5', '', 'Recent commits'));
    const lg = el('div', 'git-log');
    for (const c of gitUi.log) {
      const row = el('div', 'git-commit');
      row.title = `${c.hash} ${c.subject} — ${c.author}, ${c.when}`;
      row.appendChild(el('span', 'hash', c.hash));
      row.appendChild(el('span', 'subject', c.subject));
      row.appendChild(el('span', 'when', c.when));
      lg.appendChild(row);
    }
    body.appendChild(lg);
  }
}

async function publishToGitHub() {
  let user = null;
  try { user = (await api('GET', '/api/git/gh-user')).user; } catch { /* ignore */ }
  if (!user) {
    await modal({ title: 'GitHub CLI not logged in', body: 'Run <code>gh auth login</code> in a terminal, then try again. Or add an existing remote URL instead.', buttons: [{ label: 'OK', value: 'ok', primary: true }] });
    return;
  }
  const r = await modal({
    title: 'Publish to GitHub',
    body: `Creates a repository under <code>${user}</code> and pushes this project to it.`,
    input: { value: app.root.split('/').pop(), placeholder: 'repository-name' },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Public', value: 'public' }, { label: 'Private', value: 'private', primary: true }],
  });
  if (!r?.choice || !r.value) return;
  await gitAction('Publish', () => api('POST', '/api/git/publish', { name: r.value, visibility: r.choice }), { successToast: (res) => `Published to ${res.url}` });
}

async function addRemote() {
  const r = await modal({
    title: 'Add remote',
    body: 'Paste the URL of an existing empty repository (HTTPS or SSH). It is added as <code>origin</code>.',
    input: { placeholder: 'git@github.com:you/repo.git' },
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add', value: 'add', primary: true }],
  });
  if (!r?.value) return;
  await gitAction('Add remote', () => api('POST', '/api/git/remote', { url: r.value }), { successToast: 'Remote added' });
}

// ---------------------------------------------------------------------------
// Resizable panes
for (const g of document.querySelectorAll('.gutter')) {
  g.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const target = $(g.dataset.target);
    const startX = e.clientX;
    const startW = target.getBoundingClientRect().width;
    g.classList.add('active');
    document.body.style.cursor = 'col-resize';
    const move = (ev) => { target.style.width = `${startW + ev.clientX - startX}px`; target.style.flex = 'none'; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); g.classList.remove('active'); document.body.style.cursor = ''; window.dispatchEvent(new Event('resize')); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

window.addEventListener('beforeunload', (e) => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------------------
// Boot
(async function boot() {
  connectWs();
  showProblemsTab('list');
  try {
    const st = await api('GET', '/api/state');
    renderProjectMenu({ recent: st.recent, workspace: st.workspace });
    if (st.root) {
      await applyProject({ root: st.root, name: st.name, settings: st.settings, tree: st.tree, candidates: st.candidates });
      if (st.lastResult) { renderProblems(st.lastResult); }
      if (st.compiling) setCompiling(true);
    } else {
      document.body.classList.add('no-project');
      showHome();
    }
    if (st.root && location.hash === '#home') showHome();
    const tr = await termPanel.restore();
    if (tr?.available === false && tr.reason) console.warn('Integrated terminal unavailable:', tr.reason);
  } catch (e) {
    toast(`Could not reach server: ${e.message}`, { error: true });
  }
})();
