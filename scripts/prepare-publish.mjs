#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const root = JSON.parse(await readFile('package.json', 'utf8'));
const version = root.version;
for (const path of ['plugins/dripline/package.json', 'plugins/runline/package.json']) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  data.dependencies['@yosit/windy'] = version;
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}
console.log(`publish dependencies: @yosit/windy@${version}`);
