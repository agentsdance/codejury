import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const packager = new URL('../scripts/package-plugin.mjs', import.meta.url);

test('plugin packager validates and passes forward-slash resource paths to ZIP on Windows', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'codejury-package-'));
  try {
    const destination = path.join(temporary, 'plugin.zip');
    // Isolate built-in mocks in a child and run the actual packaging entry point.
    // Windows joins drive the walker; filesystem reads use the host's separators.
    const script = `
      import assert from 'node:assert/strict';
      import childProcess from 'node:child_process';
      import fs from 'node:fs';
      import path from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';

      const nativeJoin = path.join;
      const nativeSeparator = path.sep;
      const nativeStat = fs.lstatSync;
      const destination = ${JSON.stringify(destination)};
      for (const method of ['readFileSync', 'readdirSync', 'lstatSync']) {
        const original = fs[method];
        fs[method] = (file, ...args) => original(
          typeof file === 'string' ? file.split('\\\\').join(nativeSeparator) : file,
          ...args,
        );
      }
      path.join = path.win32.join;
      path.sep = path.win32.sep;
      childProcess.execFileSync = (command, args, options) => {
        assert.equal(command, 'zip');
        assert.deepEqual(args.slice(0, 3), ['-X', '-q', destination]);
        assert.ok(args.length > 3);
        for (const entry of args.slice(3)) {
          assert.ok(!entry.includes('\\\\'), 'ZIP entry contains a backslash: ' + entry);
          assert.ok(nativeStat(nativeJoin(options.cwd, ...entry.split('/'))).isFile());
        }
        fs.writeFileSync(destination, 'ZIP fixture');
      };
      syncBuiltinESMExports();
      process.argv[2] = destination;
      await import(${JSON.stringify(packager.href)});
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.archive, destination);
    for (const resource of ['plugin.json', 'LICENSE', 'skills/codejury-setup/SKILL.md',
      'assets/logo.svg', 'assets/review-dashboard.png', 'scripts/jury.mjs']) {
      assert.ok(report.files.includes(resource), `Missing archive entry: ${resource}`);
    }
    assert.ok(report.files.every(entry => !entry.includes('\\')));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
