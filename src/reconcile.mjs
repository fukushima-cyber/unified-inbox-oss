import {open} from './security.mjs';

const MAX_ROOMS=40;
const HEADROOM=10;
const asIso=seconds=>new Date(Number(seconds)*1000).toISOString();
export const cleanHtml=value=>String(value??'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/gi,' ').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&amp;/gi,'&');

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
 let checkedRooms=0,gapPossible=rooms.length>MAX_ROOMS;
 for(const room of rooms.slice(0,MAX_ROOMS)){
  if(!Number.isInteger(Number(room.room_id)))continue;
  store.db.prepare(`INSERT INTO chatwork_rooms(connection_id,user_id,room_id,room_type,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,room_id) DO UPDATE SET room_type=excluded.room_type,updated_at=excluded.updated_at`).run(c.id,c.user_id,String(room.room_id),String(room.type||'unknown'),new Date().toISOString());
  const url=`https://api.chatwork.com/v2/rooms/${room.room_id}/messages?force=1`;
  const result=await getJson(fetcher,url,headers);
  if(result.remaining<HEADROOM){gapPossible=true;break}
  checkedRooms++;
  const messages=result.value||[];if(!Array.isArray(messages))throw Error('invalid_message_response');
  if(messages.length>=100)gapPossible=true;
  for(const m of [...messages].reverse()){
   if(!m.message_id||!m.body||String(m.account?.account_id)===c.external_account_id)continue;
   if(room.type!=='direct'&&!m.body.includes(`[To:${c.external_account_id}]`))continue;
   store.ingest(c,{eventKey:`${room.room_id}:${m.message_id}`,externalConversationId:String(room.room_id),recipientRef:String(room.room_id),displayName:String(room.name||`Room ${room.room_id}`),body:m.body,externalMessageId:String(m.message_id),senderName:String(m.account?.name||m.account?.account_id||''),sourceAt:asIso(m.send_time)});
  }
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
   store.ingest(c,{eventKey:`${room.id}:${m.id}`,externalConversationId:room.id,recipientRef:room.id,displayName:String(room.topic||room.id),body,externalMessageId:m.id,senderName:String(m.from?.user?.displayName||''),sourceAt:m.createdDateTime||new Date().toISOString()});
  }
 }
 return {checkedRooms,gapPossible};
}

export async function runReconciliation(store,c,fetcher=fetch){
 if(!['chatwork','teams'].includes(c.provider))throw Error('sync_not_supported');
 store.beginSync(c);
 try{
  const result=c.provider==='chatwork'?await reconcileChatwork(store,c,fetcher):await reconcileTeams(store,c,fetcher);
  store.finishSync(c,result);return {status:result.gapPossible?'gap_possible':'healthy',...result};
 }catch(e){
  if([401,403].includes(e.status))store.db.prepare("UPDATE connections SET status='reauth_required' WHERE id=? AND user_id=?").run(c.id,c.user_id);
  store.finishSync(c,{error:String(e.message).slice(0,120),gapPossible:true});
  return {status:'failed',error:String(e.message)};
 }
}
