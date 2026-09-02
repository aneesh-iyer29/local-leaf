// Native macOS folder chooser. The server runs on the user's Mac, so we can pop Finder's dialog.
import { execFile } from 'node:child_process';

export function pickFolder(defaultPath) {
  const script = defaultPath
    ? `POSIX path of (choose folder with prompt "Choose a LaTeX project folder" default location POSIX file ${JSON.stringify(defaultPath)})`
    : `POSIX path of (choose folder with prompt "Choose a LaTeX project folder")`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "System Events" to activate', '-e', script], (err, stdout) => {
      if (err) return resolve(null); // user cancelled
      resolve(stdout.trim().replace(/\/$/, ''));
    });
  });
}
