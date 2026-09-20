#!/usr/bin/env node
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDripline = join(packageDir, 'dist/vex/windy-dripline.js');
const sourceRunline = join(packageDir, 'dist/vex/windy-runline.js');

function workspaceArg() {
  const i = process.argv.indexOf('--workspace');
  return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : resolve(process.env.VEX_WORKSPACE_PATH ?? process.cwd());
}

async function bytes(path) {
  try { return await readFile(path); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function installOne(source, target, check) {
  const expected = await bytes(source);
  if (!expected) throw new Error(`missing build artifact: ${source}; run pnpm bundle first`);
  const actual = await bytes(target);
  if (actual && Buffer.compare(expected, actual) === 0) {
    console.log(`current ${target}`);
    return true;
  }
  if (check) {
    console.log(`${actual ? 'stale' : 'missing'} ${target}`);
    return false;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.tmp-${process.pid}`;
  try {
    await writeFile(temp, expected, { flag: 'wx', mode: 0o600 });
    await rename(temp, target);
    console.log(`installed ${target}`);
    return true;
  } finally {
    await rm(temp, { force: true });
  }
}

const ws = workspaceArg();
const check = process.argv.includes('--check');
const okDripline = await installOne(sourceDripline, join(ws, '.dripline/windy.js'), check);
const okRunline = await installOne(sourceRunline, join(ws, '.runline/plugins/windy/index.js'), check);
if (check && (!okDripline || !okRunline)) process.exitCode = 1;
