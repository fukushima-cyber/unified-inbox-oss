import {open} from './security.mjs';

const MAX_CHATS=40;
const LIFETIME_MS=50*60_000;
const RENEW_BEFORE_MS=20*60_000;

export function notificationOrigin(value){
 if(!value)return null;
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('invalid_public_origin');
 return url.origin;
}

async function graph(fetcher,url,credential,method='GET',payload){
 const response=await fetcher(url,{method,headers:{authorization:`Bearer ${credential}`,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(12000)});
 if(!response.ok){const error=new Error(`graph_http_${response.status}`);error.status=response.status;throw error}
 return response.status===204?{}:response.json();
}

export async function maintainTeamsSubscriptions(store,c,origin,fetcher=fetch,clock=Date.now()){
 const publicOrigin=notificationOrigin(origin);
 if(!publicOrigin)throw Error('public_origin_required');
 if(c.provider!=='teams')throw Error('teams_only');
 const credential=c.credential&&open(store.key,c.credential);
 const clientState=c.webhook_secret&&open(store.key,c.webhook_secret);
 if(!credential||!clientState)throw Error('missing_credential');
 const headersUrl='https://graph.microsoft.com/v1.0';
 let url=`${headersUrl}/me/chats?$top=50`,pages=0,chats=[],truncated=false;
 while(url&&pages<3){
  const response=await graph(fetcher,url,credential);
  if(!Array.isArray(response.value))throw Error('invalid_chat_response');
  chats.push(...response.value);pages++;
  const next=response['@odata.nextLink'];
  if(next&&!next.startsWith(`${headersUrl}/`))throw Error('invalid_next_link');
  url=next||'';
 }
 if(url||chats.length>MAX_CHATS)truncated=true;
 let maintained=0;
 for(const chat of chats.slice(0,MAX_CHATS)){
  if(!chat.id)continue;
  const existing=store.db.prepare('SELECT * FROM teams_subscriptions WHERE connection_id=? AND user_id=? AND chat_id=?').get(c.id,c.user_id,chat.id);
  if(existing&&Date.parse(existing.expires_at)-clock>RENEW_BEFORE_MS){store.db.prepare('UPDATE teams_subscriptions SET room_type=? WHERE connection_id=? AND chat_id=?').run(String(chat.chatType||'unknown'),c.id,chat.id);continue;}
  const expirationDateTime=new Date(clock+LIFETIME_MS).toISOString();
  let response;
  try{
   if(existing){
    response=await graph(fetcher,`${headersUrl}/subscriptions/${encodeURIComponent(existing.subscription_id)}`,credential,'PATCH',{expirationDateTime});
   }else{
    response=await graph(fetcher,`${headersUrl}/subscriptions`,credential,'POST',{changeType:'created',notificationUrl:`${publicOrigin}/webhooks/teams/${c.id}`,resource:`/chats/${chat.id}/messages`,includeResourceData:false,expirationDateTime,clientState});
   }
  }catch(e){
   if(existing&&e.status===404){store.db.prepare('DELETE FROM teams_subscriptions WHERE connection_id=? AND chat_id=?').run(c.id,chat.id);truncated=true;continue}
   throw e;
  }
  if(!response.id||!response.expirationDateTime)throw Error('invalid_subscription_response');
  store.db.prepare(`INSERT INTO teams_subscriptions(connection_id,user_id,chat_id,subscription_id,expires_at,room_type) VALUES(?,?,?,?,?,?) ON CONFLICT(connection_id,chat_id) DO UPDATE SET subscription_id=excluded.subscription_id,expires_at=excluded.expires_at,room_type=excluded.room_type`).run(c.id,c.user_id,chat.id,response.id,response.expirationDateTime,String(chat.chatType||'unknown'));
  maintained++;
 }
 const status=truncated?'gap_possible':'healthy';
 store.db.prepare('UPDATE connections SET subscription_status=?,subscription_error=NULL,subscription_checked_at=? WHERE id=? AND user_id=?').run(status,new Date(clock).toISOString(),c.id,c.user_id);
 return {status,discovered:chats.length,maintained};
}

export async function runTeamsSubscriptions(store,c,origin,fetcher=fetch,clock=Date.now()){
 try{return await maintainTeamsSubscriptions(store,c,origin,fetcher,clock)}
 catch(e){
  if([401,403].includes(e.status))store.db.prepare("UPDATE connections SET status='reauth_required' WHERE id=? AND user_id=?").run(c.id,c.user_id);
  store.db.prepare('UPDATE connections SET subscription_status=?,subscription_error=?,subscription_checked_at=? WHERE id=? AND user_id=?').run('failed',String(e.message).slice(0,120),new Date(clock).toISOString(),c.id,c.user_id);
  return {status:'failed',error:String(e.message)};
 }
}
