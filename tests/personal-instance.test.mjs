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
async function freePort(){const s=net.createServer();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p}
test('personal instance accepts only its owner invitation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-personal-')),db=join(dir,'db.sqlite'),key=randomBytes(32).toString('hex'),port=await freePort();
 const store=new Store(db,Buffer.from(key,'hex'));
 const owner=store.createInvite('owner@example.test'),other=store.createInvite('other@example.test');store.close();
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,INBOX_MASTER_KEY:key,INBOX_DB:db,INBOX_OWNER_EMAIL:'owner@example.test',PORT:String(port)},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 try{
  let ready=false;for(let i=0;i<40;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await delay(100)}assert.equal(ready,true);
  const activate=token=>fetch(base+'/api/auth/activate',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({inviteToken:token,password:'a-long-secure-password'})});
  assert.equal((await activate(other.token)).status,403);
  assert.equal((await activate(owner.token)).status,201);
  assert.equal((await activate(other.token)).status,403);
 }finally{child.kill('SIGTERM');rmSync(dir,{recursive:true,force:true})}
});
