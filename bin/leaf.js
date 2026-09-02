#!/usr/bin/env node
// leaf — command-line client for a running local-leaf server. Everything the browser can do,
// callable from a terminal or an agent: projects, compile, problems, logs, settings, SyncTeX, git.
import { spawn } from 'node:child_process';
import { readFileSync, openSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--') { positional.push(...args.slice(i + 1)); break; }
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (['message', 'm', 'port', 'n', 'engine', 'name'].includes(k) && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) flags[k] = args[++i];
    else flags[k] = true;
  } else if (a === '-m' && args[i + 1] !== undefined) flags.message = args[++i];
  else if (a === '-n' && args[i + 1] !== undefined) flags.n = args[++i];
  else positional.push(a);
}
const JSON_OUT = !!flags.json;
const PORT = Number(flags.port || process.env.LOCAL_LEAF_PORT || 3737);
const BASE = `http://127.0.0.1:${PORT}`;

const HELP = `leaf — control local-leaf from the terminal (server must be running: \`leaf serve\` or \`npm start\`)

Project
  leaf status                    Current project, main file, engine, last compile, git branch
  leaf projects                  Projects in the workspace folder and other recent folders
  leaf open <name|path>          Open a workspace project by name, or any folder by path
  leaf new <name>                Create a project in the workspace and open it
  leaf import <path> [--move|--in-place]   Copy (default) or move a folder into the workspace, or open in place
  leaf root                      Print the open project's absolute path
  leaf workspace [path]          Show or change the folder that holds your projects
  leaf files                     List project files (build products hidden; --all shows them)
  leaf cat <file>                Print a project file (path relative to the project)

Compile
  leaf compile [file.tex]        Compile and wait; prints problems; exit 1 on failure. With a file that has its
                                 own \documentclass, that file is built; otherwise the main file is.
  leaf problems                  Errors / warnings / notes from the last compile (--errors for errors only)
  leaf log                       Full LaTeX .log of the last compile
  leaf output                    Raw latexmk console output of the last compile
  leaf pdf [--open]              Path of the output PDF (--open opens it in Preview)
  leaf clean                     Remove auxiliary files (latexmk -C)
  leaf set main <file>           Set the main .tex file
  leaf set engine <pdflatex|xelatex|lualatex>
  leaf set auto <on|off>         Auto-compile when files change on disk
  leaf synctex <file>:<line>     Where a source line lands in the PDF
  leaf synctex --inverse <page> <x> <y>   Which source line is at a PDF position (points, top-left origin)

Git (the open project is its own repository)
  leaf git status | log | init | commit -m "msg" | push | pull | fetch
  leaf git publish [--name repo] [--public]   Create a GitHub repo with gh and push
  leaf git remote <url>          Add or replace the origin remote

Overleaf
  leaf overleaf token <token>    Save your Overleaf git token (Account settings → Git integration; paid plans)
  leaf overleaf token --clear    Forget the saved token
  leaf overleaf import <url|id> [--name folder]   Clone an Overleaf project into the workspace, detach it from Overleaf, open it
  (Free plan: download the project as a zip from Overleaf and use Upload .zip… in the browser.)

Terminal
  leaf terminal [--claude]       Open a terminal window (or Claude Code) in the open project's folder

Server
  leaf serve [--detach]          Start the server (builds first); --detach runs it in the background
  leaf events                    Stream server events (file changes, compile start/done) as JSON lines

Options: --json (machine-readable output), --port N (default 3737)
`;

function out(obj, human) {
  if (JSON_OUT) console.log(JSON.stringify(obj, null, 2));
  else if (typeof human === 'function') human(obj);
  else if (human !== undefined) console.log(human);
}
function fail(msg, code = 1) {
  if (JSON_OUT) console.log(JSON.stringify({ error: msg }));
  else console.error(`leaf: ${msg}`);
  process.exit(code);
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    fail(`cannot reach local-leaf at ${BASE}. Start it with \`leaf serve --detach\` (or \`npm start\` in ${ROOT}).`, 2);
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) fail(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

const rel = (p) => p.replace(homedir(), '~');
function printProblems(errors, { onlyErrors = false } = {}) {
  const list = onlyErrors ? errors.filter((e) => e.type === 'error') : errors;
  if (!list.length) { console.log(onlyErrors ? 'No errors.' : 'No problems.'); return; }
  const order = { error: 0, warning: 1, info: 2 };
  for (const e of [...list].sort((a, b) => order[a.type] - order[b.type])) {
    const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : '';
    console.log(`${e.type.toUpperCase().padEnd(7)} ${loc ? loc + '  ' : ''}${e.message}`);
    if (e.context) console.log(`        ${e.context.split('\n').join('\n        ')}`);
  }
}
function printCompile(r) {
  const n = (t) => r.errors.filter((e) => e.type === t).length;
  console.log(`${r.ok ? 'OK' : 'FAILED'}  ${r.main}  (${n('error')} errors, ${n('warning')} warnings, ${n('info')} notes)${r.pdf ? `  → ${r.pdf}` : '  (no PDF)'}`);
  printProblems(r.errors);
}

const commands = {
  async help() { console.log(HELP); },

  async status() {
    const st = await api('GET', '/api/state');
    if (!st.root) return out(st, 'No project open. `leaf projects` to list, `leaf open <name>` to open one.');
    let git = null;
    try { git = await api('GET', '/api/git/status'); } catch { /* ignore */ }
    out({ ...st, tree: undefined, git }, () => {
      console.log(`Project   ${st.name}  (${rel(st.root)})${st.inWorkspace ? '' : '  [outside workspace]'}`);
      console.log(`Main      ${st.settings.main || '(none)'}${st.target && st.target !== st.settings.main ? `    Target ${st.target} (selected standalone file)` : ''}    Engine ${st.settings.engine}    Auto-compile ${st.settings.autoCompile ? 'on' : 'off'}`);
      if (st.compiling) console.log('Compiling now…');
      const r = st.lastResult;
      if (r) console.log(`Last      ${r.ok ? 'OK' : 'FAILED'} at ${new Date(r.at).toLocaleTimeString()}  ${r.errors.filter((e) => e.type === 'error').length} errors, ${r.errors.filter((e) => e.type === 'warning').length} warnings${r.pdf ? `  → ${r.pdf}` : ''}`);
      else console.log('Last      (no compile yet)');
      if (git?.repo) console.log(`Git       ${git.mode === 'scoped' ? `${git.repoName} repo, ` : ''}${git.branch}${git.upstream ? ` ↑${git.ahead} ↓${git.behind}` : git.remotes.length ? ' (not pushed)' : ' (no remote)'}  ${git.changes.length} changed file${git.changes.length === 1 ? '' : 's'}`);
      else if (git) console.log('Git       not a repository');
    });
  },

  async projects() {
    const st = await api('GET', '/api/state');
    const external = st.recent.filter((r) => !r.path.startsWith(st.workspace.path + '/'));
    out({ workspace: st.workspace, recent: external, current: st.root }, () => {
      console.log(`Workspace: ${rel(st.workspace.path)}`);
      if (!st.workspace.projects.length) console.log('  (empty)');
      for (const p of st.workspace.projects) console.log(`  ${p.path === st.root ? '*' : ' '} ${p.name.padEnd(28)} ${p.main || '(no main file)'}`);
      if (external.length) {
        console.log('Other recent:');
        for (const r of external) console.log(`  ${r.path === st.root ? '*' : ' '} ${rel(r.path)}`);
      }
    });
  },

  async open([target]) {
    if (!target) fail('usage: leaf open <name|path>');
    const path = target.includes('/') ? resolve(target) : target;
    const p = await api('POST', '/api/projects/open', { path });
    out(p, `Opened ${p.name} (${rel(p.root)})  main: ${p.settings.main || '(none)'}`);
  },

  async new([name]) {
    if (!name) fail('usage: leaf new <name>');
    const p = await api('POST', '/api/workspace/create', { name });
    out(p, `Created and opened ${p.name} (${rel(p.root)})`);
  },

  async import([path]) {
    if (!path) fail('usage: leaf import <path> [--move|--in-place]');
    if (flags['in-place']) return commands.open([path]);
    const p = await api('POST', '/api/workspace/import', { path: resolve(path), mode: flags.move ? 'move' : 'copy' });
    out(p, `${flags.move ? 'Moved' : 'Copied'} into workspace and opened: ${p.name} (${rel(p.root)})`);
  },

  async workspace([path]) {
    if (path) {
      const r = await api('POST', '/api/workspace/path', { path: resolve(path) });
      return out(r, `Projects folder is now ${r.path} (${r.projects.length} project${r.projects.length === 1 ? '' : 's'})`);
    }
    const w = await api('GET', '/api/workspace');
    out(w, `${w.path}${w.path === w.default ? '  (default)' : ''}  — ${w.projects.length} project${w.projects.length === 1 ? '' : 's'}`);
  },

  async root() {
    const st = await api('GET', '/api/state');
    if (!st.root) fail('no project open');
    out({ root: st.root }, st.root);
  },

  async files() {
    const tree = await api('GET', `/api/tree?all=${flags.all ? 1 : 0}`);
    out(tree, () => {
      const walk = (nodes, depth) => { for (const n of nodes) { console.log(`${'  '.repeat(depth)}${n.name}${n.type === 'dir' ? '/' : ''}`); if (n.children) walk(n.children, depth + 1); } };
      walk(tree, 0);
    });
  },

  async cat([file]) {
    if (!file) fail('usage: leaf cat <file>');
    const f = await api('GET', `/api/file?path=${encodeURIComponent(file)}`);
    if (f.binary) fail(`${file} is binary (${f.size} bytes)`);
    out(f, f.content.replace(/\n$/, ''));
  },

  async compile([file]) {
    const r = await api('POST', '/api/compile?wait=1', file ? { file } : {});
    out(r, () => printCompile(r));
    if (!r.ok) process.exit(1);
  },

  async problems() {
    const r = await api('GET', '/api/compile/result');
    if (r.ok === null) return out(r, 'No compile yet. Run `leaf compile`.');
    out(r.errors, () => printProblems(r.errors, { onlyErrors: !!flags.errors }));
  },

  async log() { process.stdout.write(await api('GET', '/api/compile/log')); },
  async output() { process.stdout.write(await api('GET', '/api/compile/output')); },

  async pdf() {
    const st = await api('GET', '/api/state');
    if (!st.root) fail('no project open');
    const relPdf = st.lastResult?.pdf || (st.settings.main ? st.settings.main.replace(/\.tex$/i, '.pdf') : null);
    if (!relPdf) fail('no main file set');
    const abs = join(st.root, relPdf);
    out({ pdf: abs }, abs);
    if (flags.open) spawn('open', [abs], { stdio: 'ignore', detached: true }).unref();
  },

  async clean() {
    const r = await api('POST', '/api/compile/clean');
    out(r, r.ok ? 'Auxiliary files removed.' : `Clean failed:\n${r.output}`);
  },

  async set([key, value]) {
    if (!key || value === undefined) fail('usage: leaf set <main|engine|auto> <value>');
    let patch;
    if (key === 'main') patch = { main: value };
    else if (key === 'engine') { if (!['pdflatex', 'xelatex', 'lualatex'].includes(value)) fail('engine must be pdflatex, xelatex or lualatex'); patch = { engine: value }; }
    else if (key === 'auto') patch = { autoCompile: ['on', 'true', '1', 'yes'].includes(value) };
    else fail(`unknown setting "${key}"`);
    const s = await api('PATCH', '/api/settings', patch);
    out(s, `main: ${s.main}   engine: ${s.engine}   auto-compile: ${s.autoCompile ? 'on' : 'off'}`);
  },

  async synctex([a, b, c]) {
    if (flags.inverse) {
      if ([a, b, c].some((v) => v === undefined)) fail('usage: leaf synctex --inverse <page> <x> <y>');
      const r = await api('POST', '/api/synctex/inverse', { page: Number(a), x: Number(b), y: Number(c) });
      if (!r) fail('no source position found');
      return out(r, `${r.file}:${r.line}`);
    }
    const m = (a || '').match(/^(.+):(\d+)(?::(\d+))?$/);
    if (!m) fail('usage: leaf synctex <file>:<line>[:<column>]');
    const r = await api('POST', '/api/synctex/forward', { file: m[1], line: Number(m[2]), column: Number(m[3] || 0) });
    if (!r) fail('no PDF position for that line (compile first?)');
    out(r, `page ${r.page}  x=${r.x.toFixed(1)} y=${r.y.toFixed(1)}  box h=${r.h.toFixed(1)} v=${r.v.toFixed(1)} W=${r.W.toFixed(1)} H=${r.H.toFixed(1)} (PDF points, top-left origin)`);
  },

  async git([sub, ...restArgs]) {
    const printStatus = (s) => {
      if (!s.repo) return console.log('Not a git repository. Run `leaf git init`.');
      if (s.mode === 'scoped') console.log(`Versioned inside the ${s.repoName} repository (${s.subpath}); commits are scoped to this project.`);
      console.log(`On branch ${s.branch}${s.upstream ? `, tracking ${s.upstream} (ahead ${s.ahead}, behind ${s.behind})` : s.remotes.length ? ' (not pushed yet)' : ' (no remote)'}`);
      if (s.remotes.length) console.log(`Remote    ${s.remotes[0].url}`);
      if (s.lastCommit) console.log(`Last      ${s.lastCommit.hash} ${s.lastCommit.subject} (${s.lastCommit.when})`);
      if (!s.changes.length) console.log('Working tree clean');
      else { console.log(`Changes (${s.changes.length}):`); for (const c of s.changes) console.log(`  ${c.code.padEnd(2)} ${c.path}`); }
    };
    switch (sub || 'status') {
      case 'status': return out(await api('GET', '/api/git/status'), printStatus);
      case 'log': {
        const l = await api('GET', `/api/git/log?n=${flags.n || 15}`);
        return out(l, () => { if (!l.length) console.log('No commits yet.'); for (const c of l) console.log(`${c.hash}  ${c.subject}  (${c.author}, ${c.when})`); });
      }
      case 'init': return out(await api('POST', '/api/git/init'), (s) => { console.log('Initialized repository with an initial commit.'); printStatus(s); });
      case 'commit': {
        const message = flags.message || flags.m || restArgs.join(' ');
        if (!message) fail('usage: leaf git commit -m "message"');
        return out(await api('POST', '/api/git/commit', { message }), (s) => console.log(`Committed ${s.lastCommit.hash} ${s.lastCommit.subject}`));
      }
      case 'push': return out(await api('POST', '/api/git/push'), (r) => console.log(r.output || 'Pushed.'));
      case 'pull': return out(await api('POST', '/api/git/pull'), (r) => console.log(r.output || 'Pulled.'));
      case 'fetch': return out(await api('POST', '/api/git/fetch'), printStatus);
      case 'remote': {
        if (!restArgs[0]) fail('usage: leaf git remote <url>');
        return out(await api('POST', '/api/git/remote', { url: restArgs[0] }), (s) => console.log(`origin → ${s.remotes[0]?.url}`));
      }
      case 'publish': return out(await api('POST', '/api/git/publish', { name: flags.name, visibility: flags.public ? 'public' : 'private' }), (r) => console.log(`Published to ${r.url}`));
      default: fail(`unknown git subcommand "${sub}"`);
    }
  },

  async overleaf([sub, value]) {
    if (sub === 'token') {
      if (!value && !flags.clear) fail('usage: leaf overleaf token <token> | leaf overleaf token --clear');
      const r = await api('POST', '/api/overleaf/token', { token: flags.clear ? '' : value });
      return out(r, r.set ? 'Overleaf token saved to ~/.local-leaf/overleaf-token' : 'Overleaf token cleared');
    }
    if (sub === 'import') {
      if (!value) fail('usage: leaf overleaf import <project-url|id> [--name folder]');
      const p = await api('POST', '/api/overleaf/import', { project: value, name: flags.name });
      return out(p, p.overleaf.joinedRepo ? `Imported ${p.name} from Overleaf into ${rel(p.root)}; it is now part of the enclosing repo. Commit and push with \`leaf git\`.` : `Imported ${p.name} from Overleaf into ${rel(p.root)} with its history, detached (no remote).`);
    }
    fail('usage: leaf overleaf token <token> | leaf overleaf import <url|id>');
  },

  async terminal() {
    const r = await api('POST', '/api/terminal/open', { claude: !!flags.claude });
    out(r, `${flags.claude ? 'Claude Code' : 'Terminal'} opened in ${r.app}`);
  },

  async serve() {
    try { await fetch(`${BASE}/api/ping`); return out({ running: true }, `local-leaf is already running at ${BASE}`); } catch { /* not running */ }
    const build = spawn(process.execPath, [join(ROOT, 'scripts', 'build.js')], { cwd: ROOT, stdio: 'inherit' });
    await new Promise((r) => build.on('close', r));
    const serverArgs = [join(ROOT, 'server', 'index.js'), '--no-open', ...positional.slice(1)];
    if (flags.detach) {
      const logDir = join(homedir(), '.local-leaf');
      mkdirSync(logDir, { recursive: true });
      const log = openSync(join(logDir, 'server.log'), 'a');
      const child = spawn(process.execPath, serverArgs, { cwd: ROOT, detached: true, stdio: ['ignore', log, log], env: { ...process.env, PORT: String(PORT) } });
      child.unref();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 150));
        try { await fetch(`${BASE}/api/ping`); return out({ running: true, pid: child.pid }, `local-leaf started at ${BASE} (pid ${child.pid}, log ~/.local-leaf/server.log)`); } catch { /* wait */ }
      }
      fail('server did not come up; see ~/.local-leaf/server.log');
    }
    spawn(process.execPath, serverArgs, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });
    await new Promise(() => {});
  },

  async events() {
    const { default: WebSocket } = await import('ws');
    await api('GET', '/api/ping');
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('message', (m) => console.log(m.toString()));
    ws.on('close', () => process.exit(0));
    await new Promise(() => {});
  },
};

const cmd = positional[0] || 'help';
if (flags.help || flags.h || cmd === 'help' || cmd === '--help') { console.log(HELP); process.exit(0); }
if (!commands[cmd]) fail(`unknown command "${cmd}". Run \`leaf help\`.`);
commands[cmd](positional.slice(1)).catch((e) => fail(e.message));
