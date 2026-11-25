// Build stand-alone Jarvis executables (no Node or install needed to run).
// Needs Bun (https://bun.sh) on the build machine.
//
//   node scripts/build-desktop.mjs            all platforms
//   node scripts/build-desktop.mjs windows    just Windows
//
// Output: dist/Jarvis-windows-x64.exe, dist/Jarvis-macos-arm64,
// dist/Jarvis-macos-x64, dist/Jarvis-linux-x64.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const build = join(root, 'build');
const dist = join(root, 'dist');

const TARGETS = {
  windows: [['bun-windows-x64', 'Jarvis-windows-x64.exe']],
  macos: [['bun-darwin-arm64', 'Jarvis-macos-arm64'], ['bun-darwin-x64', 'Jarvis-macos-x64']],
  linux: [['bun-linux-x64', 'Jarvis-linux-x64']],
};

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

mkdirSync(build, { recursive: true });
mkdirSync(dist, { recursive: true });
const assets = {};
for (const f of walk(pub)) assets[relative(pub, f).split('\\').join('/')] = readFileSync(f).toString('base64');
writeFileSync(join(build, 'assets.mjs'), `export default ${JSON.stringify(assets)};\n`);
writeFileSync(join(build, 'entry.mjs'), "import assets from './assets.mjs';\nimport { runDesktop } from '../desktop.js';\nrunDesktop({ assets });\n");
console.log(`Embedded ${Object.keys(assets).length} files.`);

const wanted = process.argv.slice(2);
const list = (wanted.length ? wanted : Object.keys(TARGETS)).flatMap((k) => {
  if (!TARGETS[k]) throw new Error(`Unknown platform "${k}". Use: ${Object.keys(TARGETS).join(', ')}`);
  return TARGETS[k];
});
for (const [target, out] of list) {
  const r = spawnSync('bun', ['build', '--compile', `--target=${target}`, join(build, 'entry.mjs'), '--outfile', join(dist, out)], { stdio: 'inherit', cwd: root });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log(`Done. Executables are in ${relative(process.cwd(), dist) || 'dist'}/`);
