#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const root = json('package.json');
const drip = json('plugins/dripline/package.json');
const runline = json('plugins/runline/package.json');
if (![root.version, drip.version, runline.version].every((v) => v === root.version)) {
  throw new Error(`version drift: root=${root.version} dripline=${drip.version} runline=${runline.version}`);
}
console.log(`version lockstep: ${root.version}`);
run('bun', ['run', 'link-workspace']);
rmSync('dist', { recursive: true, force: true });
run('bun', ['run', 'build']);
run('bun', ['run', '--filter', '@yosit/dripline-plugin-windy', 'build']);
run('bun', ['run', '--filter', '@yosit/runline-plugin-windy', 'build']);
run('bun', ['run', 'bundle']);
run('bun', ['test']);

const dripBundle = readFileSync('dist/vex/windy-dripline.js', 'utf8');
const runBundle = readFileSync('dist/vex/windy-runline.js', 'utf8');
for (const [name, code] of [['dripline', dripBundle], ['runline', runBundle]]) {
  if (code.match(/from ["'](?:@yosit\/windy|@yosit\/windy-cli)["']/)) {
    throw new Error(`${name} bundle contains an unresolved shared-package import`);
  }
}
console.log('standalone bundles: no unresolved shared-package imports');

const workspace = mkdtempSync(join(tmpdir(), 'windy-smoke-'));
try {
  run('node', ['dist/install.mjs', '--workspace', workspace]);
  run('node', ['dist/install.mjs', '--check', '--workspace', workspace]);
  run('bun', ['pm', 'pack', '--destination', workspace]);
  const tarball = readdirSync(workspace).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('bun pm pack did not produce a tarball');
  const packed = execFileSync('tar', ['-tf', join(workspace, tarball)], { encoding: 'utf8' });
  for (const required of ['package/dist/install.mjs', 'package/dist/vex/windy-dripline.js', 'package/dist/vex/windy-runline.js', 'package/skills/windy/SKILL.md']) {
    if (!packed.includes(required)) throw new Error(`packed artifact missing ${required}`);
  }
  console.log('installer and packed artifact checks passed');
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

if (process.env.RUN_LIVE_TESTS === '1') {
  const { WindyClient } = await import('../dist/index.js');
  const client = WindyClient.fromEnv({ ephemeral: true });
  const publicForecast = await client.pointForecast(32.0853, 34.7818, {
    model: 'ecmwf',
    step: 3,
  });
  if (!publicForecast.data?.ts?.length) throw new Error('live forecast returned no timesteps');
  const account = await client.whoami();
  if (!account) throw new Error('live authenticated account check returned no profile');
  const settings = await client.userSettings();
  if (!settings) throw new Error('live authenticated settings check returned no data');
  const favourites = await client.favourites();
  if (!favourites) throw new Error('live authenticated favourites check returned no data');
  console.log(`live checks passed: forecast=${publicForecast.data.ts.length} timesteps, authenticated account/settings/favourites`);
} else {
  console.log('live checks skipped (set RUN_LIVE_TESTS=1 when credentialed live tests are available)');
}
