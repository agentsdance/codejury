import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL('../bin/jury.js', import.meta.url));
const root = path.dirname(path.dirname(cli));
const { DEFAULTS, loadConfig, judgeAgent } = await import(pathToFileURL(path.join(root, 'lib/config.js')));
const { runAgent } = await import(pathToFileURL(path.join(root, 'lib/agents.js')));
const cases = [
  {
    "name": "amp",
    "bin": "amp",
    "review": [
      "--no-notifications",
      "--no-ide",
      "--visibility",
      "private",
      "--execute=@prompt"
    ],
    "judge": [
      "--no-notifications",
      "--no-ide",
      "--visibility",
      "private",
      "--execute=@prompt"
    ]
  },
  {
    "name": "qwen",
    "bin": "qwen",
    "review": [
      "--approval-mode",
      "default",
      "--output-format",
      "json",
      "--exclude-tools",
      "Edit",
      "Write",
      "NotebookEdit",
      "Task",
      "--allowed-tools",
      "Bash(git diff *)",
      "Bash(git status*)",
      "Bash(git show *)",
      "Bash(git merge-base *)",
      "Bash(git log *)",
      "Bash(git rev-parse *)",
      "--session-id",
      "@session",
      "--prompt=@prompt"
    ],
    "judge": [
      "--approval-mode",
      "yolo",
      "--output-format",
      "json",
      "--prompt=@prompt"
    ],
    "resume": true,
    "output": "[{\"type\": \"result\", \"subtype\": \"success\", \"is_error\": false, \"result\": \"NO NEW FINDINGS\"}]"
  },
  {
    "name": "copilot",
    "bin": "copilot",
    "review": [
      "-p",
      "@prompt",
      "--silent",
      "--add-dir",
      "@cwd",
      "--deny-tool",
      "write",
      "--allow-tool",
      "read",
      "--allow-tool",
      "shell(git diff)",
      "--allow-tool",
      "shell(git status)",
      "--allow-tool",
      "shell(git show)",
      "--allow-tool",
      "shell(git merge-base)",
      "--allow-tool",
      "shell(git log)",
      "--allow-tool",
      "shell(git rev-parse)"
    ],
    "judge": [
      "-p",
      "@prompt",
      "--silent",
      "--add-dir",
      "@cwd",
      "--allow-all-tools"
    ]
  },
  {
    "name": "cursor",
    "bin": "cursor-agent",
    "review": [
      "-p",
      "--output-format",
      "json",
      "--",
      "@prompt"
    ],
    "judge": [
      "-p",
      "--output-format",
      "json",
      "--force",
      "--",
      "@prompt"
    ],
    "output": "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"NO NEW FINDINGS\"}"
  },
  {
    "name": "kimi",
    "bin": "kimi",
    "review": [
      "--quiet",
      "--work-dir",
      "@cwd",
      "--prompt",
      "@prompt"
    ],
    "judge": [
      "--quiet",
      "--work-dir",
      "@cwd",
      "--prompt",
      "@prompt"
    ]
  }
];

for (const spec of cases) test(`${spec.name}: installed discovery, literal invocation, roles, selection, and failures`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), `jury-${spec.name}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, 'work tree'); const bin = path.join(dir, 'bin');
  await mkdir(worktree); await mkdir(bin);
  const exe = path.join(bin, spec.bin);
  const clean = `const fs=require('node:fs');fs.writeFileSync('call.json',JSON.stringify({cwd:process.cwd(),pwd:process.env.PWD,args:process.argv.slice(2)}));console.log(${JSON.stringify(spec.output ?? 'NO NEW FINDINGS')});`;
  const script = body => writeFile(exe, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  await script(clean);
  const cfg = await loadConfig(worktree, { globalFile: path.join(dir, 'absent') });
  const agent = (cfg.available ?? cfg.agents).find(a => a.name === spec.name);
  const prompt = '--literal "quotes"; $(touch unwanted)\nReview only.';
  const invoke = a => runAgent({ ...a, argv: [exe, ...a.argv.slice(1)] }, { worktree, prompt, stopToken: 'NO NEW FINDINGS', timeoutSeconds: 5 });
  for (const [role, a] of [['review', agent], ['judge', judgeAgent(cfg, spec.name)]]) {
    const result = await invoke(a); assert.equal(result.verdict, 'clean');
    const call = JSON.parse(await readFile(path.join(worktree, 'call.json')));
    assert.equal(call.cwd, await realpath(worktree));
    assert.equal(call.pwd,worktree);
    assert.deepEqual(call.args, spec[role].map(v => v.replace('@cwd',worktree).replace('@prompt',()=>prompt).replace('@session',result.sessionId)));
  }
  assert.equal(agent.resume.supported, spec.resume ?? false);
  if (spec.resume) {
    const {replyArgv}=await import(pathToFileURL(path.join(root,'lib/reply.js')));
    const first=await invoke(agent); const second=await invoke(agent);
    assert.match(first.sessionId,/^[0-9a-f-]{36}$/); assert.notEqual(first.sessionId,second.sessionId);
    const reply=replyArgv(agent,{promptText:prompt,worktree,sessionId:first.sessionId});
    assert.equal(reply.resumed,true);assert.equal(reply.argv[reply.argv.indexOf('--resume')+1],first.sessionId);
    assert.equal(replyArgv(agent,{promptText:prompt,worktree}).resumed,false);
  }
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const command = args => spawnSync(process.execPath, [cli, ...args], { cwd: worktree, env, encoding: 'utf8', timeout: 15000 });
  assert.match(command(['agents']).stdout, new RegExp(`ok\\s+${spec.name}\\s+reviewer`));
  assert.equal(command(['agents', 'judge', spec.name]).status, 0);
  assert.equal(JSON.parse(await readFile(path.join(dir, '.jury/config.json'))).judge, spec.name);
  assert.equal(command(['agents', 'judge', '--reset']).status, 0);
  await writeFile(path.join(worktree,'jury.config.json'),JSON.stringify({agents:[{name:spec.name,role:'main'}]}));
  assert.equal((await loadConfig(worktree,{globalFile:path.join(dir,'absent')})).main?.name,spec.name);
  await rm(path.join(worktree,'jury.config.json'));
  const git = args => execFileSync('git', args, { cwd: worktree, env, stdio: 'ignore' });
  git(['init', '-q', '-b', 'master']); git(['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','--allow-empty','-qm','base']);git(['checkout','-qb','feature']);
  // Keep one mock judge and this actual built-in registry entry. Never launch another installed agent.
  await writeFile(path.join(worktree,'jury.config.json'),JSON.stringify({agents:[...DEFAULTS.agents.filter(a=>a.name!==spec.name).map(({name})=>({name,enabled:false})),{name:'fixture-judge',role:'main',argv:[process.execPath,'-e',"console.log('NO NEW FINDINGS')"]}]}));
  for (const flag of ['--reviewer','--jury']) {
    const r=command(['review','--dir',worktree,'--trunk','master','--web=false','--push=false','--rounds','1',flag,spec.name]);
    assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/REVIEW COMPLETE/);
    const self=command(['review','--dir',worktree,'--trunk','master','--web=false','--push=false','--judge',spec.name,flag,spec.name]);
    assert.notEqual(self.status,0);assert.match(self.stderr,/selected judge and cannot review its own work/);
  }
  await script(clean+'process.exit(2);'); const failed = await invoke(agent); assert.equal(failed.ok,false); assert.equal(failed.verdict,'error'); assert.match(failed.report,/exited 2/);
  await script('setInterval(()=>{},1000);');
  const timed=await runAgent({...agent,argv:[exe]},{worktree,prompt,stopToken:'NO NEW FINDINGS',timeoutSeconds:0.3});
  assert.equal(timed.verdict,'error');assert.match(timed.report,/timed out/);
  await rm(exe); assert.equal((await invoke(agent)).verdict,'error');
});
