import { execFile } from 'node:child_process';
import { join, dirname, basename, extname, relative } from 'node:path';
import { texEnv } from './compile.js';

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('synctex', args, { cwd, env: texEnv(), maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// Source → PDF. Returns first matching record: { page, x, y, h, v, W, H } in PDF points, top-left origin.
export async function forward({ root, main, file, line, column = 0 }) {
  const cwd = join(root, dirname(main));
  const pdf = `${basename(main, extname(main))}.pdf`;
  const relFile = relative(cwd, join(root, file)).replace(/\\/g, '/');
  const candidates = [relFile, `./${relFile}`, join(root, file)];
  let out = '';
  for (const c of candidates) {
    try {
      out = await run(['view', '-i', `${line}:${column}:${c}`, '-o', pdf], cwd);
      if (/^Page:/m.test(out)) break;
    } catch { /* try next */ }
  }
  const records = [];
  let cur = null;
  for (const l of out.split('\n')) {
    const m = l.match(/^(Page|x|y|h|v|W|H):(.*)$/);
    if (!m) { if (l.startsWith('Output:') && cur) { records.push(cur); cur = null; } continue; }
    if (m[1] === 'Page') { if (cur) records.push(cur); cur = { page: Number(m[2]) }; }
    else if (cur) cur[m[1]] = Number(m[2]);
  }
  if (cur) records.push(cur);
  return records.length ? records[0] : null;
}

// PDF → source. Returns { file, line, column } with file relative to project root.
export async function inverse({ root, main, page, x, y }) {
  const cwd = join(root, dirname(main));
  const pdf = `${basename(main, extname(main))}.pdf`;
  const out = await run(['edit', '-o', `${page}:${x}:${y}:${pdf}`], cwd);
  const file = out.match(/^Input:(.*)$/m)?.[1]?.trim();
  const line = Number(out.match(/^Line:(\d+)/m)?.[1]);
  const column = Number(out.match(/^Column:(-?\d+)/m)?.[1] || 0);
  if (!file || !line) return null;
  const abs = file.startsWith('/') ? file : join(cwd, file);
  return { file: relative(root, abs).replace(/\\/g, '/'), line, column: Math.max(0, column) };
}
