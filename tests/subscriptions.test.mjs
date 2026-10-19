import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {runTeamsSubscriptions,notificationOrigin} from '../src/teams-subscriptions.mjs';

const key=Buffer.alloc(32,7);
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),'inbox-sub-'));const store=new Store(join(dir,'db.sqlite'),key);const user=store.createUser('a@example.com');const {id}=store.addConnection(user.id,{provider:'teams',externalAccountId:'me',displayName:'Teams',credential:'token',webhookSecret:'state'});return {store,c:store.connection(user.id,id),close:()=>{store.close();rmSync(dir,{recursive:true,force:true})}}};
const response=(body,status=200)=>({ok:status<300,status,json:async()=>body});

test('Teams subscriptions are created per chat, renewed, and bound to connection',async()=>{
 const f=fixture(),calls=[],clock=Date.parse('2026-10-18T00:00:00Z');
 try{
  const fetcher=async(url,options)=>{calls.push({url,options});if(url.includes('/me/chats'))return response({value:[{id:'chat-1'},{id:'chat-2'}]});if(options.method==='POST')return response({id:`sub-${calls.filter(x=>x.options.method==='POST').length}`,expirationDateTime:JSON.parse(options.body).expirationDateTime});if(options.method==='PATCH')return response({id:url.split('/').at(-1),expirationDateTime:JSON.parse(options.body).expirationDateTime});throw Error('unexpected')};
  const first=await runTeamsSubscriptions(f.store,f.c,'https://example.com',fetcher,clock);
  assert.equal(first.status,'healthy');assert.equal(first.maintained,2);
  assert.equal(calls[1].options.method,'POST');assert.equal(JSON.parse(calls[1].options.body).resource,'/chats/chat-1/messages');
  assert.equal(JSON.parse(calls[1].options.body).notificationUrl,`https://example.com/webhooks/teams/${f.c.id}`);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM teams_subscriptions').get().n,2);
  const second=await runTeamsSubscriptions(f.store,f.c,'https://example.com',fetcher,clock+5*60_000);
  assert.equal(second.maintained,0);
  const third=await runTeamsSubscriptions(f.store,f.c,'https://example.com',fetcher,clock+35*60_000);
  assert.equal(third.maintained,2);assert.equal(calls.filter(x=>x.options.method==='PATCH').length,2);
 }finally{f.close()}
});

test('Teams subscription errors are visible and expired credentials require reconnection',async()=>{
 const f=fixture();try{
  const result=await runTeamsSubscriptions(f.store,f.c,'https://example.com',async()=>response({},401));
  assert.equal(result.status,'failed');assert.equal(f.store.connection(f.c.user_id,f.c.id).status,'reauth_required');
  assert.equal(f.store.connections(f.c.user_id)[0].subscription_error,'graph_http_401');
  assert.throws(()=>notificationOrigin('http://example.com'),/invalid_public_origin/);
 }finally{f.close()}
});

test('changing Teams client state invalidates local subscriptions for recreation',()=>{
 const f=fixture();try{f.store.db.prepare('INSERT INTO teams_subscriptions VALUES(?,?,?,?,?,?)').run(f.c.id,f.c.user_id,'chat-1','sub-1','2026-10-18T01:00:00.000Z','oneOnOne');assert.equal(f.store.updateCredential(f.c.user_id,f.c.id,'new-token','new-state'),true);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM teams_subscriptions').get().n,0);assert.equal(f.store.connection(f.c.user_id,f.c.id).subscription_status,'gap_possible')}finally{f.close()}
});
