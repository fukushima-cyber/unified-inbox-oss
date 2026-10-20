import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {request} from 'node:http';
import net from 'node:net';
import {Store} from '../src/store.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port}

test('local personal instance opens for its owner without credentials and rejects cross-site access',async()=>{
 const tmp=mkdtempSync(join(tmpdir(),'inbox-local-')),db=join(tmp,'data.sqlite'),key=randomBytes(32).toString('hex'),port=await freePort();
 const store=new Store(db,Buffer.from(key,'hex'));
 const owner=store.createUser('owner@example.test');
 const line=store.addConnection(owner.id,{provider:'line',externalAccountId:'owner-line',displayName:'LINE'});
 const conversation=store.ingest(store.connection(owner.id,line.id),{eventKey:'one',externalConversationId:'person-one',recipientRef:'stable-one',displayName:'Person One',body:'private'}).conversationId;
 store.close();
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,INBOX_MASTER_KEY:key,INBOX_DB:db,INBOX_OWNER_EMAIL:'owner@example.test',INBOX_LOCAL_NO_LOGIN:'1',INBOX_HOST:'127.0.0.1',INBOX_PUBLIC_ORIGIN:'',PORT:String(port)},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;for(let i=0;i<300;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await delay(100)}assert.equal(ready,true);
  const inbox=await fetch(base+'/api/inbox');assert.equal(inbox.status,200);const page=await inbox.json();assert.equal(page.authMode,'local');assert.equal(page.user.id,owner.id);assert.equal(page.conversations[0].id,conversation);
  const post=(origin,headers={})=>fetch(base+`/api/conversations/${conversation}/attention`,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:JSON.stringify({attention:false})});
  assert.equal((await post('https://evil.example')).status,403);
  assert.equal((await fetch(base+'/api/inbox',{headers:{'sec-fetch-site':'cross-site'}})).status,403);
  assert.equal((await post(base)).status,200);
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:base}})).status,404);
  const spoofedHost=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/api/inbox',headers:{host:`evil.example:${port}`}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()});
  assert.equal(spoofedHost,403);
 }finally{child.kill('SIGTERM');rmSync(tmp,{recursive:true,force:true})}
});
