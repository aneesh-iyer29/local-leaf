import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { parseLog } from './logparse.js';

const ENGINE_FLAGS = {
  pdflatex: ['-pdf'],
  xelatex: ['-xelatex'],
  lualatex: ['-lualatex'],
};

const TEXBIN = '/Library/TeX/texbin';

export function texEnv() {
  const env = { ...process.env, max_print_line: '10000', error_line: '254', half_error_line: '238' };
  if (!env.PATH.split(':').includes(TEXBIN)) env.PATH = `${TEXBIN}:${env.PATH}`;
  return env;
}

// Runs latexmk in the project directory. Returns { ok, exitCode, output, log, errors, pdf }.
export function compile({ root, main, engine = 'pdflatex', onOutput }) {
  const args = [
    ...(ENGINE_FLAGS[engine] || ENGINE_FLAGS.pdflatex),
    '-synctex=1',
    '-interaction=nonstopmode',
    '-file-line-error',
    // Like Overleaf: keep going after TeX errors so the PDF, cross-references and page totals
    // still get their rerun passes. The exit code stays non-zero, so failures are still reported.
    '-f',
    // Always run at least once, even if latexmk thinks nothing changed (e.g. after a failed run).
    '-g',
    main,
  ];
  const cwd = join(root, dirname(main));
  const stem = basename(main, extname(main));
  const proc = spawn('latexmk', args, { cwd, env: texEnv() });
  let output = '';
  const collect = (chunk) => {
    const s = chunk.toString();
    output += s;
    onOutput?.(s);
  };
  proc.stdout.on('data', collect);
  proc.stderr.on('data', collect);

  const done = new Promise((resolve) => {
    proc.on('close', async (code) => {
      let log = '';
      try { log = await fs.readFile(join(cwd, `${stem}.log`), 'utf8'); } catch { /* no log */ }
      let errors = parseLog(log);
      if (code !== 0 && !errors.some((e) => e.type === 'error')) {
        // latexmk failed for a reason outside the TeX log (missing binary, bibtex, etc.)
        const tail = output.trim().split('\n').slice(-15).join('\n');
        errors.unshift({ type: 'error', file: null, line: null, message: `latexmk exited with code ${code}`, context: tail });
      }
      const pdfRel = join(dirname(main), `${stem}.pdf`).replace(/\\/g, '/');
      let pdfExists = false;
      try { await fs.access(join(root, pdfRel)); pdfExists = true; } catch { /* none */ }
      resolve({ ok: code === 0, exitCode: code, output, log, errors, pdf: pdfExists ? pdfRel : null });
    });
    proc.on('error', (err) => {
      resolve({ ok: false, exitCode: -1, output: String(err), log: '', pdf: null,
        errors: [{ type: 'error', file: null, line: null, message: `Could not start latexmk: ${err.message}`, context: '' }] });
    });
  });

  return { proc, done };
}

export function clean({ root, main }) {
  const cwd = join(root, dirname(main));
  return new Promise((resolve) => {
    const proc = spawn('latexmk', ['-C', main], { cwd, env: texEnv() });
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (out += d));
    proc.on('close', (code) => resolve({ ok: code === 0, output: out }));
    proc.on('error', (e) => resolve({ ok: false, output: String(e) }));
  });
}
