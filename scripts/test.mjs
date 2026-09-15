// Expand test files in JavaScript so Node 20 and newer receive identical paths.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { testEnvironment } from './test-environment.mjs';
const files = readdirSync('test').filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`);
const isolated = testEnvironment();
try {
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', env: isolated.env });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  isolated.dispose();
}
