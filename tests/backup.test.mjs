import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

test('online backup is restorable and cannot overwrite an earlier copy',()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-backup-'));
 const db=join(dir,'live.sqlite'),copy=join(dir,'copy.sqlite'),key=randomBytes(32);
 try{
  const live=new Store(db,key);
  const user=live.createUser('backup@example.test');
  const connection=live.addConnection(user.id,{provider:'line',externalAccountId:'self',displayName:'LINE'});
  const c=live.connection(user.id,connection.id);
  live.ingest(c,{eventKey:'one',externalConversationId:'room',recipientRef:'friend',displayName:'Friend',body:'first'});
  execFileSync(process.execPath,['scripts/backup.mjs',copy],{cwd:new URL('..',import.meta.url),env:{...process.env,INBOX_DB:db}});
  assert.equal(statSync(copy).mode&0o777,0o600);
  live.ingest(c,{eventKey:'two',externalConversationId:'room',recipientRef:'friend',displayName:'Friend',body:'second'});
  const restored=new Store(copy,key);
  try{assert.deepEqual(restored.inbox(user.id)[0].messages.map(m=>m.body),['first'])}finally{restored.close()}
  assert.throws(()=>execFileSync(process.execPath,['scripts/backup.mjs',copy],{cwd:new URL('..',import.meta.url),env:{...process.env,INBOX_DB:db},stdio:'pipe'}));
  assert.equal(live.inbox(user.id)[0].messages.length,2);
  live.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
