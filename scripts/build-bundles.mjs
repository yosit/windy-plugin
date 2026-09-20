import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/vex', { recursive: true });
await copyFile('scripts/install.mjs', 'dist/install.mjs');

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  external: ['runline', 'dripline'],
  banner: { js: '// Generated standalone Vex adapter. Do not edit.\n' },
};

await build({
  ...shared,
  entryPoints: ['plugins/dripline/src/index.ts'],
  outfile: 'dist/vex/windy-dripline.js',
});
await build({
  ...shared,
  entryPoints: ['plugins/runline/src/index.ts'],
  outfile: 'dist/vex/windy-runline.js',
});
