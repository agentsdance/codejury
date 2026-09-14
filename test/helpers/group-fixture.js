import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

export async function groupFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "jury-related-"));
  if (!process.env.JURY_KEEP_FIXTURE) t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"); await mkdir(bin);
  const receipt = path.join(root, "agents.jsonl");
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com",
    JURY_FIXTURE: root };
  const git = async (cwd, ...args) => (await exec("git", args, { cwd, env })).stdout.trim();
  const agent = path.join(root, "agent.cjs");
  await writeFile(agent, `const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process'), assert=require('node:assert/strict');
const role=process.argv[2], prompt=process.argv[3], cwd=process.cwd();
assert.ok(prompt.includes('ONE coordinated change'));
assert.ok(prompt.includes('API description') && prompt.includes('Client description'));
assert.ok(prompt.includes('origin/main') && prompt.includes('origin/stable'));
const dirs=['PR1','PR2'].map(p=>path.join(cwd,p));
const values=dirs.map(p=>fs.readFileSync(path.join(p,'contract.txt'),'utf8').trim());
const heads=dirs.map(p=>cp.execFileSync('git',['rev-parse','HEAD'],{cwd:p,encoding:'utf8'}).trim());
const diffs=dirs.map((p,i)=>{const base=cp.execFileSync('git',['merge-base','HEAD','origin/'+['main','stable'][i]],{cwd:p,encoding:'utf8'}).trim();return cp.execFileSync('git',['diff',base,'HEAD'],{cwd:p,encoding:'utf8'});});
fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({role,prompt,heads,values,diffs,cwd})+'\\n');
if(process.env.JURY_FIXTURE_FAIL===role || (process.env.JURY_FIXTURE_FAIL_REPLY===role && values.every(v=>v==='v3'))){console.error('fixture reviewer failure');process.exit(1);}
if(role==='judge'){
 if(values.every(v=>v==='v3')) {console.log(JSON.stringify({verdict:'rejected',reason:'Already fixed in this round'}));process.exit(0);}
 for(const p of dirs){
  fs.writeFileSync(path.join(p,'contract.test.cjs'),"require('node:assert/strict').equal(require('node:fs').readFileSync('contract.txt','utf8').trim(),'v3');\\n");
  assert.notEqual(cp.spawnSync(process.execPath,['contract.test.cjs'],{cwd:p}).status,0);
  fs.writeFileSync(path.join(p,'contract.txt'),'v3\\n');
  assert.equal(cp.spawnSync(process.execPath,['contract.test.cjs'],{cwd:p}).status,0);
 }
 console.log(JSON.stringify({verdict:'accepted',reproduced:'Both contract tests failed before correction',test:'contract.test.cjs in each PR fails before the fix and passes after',reason:'Fixed both PR contracts'}));
}else if(values.every(v=>v==='v3')) console.log('NO NEW FINDINGS');
else console.log('FINDING: Related API contracts disagree\\nWHERE: '+(process.env.JURY_BAD_LOCATION?'contract.txt:1':'PR1/contract.txt:1')+'\\nPR1 and PR2 must agree on the contract.');
`);
  const agents = ["claude", "grok", "droid", "agy"].map(name => ({ name, enabled: false }));
  agents.push({ name: "codex", role: "main", cwd: "worktree", argv: [process.execPath, agent, "judge", "{{promptText}}"], report: "whole" });
  for (const name of ["alpha", "beta"]) agents.push({ name, role: "reviewer", cwd: "worktree", argv: [process.execPath, agent, name, "{{promptText}}"], report: "whole" });
  const members = [];
  for (const [i, name] of ["api", "client"].entries()) {
    const repo = path.join(root, name); await mkdir(repo);
    const base = i ? "stable" : "main", branch = `${name}-change`;
    await git(repo, "init", "-q", "-b", base);
    await writeFile(path.join(repo, "contract.txt"), "base\n");
    await writeFile(path.join(repo, "jury.config.json"), JSON.stringify({ agents }));
    await git(repo, "add", "."); await git(repo, "commit", "-qm", "base");
    const baseSha = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "-qb", branch);
    await writeFile(path.join(repo, "contract.txt"), `v${i + 1}\n`);
    await git(repo, "commit", "-qam", "change");
    const sha = await git(repo, "rev-parse", "HEAD");
    const remote = path.join(root, `${name}.git`);
    await git(root, "clone", "--bare", "-q", repo, remote);
    await git(remote, "symbolic-ref", "HEAD", `refs/heads/${base}`);
    await git(remote, "update-ref", "refs/pull/7/head", sha);
    members.push({ name, remote, repo, base, branch, baseSha, sha, url: `https://github.com/fixture/${name}/pull/7` });
  }
  await writeFile(path.join(root, "members.json"), JSON.stringify(members));
  await writeFile(path.join(bin, "gh"), `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const all=JSON.parse(fs.readFileSync(path.join(process.env.JURY_FIXTURE,'members.json')));
const a=process.argv.slice(2);
if(a[0]==='pr'&&a[1]==='view'){
 const m=all.find(m=>m.url===a[2]);
 if(!m||process.env.JURY_FIXTURE_MISSING===m.name){console.error('fixture missing PR');process.exit(1);}
 console.log(JSON.stringify({title:m.name+' changes',body:m.name==='api'?'API description':'Client description',state:'OPEN',baseRefName:m.base,headRefName:m.branch,headRefOid:m.sha,headRepository:{nameWithOwner:'fixture/'+m.name}}));
}else if(a[0]==='repo'&&a[1]==='clone'){
 const m=all.find(m=>a[2].endsWith('fixture/'+m.name));
 cp.execFileSync('git',['clone','--quiet',m.remote,a[3]]);
}else {console.error('unexpected gh command',a);process.exit(1);}
`, { mode: 0o755 });
  const state = path.join(root, "state"); await mkdir(state);
  const cli = process.env.JURY_TEST_CLI ?? new URL("../../bin/jury.js", import.meta.url).pathname;
  const review = async (args = [], extraEnv = {}) => {
    try {
      const result = await exec(process.execPath, [cli, "review", ...members.map(m => m.url),
        "--dir", state, "--web=false", "--rounds", "3", ...args], { cwd: root, env: { ...env, ...extraEnv }, maxBuffer: 4e6 });
      return { ...result, code: 0 };
    } catch (error) { return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code }; }
  };
  const saved = async () => {
    const slugs = await readdir(path.join(state, "runs"));
    const slug = slugs.at(-1);
    const dir = path.join(state, "runs", slug);
    return { slug, dir, run: JSON.parse(await readFile(path.join(dir, "run.json"))) };
  };
  return { root, state, bin, env, members, git, review, saved,
    receipts: async () => (await readFile(receipt, "utf8")).trim().split("\n").map(JSON.parse) };
}
