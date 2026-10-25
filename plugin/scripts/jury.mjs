// Both plugins use npm's global CodeJury installation. Keep the two shipped runners in sync.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 10)) throw new Error('CodeJury requires Node.js 20.10+.');

function npm(args, capture = false) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ${args.join(' ')} failed (${result.error?.message ?? result.status ?? result.signal}). Fix npm's global installation and retry.`, { cause: result.error });
  }
  return capture ? result.stdout.trim() : undefined;
}

const globalRoot = npm(['root', '--global'], true);
if (!path.isAbsolute(globalRoot)) throw new Error('npm did not return an absolute global package directory.');
const packageRoot = path.join(globalRoot, '@agentsdance', 'codejury');
const entry = path.join(packageRoot, 'bin', 'jury.js');
function installed() {
  try {
    const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return metadata.name === '@agentsdance/codejury' && existsSync(entry) ? metadata : null;
  } catch { return null; }
}

let metadata = installed();
if (!metadata) {
  console.error('Installing CodeJury globally with npm.');
  npm(['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '@agentsdance/codejury@latest']);
  metadata = installed();
}
if (!metadata) throw new Error(`Global CodeJury installation is incomplete at ${packageRoot}. Run npm install --global @agentsdance/codejury@latest and retry.`);
console.error(`Using global CodeJury ${metadata.version} at ${entry}`);

// Import in this process so cancellation reaches the CLI and its agent cleanup.
process.argv = [process.execPath, entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
