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
const { readEvents, readRun, publishEvents } = await import(pathToFileURL(path.join(root, 'lib/store.js')));
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
  d.feed(lines([{type:'turn.started'},complete(130,25),complete(130,25)]));
  assert.equal(d.finish().length,2);
  assert.equal(d.snapshot()[1].total,35);
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

test('Qwen preserves reported totals and includes separately counted thinking in saved output', async t => {
  const dir = await scratch(t), logs = [];
  const response = JSON.stringify([
    {type:'system',model:'qwen-fixture'},
    {type:'result',subtype:'success',is_error:false,result:'NO NEW FINDINGS',
      usage:{input_tokens:100,output_tokens:20,total_tokens:180,cache_read_input_tokens:80}},
  ]);
  const result = await runAgent({name:'qwen',report:'result-json',
    argv:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(response)})`]},
    {worktree:dir,prompt:'review',stopToken:'NO NEW FINDINGS',
      usageContext:{dir,round:1,action:'review'},onLog:line=>logs.push(line)});
  assert.equal(result.ok,true);
  await publishEvents(dir);
  const {usage} = JSON.parse(await readFile(path.join(dir,'run.json'),'utf8'));
  assert.equal(usage.total,180, 'Qwen total includes thinking absent from candidate output');
  for (const row of [usage,usage.invocations[0],usage.rounds[0],usage.rounds[0].review,usage.models[0]]) {
    assert.equal(row.input,100);
    assert.equal(row.output,80);
    assert.equal(row.total,180);
    assert.equal(row.cacheRead,80);
    assert.equal(row.partial,false);
  }
  assert.equal(usage.models[0].model,'qwen-fixture');
  assert.match(logs.join('\n'),/tokens · 180 total · 100 input · 80 output/);
});

test('Qwen falls back for absent or invalid totals and preserves totals with incomplete breakdowns', () => {
  const decode = usage => {
    const d = usageDecoder({name:'qwen',report:'result-json'});
    d.feed(JSON.stringify({type:'result',usage}));
    return summarizeUsage([{agent:'qwen',round:1,action:'review',status:'completed',records:d.finish()}]);
  };
  for (const total_tokens of [undefined,null,-1,'180',1.5]) {
    const usage = decode({input_tokens:100,output_tokens:20,total_tokens});
    assert.equal(usage.total,120);
    assert.equal(usage.output,20);
  }
  const zero = decode({input_tokens:0,output_tokens:0,total_tokens:0});
  assert.equal(zero.total,0);
  assert.equal(zero.output,0);
  for (const fields of [{},{input_tokens:100},{output_tokens:20}]) {
    const usage = decode({...fields,total_tokens:180});
    assert.equal(usage.total,180);
    assert.equal(usage.input,fields.input_tokens??null);
    assert.equal(usage.output,fields.output_tokens??null);
    assert.equal(usage.partial,true);
  }
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

test('resuming an older run keeps unrecorded reviews unavailable and combined usage partial', async t => {
  const dir = await scratch(t);
  const old = [{t:'round.start',n:1},
    {t:'agent.launch',agent:'codex',round:1},
    {t:'agent.report',agent:'codex',round:1,verdict:'clean'}];
  await writeFile(path.join(dir,'events.ndjson'),lines(old));
  // The saved snapshot predates usage tracking; a resumed run adds new events.
  await writeFile(path.join(dir,'run.json'),JSON.stringify({target:{},rounds:[{n:1}]}));
  const current = [{t:'round.start',n:2}, {t:'agent.launch',agent:'codex',round:2},
    {t:'usage.snapshot',id:'new-review',agent:'codex',round:2,action:'review',status:'completed',
      records:[{model:'fixture',modelSource:'configured',input:100,output:20,total:120,cacheRead:80,cacheWrite:null}]},
    {t:'agent.report',agent:'codex',round:2,verdict:'clean'}];
  await writeFile(path.join(dir,'events.ndjson'),lines([...old,...current]));
  const recovered = await readRun(dir);
  await publishEvents(dir);
  const published = JSON.parse(await readFile(path.join(dir,'run.json'),'utf8'));
  for (const {usage} of [recovered,published]) {
    assert.equal(usage.partial,true, 'new usage cannot make unmeasured older work complete');
    assert.equal(usage.total,120);
    assert.deepEqual(usage.rounds.map(r=>r.round),[1,2]);
    assert.equal(usage.invocations.length,2);
    assert.equal(usage.invocations[0].total,null);
    assert.equal(usage.invocations[0].partial,true);
    assert.equal(usage.rounds[0].review.total,null);
    assert.equal(usage.rounds[0].partial,true);
    assert.equal(usage.rounds[1].total,120);
    assert.equal(usage.rounds[1].partial,false);
  }
});

test('legacy attempts stay unavailable beside tracked retries and replies in the same round', () => {
  const record = {model:null,modelSource:'unavailable',input:100,output:20,total:120,cacheRead:null,cacheWrite:null};
  const review = {t:'usage.snapshot',id:'retry',agent:'codex',round:1,action:'review',status:'completed',records:[record]};
  const reply = {...review,id:'reply',action:'reply'};
  const events = [{t:'round.start',n:1},
    {t:'agent.launch',agent:'codex',round:1}, // interrupted older launch, no report
    {t:'agent.launch',agent:'codex',round:1},review,review,
    {t:'agent.report',agent:'codex',round:1,verdict:'clean'},
    {t:'reply.sent',agent:'codex',replyId:'old'},
    {t:'reply.answered',agent:'codex',replyId:'old',verdict:'clean'},
    {t:'reply.sent',agent:'codex',replyId:'new'},reply,reply,
    {t:'reply.answered',agent:'codex',replyId:'new',verdict:'clean'}];
  const usage = usageFromEvents(events);
  assert.equal(usage.partial,true);
  assert.deepEqual(usage.invocations.map(i=>i.total),[null,120,null,120]);
  assert.equal(usage.total,240);
  assert.equal(usage.rounds[0].review.partial,true);
  assert.equal(usage.rounds[0].reply.partial,true);
  assert.equal(usage.models[0].partial,true);
  // A report can survive in an older log without its corresponding launch.
  const reports = usageFromEvents([{t:'agent.report',agent:'codex',round:1,verdict:'error'},review]);
  assert.deepEqual(reports.invocations.map(i=>i.total),[null,120]);
  assert.equal(reports.partial,true);
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

test('Codex resumes subtract persisted thread usage across replies and repeated judge turns', async t => {
  const dir = await scratch(t);
  const invoke = async (session, action, input, output, cacheRead, cacheWrite, failed = false) => {
    const events = lines([{type:'thread.started',thread_id:session}, {type:'turn.started'},
      {type:'item.completed',item:{type:'agent_message',text:'NO NEW FINDINGS'}},
      {type:'turn.completed',usage:{input_tokens:input,output_tokens:output,
        cached_input_tokens:cacheRead,cache_write_input_tokens:cacheWrite}}]);
    // Each invocation starts a new Jury process, as a later `jury reply` does.
    const script = `import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
await runAgent(${JSON.stringify({...codex,argv:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(events)});process.exit(${failed ? 1 : 0})`]})},
 {worktree:${JSON.stringify(dir)},prompt:'review',stopToken:'NO NEW FINDINGS',onLog:console.log,
 usageContext:${JSON.stringify({dir,round:1,action})}});`;
    return exec(process.execPath, ['--input-type=module','-e',script]);
  };
  await invoke('review-session','review',100,20,80,10);
  const reply = await invoke('review-session','reply',140,30,100,15);
  let usage = usageFromEvents(await readEvents(dir));
  assert.equal(usage.total,170, '120 then 170 cumulative must total 170, not 290');
  assert.match(reply.stdout,/tokens · 50 total · 40 input · 10 output/);
  assert.equal(usage.invocations[1].cacheRead,20);
  assert.equal(usage.invocations[1].cacheWrite,5);

  await invoke('judge-session','fix',100,20,80,10);
  await invoke('judge-session','fix',140,30,100,15,true);
  await invoke('review-session','reply',200,40,120,20);
  await invoke('judge-session','fix',200,40,120,20);
  await invoke('judge-session','fix',200,40,120,20);
  usage = usageFromEvents(await readEvents(dir));
  assert.deepEqual(usage.invocations.map(i=>i.total),[120,50,120,50,70,70,0]);
  assert.equal(usage.total,480);
  assert.equal(usage.input,400);
  assert.equal(usage.output,80);
  assert.equal(usage.cacheRead,240);
  assert.equal(usage.cacheWrite,40);
  assert.equal(usage.rounds[0].reply.total,120);
  assert.equal(usage.rounds[0].fix.total,240);
  assert.equal(usage.models[0].total,480);
  assert.equal(usage.invocations[3].status,'failed');
  assert.equal(usage.partial,true);
});

test('resuming a Codex thread without a saved baseline leaves its first delta unavailable', async t => {
  const dir=await scratch(t);
  const invoke=async (input,output) => {
    const events=lines([{type:'thread.started',thread_id:'old-thread'},complete(input,output),
      {type:'item.completed',item:{type:'agent_message',text:'NO NEW FINDINGS'}}]);
    const argv=[process.execPath,'-e',`process.stdout.write(${JSON.stringify(events)})`];
    return runAgent({...codex,argv,resume:{supported:true,argv}},
      {worktree:dir,prompt:'reply',stopToken:'NO NEW FINDINGS',sessionId:'old-thread',
        usageContext:{dir,round:2,action:'reply'}});
  };
  await invoke(1000,100);
  let usage=usageFromEvents(await readEvents(dir));
  assert.equal(usage.invocations[0].total,null,'historical thread tokens are not this invocation consumption');
  assert.equal(usage.partial,true);
  await invoke(1040,110);
  usage=usageFromEvents(await readEvents(dir));
  assert.deepEqual(usage.invocations.map(i=>i.total),[null,50]);
  assert.equal(usage.total,50);
  assert.equal(usage.partial,true);
});

test('SIGTERM preserves streamed usage and resume subtracts it after the last publication', {skip:process.platform==='win32',timeout:15000}, async t => {
  const dir=await scratch(t);
  await writeFile(path.join(dir,'run.json'),JSON.stringify({target:{},rounds:[]}));
  const script=`import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
await runAgent(${JSON.stringify({...codex,argv:[process.execPath,'-e',`console.log(${JSON.stringify(lines([{type:'thread.started',thread_id:'interrupted-session'},complete(),{type:'item.completed',item:{type:'agent_message',text:'ready'}}]))});setInterval(()=>{},1000)`]})},
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
  const resumed = lines([{type:'thread.started',thread_id:'interrupted-session'},complete(140,30),
    {type:'item.completed',item:{type:'agent_message',text:'NO NEW FINDINGS'}}]);
  await runAgent({...codex,argv:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(resumed)})`]},
    {worktree:dir,prompt:'review',stopToken:'NO NEW FINDINGS',usageContext:{dir,round:2,action:'fix'}});
  const updated = await readRun(dir);
  assert.equal(updated.usage.total,170);
  assert.equal(updated.usage.invocations[1].total,50);
  assert.equal(updated.usage.partial,true);
});

test('installed CLI persists review, fix, reply, multiple rounds and resume with reconciled totals', async t => {
  const dir=await scratch(t), repo=path.join(dir,'repo'), bin=path.join(dir,'bin');
  await mkdir(repo); await mkdir(bin);
  const script=`#!${process.execPath}
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
const prompt=process.argv.at(-1);
const resume=process.argv.indexOf('resume');
const session=resume<0?randomUUID():process.argv.at(-2);
const stateFile=process.env.HOME+'/codex-usage.json';
const state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{};
const judge=prompt.includes('A code reviewer raised this finding');
const reply=prompt.startsWith('Thanks —');
let report, tokens;
if(judge){fs.writeFileSync('a.txt','fixed\\n');tokens=200;report=JSON.stringify({verdict:'accepted',reproduced:'wrong value in a.txt',test:'fixture checked before and after',reason:'fixed a.txt'});}
else if(reply){tokens=300;report='The fix is ready for another review round.';}
else {tokens=100;report=fs.readFileSync('a.txt','utf8').includes('fixed')?'NO NEW FINDINGS':'FINDING: incorrect value\\nWHERE: a.txt:1\\nThe value is wrong.';}
const usage=state[session]??{input_tokens:0,output_tokens:0,cached_input_tokens:0};
usage.input_tokens+=tokens;usage.output_tokens+=10;usage.cached_input_tokens+=50;
state[session]=usage;fs.writeFileSync(stateFile,JSON.stringify(state));
for(const event of [{type:'thread.started',thread_id:session},{type:'turn.started'},
{type:'item.completed',item:{type:'agent_message',text:report}},
{type:'turn.completed',usage}])console.log(JSON.stringify(event));
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
  assert.equal(run.usage.partial,false);
  assert.equal(run.usage.rounds.reduce((n,r)=>n+r.total,0),740);
  assert.equal(run.usage.rounds[0].fix.total,210);
  assert.equal(run.usage.models[0].modelSource,'configured');
  await exec(process.execPath,[cli,...args,'--resume',slug],{cwd:repo,env});
  run=JSON.parse(await readFile(path.join(repo,'runs',slug,'run.json')));
  assert.equal(run.usage.total,850); assert.equal(run.usage.invocations.length,5);
  assert.equal(run.usage.partial,false);
});
