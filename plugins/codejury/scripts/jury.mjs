// Reuse an installed CodeJury CLI, or download the fallback release.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const version = '0.9.0';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 10)) throw new Error('CodeJury requires Node.js 20.10+.');

function installedCli() {
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const command of ['jury', 'codejury']) {
      const executable = path.resolve(directory, command + (process.platform === 'win32' ? '.cmd' : ''));
      try {
        accessSync(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        const target = realpathSync(executable);
        // npm uses symlinks on POSIX and .cmd shims beside node_modules on Windows.
        const packageRoot = process.platform === 'win32'
          ? path.join(directory, 'node_modules', '@agentsdance', 'codejury')
          : path.dirname(path.dirname(target));
        const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
        const entry = realpathSync(path.join(packageRoot, 'bin', 'jury.js'));
        if (metadata.name === '@agentsdance/codejury' &&
            (process.platform === 'win32' || entry === target)) return entry;
      } catch { /* No usable CodeJury package behind this executable. */ }
    }
  }
  return null;
}

function cachedCli() {
  const cache = path.resolve(process.env.CODEJURY_PLUGIN_CACHE || path.join(homedir(), '.cache', 'codejury', 'plugin-cli'));
  const install = path.join(cache, version);
  const packageRoot = path.join(install, 'node_modules', '@agentsdance', 'codejury');
  const entry = path.join(packageRoot, 'bin', 'jury.js');
  function installed() {
    try {
      const metadata = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
      return metadata.name === '@agentsdance/codejury' && metadata.version === version && existsSync(entry);
    } catch { return false; }
  }
  let ready = installed();
  if (!ready && existsSync(install)) {
    // A concurrent launcher may have published a complete cache after our miss.
    ready = installed();
    if (!ready) throw new Error(`Incomplete CLI cache at ${install}; move it aside and retry.`);
  }
  if (!ready) {
    mkdirSync(cache, { recursive: true });
    const staging = mkdtempSync(path.join(cache, '.install-'));
    try {
      console.error(`Downloading CodeJury ${version} from npm into ${cache}`);
      // cwd is the staging directory; keep cache paths out of the Windows shell command.
      const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
        'install', '--prefix', '.', '--no-save', '--package-lock=false',
        '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org',
        `@agentsdance/codejury@${version}`,
      ], { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32' });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`npm installation failed (${result.status ?? result.signal}).`);
      try { renameSync(staging, install); }
      catch (error) { if (!installed()) throw error; } // Another concurrent invocation may have installed it.
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  if (!installed()) throw new Error(`Expected CodeJury ${version} at ${install}.`);
  return entry;
}

const entry = installedCli() || cachedCli();
// Import in this process so cancellation reaches the CLI and its agent cleanup.
process.argv = [process.execPath, entry, ...process.argv.slice(2)];
await import(pathToFileURL(entry).href);
