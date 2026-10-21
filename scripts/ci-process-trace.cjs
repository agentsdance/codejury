// Loaded only by ci-check.mjs. Do not record argv, environment values or paths.
const { appendFileSync } = require('node:fs');
const path = require('node:path');
const file = process.env.JURY_CI_TRACE;
const entry = path.basename(process.argv[1] || '');
const role = process.execArgv.includes('--test') ? 'test-runner'
  : path.basename(path.dirname(process.argv[1] || '')) === 'test'
  && /^[a-z0-9-]+\.test\.js$/.test(entry) ? entry
  : ['jury.js', 'test.mjs', 'check-package.mjs'].includes(entry) ? entry : 'node';
function record(event, extra = {}) {
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(),
      pid: process.pid, ppid: process.ppid, role, event, ...extra }) + '\n');
  } catch {} // Diagnostics must not change fixture behavior.
}
record('start');
setInterval(() => record('alive', { resources: process.getActiveResourcesInfo() }), 10000).unref();
process.on('exit', code => record('end', { code }));
