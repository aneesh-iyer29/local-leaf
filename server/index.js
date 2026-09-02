import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { pickFolder } from './picker.js';
import * as config from './config.js';
import { readTree, safeJoin, findMainCandidates, isTextFile, trash } from './files.js';
import * as gitx from './git.js';
import * as overleaf from './overleaf.js';
import * as term from './terminal.js';
import * as ptys from './pty.js';
import { compile, clean } from './compile.js';
import * as synctex from './synctex.js';
import { watchProject } from './watcher.js';
import * as ws from './workspace.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// If the server was started from inside a Claude Code session (its Bash tool, or a terminal that
// Claude Code opened), the process inherits that session's marker variables. Anything we spawn —
// the integrated terminal's shell, `claude` started from it, latexmk, git — would then look like a
// nested child session (Claude Code disables transcript saving, for one). Scrub them so every
// child starts as a fresh, top-level environment.
for (const key of Object.keys(process.env)) {
  if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key.startsWith('CLAUDE_AGENT_') || key.startsWith('CLAUDE_PREVIEW_') || key === 'CLAUDE_PID' || key === 'CLAUDE_EFFORT') {
    delete process.env[key];
  }
}
const PORT = Number(process.env.PORT || 3737);
const app = express();
app.use(express.json({ limit: '300mb' }));
app.use(express.text({ limit: '50mb', type: 'text/plain' }));
app.use(express.static(join(__dirname, '..', 'public')));

// ---- state -----------------------------------------------------------------
const state = {
  root: null,
  settings: null,
  watcher: null,
  compiling: false,
  pending: false,
  current: null, // { proc }
  lastResult: null,
  compileTimer: null,
  activeFile: null, // file currently selected in the editor
};

// A .tex file with its own \documentclass can be compiled on its own.
async function isStandalone(rel) {
  if (!rel || !/\.tex$/i.test(rel) || !state.root) return false;
  try {
    const head = (await fs.readFile(safeJoin(state.root, rel), 'utf8')).slice(0, 20000);
    return /^\s*\\documentclass/m.test(head);
  } catch { return false; }
}

// What to compile: the selected file if it is a standalone document, otherwise the main file.
async function compileTarget(explicit) {
  const candidate = explicit !== undefined ? explicit : state.activeFile;
  if (await isStandalone(candidate)) return candidate;
  return state.settings?.main || null;
}

const compileWaiters = [];
const wss = new WebSocketServer({ noServer: true });
function broadcast(type, data = {}) {
  const msg = JSON.stringify({ type, ...data });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}

async function openProject(root) {
  root = resolve(root);
  const st = await fs.stat(root).catch(() => null);
  if (!st?.isDirectory()) { const e = new Error('Not a directory'); e.status = 400; throw e; }
  if (state.watcher) await state.watcher.close();
  if (state.current) { try { state.current.proc.kill(); } catch { /* ignore */ } }
  state.root = root;
  state.settings = config.projectSettings(root);
  state.lastResult = null;
  state.activeFile = null;
  const candidates = await findMainCandidates(root);
  if (!state.settings.main || !(await fs.access(join(root, state.settings.main)).then(() => true, () => false))) {
    state.settings = config.updateProjectSettings(root, { main: candidates[0] || null });
  }
  config.touchRecent(root);
  state.watcher = watchProject(root, { onChange: onDiskChange });
  broadcast('project:opened', { root });
  return { root, name: basename(root), settings: state.settings, candidates, tree: await readTree(root), inWorkspace: ws.inWorkspace(root) };
}

async function closeProject() {
  if (state.watcher) await state.watcher.close();
  if (state.current) { try { state.current.proc.kill(); } catch { /* ignore */ } }
  state.root = null; state.settings = null; state.watcher = null; state.lastResult = null;
  broadcast('project:closed');
}

function onDiskChange(ev) {
  broadcast('fs', ev);
  if (ev.isSource && state.settings?.autoCompile && state.settings.main) scheduleCompile(400);
}

function scheduleCompile(delay) {
  clearTimeout(state.compileTimer);
  state.compileTimer = setTimeout(() => runCompile().catch(() => {}), delay);
}

async function runCompile(target) {
  if (!state.root) return null;
  target = target || (await compileTarget());
  if (!target) return null;
  if (state.compiling) { state.pending = true; return null; }
  state.compiling = true;
  state.pending = false;
  broadcast('compile:start', { main: target, engine: state.settings.engine });
  const { proc, done } = compile({
    root: state.root, main: target, engine: state.settings.engine,
    onOutput: (chunk) => broadcast('compile:output', { chunk }),
  });
  state.current = { proc };
  const result = await done;
  state.current = null;
  state.compiling = false;
  state.lastResult = { ...result, at: Date.now(), main: target };
  broadcast('compile:done', summarize(state.lastResult));
  compileWaiters.splice(0).forEach((r) => r());
  if (state.pending) scheduleCompile(100);
  return state.lastResult;
}

function summarize(r) {
  if (!r) return null;
  const { output, log, ...rest } = r;
  return rest;
}

function requireProject(req, res, next) {
  if (!state.root) return res.status(409).json({ error: 'No project open' });
  next();
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- projects --------------------------------------------------------------
app.get('/api/ping', (req, res) => res.json({ ok: true, app: 'local-leaf', pid: process.pid }));

app.get('/api/state', wrap(async (req, res) => {
  res.json({
    root: state.root,
    name: state.root ? basename(state.root) : null,
    settings: state.settings,
    compiling: state.compiling,
    lastResult: summarize(state.lastResult),
    recent: config.recentProjects(),
    inWorkspace: ws.inWorkspace(state.root),
    activeFile: state.activeFile,
    target: state.root ? await compileTarget() : null,
    workspace: { path: ws.workspacePath(), default: ws.DEFAULT_WORKSPACE, projects: await ws.listProjects() },
    tree: state.root ? await readTree(state.root, { showAll: req.query.all === '1' }) : null,
    candidates: state.root ? await findMainCandidates(state.root) : [],
  });
}));

app.post('/api/projects/pick', wrap(async (req, res) => {
  const path = await pickFolder(state.root ? dirname(state.root) : undefined);
  if (!path) return res.json({ cancelled: true });
  res.json(await openProject(path));
}));

// Pick a folder without opening it, so the client can ask whether to import it.
app.post('/api/projects/pick-path', wrap(async (req, res) => {
  const path = await pickFolder(state.root ? dirname(state.root) : undefined);
  if (!path) return res.json({ cancelled: true });
  res.json({ path, inWorkspace: ws.inWorkspace(path) });
}));

app.post('/api/projects/close', wrap(async (req, res) => {
  await closeProject();
  res.json({ ok: true });
}));

// ---- workspace (repo's projects/ folder) ------------------------------------
app.get('/api/workspace', wrap(async (req, res) => {
  res.json({ path: ws.workspacePath(), default: ws.DEFAULT_WORKSPACE, projects: await ws.listProjects() });
}));

// Change the workspace folder (where projects live). With no path, pop the native folder chooser.
app.post('/api/workspace/path', wrap(async (req, res) => {
  let path = req.body.path;
  if (!path) { path = await pickFolder(ws.workspacePath()); if (!path) return res.json({ cancelled: true }); }
  if (state.root && !ws.inWorkspace(state.root)) { /* project outside stays open */ }
  const abs = await ws.setWorkspacePath(path);
  if (state.root && state.root !== abs && !ws.inWorkspace(state.root)) await closeProject();
  res.json({ path: abs, projects: await ws.listProjects() });
}));

app.post('/api/workspace/create', wrap(async (req, res) => {
  const target = await ws.createProject(req.body.name);
  res.json(await openProject(target));
}));

app.post('/api/workspace/import', wrap(async (req, res) => {
  const src = req.body.path || state.root;
  if (!src) return res.status(400).json({ error: 'No folder given' });
  const movingCurrent = state.root && resolve(src) === state.root;
  if (movingCurrent) await closeProject();
  const target = await ws.importFolder(src, req.body.mode === 'move' ? 'move' : 'copy');
  if (req.body.mode === 'move') config.forgetRecent(resolve(src));
  res.json(await openProject(target));
}));

app.post('/api/workspace/upload-file', wrap(async (req, res) => {
  const root = await ws.writeProjectFile(req.body.project, req.body.path, Buffer.from(req.body.data, 'base64'));
  res.json({ ok: true, root });
}));

app.post('/api/workspace/import-zip', wrap(async (req, res) => {
  const target = await ws.importZip(req.body.name || 'project', Buffer.from(req.body.data, 'base64'));
  res.json(await openProject(target));
}));

app.post('/api/workspace/rename', wrap(async (req, res) => {
  const path = resolve(req.body.path);
  const wasOpen = state.root === path;
  if (wasOpen) await closeProject();
  const target = await ws.renameProject(path, req.body.name);
  config.forgetRecent(path);
  if (wasOpen) return res.json({ ok: true, path: target, project: await openProject(target) });
  res.json({ ok: true, path: target, projects: await ws.listProjects() });
}));

app.post('/api/workspace/reveal', wrap(async (req, res) => {
  const path = resolve(req.body.path);
  if (!ws.inWorkspace(path) && !config.recentProjects().some((r) => r.path === path)) return res.status(400).json({ error: 'Unknown project' });
  execFile('open', ['-R', path]);
  res.json({ ok: true });
}));

app.post('/api/workspace/trash', wrap(async (req, res) => {
  const path = resolve(req.body.path);
  if (state.root === path) await closeProject();
  await ws.trashProject(path);
  config.forgetRecent(path);
  res.json({ ok: true, projects: await ws.listProjects() });
}));

app.post('/api/projects/open', wrap(async (req, res) => {
  let path = req.body.path;
  if (path && !path.includes('/')) {
    const match = (await ws.listProjects()).find((p) => p.name === path);
    if (match) path = match.path;
  }
  res.json(await openProject(path));
}));

app.post('/api/projects/forget', (req, res) => {
  config.forgetRecent(req.body.path);
  res.json({ recent: config.recentProjects() });
});

app.post('/api/projects/reveal-workspace', wrap(async (req, res) => {
  await ws.ensureWorkspace();
  execFile('open', [ws.workspacePath()]);
  res.json({ ok: true });
}));

app.post('/api/projects/reveal', requireProject, (req, res) => {
  const target = safeJoin(state.root, req.body.path || '.');
  execFile('open', ['-R', target]);
  res.json({ ok: true });
});

// The editor reports which file is selected; the compile target follows it when standalone.
app.put('/api/active', requireProject, wrap(async (req, res) => {
  state.activeFile = req.body.file || null;
  const target = await compileTarget();
  res.json({ activeFile: state.activeFile, target, standalone: target === state.activeFile && !!state.activeFile });
}));

app.patch('/api/settings', requireProject, (req, res) => {
  const allowed = {};
  for (const k of ['main', 'engine', 'autoCompile']) if (k in req.body) allowed[k] = req.body[k];
  state.settings = config.updateProjectSettings(state.root, allowed);
  broadcast('settings', { settings: state.settings });
  res.json(state.settings);
});

// ---- files -----------------------------------------------------------------
app.get('/api/tree', requireProject, wrap(async (req, res) => {
  res.json(await readTree(state.root, { showAll: req.query.all === '1' }));
}));

app.get('/api/file', requireProject, wrap(async (req, res) => {
  const abs = safeJoin(state.root, req.query.path);
  const st = await fs.stat(abs);
  if (!isTextFile(abs)) {
    return res.json({ path: req.query.path, binary: true, size: st.size, mtime: st.mtimeMs });
  }
  const content = await fs.readFile(abs, 'utf8');
  res.json({ path: req.query.path, content, mtime: st.mtimeMs, size: st.size });
}));

// Raw file bytes (images, PDFs). Cache-busted by the client.
app.get('/api/raw', requireProject, wrap(async (req, res) => {
  const abs = safeJoin(state.root, req.query.path);
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(abs);
}));

app.put('/api/file', requireProject, wrap(async (req, res) => {
  const abs = safeJoin(state.root, req.query.path);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, typeof req.body === 'string' ? req.body : req.body.content ?? '', 'utf8');
  const st = await fs.stat(abs);
  res.json({ ok: true, mtime: st.mtimeMs });
}));

app.post('/api/file/create', requireProject, wrap(async (req, res) => {
  const abs = safeJoin(state.root, req.body.path);
  if (await fs.access(abs).then(() => true, () => false)) return res.status(409).json({ error: 'Already exists' });
  if (req.body.type === 'dir') await fs.mkdir(abs, { recursive: true });
  else { await fs.mkdir(dirname(abs), { recursive: true }); await fs.writeFile(abs, req.body.content ?? '', 'utf8'); }
  res.json({ ok: true, tree: await readTree(state.root) });
}));

app.post('/api/file/rename', requireProject, wrap(async (req, res) => {
  const from = safeJoin(state.root, req.body.from);
  const to = safeJoin(state.root, req.body.to);
  if (await fs.access(to).then(() => true, () => false)) return res.status(409).json({ error: 'Target already exists' });
  await fs.mkdir(dirname(to), { recursive: true });
  await fs.rename(from, to);
  if (state.settings.main === req.body.from) {
    state.settings = config.updateProjectSettings(state.root, { main: req.body.to });
    broadcast('settings', { settings: state.settings });
  }
  res.json({ ok: true, tree: await readTree(state.root) });
}));

app.delete('/api/file', requireProject, wrap(async (req, res) => {
  const abs = safeJoin(state.root, req.query.path);
  if (abs === state.root) return res.status(400).json({ error: 'Refusing to delete project root' });
  // Move to Trash rather than hard-deleting so mistakes are recoverable.
  await trash(abs);
  res.json({ ok: true, tree: await readTree(state.root) });
}));

// Upload via multipart-free approach: base64 body
app.post('/api/file/upload', requireProject, wrap(async (req, res) => {
  const abs = safeJoin(state.root, req.body.path);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from(req.body.data, 'base64'));
  res.json({ ok: true, tree: await readTree(state.root) });
}));

// ---- compile ----------------------------------------------------------------
// With ?wait=1 (used by the CLI) a request made mid-compile waits for the running compile to
// finish and then runs a fresh one, so the caller always gets a result for the current sources.
app.post('/api/compile', requireProject, wrap(async (req, res) => {
  const target = await compileTarget(req.body?.file !== undefined ? req.body.file : undefined);
  if (!target) return res.status(400).json({ error: 'No main file set and the selected file is not a standalone document' });
  if (state.compiling && req.query.wait !== '1') { state.pending = true; return res.json({ queued: true }); }
  while (state.compiling) await new Promise((r) => compileWaiters.push(r));
  clearTimeout(state.compileTimer);
  const result = await runCompile(target);
  res.json(summarize(result));
}));

app.get('/api/compile/result', requireProject, (req, res) => {
  res.json(summarize(state.lastResult) || { ok: null, errors: [], pdf: null, message: 'No compile yet' });
});

app.post('/api/compile/stop', requireProject, (req, res) => {
  if (state.current) { try { state.current.proc.kill('SIGTERM'); } catch { /* ignore */ } }
  state.pending = false;
  res.json({ ok: true });
});

app.post('/api/compile/clean', requireProject, wrap(async (req, res) => {
  const target = state.lastResult?.main || state.settings.main;
  if (!target) return res.status(400).json({ error: 'No main file set' });
  res.json(await clean({ root: state.root, main: target }));
}));

app.get('/api/compile/log', requireProject, (req, res) => {
  res.type('text/plain').send(state.lastResult?.log || '');
});
app.get('/api/compile/output', requireProject, (req, res) => {
  res.type('text/plain').send(state.lastResult?.output || '');
});

app.get('/api/pdf', requireProject, wrap(async (req, res) => {
  const target = state.lastResult?.main || (await compileTarget());
  const pdf = state.lastResult?.pdf || (target && target.replace(/\.tex$/i, '.pdf'));
  if (!pdf) return res.status(404).end();
  const abs = safeJoin(state.root, pdf);
  const exists = await fs.access(abs).then(() => true, () => false);
  if (!exists) return res.status(404).end();
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/pdf');
  res.sendFile(abs);
}));

// ---- synctex ----------------------------------------------------------------
app.post('/api/synctex/forward', requireProject, wrap(async (req, res) => {
  const { file, line, column } = req.body;
  res.json(await synctex.forward({ root: state.root, main: state.lastResult?.main || state.settings.main, file, line, column }));
}));
app.post('/api/synctex/inverse', requireProject, wrap(async (req, res) => {
  const { page, x, y } = req.body;
  res.json(await synctex.inverse({ root: state.root, main: state.lastResult?.main || state.settings.main, page, x, y }));
}));

// ---- terminal / Claude Code ---------------------------------------------------
function resolveProjectDir(path) {
  if (!path) return state.root;
  const abs = resolve(path);
  if (abs === state.root || ws.inWorkspace(abs) || config.recentProjects().some((r) => r.path === abs)) return abs;
  const e = new Error('Unknown project folder'); e.status = 400; throw e;
}

app.get('/api/terminal', wrap(async (req, res) => {
  const apps = term.installedApps();
  const selected = config.getGlobal('terminalApp', apps[0]?.id || 'Terminal');
  res.json({ apps, selected: apps.some((a) => a.id === selected) ? selected : apps[0]?.id, claude: await term.claudeAvailable() });
}));

app.post('/api/terminal/app', (req, res) => {
  config.setGlobal('terminalApp', req.body.app);
  res.json({ ok: true, selected: req.body.app });
});

app.post('/api/terminal/open', wrap(async (req, res) => {
  const dir = resolveProjectDir(req.body.path);
  if (!dir) return res.status(409).json({ error: 'No project open' });
  const app_ = config.getGlobal('terminalApp', term.installedApps()[0]?.id || 'Terminal');
  res.json(await term.openTerminal({ dir, app: app_, claude: !!req.body.claude }));
}));

// ---- integrated terminal ------------------------------------------------------
app.get('/api/terminals', (req, res) => res.json({ available: ptys.available(), reason: ptys.unavailableReason(), sessions: ptys.list() }));
app.post('/api/terminals', wrap(async (req, res) => {
  const dir = resolveProjectDir(req.body.path);
  if (!dir) return res.status(409).json({ error: 'Open a project first' });
  res.json(ptys.create({ cwd: dir, cols: req.body.cols, rows: req.body.rows, claude: !!req.body.claude }));
}));
app.patch('/api/terminals/:id', (req, res) => res.json(ptys.rename(req.params.id, req.body.title) || {}));
app.delete('/api/terminals/:id', (req, res) => res.json({ ok: ptys.kill(req.params.id) }));

// ---- overleaf ----------------------------------------------------------------
app.get('/api/overleaf/token', (req, res) => res.json({ set: overleaf.hasToken() }));
app.post('/api/overleaf/token', wrap(async (req, res) => res.json({ set: await overleaf.setToken(req.body.token) })));
app.post('/api/overleaf/import', wrap(async (req, res) => {
  const r = await overleaf.importProject({ project: req.body.project, name: req.body.name });
  res.json({ ...(await openProject(r.path)), overleaf: { id: r.id, url: r.url, joinedRepo: r.joinedRepo } });
}));

// ---- git (per project) -------------------------------------------------------
app.get('/api/git/status', requireProject, wrap(async (req, res) => res.json(await gitx.status(state.root))));
app.get('/api/git/log', requireProject, wrap(async (req, res) => res.json(await gitx.log(state.root, Number(req.query.n) || 8))));
app.get('/api/git/gh-user', wrap(async (req, res) => res.json({ user: await gitx.ghUser() })));
app.post('/api/git/init', requireProject, wrap(async (req, res) => res.json(await gitx.init(state.root))));
app.post('/api/git/commit', requireProject, wrap(async (req, res) => res.json(await gitx.commit(state.root, req.body.message))));
app.post('/api/git/push', requireProject, wrap(async (req, res) => res.json(await gitx.push(state.root))));
app.post('/api/git/pull', requireProject, wrap(async (req, res) => res.json(await gitx.pull(state.root))));
app.post('/api/git/fetch', requireProject, wrap(async (req, res) => res.json(await gitx.fetch(state.root))));
app.post('/api/git/remote', requireProject, wrap(async (req, res) => res.json(await gitx.setRemote(state.root, req.body.url))));
app.post('/api/git/publish', requireProject, wrap(async (req, res) => res.json(await gitx.publish(state.root, req.body))));

// ---- errors -----------------------------------------------------------------
app.use((err, req, res, next) => {
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  res.status(status).json({ error: err.message });
});

// ---- boot -------------------------------------------------------------------
const server = createServer(app);
const termWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/ws') return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  if (url.pathname === '/ws/term') return termWss.handleUpgrade(req, socket, head, (ws) => ptys.attach(url.searchParams.get('id'), ws));
  socket.destroy();
});
process.on('exit', () => ptys.killAll());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { ptys.killAll(); process.exit(0); });

server.listen(PORT, '127.0.0.1', async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`local-leaf running at ${url}`);
  const argPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const startPath = argPath || config.recentProjects()[0]?.path;
  if (startPath) {
    try { await openProject(startPath); console.log(`Opened ${state.root}`); } catch (e) { console.warn(`Could not open ${startPath}: ${e.message}`); }
  }
  if (!process.argv.includes('--no-open') && process.platform === 'darwin') execFile('open', [url]);
});
