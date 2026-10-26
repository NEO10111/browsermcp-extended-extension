import { readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
async function walk(dir) {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else paths.push(path);
  }
  return paths;
}
const files = await walk('.');
for (const file of files) {
  if (/\.(js|mjs|cjs)$/.test(file)) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  if (file.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
}
if (files.includes('manifest.json')) {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  if (manifest.version !== pkg.version) throw new Error('Manifest and package versions differ');
  const paths = [...Object.values(manifest.icons), manifest.background.service_worker, manifest.action.default_popup];
  for (const path of paths) await access(path);
}
console.log(`Validated syntax, JSON and referenced manifest assets (${files.length} files).`);
