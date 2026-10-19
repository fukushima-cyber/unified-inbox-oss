import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

test('setup invite rotates pending codes but preserves active accounts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-setup-'));
 const db=join(dir,'inbox.sqlite');
 const key=randomBytes(32).toString('hex');
 const keyFile=join(dir,'key');
 writeFileSync(keyFile,key);
 const env={...process.env,INBOX_DB:db,INBOX_MASTER_KEY_FILE:keyFile};
 const run=()=>JSON.parse(execFileSync(process.execPath,['scripts/setup-invite.mjs','person@example.test'],{cwd:new URL('..',import.meta.url),env,encoding:'utf8'}));
 try{
  const first=run();
  assert.equal(first.status,'invited');
  assert.equal(first.email,'person@example.test');
  const second=run();
  assert.equal(second.status,'invited');
  assert.notEqual(second.token,first.token);
  const store=new Store(db,Buffer.from(key,'hex'));
  assert.equal(store.validInvite(first.token),undefined);
  assert.equal(store.validInvite(second.token).email,'person@example.test');
  store.activateInvite(second.token,'stored-password-hash');
  store.close();
  assert.deepEqual(run(),{email:'person@example.test',status:'already_active'});
 }finally{rmSync(dir,{recursive:true,force:true})}
});
