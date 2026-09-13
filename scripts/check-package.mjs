// Verify the distribution users actually install, not just source-tree imports.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = process.cwd();
const temporary = mkdtempSync(path.join(tmpdir(), 'jury-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const exec = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
try {
  const [packed] = JSON.parse(exec(npm, ['pack', '--json', '--pack-destination', temporary]));
  const files = packed.files.map(f => f.path);
  for (const required of ['bin/jury.js', 'lib/review-group.js', 'web/index.html', 'jury.config.example.json', 'LICENSE', 'README.md', 'docs/usage.md', 'docs/console-demo.html']) assert.ok(files.includes(required), `missing ${required}`);
  assert.ok(!files.some(f => /(^|\/)(runs|node_modules|test|\.git)(\/|$)|(^|\/)\.(env|npmrc)$|(^|\/)jury\.config\.json$/.test(f)), 'private/development files in package');
  exec(npm, ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename)]);
  const installed = path.join(temporary, 'node_modules', '@agentsdance', 'codejury', 'bin', 'jury.js');
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
  assert.equal(exec(process.execPath, [installed, 'version'], { cwd: temporary }).trim(), `jury ${version}`);
  const help = exec(process.execPath, [installed, 'help', 'review'], { cwd: temporary });
  assert.match(help, /--reviewer/);
  assert.match(help, /<pr-url-1> <pr-url-2>/);
  assert.match(help, /--push=false/);
  // Full related-PR path: subprocess agents, real local remotes, fixes, resume, failures.
  exec(process.execPath, ['--test', 'test/review-group.test.js'], {
    cwd: root, env: { ...process.env, JURY_TEST_CLI: installed }, maxBuffer: 8e6,
  });
  console.log(`Verified installed @agentsdance/codejury@${version}: ${files.length} files, command help, related-PR fixes/push/resume/failure tests.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
