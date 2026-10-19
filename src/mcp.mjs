// Stateless MCP bridge. Browser credentials remain in the user's own Bot session.
const specFor=provider=>[
 {name:`record_${provider}_message`,description:`Record one observed incoming ${provider} message. Use a stable eventKey; never invent a sender or recipient identity.`,inputSchema:{type:'object',required:['eventKey','externalConversationId','recipientRef','displayName','body'],properties:{eventKey:{type:'string'},externalConversationId:{type:'string'},recipientRef:{type:'string'},displayName:{type:'string'},body:{type:'string'},externalMessageId:{type:'string'},senderName:{type:'string'},sourceAt:{type:'string'}}}},
 {name:'claim_reply',description:`Lease one reply for this authenticated ${provider} account. If none, returns null.`,inputSchema:{type:'object',properties:{}}},
 {name:'mark_reply_started',description:`Call immediately before touching the ${provider} send UI, after verifying the recipient against the leased conversation.`,inputSchema:{type:'object',required:['id','leaseToken'],properties:{id:{type:'string'},leaseToken:{type:'string'}}}},
 {name:'report_reply_result',description:`Report sent only after the exact recipient and sent text are visible in ${provider}. If any doubt remains, report uncertain. Never click send again for an uncertain command.`,inputSchema:{type:'object',required:['id','leaseToken','status'],properties:{id:{type:'string'},leaseToken:{type:'string'},status:{type:'string',enum:['sent','failed','uncertain']},evidence:{type:'string'},errorCode:{type:'string'},externalMessageId:{type:'string'},recipientVerified:{type:'boolean'},messageVisible:{type:'boolean'}}}},
 {name:'report_sync_status',description:`Report whether this ${provider} browser sync completed or may have missed messages.`,inputSchema:{type:'object',properties:{gapPossible:{type:'boolean'},error:{type:'string'}}}}
];
const respond=(res,status,x)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(x))};
export async function mcp(req,res,store,c,readBody){
 if(!c)return respond(res,401,{error:'unauthorized'});
 const spec=specFor(c.provider);
 if(req.headers.origin && req.headers.origin!==process.env.INBOX_PUBLIC_ORIGIN)return respond(res,403,{error:'origin_not_allowed'});
 if(req.method==='GET'||req.method==='DELETE')return respond(res,405,{error:'method_not_allowed'});
 if(req.method!=='POST')return respond(res,405,{error:'method_not_allowed'});
 const {data}=await readBody(req);
 if(data.jsonrpc!=='2.0'||typeof data.method!=='string')return respond(res,400,{error:'invalid_jsonrpc'});
 if(data.id===undefined){res.writeHead(202);return res.end()}
 const ok=result=>respond(res,200,{jsonrpc:'2.0',id:data.id,result});
 const error=(code,message)=>respond(res,200,{jsonrpc:'2.0',id:data.id,error:{code,message}});
 if(data.method==='initialize')return ok({protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:`unified-inbox-${c.provider}`,version:'0.1.0'}});
 if(data.method==='ping')return ok({});
 if(data.method==='tools/list')return ok({tools:spec});
 if(data.method!=='tools/call')return error(-32601,'Method not found');
 const name=data.params?.name,a=data.params?.arguments||{};
 try{let value;
  if(name===spec[0].name){for(const k of spec[0].inputSchema.required)if(typeof a[k]!=='string'||!a[k].trim())throw Error('invalid_'+k);if(a.body.length>20000)throw Error('body_too_large');value=store.ingest(c,a)}
  else if(name==='claim_reply')value={command:store.lease(c)};
  else if(name==='mark_reply_started')value={ok:store.executing(c,a.id,a.leaseToken)};
  else if(name==='report_reply_result'){if(!['sent','failed','uncertain'].includes(a.status))throw Error('invalid_status');value={ok:store.finish(c,a.id,a)}}
  else if(name==='report_sync_status'){if(typeof a.error!=='undefined'&&(typeof a.error!=='string'||a.error.length>120))throw Error('invalid_error');if(typeof a.gapPossible!=='undefined'&&typeof a.gapPossible!=='boolean')throw Error('invalid_gapPossible');store.beginSync(c);store.finishSync(c,{error:a.error||'',gapPossible:a.gapPossible===true});value={ok:true}}
  else return error(-32602,'Unknown tool');
  return ok({content:[{type:'text',text:JSON.stringify(value)}],isError:value?.ok===false});
 }catch(e){return ok({content:[{type:'text',text:String(e.message)}],isError:true})}
}
