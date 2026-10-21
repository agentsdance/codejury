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

test('structured parse errors retain a fresh session id for the next reply',async()=>{
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:5};
 const resume={supported:true,argv:[process.execPath,'-e','', '{{sessionId}}']};
 const assigned=await runAgent({name:'assigned',report:'result-json',newSession:true,resume,
  argv:[process.execPath,'-e',"console.log('not JSON')",'{{sessionId}}']},options);
 assert.equal(assigned.ok,false);
 assert.match(assigned.sessionId,/^[0-9a-f-]{36}$/);

 const exposed=await runAgent({name:'exposed',report:'result-json',
  resume:{...resume,idFrom:'session: (\\S+)'},
  argv:[process.execPath,'-e',"console.log('session: exposed-session\\nnot JSON')"]},options);
 assert.equal(exposed.ok,false);
 assert.equal(exposed.sessionId,'exposed-session');
});

test('nonzero agents do not establish an assigned session id',async()=>{
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:1};
 const resume={supported:true,argv:[process.execPath,'-e','', '{{sessionId}}']};
 const assigned=await runAgent({name:'assigned',newSession:true,resume,
  argv:[process.execPath,'-e','process.exit(2)', '{{sessionId}}']},options);
 assert.equal(assigned.ok,false);
 assert.equal(assigned.sessionId,null,'a failed command cannot prove that its generated ID was persisted');
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

test('timed out agents retain an exposed session id for the next reply',{timeout:15000},async t=>{
 // Test the timeout handler after the provider has exposed its ID. Clock-based
 // deadline enforcement has separate coverage; Node startup must not race it.
 let triggerDeadline;
 let observed='';
 let ready=false;
 t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
  if(delay!==100) return realSetTimeout(callback,delay,...args);
  // Bound a broken fixture without assuming how quickly its child starts.
  const timer=realSetTimeout(callback,10000,...args);
  triggerDeadline=()=>{realClearTimeout(timer);callback(...args)};
  return timer;
 });
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:0.1,
  onChunk:chunk=>{observed+=chunk;if(!ready&&observed.includes('session: exposed-session')){ready=true;triggerDeadline()}}};
 const resume={supported:true,argv:[process.execPath,'-e','', '{{sessionId}}']};
 const exposed=await runAgent({name:'exposed',resume:{...resume,idFrom:'session: (\\S+)'},
  argv:[process.execPath,'-e',"console.log('session: exposed-session'); setInterval(()=>{},1000)"]},options);
 assert.equal(exposed.ok,false);
 assert.equal(ready,true,'the session output must precede the timeout');
 assert.equal(exposed.timedOut,true);
 assert.equal(exposed.sessionId,'exposed-session');
});
