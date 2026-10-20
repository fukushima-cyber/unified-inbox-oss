import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GmailAgent,incomingGmail,replyMime} from '../src/gmail-agent.mjs';

const message={id:'m1',threadId:'t1',labelIds:['INBOX'],internalDate:'1760000000000',snippet:'fallback',payload:{mimeType:'text/plain',headers:[{name:'From',value:'Alice <alice@example.test>'},{name:'Reply-To',value:'Alice <alice@example.test>'},{name:'Subject',value:'Question'},{name:'Message-ID',value:'<m1@example.test>'}],body:{data:Buffer.from('Hello from Gmail').toString('base64url')}}};

test('Gmail parsing fixes the sender and thread and safely builds a reply',()=>{
 const event=incomingGmail(message,'owner@example.test');
 assert.equal(event.eventKey,'gmail:m1');
 assert.equal(event.externalConversationId,'t1');
 assert.equal(event.recipientRef,'alice@example.test');
 assert.equal(event.displayName,'Question');
 assert.equal(event.senderName,'Alice <alice@example.test>');
 assert.equal(event.body,'Hello from Gmail');
 assert.equal(incomingGmail({...message,payload:{...message.payload,headers:message.payload.headers.filter(x=>x.name!=='Subject')}},'owner@example.test').displayName,'（件名なし）');
 assert.throws(()=>incomingGmail({...message,payload:{...message.payload,headers:[...message.payload.headers.filter(x=>x.name!=='Reply-To'),{name:'Reply-To',value:'a@example.test, b@example.test'}]}},'owner@example.test'),/gmail_recipient_ambiguous/);
 const raw=Buffer.from(replyMime({from:'owner@example.test',to:event.recipientRef,subject:'Question',messageId:'<m1@example.test>',body:'返信です'}),'base64url').toString('utf8');
 assert.match(raw,/To: alice@example\.test\r\n/);
 assert.match(raw,/In-Reply-To: <m1@example\.test>\r\n/);
 assert.match(raw,/Subject: =\?UTF-8\?B\?UmU6IFF1ZXN0aW9u\?=\r\n/);
 const long=Buffer.from(replyMime({from:'owner@example.test',to:'alice@example.test',subject:'長い件名'.repeat(80),messageId:'<m1@example.test>',body:'返事'}),'base64url').toString('utf8');
 const subjectLines=long.split('\r\n').filter(x=>x.startsWith('Subject: ')||x.startsWith(' =?UTF-8?B?'));
 assert.ok(subjectLines.length>1);
 assert.ok(subjectLines.every(x=>Buffer.byteLength(x)<=78));
 assert.throws(()=>replyMime({from:'owner@example.test',to:'alice@example.test\r\nBcc: evil@example.test',subject:'x',messageId:'<m1@example.test>',body:'x'}));
});

test('Gmail agent syncs and replies while keeping OAuth tokens off the inbox',async()=>{
 const calls=[],saved=[];
 const config={inboxUrl:'https://inbox.example.test',bridgeToken:'bridge-secret',email:'owner@example.test',clientId:'own-client-id',refreshToken:'gmail-refresh-secret',historyId:''};
 const fetcher=async(url,init={})=>{
  calls.push({url:String(url),init});
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'gmail-access-secret',expires_in:3600});
  if(url.endsWith('/api/bridge/identity'))return Response.json({provider:'gmail',externalAccountId:config.email});
  if(url.endsWith('/profile'))return Response.json({emailAddress:config.email,historyId:'42'});
  if(String(url).includes('/messages?'))return Response.json({messages:[{id:'m1'}]});
  if(String(url).includes('/messages/m1?'))return Response.json(message);
  if(url.endsWith('/api/bridge/events'))return Response.json({id:'stored'});
  if(url.endsWith('/api/bridge/heartbeat'))return Response.json({ok:true});
  if(url.endsWith('/api/bridge/lease'))return Response.json({command:{id:'cmd1',leaseToken:'lease1',body:'Reply body',conversation:{external_key:'t1',recipient_ref:'alice@example.test'}}});
  if(String(url).includes('/threads/t1?'))return Response.json({messages:[message]});
  if(url.endsWith('/api/bridge/commands/cmd1/executing'))return Response.json({ok:true});
  if(url.endsWith('/messages/send'))return Response.json({id:'sent-id',threadId:'t1'});
  if(url.endsWith('/api/bridge/commands/cmd1/result'))return Response.json({ok:true});
  throw Error(`Unexpected URL: ${url}`);
 };
 const agent=new GmailAgent(config,x=>saved.push({...x}),fetcher);
 assert.deepEqual(await agent.sync(),{gapPossible:false});
 assert.equal(config.historyId,'42');
 assert.equal(saved.at(-1).historyId,'42');
 assert.deepEqual(await agent.reply(),{status:'sent',id:'sent-id'});
 const event=JSON.parse(calls.find(x=>x.url.endsWith('/api/bridge/events')).init.body);
 assert.equal(event.body,'Hello from Gmail');
 const send=JSON.parse(calls.find(x=>x.url.endsWith('/messages/send')).init.body);
 assert.equal(send.threadId,'t1');
 assert.match(Buffer.from(send.raw,'base64url').toString('utf8'),/To: alice@example\.test/);
 for(const call of calls.filter(x=>x.url.startsWith('https://inbox.example.test'))){
  assert.equal(call.init.headers.authorization,'Bearer bridge-secret');
  assert.ok(!JSON.stringify(call.init).includes('gmail-refresh-secret'));
  assert.ok(!JSON.stringify(call.init).includes('gmail-access-secret'));
 }
});

test('an uncertain Gmail send is never reported as sent',async()=>{
 const results=[];
 const config={inboxUrl:'https://inbox.example.test',bridgeToken:'bridge-secret',email:'owner@example.test',clientId:'own-client-id',refreshToken:'refresh',historyId:'42'};
 const fetcher=async(url,init={})=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'access',expires_in:3600});
  if(url.endsWith('/api/bridge/lease'))return Response.json({command:{id:'cmd1',leaseToken:'lease1',body:'Reply',conversation:{external_key:'t1',recipient_ref:'alice@example.test'}}});
  if(String(url).includes('/threads/t1?'))return Response.json({messages:[message]});
  if(url.endsWith('/api/bridge/commands/cmd1/executing'))return Response.json({ok:true});
  if(url.endsWith('/messages/send'))throw Error('timeout');
  if(url.endsWith('/api/bridge/commands/cmd1/result')){results.push(JSON.parse(init.body));return Response.json({ok:true})}
  throw Error(`Unexpected URL: ${url}`);
 };
 const agent=new GmailAgent(config,()=>{},fetcher);
 assert.equal((await agent.reply()).status,'uncertain');
 assert.equal(results[0].status,'uncertain');
});

test('expired Gmail history stays visibly incomplete after a recent rescan',async()=>{
 const heartbeats=[],config={inboxUrl:'https://inbox.example.test',bridgeToken:'bridge',email:'owner@example.test',clientId:'client',refreshToken:'refresh',historyId:'old'};
 const fetcher=async(url,init={})=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'access',expires_in:3600});
  if(url.endsWith('/api/bridge/identity'))return Response.json({provider:'gmail',externalAccountId:config.email});
  if(String(url).includes('/history?'))return Response.json({error:'notFound'},{status:404});
  if(url.endsWith('/profile'))return Response.json({emailAddress:config.email,historyId:'new'});
  if(String(url).includes('/messages?'))return Response.json({messages:[]});
  if(url.endsWith('/api/bridge/heartbeat')){heartbeats.push(JSON.parse(init.body));return Response.json({ok:true})}
  throw Error(`Unexpected URL: ${url}`);
 };
 const agent=new GmailAgent(config,()=>{},fetcher);
 assert.deepEqual(await agent.sync(),{gapPossible:true});
 assert.equal(config.historyId,'');
 assert.deepEqual(await agent.sync(),{gapPossible:true});
 assert.equal(config.historyId,'new');
 assert.deepEqual(heartbeats.map(x=>x.gapPossible),[true,true]);
});

test('initial Gmail sync resumes after a failed message without listing mail again',async()=>{
 const config={inboxUrl:'https://inbox.example.test',bridgeToken:'bridge',email:'owner@example.test',clientId:'client',refreshToken:'refresh',historyId:''};
 let lists=0,firstAttempts=0;
 const fetcher=async(url)=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'access',expires_in:3600});
  if(url.endsWith('/api/bridge/identity'))return Response.json({provider:'gmail',externalAccountId:config.email});
  if(url.endsWith('/profile'))return Response.json({emailAddress:config.email,historyId:'42'});
  if(String(url).includes('/messages?')){lists++;return Response.json({messages:[{id:'m2'},{id:'m1'}]})}
  if(String(url).includes('/messages/m1?')){firstAttempts++;return firstAttempts===1?Response.json({error:{errors:[{reason:'forbidden'}]}},{status:403}):Response.json({...message,id:'m1'})}
  if(String(url).includes('/messages/m2?'))return Response.json({...message,id:'m2'});
  if(url.endsWith('/api/bridge/events'))return Response.json({ok:true});
  if(url.endsWith('/api/bridge/heartbeat'))return Response.json({ok:true});
  throw Error(`Unexpected URL: ${url}`);
 };
 const agent=new GmailAgent(config,()=>{},fetcher);
 await assert.rejects(agent.sync(),/gmail_http_403/);
 assert.deepEqual(config.pendingMessageIds,['m1','m2']);
 assert.deepEqual(await agent.sync(),{gapPossible:false});
 assert.equal(lists,1);
 assert.equal(config.historyId,'42');
 assert.equal(config.pendingMessageIds,undefined);
});
