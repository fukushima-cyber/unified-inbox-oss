import http from 'node:http';

// Expose only the Bot bridge through an HTTPS tunnel. The inbox UI stays on localhost.
export function createMcpGateway({target='http://127.0.0.1:8787/mcp',host='127.0.0.1',port=8788}={}){
 const upstream=new URL(target);
 if(upstream.protocol!=='http:'||upstream.hostname!=='127.0.0.1'||upstream.pathname!=='/mcp'||upstream.search)throw Error('gateway_target_must_be_loopback_mcp');
 const server=http.createServer(async(req,res)=>{
  const reject=(status)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:status===401?'unauthorized':'not_found'}))};
  if(req.method!=='POST'||req.url!=='/mcp')return reject(404);
  const authorization=req.headers.authorization;
  if(typeof authorization!=='string'||!/^Bearer [^\s]+$/.test(authorization))return reject(401);
  try{
   let bytes=0;const chunks=[];
   for await(const chunk of req){bytes+=chunk.length;if(bytes>1_000_000)return reject(413);chunks.push(chunk)}
   const response=await fetch(upstream,{method:'POST',headers:{authorization,'content-type':'application/json'},body:Buffer.concat(chunks),signal:AbortSignal.timeout(15000)});
   res.writeHead(response.status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
   res.end(Buffer.from(await response.arrayBuffer()));
  }catch{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:'bridge_unavailable'}))}else res.end()}
 });
 return server.listen(port,host);
}

if(import.meta.url===`file://${process.argv[1]}`){
 const port=Number(process.env.INBOX_MCP_GATEWAY_PORT||8788);
 createMcpGateway({port});
 console.log(`MCP gateway: http://127.0.0.1:${port}/mcp`);
}
