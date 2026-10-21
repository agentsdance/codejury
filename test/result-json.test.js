import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as realSetTimeout,clearTimeout as realClearTimeout} from 'node:timers';
import {extractReport,runAgent} from '../lib/agents.js';
const success={type:'result',subtype:'success',is_error:false,result:'NO NEW FINDINGS'};
test('structured agents approve only a successful final result',()=>{
 for(const data of [success,[{type:'assistant',message:'Earlier findings'},success]]) assert.equal(extractReport(JSON.stringify(data),'result-json'),'NO NEW FINDINGS');
 for(const data of [null,[],{}, {response:'NO NEW FINDINGS'}, {...success,is_error:true}, {...success,subtype:'error_max_turns'}, {...success,result:''}, [success,{type:'assistant',text:'unfinished'}]]) assert.throws(()=>extractReport(JSON.stringify(data),'result-json'));
 assert.throws(()=>extractReport('NO NEW FINDINGS','result-json'));
});

test('structured parse errors retain only known or exposed session ids',async()=>{
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:5};
 const resume={supported:true,argv:[process.execPath,'-e','', '{{sessionId}}']};
 for(const output of ['not JSON',JSON.stringify({...success,is_error:true}),JSON.stringify({...success,result:''})]) {
  const argv=[process.execPath,'-e',`console.log(${JSON.stringify(output)})`,'{{sessionId}}'];
  const agent={name:'assigned',report:'result-json',newSession:true,resume:{...resume,argv},argv};
  const assigned=await runAgent(agent,options);
  assert.equal(assigned.ok,false);
  assert.equal(assigned.sessionId,null,'invalid provider output cannot establish a generated session');
  const known=await runAgent(agent,{...options,sessionId:'known-session'});
  assert.equal(known.ok,false);
  assert.equal(known.sessionId,'known-session');
 }

 const accepted=await runAgent({name:'assigned',report:'result-json',newSession:true,resume,
  argv:[process.execPath,'-e',`console.log(${JSON.stringify(JSON.stringify(success))})`,'{{sessionId}}']},options);
 assert.equal(accepted.ok,true);
 assert.match(accepted.sessionId,/^[0-9a-f-]{36}$/);

 const exposed=await runAgent({name:'exposed',report:'result-json',
  resume:{...resume,idFrom:'session: (\\S+)'},
  argv:[process.execPath,'-e',"console.log('session: exposed-session\\nnot JSON')"]},options);
 assert.equal(exposed.ok,false);
 assert.equal(exposed.sessionId,'exposed-session');
});

test('nonzero agents retain only known or exposed session ids',async()=>{
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:5};
 const resume={supported:true,argv:[process.execPath,'-e','process.exit(2)', '{{sessionId}}']};
 const assigned=await runAgent({name:'assigned',newSession:true,resume,
  argv:[process.execPath,'-e','process.exit(2)', '{{sessionId}}']},options);
 assert.equal(assigned.ok,false);
 assert.equal(assigned.sessionId,null,'a failed command cannot prove that its generated ID was persisted');
 const known=await runAgent({name:'known',argv:resume.argv,resume},{...options,sessionId:'known-session'});
 assert.equal(known.ok,false);
 assert.equal(known.sessionId,'known-session');
 const exposed=await runAgent({name:'exposed',newSession:true,resume:{...resume,idFrom:'session: (\\S+)'},
  argv:[process.execPath,'-e',"console.log('session: '+process.argv[1]); process.exit(2)",'{{sessionId}}']},options);
 assert.equal(exposed.ok,false);
 assert.match(exposed.sessionId,/^[0-9a-f-]{36}$/,'an explicitly reported ID can survive a later failure');
});

test('launch failures do not establish newly assigned sessions',async()=>{
 const agent={name:'missing',newSession:true,
  argv:['jury-missing-session-fixture','{{sessionId}}'],
  resume:{supported:true,argv:['jury-missing-session-fixture','--resume','{{sessionId}}']}};
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS'};
 const fresh=await runAgent(agent,options);
 assert.equal(fresh.ok,false);
 assert.match(fresh.report,/ENOENT/);
 assert.equal(fresh.sessionId,null,'an executable that never starts cannot receive its generated ID');
 const resumed=await runAgent(agent,{...options,sessionId:'known-session'});
 assert.equal(resumed.ok,false);
 assert.equal(resumed.sessionId,'known-session','a failed launch must not erase an already known session');
});

test('timed out agents retain only known or exposed session ids',{timeout:15000},async t=>{
 // Test the timeout handler after the provider has exposed its ID. Clock-based
 // deadline enforcement has separate coverage; Node startup must not race it.
 let triggerDeadline;
 t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
  if(delay!==100) return realSetTimeout(callback,delay,...args);
  // Bound a broken fixture without assuming how quickly its child starts.
  const timer=realSetTimeout(callback,10000,...args);
  triggerDeadline=()=>{realClearTimeout(timer);callback(...args)};
  return timer;
 });
 for(const kind of ['exposed','assigned','known']) {
  let observed='';
  let ready=false;
  const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:0.1,
   ...(kind==='known'?{sessionId:'known-session'}:{}),
   onChunk:chunk=>{observed+=chunk;if(!ready&&observed.includes('ready')){ready=true;triggerDeadline()}}};
  const output=kind==='exposed'?'session: exposed-session\nready':'ready';
  // Exit zero when terminated to verify that timeout status still rejects an
  // unconfirmed assigned ID. Readiness makes this independent of startup time.
  const argv=[process.execPath,'-e',`process.on('SIGTERM',()=>process.exit(0));console.log(${JSON.stringify(output)});setInterval(()=>{},1000)`,'{{sessionId}}'];
  const result=await runAgent({name:kind,newSession:true,argv,
   resume:{supported:true,argv,idFrom:'session: (\\S+)'}},options);
  assert.equal(result.ok,false);
  assert.equal(ready,true,'the provider must be ready before the timeout');
  assert.equal(result.timedOut,true);
  assert.equal(result.sessionId,kind==='exposed'?'exposed-session':kind==='known'?'known-session':null);
 }
});
