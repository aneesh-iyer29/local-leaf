// Import from Overleaf via its git bridge (https://git.overleaf.com/<project-id>). After the clone
// the Overleaf remote is removed: the project keeps its full history but lives locally from then on.
// Overleaf authenticates git with username "git" and a personal git token as the password.
// The token is kept in ~/.local-leaf/overleaf-token (mode 600) and handed to git through a
// GIT_ASKPASS helper, so it never appears in a remote URL or a process argument.
import { promises as fs, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { workspacePath, ensureWorkspace, safeName } from './workspace.js';
import { enclosingRepo } from './git.js';

const DIR = join(homedir(), '.local-leaf');
const TOKEN_FILE = join(DIR, 'overleaf-token');
const ASKPASS = join(DIR, 'overleaf-askpass.sh');
export const OVERLEAF_GIT_HOST = 'git.overleaf.com';

function httpError(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

export function hasToken() { return existsSync(TOKEN_FILE); }

export async function setToken(token) {
  token = String(token || '').trim();
  if (!token) { await fs.rm(TOKEN_FILE, { force: true }); return false; }
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(TOKEN_FILE, token, { mode: 0o600 });
  await fs.chmod(TOKEN_FILE, 0o600);
  await ensureAskpass();
  return true;
}

async function ensureAskpass() {
  await fs.mkdir(DIR, { recursive: true });
  const script = `#!/bin/sh
# GIT_ASKPASS helper for Overleaf: username is always "git", password is the stored token.
case "$1" in
  *sername*) echo git ;;
  *) cat "${TOKEN_FILE}" ;;
esac
`;
  await fs.writeFile(ASKPASS, script, { mode: 0o700 });
  await fs.chmod(ASKPASS, 0o700);
}

// Environment for git commands that talk to Overleaf. Only applied when the remote is Overleaf.
export function gitEnv() {
  if (!hasToken() || !existsSync(ASKPASS)) return {};
  return { GIT_ASKPASS: ASKPASS, GIT_TERMINAL_PROMPT: '0' };
}
export const isOverleafUrl = (url) => typeof url === 'string' && url.includes(OVERLEAF_GIT_HOST);

// Accepts https://www.overleaf.com/project/<id>, https://git.overleaf.com/<id>, or a bare id.
export function parseProjectId(input) {
  const s = String(input || '').trim();
  if (/overleaf\.com\/read\//.test(s)) throw httpError('That is a read-only share link. Open the project in Overleaf and copy the URL from the address bar instead.');
  const m = s.match(/([0-9a-f]{24})(?![0-9a-f])/i);
  if (!m) throw httpError('Could not find an Overleaf project id. Paste the project URL from your browser (https://www.overleaf.com/project/…) or the git URL.');
  return m[1].toLowerCase();
}

export async function importProject({ project, name }) {
  if (!hasToken()) throw httpError('No Overleaf git token saved yet. Generate one under Overleaf → Account settings → Git integration, then save it here.');
  const id = parseProjectId(project);
  await ensureAskpass();
  await ensureWorkspace();
  let target = join(workspacePath(), safeName(name || `overleaf-${id.slice(-6)}`));
  let i = 2;
  const base = target;
  while (existsSync(target)) target = `${base}-${i++}`;
  const url = `https://${OVERLEAF_GIT_HOST}/${id}`;
  await new Promise((res, rej) => {
    execFile('git', ['clone', url, target], { env: { ...process.env, ...gitEnv(), GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 1 << 24 }, (err, _o, stderr) => {
      if (!err) return res();
      const msg = String(stderr || err.message);
      if (/Authentication failed|403|401|could not read Username/i.test(msg)) {
        return rej(httpError('Overleaf rejected the git token. Check the token, and note that Overleaf only offers git access on paid plans. You can always import the project as a zip instead.'));
      }
      if (/not found|404/i.test(msg)) return rej(httpError(`Overleaf has no project with id ${id} that this token can access.`));
      rej(httpError(`git clone failed: ${msg.trim()}`));
    });
  });
  // Detach from Overleaf. If the workspace sits inside a repository (the local-leaf repo), the
  // project joins that repo: its nested .git goes away and the files become ordinary tracked files.
  // Otherwise it stays a standalone repo, minus the Overleaf remote.
  const outer = await enclosingRepo(workspacePath());
  if (outer) {
    await fs.rm(join(target, '.git'), { recursive: true, force: true });
    await gitIn(outer, ['config', `leaf.overleaf.${basename(target)}`, id]);
  } else {
    await gitIn(target, ['remote', 'remove', 'origin']);
    await gitIn(target, ['config', 'leaf.overleafProject', id]);
  }
  return { path: target, name: basename(target), id, url, joinedRepo: !!outer };
}

function gitIn(cwd, args) {
  return new Promise((res) => execFile('git', args, { cwd }, () => res()));
}
