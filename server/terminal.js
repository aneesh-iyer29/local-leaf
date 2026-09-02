// Open a terminal (or Claude Code inside one) at a project folder. Uses `open` and .command
// files so no AppleScript / Automation permission is needed.
import { promises as fs, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';

const APPS = [
  { id: 'Terminal', name: 'Terminal', paths: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'], commandFiles: true },
  { id: 'iTerm', name: 'iTerm2', paths: ['/Applications/iTerm.app', join(homedir(), 'Applications/iTerm.app')], commandFiles: true },
  { id: 'Warp', name: 'Warp', paths: ['/Applications/Warp.app'], commandFiles: false },
  { id: 'Ghostty', name: 'Ghostty', paths: ['/Applications/Ghostty.app'], commandFiles: false },
  { id: 'kitty', name: 'kitty', paths: ['/Applications/kitty.app'], commandFiles: false },
  { id: 'Alacritty', name: 'Alacritty', paths: ['/Applications/Alacritty.app'], commandFiles: false },
  { id: 'WezTerm', name: 'WezTerm', paths: ['/Applications/WezTerm.app'], commandFiles: false },
];

export function installedApps() {
  return APPS.filter((a) => a.paths.some((p) => existsSync(p))).map(({ id, name, commandFiles }) => ({ id, name, commandFiles }));
}

function run(cmd, args) {
  return new Promise((res, rej) => execFile(cmd, args, (err, stdout, stderr) => (err ? rej(new Error((stderr || err.message).trim())) : res(stdout))));
}

// Is the `claude` CLI reachable from a login shell?
export async function claudeAvailable() {
  try { await run('/bin/zsh', ['-lc', 'command -v claude']); return true; } catch { return false; }
}

export async function openTerminal({ dir, app = 'Terminal', claude = false }) {
  const known = installedApps().find((a) => a.id === app) || installedApps()[0];
  if (!known) throw Object.assign(new Error('No supported terminal app found'), { status: 400 });
  if (!claude) {
    // Opening a folder with a terminal app starts a shell there (Terminal, iTerm, Warp, Ghostty all do this).
    await run('open', ['-a', known.id, dir]);
    return { app: known.id };
  }
  // Claude Code: a small .command script that cds into the project and starts `claude` in a login
  // shell (so PATH is the user's). After Claude exits the shell stays open for further work.
  const launchDir = join(homedir(), '.local-leaf', 'launch');
  await fs.mkdir(launchDir, { recursive: true });
  const script = join(launchDir, `${basename(dir).replace(/[^A-Za-z0-9._-]/g, '_')}.command`);
  await fs.writeFile(script, `#!/bin/zsh -l
cd ${JSON.stringify(dir)} || exit 1
printf '\\033]0;%s\\007' ${JSON.stringify(`Claude Code — ${basename(dir)}`)}
if command -v claude >/dev/null 2>&1; then
  claude
else
  echo "claude is not on your PATH. Install Claude Code, then run: claude"
fi
exec zsh -l
`, { mode: 0o755 });
  await fs.chmod(script, 0o755);
  const via = known.commandFiles ? known.id : 'Terminal';
  await run('open', ['-a', via, script]);
  return { app: via, script };
}
