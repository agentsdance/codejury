// Verify the distribution users actually install, not just source-tree imports.
import assert from 'node:assert/strict';
import { testEnvironment } from './test-environment.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = process.cwd();
const isolated = testEnvironment();
const temporary = mkdtempSync(path.join(tmpdir(), 'jury-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const exec = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: isolated.env, ...options });
try {
  const [packed] = JSON.parse(exec(npm, ['pack', '--json', '--pack-destination', temporary]));
  const files = packed.files.map(f => f.path);
  for (const required of ['bin/jury.js', 'lib/review-group.js', 'lib/agents/kimi-reviewer.md', 'web/index.html', 'jury.config.example.json', 'LICENSE', 'README.md', 'docs/usage.md', 'docs/console-demo.html']) assert.ok(files.includes(required), `missing ${required}`);
  assert.ok(!files.some(f => /(^|\/)(runs|node_modules|test|\.git)(\/|$)|(^|\/)\.(env|npmrc)$|(^|\/)jury\.config\.json$/.test(f)), 'private/development files in package');
  exec(npm, ['install', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, packed.filename)]);
  // Exercise npm-created executable links through PATH, as users invoke them.
  const bin = path.join(temporary, 'node_modules', '.bin');
  const installed = path.join(temporary, 'node_modules', '@agentsdance', 'codejury', 'bin', 'jury.js');
  const version = JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
  assert.equal(exec(process.execPath, [installed, 'version'], { cwd: temporary }).trim(), `jury ${version}`);
  for (const name of ['jury', 'codejury', 'cr']) {
    assert.equal(realpathSync(path.join(bin, name)), realpathSync(installed), `wrong npm bin target for ${name}`);
    assert.equal(exec(name, ['version'], { cwd: temporary, env: { ...isolated.env, PATH: `${bin}${path.delimiter}${isolated.env.PATH}` } }).trim(), `jury ${version}`);
  }
  const help = exec(process.execPath, [installed, 'help', 'review'], { cwd: temporary });
  assert.match(help, /--reviewer/);
  assert.match(help, /<pr-url-1> <pr-url-2>/);
  assert.match(help, /--push=false/);
  assert.match(exec(process.execPath, [installed, 'help', '--all'], { cwd: temporary }), /jury review <pr-url>/);
  // Full related-PR path: subprocess agents, real local remotes, fixes, resume, failures.
  exec(process.execPath, ['--test', 'test/cli-commands.test.js', 'test/global-judge.test.js', 'test/help.test.js', 'test/web-launch.test.js', 'test/review-group.test.js', 'test/reviewer-selection.test.js', 'test/automatic-roles.test.js', 'test/agy.test.js', 'test/opencode.test.js', 'test/new-agents.test.js', 'test/kimi.test.js'], {
    cwd: root, env: { ...isolated.env, JURY_TEST_CLI: installed }, maxBuffer: 8e6,
  });
  console.log(`Verified installed @agentsdance/codejury@${version}: ${files.length} files, CLI commands/subcommands, executable links, saved console, and related-PR fixes/push/resume/failure tests.`);
} finally {
  isolated.dispose();
  rmSync(temporary, { recursive: true, force: true });
}
