// Integrated terminal sessions (VS Code style). Each session is a PTY running the user's login
// shell in a project folder. Sessions outlive the browser tab: output is buffered for replay.
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
let pty = null;
let ptyError = null;
try { pty = require('node-pty'); } catch (e) { ptyError = e; }

const SHELL = process.env.SHELL || '/bin/zsh';
const MAX_BUFFER = 300_000;
const sessions = new Map();
let counter = 0;

export function available() { return !!pty; }
export function unavailableReason() { return ptyError ? ptyError.message : null; }

export function list() {
  return [...sessions.values()].map(({ id, title, cwd, exited, exitCode, claude, createdAt }) => ({ id, title, cwd, exited, exitCode, claude, createdAt }));
}

export function create({ cwd, cols = 100, rows = 30, claude = false }) {
  if (!pty) throw Object.assign(new Error(`Integrated terminal unavailable: ${ptyError?.message || 'node-pty missing'}`), { status: 500 });
  const id = randomBytes(6).toString('hex');
  const n = ++counter;
  // Claude Code: run `claude` in a login shell, then drop into an interactive shell when it exits.
  const args = claude ? ['-l', '-c', 'command -v claude >/dev/null 2>&1 && claude || echo "claude is not on your PATH"; exec zsh -il'] : ['-l'];
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8', LOCAL_LEAF: '1' };
  delete env.GIT_ASKPASS;
  const proc = pty.spawn(SHELL, args, { name: 'xterm-256color', cols, rows, cwd, env });
  const s = { id, n, proc, cwd, title: claude ? `claude: ${basename(cwd)}` : `${basename(cwd)} #${n}`, buffer: '', clients: new Set(), exited: false, exitCode: null, claude, createdAt: Date.now() };
  proc.onData((data) => {
    s.buffer = (s.buffer + data).slice(-MAX_BUFFER);
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data }));
  });
  proc.onExit(({ exitCode }) => {
    s.exited = true;
    s.exitCode = exitCode;
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
  });
  sessions.set(id, s);
  return { id, title: s.title, cwd, claude };
}

export function attach(id, ws) {
  const s = sessions.get(id);
  if (!s) { ws.send(JSON.stringify({ type: 'gone' })); ws.close(); return; }
  s.clients.add(ws);
  ws.send(JSON.stringify({ type: 'replay', data: s.buffer, title: s.title, exited: s.exited }));
  if (s.exited) ws.send(JSON.stringify({ type: 'exit', code: s.exitCode }));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (s.exited) return;
    if (msg.type === 'input') s.proc.write(msg.data);
    else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) { try { s.proc.resize(Math.floor(msg.cols), Math.floor(msg.rows)); } catch { /* ignore */ } }
  });
  ws.on('close', () => s.clients.delete(ws));
}

export function rename(id, title) {
  const s = sessions.get(id);
  if (s) s.title = String(title || s.title).slice(0, 60);
  return s ? { id, title: s.title } : null;
}

export function kill(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try { if (!s.exited) s.proc.kill(); } catch { /* ignore */ }
  for (const ws of s.clients) { try { ws.close(); } catch { /* ignore */ } }
  sessions.delete(id);
  return true;
}

export function killAll() { for (const id of [...sessions.keys()]) kill(id); }
