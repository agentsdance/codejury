import {test} from 'node:test';
import assert from 'node:assert/strict';
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

test('nonzero agents retain an assigned session id for the next reply',async()=>{
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:1};
 const resume={supported:true,argv:[process.execPath,'-e','', '{{sessionId}}']};
 const assigned=await runAgent({name:'assigned',newSession:true,resume,
  argv:[process.execPath,'-e','process.exit(2)', '{{sessionId}}']},options);
 assert.equal(assigned.ok,false);
 assert.match(assigned.sessionId,/^[0-9a-f-]{36}$/);
});

test('timed out agents retain an exposed session id for the next reply',async()=>{
 const options={worktree:process.cwd(),prompt:'review',stopToken:'NO NEW FINDINGS',timeoutSeconds:0.1};
 const resume={supported:true,argv:[process.execPath,'-e','', '{{sessionId}}']};
 const exposed=await runAgent({name:'exposed',resume:{...resume,idFrom:'session: (\\S+)'},
  argv:[process.execPath,'-e',"console.log('session: exposed-session'); setInterval(()=>{},1000)"]},options);
 assert.equal(exposed.ok,false);
 assert.equal(exposed.timedOut,true);
 assert.equal(exposed.sessionId,'exposed-session');
});
