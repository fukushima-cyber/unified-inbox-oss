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
async function freePort(){const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port}
test('invited users activate private browser sessions and remain isolated',async()=>{
 const tmp=mkdtempSync(join(tmpdir(),'inbox-auth-')),db=join(tmp,'data.sqlite'),key=randomBytes(32).toString('hex'),port=await freePort();
 const store=new Store(db,Buffer.from(key,'hex'));
 const legacy=store.createUser('alice@example.test');const line=store.addConnection(legacy.id,{provider:'line',externalAccountId:'alice-line',displayName:'LINE'});
 const conversation=store.ingest(store.connection(legacy.id,line.id),{eventKey:'one',externalConversationId:'person-one',recipientRef:'stable-one',displayName:'Person One',body:'private'}).conversationId;
 const inviteA=store.createInvite('alice@example.test'),inviteB=store.createInvite('bob@example.test');store.close();
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,INBOX_MASTER_KEY:key,INBOX_DB:db,PORT:String(port)},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;const post=async(path,data,cookie='',origin=base)=>fetch(base+path,{method:'POST',headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},body:JSON.stringify(data)});
 try{let ready=false;for(let i=0;i<300;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await delay(100)}assert.equal(ready,true);
  assert.equal((await post('/api/auth/activate',{inviteToken:inviteA.token,password:'too-short'})).status,400);
  const activated=await post('/api/auth/activate',{inviteToken:inviteA.token,password:'alice-strong-passphrase'});assert.equal(activated.status,201);
  const cookieA=activated.headers.get('set-cookie');assert.match(cookieA,/HttpOnly/);assert.match(cookieA,/SameSite=Strict/);assert.match(cookieA,/Max-Age=604800/);
  assert.equal((await post('/api/auth/activate',{inviteToken:inviteA.token,password:'alice-strong-passphrase'})).status,401);
  assert.equal((await fetch(base+'/api/inbox',{headers:{authorization:`Bearer ${legacy.token}`}})).status,401);
  const inboxA=await fetch(base+'/api/inbox',{headers:{cookie:cookieA}});assert.equal(inboxA.status,200);assert.equal((await inboxA.json()).conversations[0].id,conversation);
  const activatedB=await post('/api/auth/activate',{inviteToken:inviteB.token,password:'bob-strong-passphrase'});assert.equal(activatedB.status,201);
  const cookieB=activatedB.headers.get('set-cookie');const inboxB=await fetch(base+'/api/inbox',{headers:{cookie:cookieB}});assert.equal((await inboxB.json()).conversations.length,0);
  assert.equal((await post(`/api/conversations/${conversation}/attention`,{attention:false},cookieB)).status,404);
  assert.equal((await post(`/api/conversations/${conversation}/attention`,{attention:false},cookieA,'https://evil.example')).status,403);
  assert.equal((await post('/api/auth/logout',{},cookieA)).status,200);assert.equal((await fetch(base+'/api/inbox',{headers:{cookie:cookieA}})).status,401);
  assert.equal((await post('/api/auth/login',{email:'alice@example.test',password:'wrong-password'})).status,401);
  const loggedIn=await post('/api/auth/login',{email:'alice@example.test',password:'alice-strong-passphrase'});assert.equal(loggedIn.status,200);assert.match(loggedIn.headers.get('set-cookie'),/HttpOnly/);
  assert.equal((await fetch(base+'/api/inbox',{headers:{cookie:loggedIn.headers.get('set-cookie')}})).status,200);
 }finally{child.kill('SIGTERM');rmSync(tmp,{recursive:true,force:true})}
});
