import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL('../bin/jury.js', import.meta.url));
const root = path.dirname(path.dirname(cli));
const { usageDecoder, usageFromEvents, summarizeUsage } = await import(pathToFileURL(path.join(root, 'lib/usage.js')));
const { runAgent } = await import(pathToFileURL(path.join(root, 'lib/agents.js')));
const { readEvents, readRun } = await import(pathToFileURL(path.join(root, 'lib/store.js')));
const codex = { name: 'codex', report: 'codex-json' };
const complete = (input=100, output=20) => ({ type: 'turn.completed', usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 80, cache_write_input_tokens: 10 } });
const lines = events => events.map(e=>JSON.stringify(e)).join('\n')+'\n';
async function scratch(t) {
  const dir = await mkdtemp(path.join(tmpdir(),'jury-usage-'));
  t.after(()=>rm(dir,{recursive:true,force:true})); return dir;
}

test('usage decodes envelopes, splits chunks, replaces duplicates and counts cache only once', () => {
  const d = usageDecoder({...codex, model:'configured'});
  const text = lines([{type:'turn.started'}, {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(complete(9999))}},
    {...complete(), model:'actual'}, {...complete(), model:'actual'}]);
  for (let n=0;n<text.length;n+=7) d.feed(text.slice(n,n+7));
  const r = d.finish();
  assert.equal(r.length,1);
  assert.deepEqual(r[0],{model:'actual',modelSource:'reported',input:100,output:20,total:120,cacheRead:80,cacheWrite:10});
  d.feed(lines([{type:'turn.started'},complete(30,5)]));
  assert.equal(d.finish().length,2);
  const aggregate = summarizeUsage([{agent:'codex',round:1,action:'review',status:'completed',records:d.snapshot()}]);
  assert.equal(aggregate.total,155);
});

test('Droid cache is additional, Qwen cache is included, OpenCode separates reasoning', () => {
  const usage = {input_tokens:100,output_tokens:20,cache_read_input_tokens:80,cache_creation_input_tokens:10};
  for (const [name,total] of [['droid',210],['qwen',120]]) {
    const d = usageDecoder({name,report:'result-json',model:'chosen'});
    d.feed(JSON.stringify({type:'result',subtype:'error',usage},null,2));
    assert.equal(d.finish()[0].total,total);
    assert.equal(d.snapshot()[0].modelSource,'configured');
  }
  const d=usageDecoder({name:'opencode',report:'opencode-json'});
  const step={type:'step_finish',part:{id:'step1',messageID:'m1',tokens:{input:10,output:5,reasoning:15,cache:{read:70,write:20}}}};
  d.feed(lines([step,step,{...step,part:{...step.part,id:'step2'}}]));
  assert.equal(d.finish().length,2);
  assert.equal(d.snapshot()[0].total,120);
  assert.equal(d.snapshot()[0].output,20);
});

test('missing and invalid counts stay unavailable; aggregates retain available totals as partial', () => {
  const d=usageDecoder(codex);
  d.feed(lines([{type:'turn.completed',usage:{input_tokens:-1,output_tokens:'20'}}]));
  assert.deepEqual(d.finish(),[]);
  const unavailable={agent:'claude',action:'review',round:1,status:'completed',records:[]};
  assert.equal(summarizeUsage([unavailable]).total,null);
  const partial=usageDecoder(codex); partial.feed(lines([{type:'turn.completed',usage:{input_tokens:10}}]));
  const a=summarizeUsage([{agent:'codex',action:'fix',round:1,status:'failed',records:partial.finish()},unavailable]);
  assert.equal(a.input,10); assert.equal(a.total,null); assert.equal(a.partial,true);
  assert.equal(a.models[0].modelSource,'unavailable');
  assert.equal(a.rounds[0].fix.input,10);
});

test('failed invocations retain usage and retries have unique IDs', async t => {
  const dir=await scratch(t);
  for (let n=0;n<2;n++) {
    const result=await runAgent({...codex,argv:[process.execPath,'-e',`console.log(${JSON.stringify(lines([complete()]))});process.exit(1)`]},
      {worktree:dir,prompt:'review',stopToken:'NO NEW FINDINGS',usageContext:{dir,round:1,action:'review'}});
    assert.equal(result.ok,false);
  }
  const usage=usageFromEvents(await readEvents(dir));
  assert.equal(usage.invocations.length,2);
  assert.equal(usage.total,240);
  assert.equal(usage.partial,true);
  assert.ok(usage.invocations.every(i=>i.status==='failed'));
});

test('SIGTERM preserves streamed usage and saved-run reads recover it after the last publication', {skip:process.platform==='win32',timeout:15000}, async t => {
  const dir=await scratch(t);
  await writeFile(path.join(dir,'run.json'),JSON.stringify({target:{},rounds:[]}));
  const script=`import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
await runAgent(${JSON.stringify({...codex,argv:[process.execPath,'-e',`console.log(${JSON.stringify(lines([complete(),{type:'item.completed',item:{type:'agent_message',text:'ready'}}]))});setInterval(()=>{},1000)`]})},
 {worktree:${JSON.stringify(dir)},prompt:'review',stopToken:'NO NEW FINDINGS',usageContext:{dir:${JSON.stringify(dir)},round:2,action:'fix'},onChunk:()=>console.log('ready')});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null) child.kill('SIGKILL')});
  const exited=once(child,'exit');
  await once(child.stdout,'data');
  child.kill('SIGTERM'); await exited;
  const run=await readRun(dir);
  assert.equal(run.usage.total,120);
  assert.equal(run.usage.invocations[0].status,'interrupted');
  assert.equal(run.usage.partial,true);
});

test('installed CLI persists review, fix, reply, multiple rounds and resume with reconciled totals', async t => {
  const dir=await scratch(t), repo=path.join(dir,'repo'), bin=path.join(dir,'bin');
  await mkdir(repo); await mkdir(bin);
  const script=`#!${process.execPath}
const fs=require('node:fs');
const prompt=process.argv.at(-1);
const judge=prompt.includes('A code reviewer raised this finding');
const reply=prompt.startsWith('Thanks —');
let report, tokens;
if(judge){fs.writeFileSync('a.txt','fixed\\n');tokens=200;report=JSON.stringify({verdict:'accepted',reproduced:'wrong value in a.txt',test:'fixture checked before and after',reason:'fixed a.txt'});}
else if(reply){tokens=300;report='The fix is ready for another review round.';}
else {tokens=100;report=fs.readFileSync('a.txt','utf8').includes('fixed')?'NO NEW FINDINGS':'FINDING: incorrect value\\nWHERE: a.txt:1\\nThe value is wrong.';}
for(const event of [{type:'thread.started',thread_id:judge?'judge-session':'review-session'},{type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',text:report}},
{type:'turn.completed',usage:{input_tokens:tokens,output_tokens:10,cached_input_tokens:50}}])console.log(JSON.stringify(event));
`;
  await writeFile(path.join(bin,'codex'),script,{mode:0o755});
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,HOME:dir,USERPROFILE:dir};
  const git=(...args)=>exec('git',['-C',repo,...args],{env});
  await git('init','-q','-b','master'); await git('config','user.email','test@example.com'); await git('config','user.name','Test');
  await writeFile(path.join(repo,'a.txt'),'base\n'); await writeFile(path.join(repo,'.gitignore'),'runs/\n');
  await git('add','.'); await git('commit','-qm','base'); await git('update-ref','refs/remotes/origin/master','HEAD');
  await git('checkout','-qb','feature'); await writeFile(path.join(repo,'a.txt'),'wrong\n'); await git('commit','-qam','change');
  const args=['review','--dir',repo,'--trunk','master','--reviewer','codex','--judge','codex','--rounds','2','--web=false','--push=false','--model','codex=fixture'];
  const result=await exec(process.execPath,[cli,...args],{cwd:repo,env});
  assert.match(result.stdout,/Token usage: 740 total/);
  assert.match(result.stdout,/round 1 fix/);
  const [slug]=await readdir(path.join(repo,'runs'));
  let run=JSON.parse(await readFile(path.join(repo,'runs',slug,'run.json')));
  assert.deepEqual(run.usage.invocations.map(i=>i.action),['review','fix','reply','review']);
  assert.equal(run.usage.total,740); assert.equal(run.usage.models[0].total,740);
  assert.equal(run.usage.rounds.reduce((n,r)=>n+r.total,0),740);
  assert.equal(run.usage.rounds[0].fix.total,210);
  assert.equal(run.usage.models[0].modelSource,'configured');
  await exec(process.execPath,[cli,...args,'--resume',slug],{cwd:repo,env});
  run=JSON.parse(await readFile(path.join(repo,'runs',slug,'run.json')));
  assert.equal(run.usage.total,850); assert.equal(run.usage.invocations.length,5);
});
