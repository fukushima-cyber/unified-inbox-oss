import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {Store} from '../src/store.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test('Teams device flow creates an owner connection and encrypts the refresh token',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-teams-device-')),db=join(dir,'data.sqlite'),key=randomBytes(32).toString('hex'),port=await freePort();
 const store=new Store(db,Buffer.from(key,'hex')),owner=store.createUser('owner@example.test');store.close();
 const child=spawn(process.execPath,['--import','./tests/helpers/mock-teams.mjs','src/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,INBOX_MASTER_KEY:key,INBOX_DB:db,PORT:String(port)},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;
 const call=async(path,body)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${owner.token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()}};
 try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await pause(100)}assert.equal(ready,true);
  const start=await call('/api/teams/device/start',{clientId:'11111111-1111-4111-8111-111111111111',tenantId:'22222222-2222-4222-8222-222222222222'});
  assert.equal(start.status,202);assert.equal(start.data.userCode,'TESTCODE');assert.ok(!JSON.stringify(start.data).includes('test-device-private'));
  assert.equal((await call(`/api/teams/device/${start.data.id}`)).status,404);
  await pause(5100);
  const result=await call(`/api/teams/device/${start.data.id}`,{});
  assert.equal(result.data.status,'connected');
  const check=new Store(db,Buffer.from(key,'hex'));
  const connection=check.connection(owner.id,result.data.connectionId);
  assert.equal(connection.external_account_id,'33333333-3333-4333-8333-333333333333');
  assert.ok(!JSON.stringify(check.db.prepare('SELECT * FROM teams_oauth').get()).includes('test-refresh-private'));
  check.close();
 }finally{child.kill('SIGTERM');rmSync(dir,{recursive:true,force:true})}
});
