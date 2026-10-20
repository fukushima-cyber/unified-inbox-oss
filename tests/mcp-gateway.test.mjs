import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createMcpGateway} from '../scripts/mcp-gateway.mjs';

test('MCP gateway exposes only authenticated POST /mcp and does not forward browser cookies',async()=>{
 const seen=[];
 const upstream=http.createServer(async(req,res)=>{seen.push({url:req.url,method:req.method,authorization:req.headers.authorization,cookie:req.headers.cookie,origin:req.headers.origin});res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}')});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
 const gateway=createMcpGateway({target:`http://127.0.0.1:${upstream.address().port}/mcp`,port:0});
 try{
  await new Promise(resolve=>gateway.listening?resolve():gateway.once('listening',resolve));
  const base=`http://127.0.0.1:${gateway.address().port}`;
  for(const path of ['/','/api/inbox','/mcp?other=1'])assert.equal((await fetch(base+path,{method:'POST',headers:{authorization:'Bearer test'}})).status,404);
  assert.equal((await fetch(base+'/mcp',{method:'GET',headers:{authorization:'Bearer test'}})).status,404);
  assert.equal((await fetch(base+'/mcp',{method:'POST'})).status,401);
  const response=await fetch(base+'/mcp',{method:'POST',headers:{authorization:'Bearer test',cookie:'inbox_session=private',origin:'https://example.test','content-type':'application/json'},body:'{"jsonrpc":"2.0"}'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
  assert.deepEqual(seen,[{url:'/mcp',method:'POST',authorization:'Bearer test',cookie:undefined,origin:undefined}]);
 }finally{await new Promise(resolve=>gateway.close(resolve));await new Promise(resolve=>upstream.close(resolve))}
});
