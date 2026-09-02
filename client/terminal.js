// Integrated terminal panel: xterm.js instances attached to server PTY sessions over WebSocket.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const THEME = {
  background: '#1b1d21', foreground: '#e6e6e6', cursor: '#e6e6e6', selectionBackground: 'rgba(71,162,72,0.35)',
  black: '#1b1d21', red: '#e05d5d', green: '#5cb85d', yellow: '#e0a83a', blue: '#6aa3e0', magenta: '#c678dd', cyan: '#56b6c2', white: '#d0d0d0',
  brightBlack: '#6b7079', brightRed: '#ff7b7b', brightGreen: '#7ed67f', brightYellow: '#ffc65c', brightBlue: '#8dbdf3', brightMagenta: '#d89bf0', brightCyan: '#7ad3dd', brightWhite: '#ffffff',
};

export function createTerminalPanel({ host, tabs, api, onCountChange }) {
  const sessions = new Map(); // id → { id, title, term, fit, ws, el, exited }
  let active = null;

  function wsUrl(id) { return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?id=${id}`; }

  function mount(info) {
    const el = document.createElement('div');
    el.className = 'term-instance';
    host.appendChild(el);
    const term = new Terminal({ cursorBlink: true, fontSize: 12.5, fontFamily: '"SF Mono", Menlo, Consolas, "Liberation Mono", monospace', theme: THEME, scrollback: 5000, allowProposedApi: true, macOptionIsMeta: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    const s = { id: info.id, title: info.title, claude: info.claude, term, fit, el, ws: null, exited: false };
    sessions.set(info.id, s);
    connect(s);
    term.onData((data) => { if (s.ws?.readyState === 1 && !s.exited) s.ws.send(JSON.stringify({ type: 'input', data })); });
    term.onResize(({ cols, rows }) => { if (s.ws?.readyState === 1) s.ws.send(JSON.stringify({ type: 'resize', cols, rows })); });
    term.onTitleChange((t) => { if (t && !s.claude) { s.title = t.length > 40 ? t.slice(0, 40) + '…' : t; renderTabs(); } });
    // Let the page handle its own shortcuts for panel toggling.
    term.attachCustomKeyEventHandler((e) => !(e.key === '`' && e.ctrlKey));
    renderTabs();
    onCountChange?.(sessions.size);
    return s;
  }

  function connect(s) {
    const ws = new WebSocket(wsUrl(s.id));
    s.ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'replay') { s.term.reset(); if (msg.data) s.term.write(msg.data); if (msg.title && !s.title) s.title = msg.title; fitActive(); }
      else if (msg.type === 'data') s.term.write(msg.data);
      else if (msg.type === 'exit') { s.exited = true; s.term.write(`\r\n\x1b[90m[process exited with code ${msg.code}]\x1b[0m\r\n`); renderTabs(); }
      else if (msg.type === 'gone') { s.exited = true; s.term.write('\r\n\x1b[90m[session no longer exists on the server]\x1b[0m\r\n'); renderTabs(); }
    };
    ws.onclose = () => { if (!s.exited && sessions.has(s.id)) setTimeout(() => sessions.has(s.id) && connect(s), 1500); };
  }

  function activate(id) {
    active = id;
    for (const s of sessions.values()) s.el.classList.toggle('active', s.id === id);
    renderTabs();
    fitActive();
    sessions.get(id)?.term.focus();
  }

  function fitActive() {
    const s = sessions.get(active);
    if (!s || !s.el.offsetParent) return;
    try { s.fit.fit(); } catch { /* not visible */ }
  }

  function renderTabs() {
    tabs.innerHTML = '';
    for (const s of sessions.values()) {
      const t = document.createElement('div');
      t.className = 'term-tab' + (s.id === active ? ' active' : '') + (s.exited ? ' exited' : '');
      t.innerHTML = `<span class="icon"></span><span class="name"></span><button class="x" title="Kill terminal">×</button>`;
      t.querySelector('.icon').textContent = s.claude ? '✦' : '>_';
      t.querySelector('.name').textContent = s.title;
      t.title = s.title;
      t.onclick = (e) => { if (!e.target.closest('.x')) activate(s.id); };
      t.querySelector('.x').onclick = (e) => { e.stopPropagation(); close(s.id); };
      tabs.appendChild(t);
    }
  }

  async function open({ claude = false, path } = {}) {
    const cols = 100, rows = 30;
    const info = await api('POST', '/api/terminals', { claude, path, cols, rows });
    const s = mount(info);
    activate(s.id);
    return s;
  }

  async function close(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.ws?.close(); } catch { /* ignore */ }
    s.term.dispose();
    s.el.remove();
    try { await api('DELETE', `/api/terminals/${id}`); } catch { /* ignore */ }
    if (active === id) { const next = [...sessions.keys()].pop(); if (next) activate(next); else { active = null; renderTabs(); } }
    onCountChange?.(sessions.size);
  }

  // Reattach to sessions that already exist on the server (page reload).
  async function restore() {
    try {
      const r = await api('GET', '/api/terminals');
      for (const info of r.sessions) if (!sessions.has(info.id)) mount(info);
      const last = r.sessions[r.sessions.length - 1];
      if (last) activate(last.id);
      return r;
    } catch { return { available: false }; }
  }

  window.addEventListener('resize', fitActive);
  return { open, close, activate, restore, fit: fitActive, get count() { return sessions.size; }, get active() { return active; } };
}
