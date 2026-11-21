import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main.ts', 'src/preload.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outExtension: { '.js': '.cjs' }, external: ['electron'], outdir: 'dist' }),
  build({
    entryPoints: { renderer: 'src/renderer.ts', 'sim-worker': 'src/sim-worker.ts', 'layout-worker': 'src/layout-worker.ts', 'editor-worker': 'node_modules/monaco-editor/esm/vs/editor/editor.worker.js' },
    bundle: true, platform: 'browser', target: 'chrome130', format: 'iife', outdir: 'dist',
    loader: { '.ttf': 'file' }, legalComments: 'linked',
  }),
  cp('src/index.html', 'dist/index.html'),
  cp('node_modules/elkjs/lib/elk-worker.min.js', 'dist/elk-worker.js'),
]);
