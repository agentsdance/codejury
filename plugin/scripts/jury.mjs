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

function versionParts(version) {
  return typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
}

function checkForUpdate(currentVersion) {
  // The host runs `version` once before the operation and presents the choice
  // in chat. Never wait for terminal input or upgrade an existing CLI here.
  try {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'view', '@agentsdance/codejury@latest', 'version', '--json', '--prefer-online',
      '--fetch-retries=0', '--fetch-timeout=2000',
    ], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000,
      maxBuffer: 16 * 1024, shell: process.platform === 'win32',
    });
    if (result.error || result.status !== 0) throw new Error('Registry unavailable');
    const latestVersion = JSON.parse(result.stdout);
    const current = versionParts(currentVersion);
    const latest = versionParts(latestVersion);
    if (!current || !latest || latest[4]) throw new Error('Invalid stable version');
    const difference = [1, 2, 3].find(index => BigInt(latest[index]) !== BigInt(current[index]));
    const newer = difference ? BigInt(latest[difference]) > BigInt(current[difference]) : Boolean(current[4]);
    if (newer) {
      console.error(`CodeJury update available: ${currentVersion} -> ${latestVersion}`);
      console.error('Upgrade the global CLI? Ask the user before upgrading; they can keep the current version.');
      console.error(`To upgrade: npm install --global @agentsdance/codejury@${latestVersion}`);
    }
  } catch {
    console.error(`Update check unavailable; continuing with global CodeJury ${currentVersion}.`);
  }
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
if (['version', '--version', '-v'].includes(process.argv[2])) checkForUpdate(metadata.version);

// Import in this process so cancellation reaches the CLI and its agent cleanup.
process.argv = [process.execPath, entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
