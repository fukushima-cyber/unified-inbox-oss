import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';

test('existing four-provider database migrates without losing linked conversations',()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-provider-migration-')),path=join(dir,'inbox.sqlite');
 try{
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
   CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,token_hash TEXT UNIQUE NOT NULL,password_hash TEXT);
   CREATE TABLE connections(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),provider TEXT NOT NULL CHECK(provider IN ('line','slack','chatwork','teams')),external_account_id TEXT NOT NULL,display_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',credential TEXT,webhook_secret TEXT,bridge_hash TEXT UNIQUE,UNIQUE(id,user_id),UNIQUE(user_id,provider,external_account_id));
   CREATE TABLE conversations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,connection_id TEXT NOT NULL,external_key TEXT NOT NULL,recipient_ref TEXT NOT NULL,display_name TEXT NOT NULL,attention INTEGER NOT NULL DEFAULT 1,last_message_at TEXT,UNIQUE(id,user_id),UNIQUE(id,connection_id,user_id),UNIQUE(connection_id,external_key),FOREIGN KEY(connection_id,user_id) REFERENCES connections(id,user_id));
   INSERT INTO users VALUES('u','old@example.test','hash',NULL);
   INSERT INTO connections(id,user_id,provider,external_account_id,display_name) VALUES('c','u','line','old-line','LINE');
   INSERT INTO conversations(id,user_id,connection_id,external_key,recipient_ref,display_name) VALUES('v','u','c','thread','recipient','Person');`);
  db.close();
  const store=new Store(path,randomBytes(32));
  assert.equal(store.connection('u','c').provider,'line');
  assert.equal(store.db.prepare('SELECT connection_id FROM conversations WHERE id=?').get('v').connection_id,'c');
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  const gmail=store.addConnection('u',{provider:'gmail',externalAccountId:'old@example.test',displayName:'Gmail'});
  assert.equal(store.connection('u',gmail.id).provider,'gmail');
  store.close();
 }finally{rmSync(dir,{recursive:true,force:true})}
});
