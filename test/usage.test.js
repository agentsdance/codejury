import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { testEnvironment } from '../scripts/test-environment.mjs';
const exec = promisify(execFile);
const cli = process.env.JURY_TEST_CLI ?? fileURLToPath(new URL('../bin/jury.js', import.meta.url));
const root = path.dirname(path.dirname(cli));
const { usageDecoder, usageFromEvents, summarizeUsage, trackUsage } = await import(pathToFileURL(path.join(root, 'lib/usage.js')));
const { runAgent } = await import(pathToFileURL(path.join(root, 'lib/agents.js')));
const { appendEvent, readEvents, readRun, publishEvents } = await import(pathToFileURL(path.join(root, 'lib/store.js')));
const { DEFAULTS } = await import(pathToFileURL(path.join(root, 'lib/config.js')));
const { findingsIn } = await import(pathToFileURL(path.join(root, 'lib/findings.js')));
const { replyRound, sessionsIn } = await import(pathToFileURL(path.join(root, 'lib/loop.js')));
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

test('result-json saves complete envelopes during feed without counting nested or partial usage', () => {
  for (const name of ['qwen','droid']) for (const format of ['object','array','ndjson']) {
    const updates = [], decoder = usageDecoder({name,report:'result-json'},records => updates.push(records));
    const result = {type:'result',result:'Quoted braces } ] and "escaped" \\ text',usage:{input_tokens:100,output_tokens:20}};
    const nested = {type:'assistant',text:JSON.stringify(result),message:result};
    const wire = format === 'object' ? JSON.stringify(result,null,2)
      : format === 'array' ? JSON.stringify([nested,result],null,2) : lines([nested]) + JSON.stringify(result);
    // Split strings, escapes, and nested objects across stdout chunks.
    for (let i=0; i<wire.length-1; i+=3) decoder.feed(wire.slice(i,Math.min(i+3,wire.length-1)));
    assert.equal(updates.length,0,`${name}/${format}: incomplete or nested results are not usage`);
    decoder.feed(wire.slice(-1));
    assert.equal(updates.at(-1)?.[0].total,120,`${name}/${format}: save a complete result before finish`);
    const received = updates.length;
    decoder.feed('\n  ');
    decoder.finish();
    assert.equal(updates.length,received,'finish must not replay an already saved envelope');
    // Multiple complete documents in one chunk must persist before a partial tail.
    decoder.feed(lines([result,result]) + '{"type":"result","usage":{"input_tokens":999');
    assert.equal(updates.length,received+2);
    assert.equal(decoder.snapshot().length,1);
    assert.equal(decoder.finish()[0].total,120);
  }
});

for (const name of ['qwen','droid']) test(`${name} received result usage survives SIGKILL before provider exit`,
  {skip:process.platform === 'win32',timeout:15000}, async t => {
    const dir = await scratch(t);
    await writeFile(path.join(dir,'run.json'),JSON.stringify({target:{},rounds:[]}));
    const provider = `
      const result = {type:'result',subtype:'success',result:'NO NEW FINDINGS',pid:process.pid,
        session_id:'received-session',usage:{input_tokens:100,output_tokens:20}};
      process.stdout.write(JSON.stringify(${name === 'qwen' ? '[{type:"system",model:"fixture",session_id:"received-session"},result]' : 'result'},null,2));
      setInterval(()=>{},1000);`;
    const agent = {name,report:'result-json',argv:[process.execPath,'-e',provider]};
    const script = `import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
let received = '';
await runAgent(${JSON.stringify(agent)}, {...${JSON.stringify({worktree:dir,prompt:'review',stopToken:'NO NEW FINDINGS',usageContext:{dir,round:1,action:'review'}})},
  onChunk:text=>{received+=text;try {const parsed=JSON.parse(received);console.log('received:'+(Array.isArray(parsed)?parsed.at(-1):parsed).pid);}catch{}}});`;
    const child = spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
    let providerPid;
    const reapProvider = () => {
      if (providerPid) try { process.kill(-providerPid,'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      providerPid = null;
    };
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      reapProvider();
    });
    const exited = once(child,'exit');
    const [ready] = await once(child.stdout,'data');
    providerPid = Number(String(ready).match(/received:(\d+)/)?.[1]);
    assert.ok(providerPid,'Jury received the entire result while the provider is still alive');
    child.kill('SIGKILL');
    await exited;
    reapProvider();
    const {usage} = await readRun(dir);
    assert.equal(usage.total,120,'readRun recovers received usage without finish or republishing');
    assert.equal(usage.invocations[0].status,'running');
    assert.equal(usage.partial,true);
    if (name === 'qwen') {
      await invokeQwen(dir,{sessionId:'received-session',breakdown:false,
        counters:{fixture:{prompt:140,candidates:30,total:170,cached:0}}});
      const resumed = (await readRun(dir)).usage;
      assert.equal(resumed.total,170);
      assert.equal(resumed.invocations[1].total,50,'the received snapshot is also the resume baseline');
    }
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

for (const format of ['array','object']) test(`Qwen saves per-model usage without adding the aggregate (${format})`, async t => {
  const dir = await scratch(t);
  const aggregate = {type:'result',subtype:'success',is_error:false,result:'NO NEW FINDINGS',
    ...(format === 'object' ? {model:'model-a'} : {}),
    usage:{input_tokens:150,output_tokens:20,total_tokens:180,cache_read_input_tokens:100}};
  const result = {...aggregate,stats:{models:{
    'model-a':{tokens:{prompt:100,candidates:10,thoughts:10,total:120,cached:80}},
    'model-b':{tokens:{prompt:50,candidates:10,thoughts:0,total:60,cached:20}},
  }}};
  // A richer result replaces an aggregate-only snapshot; repeated results
  // must also replace the same model rows instead of charging them twice.
  const events = [{type:'system',model:'model-a'},aggregate,result,result];
  const response = JSON.stringify(format === 'array' ? events : result);
  const run = await runAgent({name:'qwen',report:'result-json',model:'configured',
    argv:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(response)})`]},
    {worktree:dir,prompt:'review',stopToken:'NO NEW FINDINGS',usageContext:{dir,round:1,action:'review'}});
  assert.equal(run.ok,true);
  await publishEvents(dir);
  const {usage} = JSON.parse(await readFile(path.join(dir,'run.json'),'utf8'));
  assert.deepEqual(usage.models,[
    {agent:'qwen',model:'model-a',modelSource:'reported',input:100,output:20,total:120,cacheRead:80,cacheWrite:null,partial:false},
    {agent:'qwen',model:'model-b',modelSource:'reported',input:50,output:10,total:60,cacheRead:20,cacheWrite:null,partial:false},
  ]);
  assert.equal(usage.invocations.length,1);
  assert.equal(usage.invocations[0].records.length,2);
  for (const row of [usage,usage.invocations[0],usage.rounds[0],usage.rounds[0].review]) {
    assert.equal(row.input,150);
    assert.equal(row.output,30, 'include separately reported thinking');
    assert.equal(row.total,180, 'count the model breakdown once, without the aggregate');
    assert.equal(row.cacheRead,100);
    assert.equal(row.partial,false);
  }
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

async function invokeQwen(dir, {sessionId = null, counters, breakdown, omitSession = false, failed = false}) {
  const usage = counters && Object.fromEntries([
    ['input_tokens','prompt'],['output_tokens','candidates'],['total_tokens','total'],['cache_read_input_tokens','cached'],
  ].map(([field,key]) => [field,Object.values(counters).reduce((sum,u) => sum + u[key],0)]));
  const result = {type:'result',subtype:failed ? 'error_during_execution' : 'success',is_error:failed,
    result:failed ? 'Authentication failed' : 'NO NEW FINDINGS',usage,
    ...(breakdown ? {stats:{models:Object.fromEntries(Object.entries(counters ?? {}).map(([name,tokens]) => [name,{tokens}]))}} : {})};
  const provider = `
    const result = ${JSON.stringify(result)};
    const system = {type:'system',model:'model-a'};
    if (!${omitSession}) system.session_id = result.session_id = process.argv[2];
    if (${Boolean(counters)}) process.stdout.write(JSON.stringify([system,result,result]));
    else process.exit(1);
    if (${failed}) process.exitCode = 1;`;
  const argv = [process.execPath,'-e',provider,'fresh','{{sessionId}}'];
  const agent = {name:'qwen',report:'result-json',newSession:true,argv,
    resume:{supported:true,argv:[...argv.slice(0,-2),'resume','{{sessionId}}']}};
  // Recover usage from disk in a fresh Jury process for every reply.
  const script = `import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
const result = await runAgent(${JSON.stringify(agent)},${JSON.stringify({worktree:dir,prompt:'review',
  stopToken:'NO NEW FINDINGS',sessionId,usageContext:{dir,round:1,action:sessionId ? 'reply' : 'review'}})});
console.log(JSON.stringify({ok:result.ok,sessionId:result.sessionId}));`;
  const {stdout} = await exec(process.execPath,['--input-type=module','-e',script]);
  const run = JSON.parse(stdout);
  assert.equal(run.ok,Boolean(counters) && !failed);
  return run.sessionId;
}

for (const breakdown of [true,false]) {
  const format = breakdown ? 'models' : 'aggregate';
  test(`Qwen resumed ${format} subtract persisted session counters across processes`, async t => {
    const dir = await scratch(t);
    const sessionId = await invokeQwen(dir,{breakdown,
      counters:{'model-a':{prompt:100,candidates:10,thoughts:10,total:120,cached:80}}});
    await invokeQwen(dir,{breakdown,sessionId,
      counters:{'model-a':{prompt:140,candidates:20,thoughts:10,total:170,cached:100}}});
    await publishEvents(dir);
    let usage = (await readRun(dir)).usage;
    assert.equal(usage.total,170,'120 then 170 cumulative must total 170, not 290');
    assert.deepEqual(usage.invocations.map(i => [i.input,i.output,i.total,i.cacheRead]),[[100,20,120,80],[40,10,50,20]]);
    assert.equal(usage.partial,false);
    if (breakdown) {
      await invokeQwen(dir,{breakdown,sessionId,counters:{
        'model-a':{prompt:140,candidates:20,thoughts:10,total:170,cached:100},
        'model-b':{prompt:50,candidates:10,thoughts:0,total:60,cached:20},
      }});
      usage = usageFromEvents(await readEvents(dir));
      assert.equal(usage.total,230);
      assert.equal(usage.invocations.at(-1).total,60,'new models start at zero; unchanged models add zero');
      assert.deepEqual(usage.models.map(m => [m.model,m.total]),[['model-a',170],['model-b',60]]);
    }
    const other = await invokeQwen(dir,{breakdown,
      counters:{'model-a':{prompt:100,candidates:10,thoughts:10,total:120,cached:80}}});
    assert.notEqual(other,sessionId);
    assert.equal(usageFromEvents(await readEvents(dir)).invocations.at(-1).total,120,'new sessions do not inherit another baseline');
  });

  test(`Qwen resumed ${format} keep missing baselines and unmeasured gaps unavailable`, async t => {
    const dir = await scratch(t), sessionId = 'older-qwen-session';
    const invoke = (prompt,candidates) => invokeQwen(dir,{breakdown,sessionId,omitSession:true,
      counters:prompt === null ? null : {'model-a':{prompt,candidates,total:prompt+candidates,cached:0}}});
    await invoke(100,20);
    await invoke(140,30);
    await invoke(null,null); // Resumed invocation exits without any usage.
    await invoke(190,40);
    await invoke(240,50);
    const events = await readEvents(dir), usage = usageFromEvents(events);
    assert.deepEqual(usage.invocations.map(i => i.total),[null,50,null,null,60]);
    assert.equal(usage.total,110);
    assert.equal(usage.partial,true);
    assert.ok(events.filter(e => e.t === 'usage.snapshot').every(e => e.resumedSessionId === sessionId));
  });

  test(`Qwen regressing ${format} error counters cannot become a resume baseline`, async t => {
    const dir = await scratch(t);
    const counters = (prompt,candidates) => ({'model-a':{prompt,candidates,total:prompt+candidates,cached:0}});
    const sessionId = await invokeQwen(dir,{breakdown,counters:counters(100,20)});
    await invokeQwen(dir,{breakdown,sessionId,failed:true,counters:counters(0,0)});
    await invokeQwen(dir,{breakdown,sessionId,failed:true,counters:counters(140,30)});
    let usage = usageFromEvents(await readEvents(dir));
    assert.deepEqual(usage.invocations.map(i => i.total),[120,null,null],
      'regressing counters invalidate the baseline; the next measurement cannot charge earlier tokens again');
    assert.equal(usage.total,120);
    assert.deepEqual(usage.invocations.map(i => i.status),['completed','failed','failed']);
    assert.equal(usage.partial,true);
    // The first trustworthy measurement restores the baseline, even on failure.
    await invokeQwen(dir,{breakdown,sessionId,counters:counters(180,40)});
    await publishEvents(dir);
    usage = (await readRun(dir)).usage;
    assert.deepEqual(usage.invocations.map(i => [i.input,i.output,i.total]),
      [[100,20,120],[null,null,null],[null,null,null],[40,10,50]]);
    assert.equal(usage.total,170);
    assert.equal(usage.partial,true);
  });

  test(`Qwen repeated zero-valued ${format} errors cannot restore an invalid baseline`, async t => {
    for (const resets of [2,4]) {
      const dir = await scratch(t);
      const counters = (prompt,candidates) => ({'model-a':{prompt,candidates,total:prompt+candidates,cached:0}});
      const sessionId = await invokeQwen(dir,{breakdown,counters:counters(100,20)});
      for (let i=0; i<resets; i++) {
        await invokeQwen(dir,{breakdown,sessionId,failed:true,counters:counters(0,0)});
        const snapshots = (await readEvents(dir)).filter(e => e.t === 'usage.snapshot');
        assert.ok(snapshots.at(-1).records.every(r => r.cumulative.input === null
          && r.cumulative.output === null && r.cumulative.total === null),
        `empty error ${i+1} must leave its durable baseline invalid`);
      }
      await invokeQwen(dir,{breakdown,sessionId,failed:true,counters:counters(140,30)});
      let usage = usageFromEvents(await readEvents(dir));
      assert.deepEqual(usage.invocations.map(i => i.total),[120,...Array(resets+1).fill(null)]);
      assert.equal(usage.total,120,'repeated errors cannot charge the earlier 120 tokens again');
      assert.equal(usage.partial,true);
      // A failed result with real usage restores the baseline for the next turn.
      await invokeQwen(dir,{breakdown,sessionId,counters:counters(180,40)});
      await publishEvents(dir);
      usage = (await readRun(dir)).usage;
      assert.deepEqual(usage.invocations.map(i => i.total),[120,...Array(resets+1).fill(null),50]);
      assert.equal(usage.total,170);
      assert.equal(usage.partial,true);
    }
  });
}

test('Qwen distinguishes empty errors from genuine zero-valued measurements after a missing baseline', () => {
  const unknown = {input:null,output:null,total:null,cacheRead:null,cacheWrite:null};
  for (const error of [{is_error:true},{subtype:'error_during_execution'}]) {
    const decoder = usageDecoder({name:'qwen',report:'result-json'},undefined,new Map([['old-session',unknown]]),'old-session');
    decoder.feed(JSON.stringify({type:'result',...error,usage:{input_tokens:0,output_tokens:0}}));
    assert.equal(decoder.snapshot()[0].cumulative.total,null);
  }
  for (const [is_error,input,output] of [[false,0,0],[true,140,0]]) {
    const decoder = usageDecoder({name:'qwen',report:'result-json'},undefined,new Map([['old-session',unknown]]),'old-session');
    decoder.feed(JSON.stringify({type:'result',is_error,usage:{input_tokens:input,output_tokens:output}}));
    const [record] = decoder.finish();
    assert.equal(record.total,null,'the unknown earlier baseline keeps this invocation unavailable');
    assert.equal(record.cumulative.total,input+output,'a successful zero or a nonempty failure establishes a baseline');
    assert.equal(record.cumulative.output,output);
  }
});

test('every persisted Qwen model result is a complete resume baseline', async t => {
  const dir = await scratch(t);
  const agent = {name:'qwen',report:'result-json'};
  const result = n => JSON.stringify({type:'result',session_id:'qwen-atomic',stats:{models:{
    A:{tokens:{prompt:n, candidates:0,total:n}}, B:{tokens:{prompt:n,candidates:0,total:n}},
  }}});
  const first = trackUsage(agent,{dir,round:1,action:'review'});
  first.feed(result(100)); first.finish('completed');
  const reply = trackUsage(agent,{dir,round:1,action:'reply'},null,'qwen-atomic');
  reply.feed(result(150)); reply.finish('completed');
  const events = await readEvents(dir);
  const snapshots = events.filter(e => e.t === 'usage.snapshot' && e.records?.length);
  // A concurrent process may start after any append, not just after feed returns.
  for (const snapshot of snapshots) assert.deepEqual(snapshot.records.map(r => r.model),['A','B']);
  const last = trackUsage(agent,{dir,round:1,action:'reply'},null,'qwen-atomic');
  last.feed(result(200)); last.finish('completed');
  assert.equal(usageFromEvents(await readEvents(dir)).total,400);
});

test('actual manual resolution after measured judge work adds no usage invocation', async t => {
  const worktree = await scratch(t), dir = path.join(worktree,'runs','manual');
  const isolated = testEnvironment(); t.after(() => isolated.dispose());
  for (const event of [{t:'target',target:{judge:'codex'}},{t:'round.start',n:1},
    {t:'usage.snapshot',id:'judge-call',agent:'codex',action:'fix',round:1,findingId:'F1',status:'completed',
      records:[{input:100,output:20,total:120}]},
    {t:'judge.session',agent:'codex',sessionId:'judge-thread',round:1},
    {t:'finding.resolved',id:'F1',who:'codex',verdict:'rejected'},
    {t:'finding.raised',id:'manual',agent:'codex',round:1,claim:'Manual case',loc:'a.js:1'}]) await appendEvent(dir,event);
  await exec(process.execPath,[cli,'finding','resolve','manual','--dir',worktree,'--run','manual',
    '--verdict','rejected','--reason','Checked manually'],{cwd:worktree,env:isolated.env});
  const events = await readEvents(dir);
  assert.equal(events.findLast(e => e.t === 'finding.resolved').who,'codex');
  const usage = usageFromEvents(events);
  assert.equal(usage.invocations.length,1);
  assert.equal(usage.total,120);
  assert.equal(usage.partial,false);
  // Ambiguous old resolution records alone are not proof that an agent ran.
  const legacy = usageFromEvents([{t:'round.start',n:1},
    {t:'judge.session',agent:'codex',sessionId:'old'},
    {t:'finding.resolved',id:'first',who:'codex',verdict:'rejected'},
    {t:'finding.resolved',id:'manual',who:'codex',verdict:'rejected'}]);
  assert.equal(legacy.invocations.length,1);
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

test('legacy judge turns survive recovery and publication beside a measured new round', async t => {
  const dir = await scratch(t);
  const events = [{t:'round.start',n:1},
    {t:'agent.launch',agent:'reviewer',round:1},
    {t:'agent.report',agent:'reviewer',round:1,verdict:'findings'},
    {t:'judge.session',agent:'judge',sessionId:'legacy-judge',round:1},
    {t:'finding.resolved',id:'F1',who:'judge',verdict:'rejected'},
    // A new saved session establishes another old call. Bare heartbeats do not.
    {t:'judge.session',agent:'judge',sessionId:'legacy-judge-2',round:1},
    {t:'agent.alive',agent:'judge',forAgent:'reviewer',round:1},
    {t:'finding.resolved',id:'F2',who:'judge',verdict:'deferred'},
    {t:'round.start',n:2},
    {t:'usage.snapshot',id:'new-review',agent:'reviewer',round:2,action:'review',status:'completed',
      records:[{model:'fixture',modelSource:'reported',input:100,output:20,total:120,cacheRead:null,cacheWrite:null}]}];
  await writeFile(path.join(dir,'events.ndjson'),lines(events));
  await writeFile(path.join(dir,'run.json'),JSON.stringify({target:{},rounds:[{n:1}]}));
  const recovered = await readRun(dir);
  await publishEvents(dir);
  const published = JSON.parse(await readFile(path.join(dir,'run.json'),'utf8'));
  for (const {usage} of [recovered,published]) {
    assert.deepEqual(usage.invocations.map(i => [i.agent,i.action,i.round,i.findingId ?? null,i.total]),
      [['reviewer','review',1,null,null],['judge','fix',1,'F1',null],['judge','fix',1,'F2',null],['reviewer','review',2,null,120]]);
    assert.equal(usage.rounds[0].fix.total,null);
    assert.equal(usage.rounds[0].fix.partial,true);
    assert.equal(usage.models.find(m => m.agent === 'judge').modelSource,'unavailable');
    assert.equal(usage.models.find(m => m.agent === 'judge').partial,true);
    assert.equal(usage.total,120);
    assert.equal(usage.partial,true);
    assert.equal(usage.rounds[1].partial,false);
    assert.ok(usage.invocations.filter(i => i.action === 'fix').every(i => i.status === 'completed'));
  }
});

test('judge lifecycle recovery matches measured findings without phantom invocations', () => {
  const snapshot = (id,findingId,status) => ({t:'usage.snapshot',id,agent:'judge',round:1,action:'fix',findingId,status,
    records:status === 'running' ? [] : [{model:'fixture',modelSource:'reported',input:100,output:20,total:120}]});
  const events = [{t:'round.start',n:1},snapshot('first','F1','running'),snapshot('first','F1','completed'),
    {t:'judge.session',agent:'judge',sessionId:'measured-judge',round:1},
    {t:'finding.resolved',id:'F1',who:'judge',verdict:'accepted'},
    snapshot('second','F2','running'),snapshot('second','F2','completed'),
    {t:'finding.resolved',id:'F2',who:'judge',verdict:'rejected'},
    // These resolutions do not establish an additional judge invocation.
    {t:'finding.resolved',id:'manual',who:'operator',verdict:'rejected'},
    {t:'finding.resolved',id:'unknown',verdict:'rejected'},
    {t:'finding.resolved',id:'limit',who:'judge',verdict:'deferred',reason:'argued 3 turns without agreement; both positions are in the log'}];
  const usage = usageFromEvents(events);
  assert.deepEqual(usage.invocations.map(i => [i.id,i.findingId,i.total]),[['first','F1',120],['second','F2',120]]);
  assert.equal(usage.total,240);
  assert.equal(usage.partial,false);
});

test('late judge heartbeats cannot create another usage invocation after resolution', () => {
  const events = [{t:'round.start',n:1},
    {t:'usage.snapshot',id:'one-call',agent:'judge',action:'fix',round:1,findingId:'F1',status:'completed',
      records:[{input:100,output:20,total:120}]},
    {t:'judge.session',agent:'judge',sessionId:'session',round:1},
    {t:'finding.resolved',id:'F1',who:'judge',verdict:'rejected'},
    // An asynchronous interval append can complete after its timer is cleared.
    {t:'agent.alive',agent:'judge',forAgent:'codex',round:1,seconds:5}];
  const usage = usageFromEvents(events);
  assert.equal(usage.invocations.length,1);
  assert.equal(usage.total,120);
  assert.equal(usage.partial,false);
});

for (const name of ['codex','qwen']) for (const identified of [true,false]) {
  test(`ID-less interrupted ${name} resume preserves unknown gaps (identified=${identified})`, async t => {
    const dir = await scratch(t), agent = {name,report:name === 'codex' ? 'codex-json' : 'result-json'};
    const invoke = (thread, resumed, savedId, input, output, emitIdentity=true) => {
      const tracker = trackUsage(agent,{dir,round:1,action:resumed?'reply':'review'},null,savedId,resumed);
      if (emitIdentity) tracker.feed(lines([name === 'codex'
        ? {type:'thread.started',thread_id:thread} : {type:'system',session_id:thread}]));
      if (input !== null) tracker.feed(lines([name === 'codex'
        ? {type:'turn.completed',usage:{input_tokens:input,output_tokens:output}}
        : {type:'result',session_id:thread,usage:{input_tokens:input,output_tokens:output}}]));
      tracker.finish(input === null ? 'interrupted' : 'completed');
    };
    invoke('A',false,null,100,20); invoke('B',false,null,100,20);
    invoke('A',true,null,null,null,identified);
    invoke('A',true,'A',200,50);
    invoke('A',true,'A',240,60);
    invoke('B',true,'B',140,30);
    const usage = usageFromEvents(await readEvents(dir));
    assert.deepEqual(usage.invocations.map(i=>i.total),[120,120,null,null,50,identified?50:null]);
    assert.equal(usage.invocations[3].partial,true);
    assert.equal(usage.invocations[4].partial,false);
    // Without an identity the interrupted resume could have selected any saved
    // session. Once identified, only that session's baseline is uncertain.
    assert.equal(usage.invocations[5].partial,!identified);
  });
}

test('distinct legacy judge sessions survive without intervening verdicts', () => {
  const usage = usageFromEvents([{t:'round.start',n:1},
    {t:'judge.session',agent:'judge',sessionId:'old-A',round:1},
    {t:'judge.session',agent:'judge',sessionId:'old-A',round:1},
    {t:'judge.session',agent:'judge',sessionId:'old-B',round:1}]);
  assert.equal(usage.invocations.length,2);
  assert.ok(usage.invocations.every(i=>i.action==='fix' && i.total===null && i.partial));
});

test('overlapping judge session records match measured session identities', () => {
  const snapshot = (id,sessionId) => ({t:'usage.snapshot',id,agent:'judge',action:'fix',round:1,
    findingId:id,status:'completed',records:[{sessionId,input:100,output:20,total:120}]});
  const usage = usageFromEvents([{t:'round.start',n:1},snapshot('A','session-A'),snapshot('B','session-B'),
    {t:'judge.session',agent:'judge',sessionId:'session-A',round:1},
    {t:'finding.resolved',id:'A',who:'judge',verdict:'rejected'},
    {t:'judge.session',agent:'judge',sessionId:'session-B',round:1},
    {t:'finding.resolved',id:'B',who:'judge',verdict:'rejected'}]);
  assert.equal(usage.invocations.length,2);
  assert.equal(usage.total,240);
  assert.equal(usage.partial,false);
});

test('a legacy judge session without a verdict remains unavailable beside a measured retry', () => {
  const usage = usageFromEvents([{t:'round.start',n:1},
    {t:'judge.session',agent:'judge',sessionId:'unparsed-judge',round:1},
    {t:'usage.snapshot',id:'retry',agent:'judge',round:1,action:'fix',findingId:'F1',status:'completed',
      records:[{input:100,output:20,total:120}]},
    {t:'finding.resolved',id:'F1',who:'judge',verdict:'rejected'}]);
  assert.deepEqual(usage.invocations.map(i => [i.action,i.status,i.total]),[['fix','unknown',null],['fix','completed',120]]);
  assert.equal(usage.rounds[0].fix.partial,true);
  assert.equal(usage.total,120);
  assert.equal(usage.partial,true);
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

test('overlapping measured reviews stay distinct in either report order, including legacy snapshots', () => {
  const record = {model:'fixture',modelSource:'configured',input:100,output:20,total:120,cacheRead:null,cacheWrite:null};
  for (const correlated of [true, false]) for (const order of [['a','b'], ['b','a']]) {
    const launch = reviewId => ({t:'agent.launch',agent:'codex',round:1,reviewId});
    const snapshot = (reviewId, status) => ({t:'usage.snapshot',id:`usage-${reviewId}`,
      agent:'codex',action:'review',round:1,status,records:status === 'running' ? [] : [record],
      ...(correlated ? {reviewId} : {})});
    const starts = [[launch('a'), snapshot('a','running'), launch('b'), snapshot('b','running')]];
    if (correlated) starts.push([launch('a'), launch('b'), snapshot('b','running'), snapshot('a','running')]);
    for (const start of starts) {
      const usage = usageFromEvents([{t:'round.start',n:1}, ...start, ...order.flatMap(reviewId => [
        snapshot(reviewId,'completed'), snapshot(reviewId,'completed'),
        {t:'agent.report',agent:'codex',round:1,reviewId,verdict:'clean'},
      ])]);
      assert.equal(usage.invocations.length,2,'two measured reviews must not create a phantom invocation');
      assert.deepEqual(usage.invocations.map(i=>i.id),['usage-a','usage-b']);
      assert.deepEqual(usage.invocations.map(i=>i.total),[120,120]);
      for (const row of [usage,usage.rounds[0],usage.rounds[0].review,usage.models[0]]) {
        assert.equal(row.total,240);
        assert.equal(row.partial,false);
      }
      if (correlated) assert.deepEqual(usage.invocations.map(i=>i.reviewId),['a','b']);
    }
  }
});

test('a measured review cannot hide an overlapping unmeasured review', () => {
  const usage = usageFromEvents([{t:'round.start',n:1},
    {t:'agent.launch',agent:'codex',round:1,reviewId:'unmeasured'},
    {t:'agent.launch',agent:'codex',round:1,reviewId:'measured'},
    {t:'usage.snapshot',id:'usage-measured',agent:'codex',action:'review',round:1,reviewId:'measured',
      status:'completed',records:[{model:null,modelSource:'unavailable',input:100,output:20,total:120}]},
    {t:'agent.report',agent:'codex',round:1,reviewId:'unmeasured',verdict:'error'},
    {t:'agent.report',agent:'codex',round:1,reviewId:'measured',verdict:'clean'}]);
  assert.deepEqual(usage.invocations.map(i=>[i.reviewId,i.total,i.status]),
    [['unmeasured',null,'failed'],['measured',120,'completed']]);
  assert.equal(usage.total,120);
  assert.equal(usage.partial,true);
});

test('overlapping measured replies stay distinct in either answer order, including legacy snapshots', () => {
  const record = {model:'fixture',modelSource:'configured',input:100,output:20,total:120,cacheRead:null,cacheWrite:null};
  for (const correlated of [true, false]) for (const order of [['a','b'], ['b','a']]) {
    const sent = replyId => ({t:'reply.sent',agent:'codex',replyId});
    const snapshot = (replyId, status) => ({t:'usage.snapshot',id:`usage-${replyId}`,
      agent:'codex',action:'reply',round:1,status,records:status === 'running' ? [] : [record],
      ...(correlated ? {replyId} : {})});
    const starts = [[sent('a'), snapshot('a','running'), sent('b'), snapshot('b','running')]];
    // IDs also disambiguate launches whose first snapshots arrive later.
    if (correlated) starts.push([sent('a'), sent('b'), snapshot('a','running'), snapshot('b','running')]);
    for (const start of starts) {
      const events = [{t:'round.start',n:1}, ...start, ...order.flatMap(replyId => [
        snapshot(replyId,'completed'), snapshot(replyId,'completed'),
        {t:'reply.answered',agent:'codex',replyId,verdict:'clean'},
      ])];
      const usage = usageFromEvents(events);
      assert.equal(usage.invocations.length,2,'two measured replies must not create a phantom invocation');
      assert.deepEqual(usage.invocations.map(i=>i.id),['usage-a','usage-b']);
      assert.deepEqual(usage.invocations.map(i=>i.total),[120,120]);
      for (const row of [usage,usage.rounds[0],usage.rounds[0].reply,usage.models[0]]) {
        assert.equal(row.total,240);
        assert.equal(row.partial,false);
      }
      if (correlated) assert.deepEqual(usage.invocations.map(i=>i.replyId),['a','b']);
    }
  }
});

test('a measured reply cannot hide an overlapping unmeasured reply', () => {
  const usage = usageFromEvents([{t:'round.start',n:1},
    {t:'reply.sent',agent:'codex',replyId:'unmeasured'},
    {t:'reply.sent',agent:'codex',replyId:'measured'},
    {t:'usage.snapshot',id:'usage-measured',agent:'codex',action:'reply',round:1,replyId:'measured',
      status:'completed',records:[{model:null,modelSource:'unavailable',input:100,output:20,total:120}]},
    {t:'reply.answered',agent:'codex',replyId:'unmeasured',verdict:'error'},
    {t:'reply.answered',agent:'codex',replyId:'measured',verdict:'clean'}]);
  assert.equal(usage.invocations.length,2);
  assert.deepEqual(usage.invocations.map(i=>[i.replyId,i.total,i.status]),
    [['unmeasured',null,'failed'],['measured',120,'completed']]);
  assert.equal(usage.total,120);
  assert.equal(usage.partial,true);
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

for (const status of ['completed', 'failed', 'interrupted']) {
  test(`a delayed ${status} Codex reply snapshot cannot roll back a newer persisted baseline`, async t => {
    const dir = await scratch(t), sessionId = 'overlapping-thread';
    const feed = (tracker, input, output, cacheRead, cacheWrite) => tracker.feed(lines([
      {type:'thread.started',thread_id:sessionId}, {type:'turn.started'},
      {type:'turn.completed',usage:{input_tokens:input,output_tokens:output,
        cached_input_tokens:cacheRead,cache_write_input_tokens:cacheWrite}},
    ]));
    const review = trackUsage(codex, {dir,round:1,action:'review'});
    t.after(() => review.finish('interrupted'));
    feed(review,100,20,80,10);
    review.finish('completed');
    const first = trackUsage(codex, {dir,round:1,action:'reply',replyId:'first'}, null, sessionId);
    t.after(() => first.finish('interrupted'));
    feed(first,200,40,160,20);
    const second = trackUsage(codex, {dir,round:1,action:'reply',replyId:'second'}, null, sessionId);
    t.after(() => second.finish('interrupted'));
    feed(second,250,50,200,25);
    second.finish('completed');
    // First reported 240 before second reached 300, but exits after second.
    first.finish(status);
    const beforeResume = await readEvents(dir);
    assert.equal(beforeResume.at(-1).records[0].cumulative.total,240);
    assert.equal(usageFromEvents(beforeResume).total,300);

    // A fresh process must recover 300 from disk, not first's late 240 snapshot.
    const output = lines([{type:'thread.started',thread_id:sessionId}, {type:'turn.started'},
      {type:'item.completed',item:{type:'agent_message',text:'NO NEW FINDINGS'}},
      {type:'turn.completed',usage:{input_tokens:300,output_tokens:60,
        cached_input_tokens:240,cache_write_input_tokens:30}}]);
    const argv = [process.execPath,'-e',`process.stdout.write(${JSON.stringify(output)})`];
    const script = `import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
await runAgent(${JSON.stringify({...codex,argv,resume:{supported:true,argv}})},
  ${JSON.stringify({worktree:dir,prompt:'reply',stopToken:'NO NEW FINDINGS',sessionId,
    usageContext:{dir,round:1,action:'reply',replyId:'next'}})});`;
    await exec(process.execPath, ['--input-type=module','-e',script]);
    await publishEvents(dir);
    const {usage} = await readRun(dir);
    assert.equal(usage.partial,status !== 'completed');
    assert.equal(usage.total,360,'a late final snapshot must not charge the newer reply twice');
    assert.deepEqual(usage.invocations.map(i=>i.total),[120,120,60,60]);
    assert.deepEqual(usage.invocations.slice(-1).map(i=>[i.input,i.output,i.cacheRead,i.cacheWrite]),[[50,10,40,5]]);
  });
}

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`an unmeasured Codex ${signal} gap invalidates the next reply baseline across processes`,
    {skip:process.platform === 'win32',timeout:15000}, async t => {
      const dir = await scratch(t), sessionId = 'unmeasured-thread';
      const invoke = async (input, output, resumed = true) => {
        const response = lines([{type:'thread.started',thread_id:sessionId}, {type:'turn.started'},
          {type:'item.completed',item:{type:'agent_message',text:'NO NEW FINDINGS'}}, complete(input,output)]);
        const argv = [process.execPath,'-e',`process.stdout.write(${JSON.stringify(response)})`];
        const script = `import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
const result = await runAgent(${JSON.stringify({...codex,argv,resume:{supported:true,argv}})},
  ${JSON.stringify({worktree:dir,prompt:'reply',stopToken:'NO NEW FINDINGS',sessionId:resumed ? sessionId : null,
    usageContext:{dir,round:1,action:resumed ? 'reply' : 'review'}})});
if (!result.ok) throw new Error(result.report);`;
        await exec(process.execPath, ['--input-type=module','-e',script]);
      };
      await invoke(100,20,false);
      // The provider did work but has not emitted a usage event when Jury dies.
      const provider = `console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(sessionId)}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'ready:' + process.pid}}));
setInterval(()=>{},1000);`;
      const argv = [process.execPath,'-e',provider];
      const script = `import {runAgent} from ${JSON.stringify(pathToFileURL(path.join(root,'lib/agents.js')).href)};
await runAgent(${JSON.stringify({...codex,argv,resume:{supported:true,argv}})},
  {...${JSON.stringify({worktree:dir,prompt:'reply',stopToken:'NO NEW FINDINGS',sessionId,
    usageContext:{dir,round:1,action:'reply',replyId:'gap'}})},onChunk:text=>console.log(text)});`;
      const child = spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});
      let providerPid;
      const reapProvider = () => {
        if (providerPid) try { process.kill(-providerPid,'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        reapProvider();
      });
      const exited = once(child,'exit');
      const [ready] = await once(child.stdout,'data');
      providerPid = Number(String(ready).match(/ready:(\d+)/)?.[1]);
      assert.ok(providerPid, 'provider must be running before interruption');
      child.kill(signal);
      await exited;
      // SIGTERM runs Jury's provider cleanup; SIGKILL cannot run its handler.
      if (signal === 'SIGKILL') reapProvider();
      providerPid = null;
      // The missing turn consumed 30; this turn consumed 60. Neither can be
      // isolated from the new cumulative total of 210, so its delta is unknown.
      await invoke(180,30);
      let usage = usageFromEvents(await readEvents(dir));
      assert.equal(usage.invocations[2].total,null,'90 tokens span two invocations, not just this reply');
      assert.equal(usage.invocations[2].partial,true);
      assert.equal(usage.invocations[2].status,'completed');
      const gap = (await readEvents(dir)).filter(e => e.t === 'usage.snapshot' && e.replyId === 'gap');
      assert.ok(gap.length);
      assert.ok(gap.every(e => e.resumedSessionId === sessionId && e.records.length === 0));
      assert.equal(gap.at(-1).status,signal === 'SIGTERM' ? 'interrupted' : 'running');
      // This new measurement establishes a baseline again for later replies.
      await invoke(230,40);
      await publishEvents(dir);
      usage = (await readRun(dir)).usage;
      assert.deepEqual(usage.invocations.map(i=>i.total),[120,null,null,60]);
      assert.equal(usage.total,180);
      assert.equal(usage.partial,true);
    });
}

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

test('ID-less cumulative resumes require a baseline for the reported session', async t => {
  for (const format of ['codex','qwen-aggregate','qwen-models']) for (const reportsId of [true,false]) {
    const dir = await scratch(t);
    const agent = format === 'codex' ? codex : {name:'qwen',report:'result-json'};
    const invoke = (input,output) => {
      const tracker = trackUsage(agent,{dir,round:1,action:'reply'},undefined,null,true);
      if (format === 'codex') {
        tracker.feed(lines([...(reportsId ? [{type:'thread.started',thread_id:'reported-thread'}] : []),complete(input,output)]));
      } else {
        tracker.feed(JSON.stringify({type:'result',subtype:'success',is_error:false,
          ...(reportsId ? {session_id:'reported-thread'} : {}),
          usage:{input_tokens:input,output_tokens:output},
          ...(format === 'qwen-models' ? {stats:{models:{fixture:{tokens:{prompt:input,candidates:output,total:input+output}}}}} : {}),
        }));
      }
      tracker.finish('completed');
    };
    invoke(1040,110);
    let usage = usageFromEvents(await readEvents(dir));
    assert.equal(usage.total,null,`${format}: cumulative history is unavailable without a saved baseline`);
    assert.equal(usage.partial,true);
    invoke(1080,120);
    usage = usageFromEvents(await readEvents(dir));
    assert.deepEqual(usage.invocations.map(i => i.total),[null,reportsId ? 50 : null],
      `${format}: only an identified session can recover its saved baseline`);
    assert.equal(usage.partial,true);
  }
});

for (const mode of ['automatic', 'standalone']) for (const idless of [false,true]) {
  test(`${mode} ${idless ? 'ID-less ' : ''}reply without a saved Codex baseline records unavailable then only the new delta`, async t => {
    const worktree = await scratch(t), dir = path.join(worktree, 'runs', 'old-run');
    const isolated = testEnvironment();
    t.after(() => isolated.dispose());
    const fixture = path.join(worktree, 'codex.cjs');
    await writeFile(fixture, `
      const fs = require('node:fs');
      const assert = require('node:assert/strict');
      assert.equal(process.argv[2], 'resume');
      assert.equal(process.argv[3], ${JSON.stringify(idless ? '--last' : 'old-thread')});
      const usage = fs.existsSync('usage.json') ? JSON.parse(fs.readFileSync('usage.json', 'utf8'))
        : {input_tokens: 1000, output_tokens: 100};
      usage.input_tokens += 40;
      usage.output_tokens += 10;
      fs.writeFileSync('usage.json', JSON.stringify(usage));
      for (const event of [{type: 'thread.started', thread_id: 'old-thread'},
        {type: 'turn.started'},
        {type: 'item.completed', item: {type: 'agent_message', text: 'NO NEW FINDINGS'}},
        {type: 'turn.completed', usage}]) {
        console.log(JSON.stringify(event));
      }
    `);
    const agent = {...codex, cwd: 'worktree',
      argv: [process.execPath, fixture, 'fresh', '{{promptText}}'],
      resume: {supported: true, argv: [process.execPath, fixture, 'resume', idless ? '--last' : '{{sessionId}}', '{{promptText}}']}};
    // An older review has no usage snapshot and may also lack a saved session ID.
    for (const event of [{t: 'target', target: {judge: 'fixture-judge'}},
      {t: 'round.start', n: 1},
      {t: 'agent.report', agent: 'codex', round: 1, sessionId: idless ? null : 'old-thread'},
      {t: 'finding.raised', id: 'A', agent: 'codex', round: 1, claim: 'Wrong value', loc: 'a.txt:1'},
      {t: 'finding.resolved', id: 'A', verdict: 'rejected', reason: 'Value is correct'}]) {
      await appendEvent(dir, event);
    }
    if (mode === 'standalone') {
      const git = (...args) => exec('git', args, {cwd: worktree, env: isolated.env});
      await git('init', '-q', '-b', 'master');
      await git('commit', '--allow-empty', '-qm', 'base');
      await writeFile(path.join(worktree, 'jury.config.json'), JSON.stringify({agents: [
        ...DEFAULTS.agents.map(a => a.name === 'codex' ? agent : {name: a.name, enabled: false}),
        {name: 'fixture-judge', role: 'main', argv: [process.execPath]},
      ]}));
    }
    const invoke = async () => {
      if (mode === 'standalone') {
        const result = await exec(process.execPath, [cli, 'reply', '--dir', worktree, '--run', 'old-run', '--reviewer', 'codex'],
          {cwd: worktree, env: isolated.env});
        return result.stdout;
      }
      const logs = [];
      const answers = await replyRound({dir, pool: [agent], cfg: {stopToken: 'NO NEW FINDINGS'},
        worktree, sha: 'abc123', round: 1, findings: await findingsIn(dir),
        sessions: sessionsIn(await readEvents(dir)), onLog: line => logs.push(line)});
      assert.equal(answers[0].clean, true);
      return logs.join('\n');
    };
    const first = await invoke();
    let usage = usageFromEvents(await readEvents(dir));
    assert.equal(usage.invocations.find(i => i.action === 'reply').total, null,
      'historical thread tokens must not be charged to the resumed reply');
    assert.match(first, /tokens · unavailable/);
    assert.equal(usage.partial, true);
    const second = await invoke();
    usage = usageFromEvents(await readEvents(dir));
    assert.deepEqual(usage.invocations.filter(i => i.action === 'reply').map(i => i.total), [null, 50]);
    assert.equal(usage.total, 50);
    assert.equal(usage.partial, true);
    assert.match(second, /tokens · 50 total · 40 input · 10 output/);
    const events = await readEvents(dir);
    const replies = events.filter(e => e.t === 'reply.sent');
    assert.equal(replies.length, 2);
    assert.notEqual(replies[0].replyId, replies[1].replyId);
    const snapshots = events.filter(e => e.t === 'usage.snapshot');
    if (idless) {
      assert.ok(replies.every(e => e.resumed && !e.sessionId));
      assert.ok(snapshots.every(e => e.resumed),
        'the actual resume decision survives even without a caller session ID');
      assert.ok(snapshots.some(e => !e.resumedSessionId), 'the call starts without a known ID');
      assert.ok(snapshots.some(e => e.observedSessionId === 'old-thread'),
        'the observed identity is saved before usage or interruption');
      assert.ok(snapshots.some(e => e.records.some(r => r.sessionId === 'old-thread')),
        'the reported thread establishes the durable baseline');
    }
    assert.ok(snapshots.every(e => replies.some(reply => reply.replyId === e.replyId)),
      'every usage snapshot must retain its caller replyId');
    for (const reply of replies) {
      assert.ok(snapshots.some(e => e.replyId === reply.replyId));
      assert.ok(events.some(e => e.t === 'reply.answered' && e.replyId === reply.replyId));
    }
    if (mode === 'standalone') assert.deepEqual((await readRun(dir)).usage, usage);
  });
}

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
  const events = await readEvents(path.join(repo,'runs',slug));
  const launches = events.filter(e => e.t === 'agent.launch');
  assert.equal(launches.length,3);
  assert.equal(new Set(launches.map(e => e.reviewId)).size,3,'every review gets a distinct lifecycle ID');
  for (const launch of launches) {
    assert.ok(launch.reviewId);
    assert.ok(events.some(e => e.t === 'agent.report' && e.reviewId === launch.reviewId));
    const snapshots = events.filter(e => e.t === 'usage.snapshot' && e.action === 'review' && e.round === launch.round);
    assert.ok(snapshots.length);
    assert.ok(snapshots.every(e => e.reviewId === launch.reviewId),'review snapshots retain the caller lifecycle ID');
  }
});

test('Qwen model counters fall back when zero denotes an unreported total', () => {
  const decoder=usageDecoder({name:'qwen',report:'result-json'});
  decoder.feed(JSON.stringify({type:'result',usage:{input_tokens:100,output_tokens:20},
    stats:{models:{actual:{tokens:{prompt:100,candidates:20,total:0,cached:0,thoughts:0}}}}}));
  assert.deepEqual(decoder.finish().map(({model,input,output,total})=>({model,input,output,total})),
    [{model:'actual',input:100,output:20,total:120}]);
});
