// Expand test files in JavaScript so Node 20 and newer receive identical paths.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('test').filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
