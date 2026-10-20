import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {normalizeAttachments} from '../src/attachments.mjs';
import {replyMime} from '../src/gmail-agent.mjs';

const file={name:'資料.pdf',type:'application/pdf',data:Buffer.from('sample attachment').toString('base64')};

test('attachment limits and provider capability are enforced',()=>{
 assert.equal(normalizeAttachments([file],'gmail')[0].size,17);
 assert.throws(()=>normalizeAttachments([file],'teams'),/attachments_not_supported/);
 assert.throws(()=>normalizeAttachments([file,file],'chatwork'),/too_many_attachments/);
 assert.equal(normalizeAttachments([{...file,name:'bad\r\nname'}],'gmail')[0].name,'badname');
});

test('Gmail reply includes a MIME attachment with a safe filename',()=>{
 const raw=Buffer.from(replyMime({from:'me@example.test',to:'you@example.test',subject:'資料',messageId:'<m@example.test>',body:'本文',attachments:normalizeAttachments([file],'gmail')}),'base64url').toString('utf8');
 assert.match(raw,/Content-Type: multipart\/mixed/);
 assert.match(raw,/filename\*=UTF-8''/);
 assert.match(raw,/Content-Type: application\/pdf/);
 assert.match(raw,/c2FtcGxlIGF0dGFjaG1lbnQ=/);
});

test('queued files stay encrypted, sent files keep only display metadata, and insights stay local',()=>{
 const store=new Store(':memory:',randomBytes(32));const user=store.createUser('me@example.test');const connection=store.addConnection(user.id,{provider:'gmail',externalAccountId:'me@example.test',displayName:'Gmail'});const c=store.connection(user.id,connection.id);
 store.db.prepare('UPDATE connections SET last_sync_at=? WHERE id=?').run(new Date().toISOString(),c.id);
 let conversationId;for(let i=0;i<3;i++)conversationId=store.ingest(c,{eventKey:`e${i}`,externalConversationId:'thread',recipientRef:'you@example.test',displayName:'You',body:'同じ問い合わせが届きました',externalMessageId:`m${i}`,sourceAt:new Date().toISOString()}).conversationId;
 const result=store.command(user.id,{conversationId,requestId:'request-1',expectedRecipientRef:'you@example.test',body:'お送りします',attachments:[file]});const row=store.db.prepare('SELECT attachments FROM commands WHERE id=?').get(result.id);assert.ok(row.attachments);assert.ok(!row.attachments.includes(file.data));
 const lease=store.lease(c);assert.deepEqual(lease.attachments[0].name,file.name);assert.equal(store.executing(c,result.id,lease.leaseToken),true);assert.equal(store.finish(c,result.id,{leaseToken:lease.leaseToken,status:'sent',externalMessageId:'sent-1'}),true);
 assert.equal(store.db.prepare('SELECT attachments FROM commands WHERE id=?').get(result.id).attachments,null);assert.deepEqual(store.messagePage(user.id,conversationId).messages.at(-1).attachments,[{name:file.name,type:file.type,size:17}]);
 const stats=store.insights(user.id);assert.equal(stats.chats,1);assert.equal(stats.received,3);assert.equal(stats.sent,1);assert.equal(stats.suggestions[0].id,'template');store.close();
});
