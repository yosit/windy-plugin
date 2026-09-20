#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const increment = process.argv[2] ?? 'patch';
if (!['major', 'minor', 'patch'].includes(increment)) {
  throw new Error(`unsupported version increment: ${increment}`);
}

const packagePaths = [
  'package.json',
  'plugins/dripline/package.json',
  'plugins/runline/package.json',
];
const packages = await Promise.all(packagePaths.map(async (path) => ({
  path,
  data: JSON.parse(await readFile(path, 'utf8')),
})));
const [major, minor, patch] = packages[0].data.version.split('.').map(Number);
const next = increment === 'major'
  ? `${major + 1}.0.0`
  : increment === 'minor'
    ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;

for (const { path, data } of packages) {
  data.version = next;
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}
console.log(next);
