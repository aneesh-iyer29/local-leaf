// The workspace is the repo's own `projects/` folder. Every subfolder is a project and shows up
// automatically in the picker. External folders can be copied or moved in.
import { promises as fs } from 'node:fs';
import { join, basename, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { findMainCandidates, safeJoin, trash } from './files.js';
import { excludeFromEnclosing } from './git.js';
import * as config from './config.js';

export const DEFAULT_WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'projects');

// The workspace folder: LOCAL_LEAF_PROJECTS env, else the saved setting, else <repo>/projects.
export function workspacePath() {
  if (process.env.LOCAL_LEAF_PROJECTS) return resolve(process.env.LOCAL_LEAF_PROJECTS);
  const saved = config.getGlobal('workspace', null);
  return saved ? resolve(saved) : DEFAULT_WORKSPACE;
}

export async function setWorkspacePath(path) {
  const abs = resolve(path);
  const st = await fs.stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw httpError('Not a directory');
  config.setGlobal('workspace', abs);
  return abs;
}

const SKIP_COPY = new Set(['node_modules', '.DS_Store', '.git']);

function httpError(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
const exists = (p) => fs.access(p).then(() => true, () => false);

export async function ensureWorkspace() { await fs.mkdir(workspacePath(), { recursive: true }); }

export function inWorkspace(p) {
  if (!p) return false;
  const r = resolve(p);
  const w = workspacePath();
  return r === w || r.startsWith(w + sep);
}

// A project is a direct child folder of the workspace.
export function isWorkspaceProject(p) {
  return inWorkspace(p) && dirname(resolve(p)) === workspacePath();
}

export async function listProjects() {
  await ensureWorkspace();
  const W = workspacePath();
  const entries = await fs.readdir(W, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const path = join(W, e.name);
    const st = await fs.stat(path);
    const mains = await findMainCandidates(path);
    out.push({ name: e.name, path, main: mains[0] || null, modified: st.mtimeMs });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

export function safeName(name) {
  const n = String(name || '').trim().replace(/[/\\:]/g, '-');
  if (!n || n.startsWith('.') || n === '..') throw httpError('Invalid project name');
  return n;
}

async function uniqueTarget(name) {
  await ensureWorkspace();
  const W = workspacePath();
  let target = join(W, name);
  let i = 2;
  while (await exists(target)) target = join(W, `${name}-${i++}`);
  return target;
}

async function copyTree(src, dest) {
  await fs.cp(src, dest, { recursive: true, filter: (s) => !SKIP_COPY.has(basename(s)) });
}

// Copy or move an external folder into the workspace. Returns the new project path.
export async function importFolder(src, mode = 'copy') {
  src = resolve(src);
  const st = await fs.stat(src).catch(() => null);
  if (!st?.isDirectory()) throw httpError('Not a directory');
  if (inWorkspace(src)) throw httpError('That folder is already inside the projects workspace');
  if (workspacePath().startsWith(src + sep)) throw httpError('Cannot import a parent of the workspace');
  const target = await uniqueTarget(basename(src));
  if (mode === 'move') {
    try {
      await fs.rename(src, target);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await copyTree(src, target);
      await fs.rm(src, { recursive: true, force: true });
    }
  } else {
    await copyTree(src, target);
  }
  // A moved folder that is its own repository stays standalone; keep it out of the enclosing repo.
  if (await exists(join(target, '.git'))) await excludeFromEnclosing(target);
  return target;
}

const TEMPLATE = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{hyperref}

\\title{TITLE}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`;

export async function createProject(name) {
  const n = safeName(name);
  await ensureWorkspace();
  const target = join(workspacePath(), n);
  if (await exists(target)) throw httpError('A project with that name already exists', 409);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(join(target, 'main.tex'), TEMPLATE.replace('TITLE', n));
  return target;
}

// Write one uploaded file into a (possibly new) workspace project. Used for folder uploads.
export async function writeProjectFile(project, rel, buffer) {
  const n = safeName(project);
  const root = join(workspacePath(), n);
  await fs.mkdir(root, { recursive: true });
  const abs = safeJoin(root, rel);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  return root;
}

// Extract a zip (e.g. an Overleaf export) into a new workspace project.
export async function importZip(name, buffer) {
  const target = await uniqueTarget(safeName(name.replace(/\.zip$/i, '')));
  const tmp = join(tmpdir(), `local-leaf-${Date.now()}.zip`);
  await fs.writeFile(tmp, buffer);
  await fs.mkdir(target, { recursive: true });
  try {
    await new Promise((res, rej) => execFile('ditto', ['-xk', tmp, target], (err, _o, stderr) => (err ? rej(new Error(stderr || err.message)) : res())));
  } finally {
    await fs.rm(tmp, { force: true });
  }
  await fs.rm(join(target, '__MACOSX'), { recursive: true, force: true });
  // Flatten a zip whose only top-level entry is a folder.
  const entries = (await fs.readdir(target)).filter((e) => e !== '.DS_Store');
  if (entries.length === 1) {
    const only = join(target, entries[0]);
    if ((await fs.stat(only)).isDirectory()) {
      for (const child of await fs.readdir(only)) await fs.rename(join(only, child), join(target, child));
      await fs.rmdir(only);
    }
  }
  return target;
}

export async function renameProject(path, name) {
  const abs = resolve(path);
  if (!isWorkspaceProject(abs)) throw httpError('Only projects inside the workspace can be renamed here');
  const target = join(workspacePath(), safeName(name));
  if (target === abs) return abs;
  if (await exists(target)) throw httpError('A project with that name already exists', 409);
  await fs.rename(abs, target);
  return target;
}

export async function trashProject(path) {
  const abs = resolve(path);
  if (!isWorkspaceProject(abs)) throw httpError('Only projects inside the workspace can be trashed from here');
  await trash(abs);
}
