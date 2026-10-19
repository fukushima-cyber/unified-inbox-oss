const GOOGLE='https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_PATH=new URL(GOOGLE).pathname;
const TOKEN='https://oauth2.googleapis.com/token';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const headersOf=message=>Object.fromEntries((message.payload?.headers||[]).map(h=>[String(h.name).toLowerCase(),String(h.value||'')]));
const emailOf=value=>{
 const matches=String(value||'').replace(/[\r\n]/g,'').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z0-9-]+/g)||[];
 return matches.length===1?matches[0].toLowerCase():'';
};
const decode=value=>Buffer.from(String(value||''),'base64url').toString('utf8');
const safeHeader=value=>String(value||'').replace(/[\r\n]/g,' ').trim();
const encodeSubject=value=>{
 const words=[];let chunk='';
 for(const char of value){
  if(Buffer.byteLength(chunk+char,'utf8')>42){words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);chunk=''}
  chunk+=char;
 }
 if(chunk)words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
 return words.join('\r\n ');
};
const messageBody=message=>{
 const parts=[];
 function walk(part){if(part.mimeType==='text/plain'&&part.body?.data)parts.push(decode(part.body.data));for(const child of part.parts||[])walk(child)}
 walk(message.payload||{});
 return (parts.join('\n')||String(message.snippet||'')||'（本文なし）').slice(0,20000);
};
export function incomingGmail(message,ownEmail){
 if(!message?.id||!message.threadId||!message.labelIds?.includes('INBOX'))return null;
 const headers=headersOf(message),sender=emailOf(headers.from),recipient=emailOf(headers['reply-to']||headers.from);
 if(!sender||!recipient)throw Error('gmail_recipient_ambiguous');
 if(sender===ownEmail.toLowerCase())return null;
 const date=Number(message.internalDate);
 return {eventKey:`gmail:${message.id}`,externalConversationId:message.threadId,recipientRef:recipient,displayName:safeHeader(headers.subject||sender).slice(0,200)||sender,body:messageBody(message),externalMessageId:message.id,senderName:safeHeader(headers.from).slice(0,200),sourceAt:Number.isFinite(date)&&date>0?new Date(date).toISOString():new Date().toISOString()};
}
export function replyMime({from,to,subject,messageId,references,body}){
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to))throw Error('invalid_email_address');
 if(!/^<[^<>\r\n]+>$/.test(messageId)||messageId.length>250)throw Error('missing_message_id');
 const title=safeHeader(subject);
 const refs=String(references||'').match(/<[^<>\r\n]+>/g)?.filter(x=>x.length<=250).slice(-20)||[];
 const encoded=Buffer.from(body,'utf8').toString('base64').replace(/.{1,76}/g,'$&\r\n').trimEnd();
 const lines=[`From: ${from}`,`To: ${to}`,`Subject: ${encodeSubject(/^re:/i.test(title)?title:`Re: ${title}`)}`,`In-Reply-To: ${messageId}`,`References: ${[...refs,messageId].join('\r\n ')}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',encoded];
 return Buffer.from(lines.join('\r\n'),'utf8').toString('base64url');
}

export class GmailAgent{
 constructor(config,save,fetcher=fetch){this.config=config;this.save=save;this.fetcher=fetcher;this.accessToken='';this.accessUntil=0}
 async refresh(){
  const data=new URLSearchParams({client_id:this.config.clientId,refresh_token:this.config.refreshToken,grant_type:'refresh_token'});
  if(this.config.clientSecret)data.set('client_secret',this.config.clientSecret);
  const response=await this.fetcher(TOKEN,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:data,signal:AbortSignal.timeout(12000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok||!result.access_token)throw Error('gmail_reauthorization_required');
  if(result.refresh_token&&result.refresh_token!==this.config.refreshToken){this.config.refreshToken=result.refresh_token;this.save(this.config)}
  this.accessToken=result.access_token;this.accessUntil=Date.now()+Math.max(1,Number(result.expires_in||3600)-90)*1000;
 }
 async google(path,method='GET',payload){
  if(Date.now()>=this.accessUntil)await this.refresh();
  const send=()=>this.fetcher(`${GOOGLE}${path}`,{method,headers:{authorization:`Bearer ${this.accessToken}`,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(12000)});
  for(let attempt=0;;attempt++){
   let response=await send();if(response.status===401&&method==='GET'){await this.refresh();response=await send()}
   if(response.ok)return response.json();
   const detail=await response.json().catch(()=>({}));
   const reason=detail.error?.errors?.[0]?.reason||detail.error?.status||'';
   const limited=response.status===429||response.status===403&&['rateLimitExceeded','userRateLimitExceeded'].includes(reason);
   if(method==='GET'&&limited&&attempt<6){await wait(Math.min(32000,1000*2**attempt));continue}
   const error=Error(`gmail_http_${response.status}${limited?'_rate_limited':''}`);error.status=response.status;throw error;
  }
 }
 async bridge(path,method='POST',payload){
  const response=await this.fetcher(`${this.config.inboxUrl}/api/bridge/${path}`,{method,headers:{authorization:`Bearer ${this.config.bridgeToken}`,...(payload?{'content-type':'application/json'}:{})},body:payload?JSON.stringify(payload):undefined,signal:AbortSignal.timeout(12000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(`inbox_${result.error||response.status}`);
  return result;
 }
 async verifyIdentity(){const x=await this.bridge('identity','GET');if(x.provider!=='gmail'||x.externalAccountId.toLowerCase()!==this.config.email.toLowerCase())throw Error('gmail_bridge_identity_mismatch')}
 async ingest(id){const message=await this.google(`/messages/${encodeURIComponent(id)}?format=full`),event=incomingGmail(message,this.config.email);if(event)await this.bridge('events','POST',event)}
 async initialSync(){
  if(!Array.isArray(this.config.pendingMessageIds)||!this.config.initialHistoryId){
   const profile=await this.google('/profile');
   if(profile.emailAddress?.toLowerCase()!==this.config.email.toLowerCase()||!profile.historyId)throw Error('gmail_account_mismatch');
   const url=new URL(`${GOOGLE}/messages`);url.searchParams.set('q','in:inbox newer_than:7d');url.searchParams.set('maxResults','100');
   let page='',pages=0,ids=[];
   do{if(page)url.searchParams.set('pageToken',page);const result=await this.google(url.pathname.slice(GOOGLE_PATH.length)+url.search);ids.push(...(result.messages||[]).map(x=>x.id));page=result.nextPageToken||'';pages++}while(page&&pages<5);
   if(page)this.config.gapPossible=true;
   this.config.pendingMessageIds=[...new Set(ids)].reverse();this.config.initialHistoryId=profile.historyId;this.save(this.config);
  }
  while(this.config.pendingMessageIds.length){
   await this.ingest(this.config.pendingMessageIds[0]);
   this.config.pendingMessageIds.shift();this.save(this.config);
   if(this.config.pendingMessageIds.length)await wait(350);
  }
  this.config.historyId=this.config.initialHistoryId;
  delete this.config.pendingMessageIds;delete this.config.initialHistoryId;this.save(this.config);
  return this.config.gapPossible===true;
 }
 async historySync(){
  let page='',pages=0,latest='';
  do{
   const url=new URL(`${GOOGLE}/history`);url.searchParams.set('startHistoryId',this.config.historyId);url.searchParams.set('historyTypes','messageAdded');url.searchParams.set('labelId','INBOX');url.searchParams.set('maxResults','100');if(page)url.searchParams.set('pageToken',page);
   let result;try{result=await this.google(url.pathname.slice(GOOGLE_PATH.length)+url.search)}catch(e){if(e.status===404){this.config.historyId='';this.config.gapPossible=true;this.save(this.config);return true}throw e}
   for(const id of [...new Set((result.history||[]).flatMap(h=>(h.messagesAdded||[]).map(x=>x.message?.id)).filter(Boolean))])await this.ingest(id);
   latest=result.historyId||latest;page=result.nextPageToken||'';pages++;
  }while(page&&pages<20);
  if(page){this.config.gapPossible=true;this.save(this.config);return true}
  if(latest){this.config.historyId=latest;this.save(this.config)}
  return this.config.gapPossible===true;
 }
 async sync(){await this.verifyIdentity();const gap=this.config.historyId?await this.historySync():await this.initialSync();await this.bridge('heartbeat','POST',{gapPossible:gap});return {gapPossible:gap}}
 async reply(){
  const {command}=await this.bridge('lease','POST',{});if(!command)return null;
  let started=false;
  try{
   const threadId=command.conversation.external_key;
   const thread=await this.google(`/threads/${encodeURIComponent(threadId)}?format=metadata`);
   const message=[...(thread.messages||[])].reverse().find(x=>emailOf(headersOf(x).from)!==this.config.email.toLowerCase());
   if(!message)throw Error('gmail_reply_target_missing');
   const h=headersOf(message),recipient=emailOf(h['reply-to']||h.from);
   if(recipient!==command.conversation.recipient_ref.toLowerCase())throw Error('gmail_recipient_changed');
   const raw=replyMime({from:this.config.email,to:recipient,subject:h.subject,messageId:h['message-id'],references:h.references,body:command.body});
   const begun=await this.bridge(`commands/${encodeURIComponent(command.id)}/executing`,'POST',{leaseToken:command.leaseToken});
   if(!begun.ok)throw Error('gmail_lease_expired');started=true;
   const sent=await this.google('/messages/send','POST',{threadId,raw});
   if(!sent.id||(sent.threadId&&sent.threadId!==threadId))throw Error('gmail_send_unconfirmed');
   await this.bridge(`commands/${encodeURIComponent(command.id)}/result`,'POST',{leaseToken:command.leaseToken,status:'sent',externalMessageId:sent.id,evidence:'gmail_api_success'});
   return {status:'sent',id:sent.id};
  }catch(error){
   try{await this.bridge(`commands/${encodeURIComponent(command.id)}/result`,'POST',{leaseToken:command.leaseToken,status:started?'uncertain':'failed',errorCode:String(error.message).slice(0,100),evidence:'gmail_agent_error'})}catch{}
   return {status:started?'uncertain':'failed',error:String(error.message)};
  }
 }
}
