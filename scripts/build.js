import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('public/build', { recursive: true });

const opts = {
  entryPoints: {
    app: 'client/main.js',
    'pdf.worker': 'node_modules/pdfjs-dist/build/pdf.worker.mjs',
  },
  bundle: true,
  format: 'esm',
  outdir: 'public/build',
  sourcemap: true,
  minify: !watch,
  logLevel: 'info',
  target: ['es2022'],
  loader: { '.css': 'css' },
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
