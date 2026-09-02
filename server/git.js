// Per-project git integration. Each project folder is its own repository with its own remote.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, resolve, basename, relative, sep } from 'node:path';
import { gitEnv as overleafEnv, isOverleafUrl } from './overleaf.js';

const GITIGNORE = `# LaTeX build products
*.aux
*.log
*.fls
*.fdb_latexmk
*.synctex.gz
*.synctex
*.out
*.toc
*.lof
*.lot
*.bbl
*.blg
*.bcf
*.run.xml
*.nav
*.snm
*.vrb
*.xdv
.DS_Store
`;

function run(cmd, args, cwd, { allowFail = false, env = {} } = {}) {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, maxBuffer: 1 << 24, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } }, (err, stdout, stderr) => {
      const code = err ? (err.code ?? 1) : 0;
      if (err && !allowFail) {
        const e = new Error((stderr || stdout || err.message).trim());
        e.status = 400;
        return rej(e);
      }
      res({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
const git = (args, cwd, o) => run('git', args, cwd, o);

// Credentials helper for remotes on git.overleaf.com; empty for everything else.
async function remoteEnv(root) {
  const r = await git(['remote', 'get-url', 'origin'], root, { allowFail: true });
  return r.code === 0 && isOverleafUrl(r.stdout.trim()) ? overleafEnv() : {};
}

async function toplevel(root) {
  const r = await git(['rev-parse', '--show-toplevel'], root, { allowFail: true });
  return r.code === 0 ? resolve(r.stdout.trim()) : null;
}

// Where git commands run for a project: its own repo, or the enclosing repo scoped to its subfolder.
async function context(root) {
  root = resolve(root);
  const top = await toplevel(root);
  if (!top) return { repo: false, cwd: root, sub: null, top: null };
  if (top === root) return { repo: true, mode: 'own', cwd: root, sub: null, top };
  const sub = relative(top, root).split(sep).join('/');
  return { repo: true, mode: 'scoped', cwd: top, sub, top };
}
const scope = (ctx) => (ctx.sub ? ['--', ctx.sub] : []);

export async function status(root) {
  const ctx = await context(root);
  if (!ctx.repo) return { repo: false, parentRepo: null };
  root = ctx.cwd;
  const scopedInfo = ctx.mode === 'scoped' ? { mode: 'scoped', repoRoot: ctx.top, repoName: basename(ctx.top), subpath: ctx.sub } : { mode: 'own' };

  const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root, { allowFail: true });
  const hasCommits = head.code === 0;
  let branch = hasCommits ? head.stdout.trim() : null;
  if (!hasCommits) {
    const sym = await git(['symbolic-ref', '--short', 'HEAD'], root, { allowFail: true });
    branch = sym.code === 0 ? sym.stdout.trim() : 'main';
  }

  const st = await git(['status', '--porcelain=v1', '-b', '--untracked-files=all', ...scope(ctx)], root);
  const lines = st.stdout.split('\n').filter(Boolean);
  let upstream = null, ahead = 0, behind = 0;
  if (lines[0]?.startsWith('##')) {
    const m = lines[0].match(/^## (?:No commits yet on )?(\S+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
    if (m) {
      upstream = m[2] || null;
      const flags = m[3] || '';
      ahead = Number(flags.match(/ahead (\d+)/)?.[1] || 0);
      behind = Number(flags.match(/behind (\d+)/)?.[1] || 0);
    }
    lines.shift();
  }
  const prefix = ctx.sub ? `${ctx.sub}/` : '';
  const changes = lines.map((l) => {
    const code = l.slice(0, 2);
    let path = l.slice(3);
    if (code.includes('R') || code.includes('C')) path = path.split(' -> ').pop();
    path = path.replace(/^"|"$/g, '');
    if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
    return { code: code.trim() || '??', path };
  });

  const rem = await git(['remote', '-v'], root, { allowFail: true });
  const remotes = [];
  for (const l of rem.stdout.split('\n')) {
    const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (m) remotes.push({ name: m[1], url: m[2] });
  }

  let lastCommit = null;
  if (hasCommits) {
    const lg = await git(['log', '-1', '--format=%h%x1f%s%x1f%ar', ...scope(ctx)], root, { allowFail: true });
    const [hash, subject, when] = lg.stdout.trim().split('\x1f');
    if (hash) lastCommit = { hash, subject, when };
  }
  return { repo: true, ...scopedInfo, branch, upstream, ahead, behind, changes, remotes, hasCommits, lastCommit };
}

export async function log(root, n = 8) {
  const ctx = await context(root);
  if (!ctx.repo) return [];
  const r = await git(['log', `-${n}`, '--format=%h%x1f%s%x1f%an%x1f%ar', ...scope(ctx)], ctx.cwd, { allowFail: true });
  if (r.code !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, subject, author, when] = l.split('\x1f');
    return { hash, subject, author, when };
  });
}

export async function init(root) {
  const ctx = await context(root);
  if (ctx.repo) throw Object.assign(new Error(ctx.mode === 'own' ? 'Already a repository' : `Already versioned inside the ${basename(ctx.top)} repository`), { status: 409 });
  await git(['init', '-b', 'main'], root);
  const gi = join(root, '.gitignore');
  try { await fs.access(gi); } catch { await fs.writeFile(gi, GITIGNORE); }
  await git(['add', '-A'], root);
  await git(['commit', '-m', 'Initial commit'], root);
  return status(root);
}

export async function commit(root, message) {
  if (!message?.trim()) throw Object.assign(new Error('Commit message is required'), { status: 400 });
  const ctx = await context(root);
  if (!ctx.repo) throw Object.assign(new Error('Not a repository'), { status: 400 });
  // In scoped mode only this project's files are staged and committed, never the rest of the repo.
  await git(['add', '-A', ...scope(ctx)], ctx.cwd);
  await git(['commit', '-m', message.trim(), ...scope(ctx)], ctx.cwd);
  return status(root);
}

export async function push(root) {
  const st = await status(root);
  const cwd = (await context(root)).cwd;
  if (!st.remotes.length) throw Object.assign(new Error('No remote configured. Publish to GitHub or add a remote URL first.'), { status: 400 });
  const args = st.upstream ? ['push'] : ['push', '-u', st.remotes[0].name, st.branch];
  const r = await git(args, cwd, { env: await remoteEnv(cwd) });
  return { output: (r.stderr || r.stdout).trim(), status: await status(root) };
}

export async function pull(root) {
  const cwd = (await context(root)).cwd;
  const r = await git(['pull', '--no-rebase'], cwd, { env: await remoteEnv(cwd) });
  return { output: (r.stdout || r.stderr).trim(), status: await status(root) };
}

export async function fetch(root) {
  const cwd = (await context(root)).cwd;
  await git(['fetch', '--prune'], cwd, { allowFail: true, env: await remoteEnv(cwd) });
  return status(root);
}

export async function setRemote(root, url, name = 'origin') {
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) throw Object.assign(new Error('That does not look like a git remote URL'), { status: 400 });
  const cwd = (await context(root)).cwd;
  const st = await status(root);
  if (st.remotes.some((r) => r.name === name)) await git(['remote', 'set-url', name, url], cwd);
  else await git(['remote', 'add', name, url], cwd);
  return status(root);
}

// Is this path inside a git work tree (e.g. the workspace inside the local-leaf repo)?
export async function enclosingRepo(path) {
  return toplevel(path);
}

// Keep a nested standalone repository out of the enclosing repo's index (no gitlinks).
export async function excludeFromEnclosing(path) {
  const top = await toplevel(resolve(path, '..'));
  if (!top) return;
  const relPath = relative(top, resolve(path)).split(sep).join('/') + '/';
  const file = join(top, '.git', 'info', 'exclude');
  let cur = '';
  try { cur = await fs.readFile(file, 'utf8'); } catch { /* none */ }
  if (!cur.split('\n').includes(relPath)) await fs.appendFile(file, `${cur.endsWith('\n') || !cur ? '' : '\n'}${relPath}\n`);
}

export async function ghUser() {
  const r = await run('gh', ['api', 'user', '--jq', '.login'], undefined, { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

// Create a GitHub repo for this project with gh and push the current branch to it.
export async function publish(root, { name, visibility = 'private' }) {
  const user = await ghUser();
  if (!user) throw Object.assign(new Error('GitHub CLI is not logged in. Run `gh auth login` in a terminal first.'), { status: 400 });
  const st = await status(root);
  if (st.mode === 'scoped') throw Object.assign(new Error(`This project is versioned inside the ${st.repoName} repository; push that instead.`), { status: 400 });
  if (!st.hasCommits) throw Object.assign(new Error('Make a first commit before publishing'), { status: 400 });
  const repoName = (name || basename(root)).trim().replace(/[^A-Za-z0-9._-]/g, '-');
  const vis = visibility === 'public' ? '--public' : '--private';
  const r = await run('gh', ['repo', 'create', repoName, vis, `--source=${root}`, '--remote=origin', '--push'], root);
  const url = (r.stdout + r.stderr).match(/https:\/\/github\.com\/\S+/)?.[0]?.replace(/\.git$/, '') || `https://github.com/${user}/${repoName}`;
  return { url, status: await status(root) };
}
