#!/usr/bin/env node
import { lstat, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const scope = join(root, 'node_modules', '@yosit');
const target = join(scope, 'windy');
try {
  const stat = await lstat(target);
  if (!stat.isSymbolicLink()) await rm(target, { recursive: true, force: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(scope, { recursive: true });
try { await symlink(root, target, 'dir'); } catch (error) {
  if (error.code !== 'EEXIST') throw error;
}

for (const plugin of ['plugins/dripline', 'plugins/runline']) {
  const pluginTarget = join(root, plugin, 'node_modules', '@yosit', 'windy');
  await rm(pluginTarget, { recursive: true, force: true });
  await mkdir(dirname(pluginTarget), { recursive: true });
  await symlink(root, pluginTarget, 'dir');
}
