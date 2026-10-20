import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {Store} from './store.mjs';
import {mcp} from './mcp.mjs';
import {runReconciliation,cleanHtml} from './reconcile.mjs';
import {runTeamsSubscriptions} from './teams-subscriptions.mjs';
import {teamsAppConfig,startTeamsDeviceCode,pollTeamsDeviceCode,refreshTeamsToken,teamsProfile} from './teams-oauth.mjs';
import {masterFromEnv,open,same,slackSignature,chatworkSignature,hash} from './security.mjs';
import {normalizeEmail,validEmail,validPassword,hashPassword,verifyPassword,readCookie,sessionCookie} from './auth.mjs';
const dir=dirname(fileURLToPath(import.meta.url));
const key=masterFromEnv();
const store=new Store(process.env.INBOX_DB||join(dir,'../inbox.sqlite'),key);
const ownerEmail=process.env.INBOX_OWNER_EMAIL?normalizeEmail(process.env.INBOX_OWNER_EMAIL):'';
if(ownerEmail){
 if(!validEmail(ownerEmail))throw Error('INBOX_OWNER_EMAIL: valid email required');
 if(store.db.prepare('SELECT COUNT(*) AS n FROM users WHERE email<>?').get(ownerEmail).n)throw Error('personal_instance_contains_other_users');
}
const allowedUser=user=>Boolean(user)&&(!ownerEmail||user.email===ownerEmail);
const allowedConnection=c=>Boolean(c)&&(!ownerEmail||store.db.prepare('SELECT email FROM users WHERE id=?').get(c.user_id)?.email===ownerEmail);
const host=process.env.INBOX_HOST||'127.0.0.1',port=Number(process.env.PORT||8787);
const publicOrigin=process.env.INBOX_PUBLIC_ORIGIN?new URL(process.env.INBOX_PUBLIC_ORIGIN).origin:'';
if((publicOrigin&&!publicOrigin.startsWith('https://')&&!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(publicOrigin))||(!['127.0.0.1','localhost','::1'].includes(host)&&!publicOrigin.startsWith('https://')))throw Error('INBOX_PUBLIC_ORIGIN: HTTPS required for public binding');
const localNoLogin=process.env.INBOX_LOCAL_NO_LOGIN==='1';
if(localNoLogin&&(host!=='127.0.0.1'||publicOrigin||!ownerEmail))throw Error('INBOX_LOCAL_NO_LOGIN requires a personal 127.0.0.1 instance without a public origin');
if(localNoLogin&&!store.passwordUser(ownerEmail))store.createUser(ownerEmail);
const localOwner=localNoLogin?store.passwordUser(ownerEmail):null;
const secureCookie=publicOrigin.startsWith('https://');
const dummyPasswordHash=hashPassword('unused-password-for-timing');
const authAttempts=new Map();let activePasswordWork=0;let globalAuthWindow={count:0,until:0};
async function passwordWork(fn){if(activePasswordWork>=4)throw Error('auth_busy');activePasswordWork++;try{return await fn()}finally{activePasswordWork--}}
function authAllowed(key){const t=Date.now(),old=authAttempts.get(key);if(globalAuthWindow.until<=t)globalAuthWindow={count:0,until:t+60_000};if(globalAuthWindow.count>=120)return false;globalAuthWindow.count++;if(authAttempts.size>2048)for(const [k,v] of authAttempts)if(v.until<=t)authAttempts.delete(k);if(authAttempts.size>4096)return false;if(old&&old.until>t&&old.count>=10)return false;authAttempts.set(key,{count:old&&old.until>t?old.count+1:1,until:t+15*60_000});return true}
const sameOrigin=req=>req.headers.origin===(publicOrigin||`http://${req.headers.host}`);
const jsonInput=req=>String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()==='application/json';
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(body))};
const fail=(res,status,error)=>json(res,status,{error});
const bearer=req=>(req.headers.authorization||'').replace(/^Bearer /,'');
async function body(req,limit=1_000_000){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>limit)throw Error('body_too_large');chunks.push(chunk)}const raw=Buffer.concat(chunks).toString('utf8');return {raw,data:raw?JSON.parse(raw):{}}}
const required=(x,...names)=>{for(const n of names)if(typeof x[n]!=='string'||!x[n].trim())throw Error('invalid_'+n)};
const notDelivered=code=>Object.assign(Error(code),{notDelivered:true});
function incoming(c,x){required(x,'eventKey','externalConversationId','recipientRef','displayName','body');if(x.body.length>20000)throw Error('body_too_large');return store.ingest(c,x)}
async function verifyConnection(x){
 if(['line','gmail','messenger'].includes(x.provider)){
  if(x.credential||x.webhookSecret)throw Error('bridge_credentials_not_accepted');
  if(x.provider==='gmail'&&!validEmail(normalizeEmail(x.externalAccountId)))throw Error('invalid_externalAccountId');
  return;
 }
 required(x,'credential');let url,headers={};
 if(x.provider==='slack'){url='https://slack.com/api/auth.test';headers={authorization:`Bearer ${x.credential}`}}
 else if(x.provider==='chatwork'){url='https://api.chatwork.com/v2/me';headers={'x-chatworktoken':x.credential}}
 else {url='https://graph.microsoft.com/v1.0/me';headers={authorization:`Bearer ${x.credential}`}}
 const r=await fetch(url,{method:x.provider==='slack'?'POST':'GET',headers,signal:AbortSignal.timeout(10000)});
 const me=await r.json().catch(()=>({}));if(!r.ok||me.ok===false)throw Error('credential_verification_failed');
 const id=x.provider==='slack'?me.user_id:x.provider==='chatwork'?String(me.account_id):me.id;
 if(String(id)!==x.externalAccountId)throw Error('account_identity_mismatch');
 if(x.provider==='slack'&&me.bot_id)throw Error('slack_user_token_required');
}
async function providerSend(c,v,text,files=[]){const credential=c.credential&&open(key,c.credential);if(!credential)throw Error('missing_credential');let url,init;
 if(files.length&&c.provider==='chatwork'){
  if(!/^\d+$/.test(v.recipient_ref))throw Error('invalid_recipient');
  const file=files[0],form=new FormData();form.set('file',new Blob([Buffer.from(file.data,'base64')],{type:file.type}),file.name);form.set('message',text);
  const response=await fetch(`https://api.chatwork.com/v2/rooms/${v.recipient_ref}/files`,{method:'POST',headers:{'x-chatworktoken':credential},body:form,signal:AbortSignal.timeout(120000)});
  const payload=await response.json().catch(()=>({}));if(!response.ok||!payload.file_id)throw (response.status>=400&&response.status<500?notDelivered:Error)(`provider_${response.status}_${payload.error||'file_upload_unconfirmed'}`);return `file:${payload.file_id}`;
 }
 if(files.length&&c.provider==='slack'){
  const uploaded=[];
  for(const file of files){const params=new URLSearchParams({filename:file.name,length:String(file.size)});const start=await fetch('https://slack.com/api/files.getUploadURLExternal',{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/x-www-form-urlencoded'},body:params,signal:AbortSignal.timeout(15000)});const result=await start.json().catch(()=>({}));if(!start.ok||!result.ok||!result.file_id||!result.upload_url)throw notDelivered(`slack_upload_start_${result.error||start.status}`);
   const target=new URL(result.upload_url);if(target.protocol!=='https:'||!['files.slack.com','files-origin.slack.com'].includes(target.hostname))throw notDelivered('slack_upload_url_invalid');
   const upload=await fetch(target,{method:'POST',headers:{'content-type':'application/octet-stream'},body:Buffer.from(file.data,'base64'),redirect:'error',signal:AbortSignal.timeout(120000)});if(!upload.ok)throw notDelivered(`slack_upload_${upload.status}`);uploaded.push({id:result.file_id,title:file.name})}
  const form=new URLSearchParams({files:JSON.stringify(uploaded),channel_id:v.recipient_ref,initial_comment:text});const response=await fetch('https://slack.com/api/files.completeUploadExternal',{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(30000)});const result=await response.json().catch(()=>({}));if(!response.ok||!result.ok)throw (['missing_scope','not_in_channel','channel_not_found'].includes(result.error)?notDelivered:Error)(`slack_upload_complete_${result.error||response.status}`);return `file:${uploaded[0].id}`;
 }
 if(c.provider==='slack'){url='https://slack.com/api/chat.postMessage';init={method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify({channel:v.recipient_ref,text})}}
 else if(c.provider==='chatwork'){if(!/^\d+$/.test(v.recipient_ref))throw Error('invalid_recipient');url=`https://api.chatwork.com/v2/rooms/${v.recipient_ref}/messages`;init={method:'POST',headers:{'x-chatworktoken':credential,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({body:text})}}
 else if(c.provider==='teams'){url=`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(v.recipient_ref)}/messages`;init={method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify({body:{contentType:'text',content:text}})}}
 else throw Error('not_api_provider');
 const response=await fetch(url,{...init,signal:AbortSignal.timeout(12000)});const payload=await response.json().catch(()=>({}));
 if(!response.ok||payload.ok===false)throw Error(`provider_${response.status}_${payload.error||payload.code||'error'}`);
 const messageId=c.provider==='slack'?payload.ts:c.provider==='chatwork'?payload.message_id:payload.id;
 if(!messageId)throw Error('missing_provider_message_id');return String(messageId);
}
async function processOne(){const q=store.db.prepare("SELECT q.*,c.provider,c.credential,c.status AS connection_status,v.recipient_ref FROM commands q JOIN connections c ON c.id=q.connection_id AND c.user_id=q.user_id JOIN conversations v ON v.id=q.conversation_id AND v.user_id=q.user_id WHERE q.status='queued' AND c.provider NOT IN ('line','gmail','messenger') ORDER BY q.created_at LIMIT 1").get();if(!q)return;
 const c=store.connection(q.user_id,q.connection_id);if(c.status!=='active')return;
 if(!allowedConnection(c))return;
 const t='worker-'+q.id;store.db.prepare("UPDATE commands SET status='executing',lease_hash=?,lease_until=? WHERE id=? AND status='queued'").run(hash(t),new Date(Date.now()+6*60000).toISOString(),q.id);
 store.db.prepare('INSERT INTO attempts VALUES(?,?,?,?,?,?,?)').run(randomUUID(),q.user_id,q.id,'executing',null,new Date().toISOString(),null);
 try{const externalMessageId=await providerSend(c,{recipient_ref:q.recipient_ref},open(key,q.body),store.commandAttachments(q));store.finish(c,q.id,{leaseToken:t,status:'sent',externalMessageId,evidence:'provider_api_success'})}
 catch(e){store.finish(c,q.id,{leaseToken:t,status:e.notDelivered?'failed':'uncertain',errorCode:String(e.message).slice(0,120),evidence:e.notDelivered?'provider_rejected_before_delivery':'provider_result_unconfirmed'})}
}
const interval=setInterval(()=>{store.expire();processOne().catch(e=>console.error('worker',e.message))},1500);interval.unref();
const syncInFlight=new Set();
async function syncConnection(c){if(!allowedConnection(c)||syncInFlight.has(c.id))return false;syncInFlight.add(c.id);try{return await runReconciliation(store,c)}finally{syncInFlight.delete(c.id)}}
const syncInterval=setInterval(()=>{const cutoff=new Date(Date.now()-5*60_000).toISOString();const c=store.db.prepare(`SELECT c.* FROM connections c LEFT JOIN sync_state s ON s.connection_id=c.id AND s.user_id=c.user_id WHERE c.provider IN ('slack','chatwork','teams') AND c.status='active' AND COALESCE(s.last_started_at,'')<? ORDER BY COALESCE(s.last_started_at,'') LIMIT 1`).get(cutoff);if(c)syncConnection(c).catch(e=>console.error('sync',e.message))},30000);syncInterval.unref();
const subscriptionInFlight=new Set();
async function maintainConnectionSubscriptions(c){
 if(!allowedConnection(c)||subscriptionInFlight.has(c.id))return false;
 if(!process.env.INBOX_PUBLIC_ORIGIN){store.db.prepare('UPDATE connections SET subscription_status=?,subscription_error=NULL,subscription_checked_at=? WHERE id=? AND user_id=?').run('polling',new Date().toISOString(),c.id,c.user_id);return {status:'polling'}}
 subscriptionInFlight.add(c.id);try{return await runTeamsSubscriptions(store,c,process.env.INBOX_PUBLIC_ORIGIN)}finally{subscriptionInFlight.delete(c.id)}
}
const subscriptionInterval=setInterval(()=>{const cutoff=new Date(Date.now()-10*60_000).toISOString();const c=store.db.prepare(`SELECT * FROM connections WHERE provider='teams' AND status='active' AND COALESCE(subscription_checked_at,'')<? ORDER BY COALESCE(subscription_checked_at,'') LIMIT 1`).get(cutoff);if(c)maintainConnectionSubscriptions(c).catch(e=>console.error('subscriptions',e.message))},60000);subscriptionInterval.unref();
const teamsDeviceFlows=new Map();let teamsRefreshInFlight=false;
async function refreshOneTeamsOauth(){
 if(teamsRefreshInFlight)return;const due=store.teamsOauthDue(new Date(Date.now()+5*60000).toISOString());if(!due)return;
 teamsRefreshInFlight=true;
 try{
  const config={clientId:due.client_id,tenantId:due.tenant_id};
  const token=await refreshTeamsToken(config,due.refreshToken);
  const profile=await teamsProfile(token.accessToken);
  if(profile.id!==due.external_account_id)throw Object.assign(Error('teams_account_mismatch'),{permanent:true});
  store.updateCredential(due.user_id,due.connection_id,token.accessToken);
  store.saveTeamsOauth(due.user_id,due.connection_id,{...config,refreshToken:token.refreshToken,expiresAt:token.expiresAt});
 }catch(error){
  console.error('Teams更新エラー:',error.message);
  if(error.permanent){store.db.prepare("UPDATE connections SET status='reauth_required' WHERE id=? AND user_id=?").run(due.connection_id,due.user_id);store.clearTeamsOauth(due.user_id,due.connection_id)}
 }finally{teamsRefreshInFlight=false}
}
const teamsRefreshInterval=setInterval(()=>refreshOneTeamsOauth().catch(e=>console.error('Teams更新エラー:',e.message)),60000);teamsRefreshInterval.unref();
async function handle(req,res){const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),p=url.pathname;
 if(localNoLogin){
  if(req.headers.host!==`127.0.0.1:${port}`||!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return fail(res,403,'local_only');
  if(p.startsWith('/api/')&&req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return fail(res,403,'cross_site_request');
  if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`)return fail(res,403,'bad_origin');
 }
 if(req.method==='GET'&&p==='/health')return json(res,200,{ok:true});
 if(req.method==='GET'&&p==='/'){const html=await readFile(join(dir,'../public/index.html'));res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",'cache-control':'no-store'});return res.end(html)}
 if(req.method==='GET'&&p==='/app.js'){const js=await readFile(join(dir,'../public/app.js'));res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(js)}
 if(req.method==='GET'&&p==='/style.css'){const css=await readFile(join(dir,'../public/style.css'));res.writeHead(200,{'content-type':'text/css; charset=utf-8','cache-control':'no-store'});return res.end(css)}
 if(localNoLogin&&p.startsWith('/api/auth/'))return fail(res,404,'not_found');
 if(req.method==='POST'&&p==='/api/auth/activate'){
  if(!sameOrigin(req))return fail(res,403,'bad_origin');if(!jsonInput(req))return fail(res,415,'json_required');
  const {data}=await body(req);if(!authAllowed('activate:'+hash(data.inviteToken??'')))return fail(res,429,'too_many_attempts');
  const invite=typeof data.inviteToken==='string'&&store.validInvite(data.inviteToken);
  if(!invite)return fail(res,401,'invalid_invite');
  if(ownerEmail&&invite.email!==ownerEmail)return fail(res,403,'personal_instance_only');
  if(!validPassword(data.password))return fail(res,400,'invalid_password');
  const passwordHash=await passwordWork(()=>hashPassword(data.password)),user=store.activateInvite(data.inviteToken,passwordHash);
  if(!user)return fail(res,401,'invalid_invite');store.endSession(readCookie(req,'inbox_session'));const session=store.createSession(user.id);
  res.setHeader('set-cookie',sessionCookie(session.token,secureCookie,7*24*60*60));return json(res,201,{user});
 }
 if(req.method==='POST'&&p==='/api/auth/login'){
  if(!sameOrigin(req))return fail(res,403,'bad_origin');if(!jsonInput(req))return fail(res,415,'json_required');
  const {data}=await body(req),email=normalizeEmail(data.email);
  if(!validEmail(email)||!validPassword(data.password))return fail(res,401,'invalid_credentials');
  if(!authAllowed('login:'+email))return fail(res,429,'too_many_attempts');
  const user=store.passwordUser(email);
  if(user&&!allowedUser(user))return fail(res,401,'invalid_credentials');
  const storedPassword=user?.password_hash||await dummyPasswordHash;const matches=await passwordWork(()=>verifyPassword(data.password,storedPassword));
  if(!user||!matches)return fail(res,401,'invalid_credentials');
  store.endSession(readCookie(req,'inbox_session'));const session=store.createSession(user.id);res.setHeader('set-cookie',sessionCookie(session.token,secureCookie,7*24*60*60));return json(res,200,{user:{id:user.id,email:user.email}});
 }
 if(req.method==='POST'&&p==='/api/auth/logout'){
  if(!sameOrigin(req))return fail(res,403,'bad_origin');store.endSession(readCookie(req,'inbox_session'));
  res.setHeader('set-cookie',sessionCookie('',secureCookie,0));return json(res,200,{ok:true});
 }
 if(p==='/mcp'){const c=store.bridge(bearer(req));return mcp(req,res,store,allowedConnection(c)&&['line','messenger'].includes(c.provider)?c:null,body)}
 if(p.startsWith('/api/bridge/')){const c=store.bridge(bearer(req));if(!allowedConnection(c))return fail(res,401,'unauthorized');
  if(req.method==='GET'&&p==='/api/bridge/identity')return json(res,200,{provider:c.provider,externalAccountId:c.external_account_id,displayName:c.display_name});
  const {data}=await body(req);
  if(req.method==='POST'&&p==='/api/bridge/events')return json(res,200,incoming(c,data));
  if(req.method==='POST'&&p==='/api/bridge/lease')return json(res,200,{command:store.lease(c)});
  if(req.method==='POST'&&p==='/api/bridge/heartbeat'){
   if(typeof data.error!=='undefined'&&(typeof data.error!=='string'||data.error.length>120))throw Error('invalid_error');
   if(typeof data.gapPossible!=='undefined'&&typeof data.gapPossible!=='boolean')throw Error('invalid_gapPossible');
   store.beginSync(c);store.finishSync(c,{error:data.error||'',gapPossible:data.gapPossible===true});return json(res,200,{ok:true});
  }
  const m=p.match(/^\/api\/bridge\/commands\/([^/]+)\/(executing|result)$/);if(m&&req.method==='POST'){
   required(data,'leaseToken');if(m[2]==='executing'){const ok=store.executing(c,m[1],data.leaseToken);return json(res,ok?200:409,{ok})}
   if(!['sent','failed','uncertain'].includes(data.status))throw Error('invalid_status');const ok=store.finish(c,m[1],data);return json(res,ok?200:409,{ok})}
  return fail(res,404,'not_found')}
 if(p.startsWith('/webhooks/')){const m=p.match(/^\/webhooks\/(slack|chatwork|teams)\/([^/]+)$/);if(!m)return fail(res,404,'not_found');const c=store.db.prepare('SELECT * FROM connections WHERE id=? AND provider=?').get(m[2],m[1]);if(!allowedConnection(c))return fail(res,404,'not_found');
  if(m[1]==='teams'&&req.method==='POST'&&url.searchParams.has('validationToken')){res.writeHead(200,{'content-type':'text/plain'});return res.end(url.searchParams.get('validationToken'))}
  const {raw,data}=await body(req);if(!c.webhook_secret)return fail(res,403,'webhook_not_configured');const secret=open(key,c.webhook_secret);
  if(m[1]==='slack'){const ts=req.headers['x-slack-request-timestamp'];if(!ts||Math.abs(Date.now()/1000-Number(ts))>300||!same(req.headers['x-slack-signature'],slackSignature(secret,ts,raw)))return fail(res,401,'bad_signature');if(data.type==='url_verification')return json(res,200,{challenge:data.challenge});const e=data.event||{};if(['message','app_mention'].includes(e.type)&&!e.subtype&&e.user&&e.user!==c.external_account_id&&(e.channel_type==='im'||e.type==='app_mention'||e.text?.includes(`<@${c.external_account_id}>`))){incoming(c,{eventKey:data.event_id||`${e.channel}:${e.ts}`,externalConversationId:e.channel,recipientRef:e.channel,displayName:e.channel,body:e.text||'',externalMessageId:e.ts,senderName:e.user,sourceAt:new Date(Number(e.ts)*1000).toISOString()})}return json(res,200,{ok:true})}
  if(m[1]==='chatwork'){if(!same(req.headers['x-chatworkwebhooksignature'],chatworkSignature(secret,raw)))return fail(res,401,'bad_signature');const e=data.webhook_event||{};const room=store.db.prepare('SELECT room_type FROM chatwork_rooms WHERE connection_id=? AND user_id=? AND room_id=?').get(c.id,c.user_id,String(e.room_id));if(['message_created','mention_to_me'].includes(data.webhook_event_type)&&e.message_id&&String(e.account_id||e.from_account_id)!==c.external_account_id&&(data.webhook_event_type==='mention_to_me'||room?.room_type==='direct')){incoming(c,{eventKey:`${e.room_id}:${e.message_id}`,externalConversationId:String(e.room_id),recipientRef:String(e.room_id),displayName:`Room ${e.room_id}`,body:e.body,externalMessageId:String(e.message_id),senderName:String(e.account_id||e.from_account_id),sourceAt:new Date(e.send_time*1000).toISOString()})}return json(res,200,{ok:true})}
  if(m[1]==='teams'){for(const e of data.value||[]){if(!same(e.clientState,secret))return fail(res,401,'bad_client_state');if(e.changeType!=='created')continue;const match=/chats\('([^']+)'\)\/messages\('([^']+)'\)/.exec(e.resource||'');if(!match)continue;const subscription=store.db.prepare('SELECT 1 FROM teams_subscriptions WHERE connection_id=? AND user_id=? AND chat_id=? AND subscription_id=? AND expires_at>?').get(c.id,c.user_id,match[1],e.subscriptionId,new Date().toISOString());if(!subscription)return fail(res,401,'unknown_subscription');const credential=c.credential&&open(key,c.credential);if(!credential)return fail(res,503,'missing_credential');const r=await fetch(`https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(match[1])}/messages/${encodeURIComponent(match[2])}`,{headers:{authorization:`Bearer ${credential}`},signal:AbortSignal.timeout(10000)});if(!r.ok)return fail(res,503,'graph_fetch_failed');const message=await r.json();if(message.from?.user?.id===c.external_account_id)continue;const room=store.db.prepare('SELECT room_type FROM teams_subscriptions WHERE connection_id=? AND chat_id=?').get(c.id,match[1]);if(room?.room_type!=='oneOnOne'&&!message.mentions?.some(x=>x.mentioned?.user?.id===c.external_account_id))continue;incoming(c,{eventKey:`${match[1]}:${match[2]}`,externalConversationId:match[1],recipientRef:match[1],displayName:match[1],body:cleanHtml(message.body?.content),externalMessageId:match[2],senderName:message.from?.user?.displayName||'',sourceAt:message.createdDateTime})}return json(res,202,{ok:true})}
 }
 const bearerUser=store.user(bearer(req)),sessionUser=store.session(readCookie(req,'inbox_session'));const user=localOwner||bearerUser||sessionUser;if(!allowedUser(user))return fail(res,401,'unauthorized');if(!bearerUser&&req.method!=='GET'&&!sameOrigin(req))return fail(res,403,'bad_origin');
 if(req.method==='POST'&&p==='/api/teams/device/start'){
  if(!jsonInput(req))return fail(res,415,'json_required');
  const {data}=await body(req),config=teamsAppConfig(data.clientId,data.tenantId);
  for(const [id,flow] of teamsDeviceFlows)if(flow.expiresAt<Date.now())teamsDeviceFlows.delete(id);
  if([...teamsDeviceFlows.values()].filter(flow=>flow.userId===user.id).length>=2)return fail(res,429,'teams_connection_busy');
  const started=await startTeamsDeviceCode(config),id=randomUUID();
  teamsDeviceFlows.set(id,{...config,...started,userId:user.id,nextPoll:Date.now()+started.interval*1000,inFlight:false});
  return json(res,202,{id,userCode:started.userCode,verificationUri:started.verificationUri,expiresIn:Math.ceil((started.expiresAt-Date.now())/1000),interval:started.interval});
 }
 const teamsDeviceMatch=p.match(/^\/api\/teams\/device\/([0-9a-f-]+)$/);
 if(req.method==='POST'&&teamsDeviceMatch){
  const flow=teamsDeviceFlows.get(teamsDeviceMatch[1]);if(!flow||flow.userId!==user.id)return fail(res,404,'not_found');
  if(Date.now()>=flow.expiresAt){teamsDeviceFlows.delete(teamsDeviceMatch[1]);return json(res,200,{status:'expired'})}
  if(flow.inFlight||Date.now()<flow.nextPoll)return json(res,200,{status:'pending'});
  flow.inFlight=true;flow.nextPoll=Date.now()+flow.interval*1000;
  try{
   const token=await pollTeamsDeviceCode(flow,flow.deviceCode);
   if(token.status==='pending'){if(token.slowDown)flow.interval+=5;return json(res,200,{status:'pending'})}
   const profile=await teamsProfile(token.accessToken);
   const existing=store.db.prepare("SELECT id FROM connections WHERE user_id=? AND provider='teams' AND external_account_id=?").get(user.id,profile.id);
   const id=existing?.id||store.addConnection(user.id,{provider:'teams',externalAccountId:profile.id,displayName:profile.displayName,credential:token.accessToken}).id;
   if(existing)store.updateCredential(user.id,id,token.accessToken);
   store.saveTeamsOauth(user.id,id,{clientId:flow.clientId,tenantId:flow.tenantId,refreshToken:token.refreshToken,expiresAt:token.expiresAt});
   teamsDeviceFlows.delete(teamsDeviceMatch[1]);return json(res,200,{status:'connected',connectionId:id});
  }catch(error){teamsDeviceFlows.delete(teamsDeviceMatch[1]);return json(res,200,{status:'failed',error:String(error.message).slice(0,80)})}
  finally{flow.inFlight=false}
 }
 if(req.method==='GET'&&p==='/api/inbox'){const provider=url.searchParams.get('provider')||'all';const page=store.inboxPage(user.id,url.searchParams.get('filter')||'attention',url.searchParams.get('cursor'),provider,url.searchParams.get('search')||'');return json(res,200,{user,authMode:localNoLogin?'local':'password',connections:store.connections(user.id),summary:store.inboxSummary(user.id,provider),conversations:page.items,nextCursor:page.nextCursor})}
 if(req.method==='GET'&&p==='/api/insights')return json(res,200,store.insights(user.id));
 const messagesMatch=p.match(/^\/api\/conversations\/([^/]+)\/messages$/);if(req.method==='GET'&&messagesMatch){const page=store.messagePage(user.id,messagesMatch[1],url.searchParams.get('cursor'));return page?json(res,200,page):fail(res,404,'not_found')}
 if(req.method==='POST'&&p==='/api/connections'){const {data}=await body(req);required(data,'provider','externalAccountId','displayName');if(!['line','slack','chatwork','teams','gmail','messenger'].includes(data.provider))throw Error('invalid_provider');await verifyConnection(data);return json(res,201,store.addConnection(user.id,data))}
 let m=p.match(/^\/api\/connections\/([^/]+)\/reconnect$/);if(req.method==='POST'&&m){const c=store.connection(user.id,m[1]);if(!c||['line','gmail','messenger'].includes(c.provider))return fail(res,404,'not_found');const {data}=await body(req);required(data,'credential');await verifyConnection({provider:c.provider,externalAccountId:c.external_account_id,credential:data.credential,webhookSecret:data.webhookSecret||(c.webhook_secret?open(key,c.webhook_secret):'')});store.updateCredential(user.id,c.id,data.credential,data.webhookSecret);if(c.provider==='teams')store.clearTeamsOauth(user.id,c.id);return json(res,200,{ok:true})}
 m=p.match(/^\/api\/connections\/([^/]+)\/subscriptions$/);if(req.method==='POST'&&m){const c=store.connection(user.id,m[1]);if(!c||c.provider!=='teams')return fail(res,404,'not_found');if(subscriptionInFlight.has(c.id))return json(res,202,{started:false,reason:'already_running'});maintainConnectionSubscriptions(c).catch(e=>console.error('subscriptions',e.message));return json(res,202,{started:true})}
 m=p.match(/^\/api\/connections\/([^/]+)\/sync$/);if(req.method==='POST'&&m){const c=store.connection(user.id,m[1]);if(!c)return fail(res,404,'not_found');if(!['slack','chatwork','teams'].includes(c.provider))return fail(res,400,'sync_not_supported');if(syncInFlight.has(c.id))return json(res,202,{started:false,reason:'already_running'});syncConnection(c).catch(e=>console.error('sync',e.message));return json(res,202,{started:true})}
 m=p.match(/^\/api\/connections\/([^/]+)\/bridge-token$/);if(req.method==='POST'&&m){const t=store.bridgeToken(user.id,m[1]);return t?json(res,200,{token:t}):fail(res,404,'not_found')}
 m=p.match(/^\/api\/conversations\/([^/]+)\/attention$/);if(req.method==='POST'&&m){const {data}=await body(req);return store.attention(user.id,m[1],data.attention)?json(res,200,{ok:true}):fail(res,404,'not_found')}
 if(req.method==='POST'&&p==='/api/replies'){const {data}=await body(req,8_600_000);required(data,'conversationId','requestId','expectedRecipientRef','body');if(data.body.length>20000)throw Error('body_too_large');return json(res,202,store.command(user.id,data))}
 return fail(res,404,'not_found')
}
const clientErrors=new Set(['recipient_changed','recipient_conflict','idempotency_conflict','connection_inactive','conversation_not_found','pending_command','gmail_agent_offline','body_too_large','credential_verification_failed','account_identity_mismatch','slack_user_token_required','bridge_credentials_not_accepted','attachments_not_supported','too_many_attachments','attachment_too_large','attachments_too_large']);
const server=http.createServer((req,res)=>handle(req,res).catch(e=>{
 console.error('request',e.message);
 const code=String(e.message),clientError=code.startsWith('invalid_')||clientErrors.has(code);
 const status=code==='storage_limit_reached'?507:code==='auth_busy'?503:clientError?400:500;
 fail(res,status,status===500?'internal_error':code);
}));
server.listen(port,host,()=>console.log(`Unified inbox: http://${host}:${port}`));
process.on('SIGTERM',()=>{clearInterval(interval);clearInterval(syncInterval);clearInterval(subscriptionInterval);server.close();store.close()});
