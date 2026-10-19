import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {Store} from '../src/store.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const port=s.address().port;await new Promise(resolve=>s.close(resolve));return port}

test('Gmail and Messenger bridge accounts keep provider tokens off the server',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-new-providers-')),db=join(dir,'db.sqlite'),key=randomBytes(32).toString('hex'),port=await freePort();
 const store=new Store(db,Buffer.from(key,'hex')),owner=store.createUser('owner@example.test'),other=store.createUser('other@example.test');store.close();
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,INBOX_MASTER_KEY:key,INBOX_DB:db,PORT:String(port)},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 const call=async(path,token,payload,method='POST')=>{const r=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined});return {status:r.status,data:await r.json()}};
 try{
  let ready=false;for(let i=0;i<40;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await delay(100)}assert.equal(ready,true);
  const bad=await call('/api/connections',owner.token,{provider:'gmail',externalAccountId:owner.email,displayName:'Gmail',credential:'should-not-be-stored'});assert.equal(bad.status,400);
  const gmail=await call('/api/connections',owner.token,{provider:'gmail',externalAccountId:owner.email,displayName:'Gmail'});assert.equal(gmail.status,201);
  const gmailBridge=await call(`/api/connections/${gmail.data.id}/bridge-token`,owner.token,{});assert.equal(gmailBridge.status,200);
  assert.deepEqual((await call('/api/bridge/identity',gmailBridge.data.token,null,'GET')).data,{provider:'gmail',externalAccountId:owner.email,displayName:'Gmail'});
  assert.equal((await call('/api/bridge/events',gmailBridge.data.token,{eventKey:'gmail:m1',externalConversationId:'thread1',recipientRef:'alice@example.test',displayName:'Question',body:'Hello',externalMessageId:'m1'})).status,200);
  const inbox=(await call('/api/inbox',owner.token,null,'GET')).data;assert.equal(inbox.conversations[0].provider,'gmail');
  assert.equal((await call('/api/inbox',other.token,null,'GET')).data.conversations.length,0);
  const reply=await call('/api/replies',owner.token,{conversationId:inbox.conversations[0].id,expectedRecipientRef:'alice@example.test',requestId:'reply1',body:'Answer'});assert.equal(reply.status,202);
  const lease=await call('/api/bridge/lease',gmailBridge.data.token,{});assert.equal(lease.data.command.body,'Answer');
  assert.equal((await call(`/api/bridge/commands/${lease.data.command.id}/executing`,gmailBridge.data.token,{leaseToken:lease.data.command.leaseToken})).status,200);
  assert.equal((await call(`/api/bridge/commands/${lease.data.command.id}/result`,gmailBridge.data.token,{leaseToken:lease.data.command.leaseToken,status:'sent',externalMessageId:'gmail-sent',evidence:'gmail_api_success'})).status,200);
  const messenger=await call('/api/connections',owner.token,{provider:'messenger',externalAccountId:'own-profile',displayName:'Messenger'});assert.equal(messenger.status,201);
  const messengerBridge=await call(`/api/connections/${messenger.data.id}/bridge-token`,owner.token,{});
  const tools=await call('/mcp',messengerBridge.data.token,{jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.equal(tools.status,200);assert.ok(tools.data.result.tools.some(x=>x.name==='record_messenger_message'));assert.ok(!tools.data.result.tools.some(x=>x.name==='record_line_message'));
  assert.equal((await call('/api/bridge/events',messengerBridge.data.token,{eventKey:'m1',externalConversationId:'friend-1',recipientRef:'friend-1',displayName:'Friend',body:'Hi'})).status,200);
  const conversation=(await call('/api/inbox',owner.token,null,'GET')).data.conversations.find(x=>x.provider==='messenger');
  await call('/api/replies',owner.token,{conversationId:conversation.id,expectedRecipientRef:'friend-1',requestId:'reply2',body:'Hello'});
  const mLease=(await call('/api/bridge/lease',messengerBridge.data.token,{})).data.command;
  await call(`/api/bridge/commands/${mLease.id}/executing`,messengerBridge.data.token,{leaseToken:mLease.leaseToken});
  assert.equal((await call(`/api/bridge/commands/${mLease.id}/result`,messengerBridge.data.token,{leaseToken:mLease.leaseToken,status:'sent'})).status,409);
  assert.equal((await call(`/api/bridge/commands/${mLease.id}/result`,messengerBridge.data.token,{leaseToken:mLease.leaseToken,status:'sent',recipientVerified:true,messageVisible:true,evidence:'visible_in_chat'})).status,200);
  const check=new Store(db,Buffer.from(key,'hex'));assert.equal(check.connection(owner.id,gmail.data.id).credential,null);assert.equal(check.connection(owner.id,messenger.data.id).credential,null);check.close();
 }finally{child.kill('SIGTERM');rmSync(dir,{recursive:true,force:true})}
});
