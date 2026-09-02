import { promises as fs } from 'node:fs';
import { join, resolve, relative, sep, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';

// Move a file or folder to the user's Trash. Try a plain rename into ~/.Trash first (no
// permissions needed), then fall back to asking Finder.
export async function trash(abs) {
  const dir = join(homedir(), '.Trash');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const target of [join(dir, basename(abs)), join(dir, `${basename(abs)} ${stamp}`)]) {
    try { await fs.rename(abs, target); return target; } catch { /* try next */ }
  }
  await new Promise((res, rej) => {
    execFile('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(abs)}`], (err, _o, stderr) => (err ? rej(new Error(`Could not move to Trash: ${stderr || err.message}`)) : res()));
  });
  return null;
}

// Build artefacts hidden from the tree by default (still on disk).
export const AUX_EXT = new Set([
  '.aux', '.log', '.fls', '.fdb_latexmk', '.synctex.gz', '.synctex', '.out', '.toc', '.lof', '.lot',
  '.bbl', '.blg', '.bcf', '.run.xml', '.nav', '.snm', '.vrb', '.idx', '.ilg', '.ind', '.glo', '.gls',
  '.glg', '.acn', '.acr', '.alg', '.xdv', '.dvi', '.figlist', '.makefile', '.auxlock', '.thm', '.loa',
  '.lol', '.brf', '.ist', '.xmpi', '.pyg', '.ptc', '.upa', '.upb', '.spl', '.cut',
]);
const HIDDEN_DIRS = new Set(['.git', 'node_modules', '_minted-main', '.svn', '.hg']);

// Extensions whose changes on disk should trigger an auto-compile.
export const SOURCE_EXT = new Set([
  '.tex', '.bib', '.sty', '.cls', '.bst', '.def', '.ltx', '.cfg', '.clo', '.dtx', '.ins', '.bbx', '.cbx', '.lbx',
  '.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.csv', '.txt', '.dat', '.tikz', '.pgf', '.md',
]);

export function auxLike(name) {
  const lower = name.toLowerCase();
  for (const ext of AUX_EXT) if (lower.endsWith(ext)) return true;
  return false;
}

// Resolve a client-supplied relative path inside the project, refusing anything that escapes it.
export function safeJoin(root, rel) {
  const abs = resolve(root, rel || '.');
  const r = relative(root, abs);
  if (r.startsWith('..') || (r && r.split(sep)[0] === '..')) {
    const err = new Error('Path escapes project');
    err.status = 400;
    throw err;
  }
  return abs;
}

export async function readTree(root, { showAll = false } = {}) {
  async function walk(dir) {
    let entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    const out = [];
    for (const e of entries) {
      if (e.name === '.DS_Store') continue;
      const rel = relative(root, join(dir, e.name)).split(sep).join('/');
      if (e.isDirectory()) {
        if (HIDDEN_DIRS.has(e.name) || (!showAll && e.name.startsWith('.'))) continue;
        out.push({ name: e.name, path: rel, type: 'dir', children: await walk(join(dir, e.name)) });
      } else if (e.isFile()) {
        if (!showAll && (auxLike(e.name) || e.name.startsWith('.'))) continue;
        // The compiled PDF is shown via the viewer; hide the main output PDF only if it is a build product
        out.push({ name: e.name, path: rel, type: 'file', ext: extname(e.name).toLowerCase() });
      }
    }
    return out;
  }
  return walk(root);
}

// Find every .tex file containing \documentclass, shallowest first.
export async function findMainCandidates(root) {
  const found = [];
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!HIDDEN_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.tex')) {
        try {
          const head = (await fs.readFile(join(dir, e.name), 'utf8')).slice(0, 20000);
          if (/^\s*\\documentclass/m.test(head)) {
            found.push({ path: relative(root, join(dir, e.name)).split(sep).join('/'), depth });
          }
        } catch { /* ignore */ }
      }
    }
  }
  await walk(root, 0);
  found.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const am = basename(a.path).toLowerCase() === 'main.tex';
    const bm = basename(b.path).toLowerCase() === 'main.tex';
    if (am !== bm) return am ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return found.map((f) => f.path);
}

export function isTextFile(name) {
  const ext = extname(name).toLowerCase();
  return !['.png', '.jpg', '.jpeg', '.gif', '.pdf', '.eps', '.ps', '.zip', '.gz', '.ttf', '.otf', '.woff', '.woff2', '.bmp', '.tiff', '.ico', '.synctex.gz'].includes(ext);
}
