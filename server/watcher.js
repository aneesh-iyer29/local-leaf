import chokidar from 'chokidar';
import { relative, sep, basename } from 'node:path';
import { auxLike, SOURCE_EXT } from './files.js';
import { extname } from 'node:path';
import { existsSync } from 'node:fs';

// A .pdf that sits next to a .tex of the same name is a build output, not a figure.
function isBuildPdf(p) {
  if (extname(p).toLowerCase() !== '.pdf') return false;
  const stem = p.slice(0, -4);
  return existsSync(`${stem}.tex`) || existsSync(`${stem}.fdb_latexmk`) || existsSync(`${stem}.log`);
}

// Watches a project root and reports source changes. Build artefacts are ignored so latexmk's
// own output never re-triggers a compile.
export function watchProject(root, { onChange }) {
  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (p, stats) => {
      const name = basename(p);
      if (name === '.git' || name === 'node_modules' || name === '.DS_Store') return true;
      if (p.includes(`${sep}.git${sep}`)) return true;
      if (stats?.isFile() && auxLike(name)) return true;
      return false;
    },
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const rel = (p) => relative(root, p).split(sep).join('/');
  const handle = (event) => (p) => {
    const r = rel(p);
    const ext = extname(p).toLowerCase();
    const buildPdf = isBuildPdf(p);
    onChange({ event, path: r, isSource: SOURCE_EXT.has(ext) && !buildPdf, isAux: auxLike(basename(p)) || buildPdf });
  };
  watcher.on('add', handle('add')).on('change', handle('change')).on('unlink', handle('unlink'))
    .on('addDir', handle('addDir')).on('unlinkDir', handle('unlinkDir'));
  return watcher;
}
