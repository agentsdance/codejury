// Serve the files from a fresh installed tarball, never the source checkout.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testEnvironment } from './test-environment.mjs';
const temporary = mkdtempSync(path.join(tmpdir(), 'jury-browser-package-'));
const isolated = testEnvironment();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const exec = args => execFileSync(npm, args, { encoding: 'utf8', env: isolated.env });
try {
  const [packed] = JSON.parse(exec(['pack', '--json', '--pack-destination', temporary]));
  exec(['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename)]);
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env,
      JURY_BROWSER_PACKAGE_ROOT: path.join(temporary, 'node_modules', '@agentsdance', 'codejury') },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  isolated.dispose();
  rmSync(temporary, { recursive: true, force: true });
}
