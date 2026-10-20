import {open} from './security.mjs';

const MAX_ROOMS=40;
const HEADROOM=10;
const asIso=seconds=>new Date(Number(seconds)*1000).toISOString();
export const cleanHtml=value=>String(value??'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&');

async function slackSenderName(store,c,userId,credential,fetcher,cache){
 if(!userId)return '';
 if(cache.has(userId))return cache.get(userId);
 if(cache.get('unavailable')||cache.size>=30)return userId;
 try{
  const url=new URL('https://slack.com/api/users.info');url.searchParams.set('user',userId);
  const response=await fetcher(url,{headers:{authorization:`Bearer ${credential}`},signal:AbortSignal.timeout(12000)});
  if(!response.ok)return userId;
  const result=await response.json();
  if(!result.ok){if(['missing_scope','not_allowed_token_type'].includes(result.error))cache.set('unavailable',true);return userId}
  const name=String(result.user?.profile?.display_name||result.user?.profile?.real_name||result.user?.real_name||result.user?.name||'').trim().slice(0,200);
  if(!name)return userId;
  cache.set(userId,name);
  store.db.prepare('UPDATE messages SET sender_name=? WHERE user_id=? AND sender_name=? AND conversation_id IN (SELECT id FROM conversations WHERE user_id=? AND connection_id=?)').run(name,c.user_id,userId,c.user_id,c.id);
  return name;
 }catch{return userId}
}

export async function reconcileSlack(store,c,fetcher=fetch){
 const credential=c.credential&&open(store.key,c.credential);if(!credential)throw Error('missing_credential');
 const now=Date.now(),previous=Date.parse(c.last_sync_at||'');
 const oldest=now-7*86400000;
 const since=Number.isFinite(previous)?Math.max(oldest,previous-86400000):oldest;
 const date=new Date(since).toISOString().slice(0,10);
 let checkedRooms=0,gapPossible=Number.isFinite(previous)&&previous<oldest;const senderCache=new Map();
 const queries=[`to:me after:${date}`,`"<@${c.external_account_id}>" after:${date}`];
 for(const query of queries){
  for(let page=1;page<=5;page++){
   const url=new URL('https://slack.com/api/search.messages');
   for(const [key,value] of Object.entries({query,count:'100',page:String(page),sort:'timestamp',sort_dir:'desc'}))url.searchParams.set(key,value);
   const response=await fetcher(url,{headers:{authorization:`Bearer ${credential}`},signal:AbortSignal.timeout(12000)});
   if(!response.ok){const error=Error(`provider_http_${response.status}`);error.status=response.status;throw error}
   const result=await response.json();if(result.ok!==true||!Array.isArray(result.messages?.matches))throw Error(`slack_${String(result.error||'invalid_search_response').slice(0,60)}`);
   const matches=result.messages.matches;
   for(const m of matches){
    const channel=String(m.channel?.id||''),stamp=Number(m.ts),body=String(m.text||'');
    if(!channel||!Number.isFinite(stamp)||!body||m.user===c.external_account_id)continue;
    if(m.type!=='im'&&!m.channel?.is_im&&!body.includes(`<@${c.external_account_id}>`))continue;
    const userId=String(m.user||''),profileName=String(m.user_profile?.display_name||m.username||'').trim().slice(0,200);
    const senderName=profileName||await slackSenderName(store,c,userId,credential,fetcher,senderCache);
    if(profileName&&userId)store.db.prepare('UPDATE messages SET sender_name=? WHERE user_id=? AND sender_name=? AND conversation_id IN (SELECT id FROM conversations WHERE user_id=? AND connection_id=?)').run(profileName,c.user_id,userId,c.user_id,c.id);
    store.ingest(c,{eventKey:`${channel}:${m.ts}`,externalConversationId:channel,recipientRef:channel,displayName:String(m.channel?.name||channel),body,externalMessageId:String(m.ts),senderName,sourceAt:asIso(stamp)});
    checkedRooms++;
   }
   const pages=Number(result.messages.paging?.pages||result.messages.pagination?.page_count||1);
   if(page>=pages)break;
   if(page===5)gapPossible=true;
  }
 }
 return {checkedRooms,gapPossible};
}

async function getJson(fetcher,url,headers){
 const response=await fetcher(url,{headers,signal:AbortSignal.timeout(12000)});
 if(response.status===204)return {value:null,remaining:Number(response.headers.get('x-ratelimit-remaining')??Infinity)};
 if(!response.ok){const error=new Error(`provider_http_${response.status}`);error.status=response.status;throw error}
 return {value:await response.json(),remaining:Number(response.headers.get('x-ratelimit-remaining')??Infinity)};
}

export async function reconcileChatwork(store,c,fetcher=fetch){
 const credential=c.credential&&open(store.key,c.credential);if(!credential)throw Error('missing_credential');
 const headers={'x-chatworktoken':credential};
 const roomsResult=await getJson(fetcher,'https://api.chatwork.com/v2/rooms',headers);
 const rooms=roomsResult.value;if(!Array.isArray(rooms))throw Error('invalid_room_response');
 const lastChecked=new Map(store.db.prepare('SELECT room_id,updated_at FROM chatwork_rooms WHERE connection_id=? AND user_id=?').all(c.id,c.user_id).map(x=>[x.room_id,x.updated_at]));
 const ordered=[...rooms].sort((a,b)=>String(lastChecked.get(String(a.room_id))||'').localeCompare(String(lastChecked.get(String(b.room_id))||'')));
 let checkedRooms=0,gapPossible=rooms.length>MAX_ROOMS;
 for(const room of ordered.slice(0,MAX_ROOMS)){
  if(!Number.isInteger(Number(room.room_id)))continue;
  const url=`https://api.chatwork.com/v2/rooms/${room.room_id}/messages?force=1`;
  const result=await getJson(fetcher,url,headers);
  if(result.remaining<HEADROOM){gapPossible=true;break}
  checkedRooms++;
  const messages=result.value||[];if(!Array.isArray(messages))throw Error('invalid_message_response');
  if(messages.length>=100)gapPossible=true;
  for(const m of [...messages].reverse()){
   if(!m.message_id||!m.body||String(m.account?.account_id)===c.external_account_id)continue;
   if(room.type!=='direct'&&!m.body.includes(`[To:${c.external_account_id}]`))continue;
   const accountId=String(m.account?.account_id||''),senderName=String(m.account?.name||accountId);
   store.ingest(c,{eventKey:`${room.room_id}:${m.message_id}`,externalConversationId:String(room.room_id),recipientRef:String(room.room_id),displayName:String(room.name||`Room ${room.room_id}`),body:m.body,externalMessageId:String(m.message_id),senderName,sourceAt:asIso(m.send_time)});
   if(accountId&&senderName!==accountId)store.db.prepare('UPDATE messages SET sender_name=? WHERE user_id=? AND external_id=? AND sender_name=? AND conversation_id IN (SELECT id FROM conversations WHERE user_id=? AND connection_id=?)').run(senderName,c.user_id,String(m.message_id),accountId,c.user_id,c.id);
  }
  store.db.prepare(`INSERT INTO chatwork_rooms(connection_id,user_id,room_id,room_type,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,room_id) DO UPDATE SET room_type=excluded.room_type,updated_at=excluded.updated_at`).run(c.id,c.user_id,String(room.room_id),String(room.type||'unknown'),new Date().toISOString());
 }
 return {checkedRooms,gapPossible};
}

export async function reconcileTeams(store,c,fetcher=fetch){
 const credential=c.credential&&open(store.key,c.credential);if(!credential)throw Error('missing_credential');
 const headers={authorization:`Bearer ${credential}`};
 let url='https://graph.microsoft.com/v1.0/me/chats?$top=50',rooms=[],pages=0;
 while(url&&pages<3){
  const result=await getJson(fetcher,url,headers);const value=result.value;
  if(!Array.isArray(value?.value))throw Error('invalid_chat_response');
  rooms.push(...value.value);pages++;
  const next=value['@odata.nextLink'];
  if(next&&!next.startsWith('https://graph.microsoft.com/v1.0/'))throw Error('invalid_next_link');
  url=next||'';
 }
 let checkedRooms=0,gapPossible=Boolean(url)||rooms.length>MAX_ROOMS;
 for(const room of rooms.slice(0,MAX_ROOMS)){
  if(!room.id)continue;
  const result=await getJson(fetcher,`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(room.id)}/messages?$top=50`,headers);
  const messages=result.value?.value;if(!Array.isArray(messages))throw Error('invalid_message_response');
  if(result.value['@odata.nextLink'])gapPossible=true;
  checkedRooms++;
  for(const m of [...messages].reverse()){
   if(!m.id||m.from?.user?.id===c.external_account_id||m.deletedDateTime)continue;
   if(room.chatType!=='oneOnOne'&&!m.mentions?.some(x=>x.mentioned?.user?.id===c.external_account_id))continue;
   const body=cleanHtml(m.body?.content);if(!body.trim())continue;
   const senderName=String(m.from?.user?.displayName||m.from?.user?.id||'');
   store.ingest(c,{eventKey:`${room.id}:${m.id}`,externalConversationId:room.id,recipientRef:room.id,displayName:String(room.topic||room.id),body,externalMessageId:m.id,senderName,sourceAt:m.createdDateTime||new Date().toISOString()});
   if(senderName)store.db.prepare('UPDATE messages SET sender_name=? WHERE user_id=? AND external_id=? AND (sender_name IS NULL OR sender_name=?) AND conversation_id IN (SELECT id FROM conversations WHERE user_id=? AND connection_id=?)').run(senderName,c.user_id,String(m.id),String(m.from?.user?.id||''),c.user_id,c.id);
  }
 }
 return {checkedRooms,gapPossible};
}

export async function runReconciliation(store,c,fetcher=fetch){
 if(!['slack','chatwork','teams'].includes(c.provider))throw Error('sync_not_supported');
 store.beginSync(c);
 try{
  const result=c.provider==='slack'?await reconcileSlack(store,c,fetcher):c.provider==='chatwork'?await reconcileChatwork(store,c,fetcher):await reconcileTeams(store,c,fetcher);
  store.finishSync(c,result);return {status:result.gapPossible?'gap_possible':'healthy',...result};
 }catch(e){
  if([401,403].includes(e.status))store.db.prepare("UPDATE connections SET status='reauth_required' WHERE id=? AND user_id=?").run(c.id,c.user_id);
  store.finishSync(c,{error:String(e.message).slice(0,120),gapPossible:true});
  return {status:'failed',error:String(e.message)};
 }
}
