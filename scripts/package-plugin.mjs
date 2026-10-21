// Build the submission ZIP from the standalone plugin directory.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../plugins/codejury/', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const destination = path.resolve(process.argv[2] ?? path.join('dist', `codejury-plugin-${manifest.version}.zip`));
if (destination.startsWith(root)) throw new Error('Write the archive outside the plugin directory.');
const walk = (directory = '') => readdirSync(path.join(root, directory)).sort().flatMap(name => {
  const relative = path.join(directory, name);
  const stat = lstatSync(path.join(root, relative));
  if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed in the submission: ${relative}`);
  if (name.startsWith('.') || name === 'node_modules' || name === 'runs') throw new Error(`Unexpected private/development path: ${relative}`);
  return stat.isDirectory() ? walk(relative) : [relative];
});
const files = walk().map(relative => relative.split(path.sep).join('/'));
const extension = manifest.extensions['com.openai'];
for (const relative of [extension.onboardingSkill, extension.interface.logo,
  extension.interface.composerIcon, ...(extension.interface.screenshots ?? [])]) {
  if (!relative.startsWith('./') || !files.includes(relative.slice(2))) throw new Error(`Missing packaged resource: ${relative}`);
}
mkdirSync(path.dirname(destination), { recursive: true });
rmSync(destination, { force: true });
execFileSync('zip', ['-X', '-q', destination, ...files], { cwd: root });
const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
console.log(JSON.stringify({ archive: destination, version: manifest.version, files, sha256 }, null, 2));
