import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractReport} from '../lib/agents.js';
const success={type:'result',subtype:'success',is_error:false,result:'NO NEW FINDINGS'};
test('structured agents approve only a successful final result',()=>{
 for(const data of [success,[{type:'assistant',message:'Earlier findings'},success]]) assert.equal(extractReport(JSON.stringify(data),'result-json'),'NO NEW FINDINGS');
 for(const data of [null,[],{}, {response:'NO NEW FINDINGS'}, {...success,is_error:true}, {...success,subtype:'error_max_turns'}, {...success,result:''}, [success,{type:'assistant',text:'unfinished'}]]) assert.throws(()=>extractReport(JSON.stringify(data),'result-json'));
 assert.throws(()=>extractReport('NO NEW FINDINGS','result-json'));
});
