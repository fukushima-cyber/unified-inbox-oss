import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {cpSync,mkdtempSync,readFileSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {Store} from '../src/store.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
 const socket=net.createServer();
 await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
 const port=socket.address().port;
 await new Promise(resolve=>socket.close(resolve));
 return port;
}

test('one-command local setup starts and preserves the key and DB on rerun',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-setup-cli-'));
 const root=new URL('..',import.meta.url);
 for(const name of ['src','scripts','public','package.json','setup.sh'])cpSync(new URL(name,root),join(dir,name),{recursive:true});
 const port=await freePort();
 const env={...process.env,PORT:String(port)};
 const start=async()=>{
  const child=spawn('sh',['setup.sh'],{cwd:dir,env});
  let output='';
  child.stdout.on('data',chunk=>output+=chunk);
  child.stderr.on('data',chunk=>output+=chunk);
  for(let i=0;i<900;i++){
   if(child.exitCode!==null)throw Error(`setup exited: ${output}`);
   try{
    const response=await fetch(`http://127.0.0.1:${port}/api/inbox`);
    if(response.ok){
     const page=await response.json();
     if(page.authMode==='local')return {child,owner:page.user};
    }
   }catch{}
   await delay(100);
  }
  child.kill('SIGTERM');
  throw Error(`setup did not become ready: ${output}`);
 };
 let child;
 try{
  const first=await start();child=first.child;
  const keyPath=join(dir,'secrets/inbox_master_key');
  const key=readFileSync(keyPath,'utf8');
  assert.equal(first.owner.email,'owner@local.invalid');
  const initialStore=new Store(join(dir,'inbox.sqlite'),Buffer.from(key.trim(),'hex'));
  const connection=initialStore.addConnection(first.owner.id,{provider:'line',externalAccountId:'test-line',displayName:'LINE'});
  initialStore.ingest(initialStore.connection(first.owner.id,connection.id),{eventKey:'one',externalConversationId:'person-one',recipientRef:'stable-one',displayName:'Person One',body:'private'});
  initialStore.close();
  child.kill('SIGTERM');await once(child,'exit');child=null;
  const second=await start();child=second.child;
  assert.equal(readFileSync(keyPath,'utf8'),key);
  assert.equal(second.owner.id,first.owner.id);
  const store=new Store(join(dir,'inbox.sqlite'),Buffer.from(key.trim(),'hex'));
  assert.equal(store.connections(second.owner.id).length,1);
  store.close();
  child.kill('SIGTERM');await once(child,'exit');child=null;
  renameSync(keyPath,join(dir,'secrets/lost-key'));
  const failed=spawnSync('sh',['setup.sh'],{cwd:dir,env,encoding:'utf8'});
  assert.notEqual(failed.status,0);
  assert.match(failed.stderr,/元の鍵を復元/);
 }finally{
  if(child){child.kill('SIGTERM');await once(child,'exit')}
  rmSync(dir,{recursive:true,force:true});
 }
});
