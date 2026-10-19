import http from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync,chmodSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {GmailAgent} from '../src/gmail-agent.mjs';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const configPath=resolve(process.env.INBOX_GMAIL_AGENT_CONFIG||join(root,'secrets/gmail-agent.json'));
const sleep=ms=>new Promise(resolve=>{if(!running)return resolve();const timer=setTimeout(resolve,ms);shutdown.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true})});
const shutdown=new AbortController();
const stop=()=>{running=false;shutdown.abort()};let running=true;
process.on('SIGINT',stop);process.on('SIGTERM',stop);

function save(config){
 const dir=dirname(configPath);mkdirSync(dir,{recursive:true,mode:0o700});
 if(dir===join(root,'secrets'))chmodSync(dir,0o700);
 const tmp=`${configPath}.${randomBytes(6).toString('hex')}.tmp`;
 try{writeFileSync(tmp,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(tmp,configPath);chmodSync(configPath,0o600)}finally{rmSync(tmp,{force:true})}
}
const readConfig=()=>JSON.parse(readFileSync(configPath,'utf8'));
const bridgeUrl=value=>{
 const url=new URL(value.trim());
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('受信箱URLはHTTPS（またはローカルHTTP）のオリジンを指定してください');
 return url.origin;
};
async function identity(url,token){
 const response=await fetch(`${url}/api/bridge/identity`,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw Error('ブリッジ鍵を確認できません');
 const result=await response.json();if(result.provider!=='gmail')throw Error('Gmail連携のブリッジ鍵ではありません');return result;
}
async function authorize(client){
 const verifier=randomBytes(32).toString('base64url'),state=randomBytes(24).toString('base64url');
 const server=http.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 const redirect=`http://127.0.0.1:${server.address().port}`;
 const auth=new URL('https://accounts.google.com/o/oauth2/v2/auth');
 for(const [k,v] of Object.entries({client_id:client.client_id,redirect_uri:redirect,response_type:'code',scope:'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}))auth.searchParams.set(k,v);
 const codePromise=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('Google認可が時間切れです')),600000);
  server.on('request',(req,res)=>{
   const url=new URL(req.url,redirect);
   if(req.method!=='GET'||url.pathname!=='/'||req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(404);return res.end()}
   if(url.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid state');clearTimeout(timer);return reject(Error('Google認可の状態が一致しません'))}
   const code=url.searchParams.get('code');if(!code){res.writeHead(400);res.end('Authorization failed');clearTimeout(timer);return reject(Error(`Google認可に失敗: ${url.searchParams.get('error')||'unknown'}`))}
   res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});res.end('認可を受け取りました。このタブを閉じてください。');clearTimeout(timer);resolve(code);
  });
 });
 console.log('本人のブラウザで次のURLを開き、Googleアカウントを認可してください。');
 console.log(auth.href);
 let code;try{code=await codePromise}finally{server.close()}
 const body=new URLSearchParams({client_id:client.client_id,code,code_verifier:verifier,redirect_uri:redirect,grant_type:'authorization_code'});
 if(client.client_secret)body.set('client_secret',client.client_secret);
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(12000)});
 const result=await response.json().catch(()=>({}));if(!response.ok||!result.refresh_token||!result.access_token)throw Error('Googleの更新トークンを取得できませんでした');
 const granted=new Set(String(result.scope||'').split(' '));if(!granted.has('https://www.googleapis.com/auth/gmail.readonly')||!granted.has('https://www.googleapis.com/auth/gmail.send'))throw Error('Gmailの読み取りと送信の両方を許可してください');
 const profileResponse=await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile',{headers:{authorization:`Bearer ${result.access_token}`},signal:AbortSignal.timeout(12000)});
 if(!profileResponse.ok)throw Error('Gmailプロフィールを取得できません');
 return {refreshToken:result.refresh_token,profile:await profileResponse.json()};
}
async function connect(clientFile){
 if(!clientFile)throw Error('使い方: node scripts/gmail-agent.mjs connect <本人のOAuthデスクトップJSON>');
 const raw=JSON.parse(readFileSync(resolve(clientFile),'utf8')),client=raw.installed;
 if(!client?.client_id)throw Error('Googleのデスクトップアプリ用OAuth JSONを指定してください');
 const rl=createInterface({input:process.stdin,output:process.stdout});
 let url,token;try{url=bridgeUrl(await rl.question('受信箱URL: '));token=(await rl.question('Gmailブリッジ鍵: ')).trim()}finally{rl.close()}
 const account=await identity(url,token);
 const {refreshToken,profile}=await authorize(client);
 if(profile.emailAddress?.toLowerCase()!==account.externalAccountId.toLowerCase())throw Error('Gmailアカウントと受信箱の登録IDが一致しません');
 save({inboxUrl:url,bridgeToken:token,email:profile.emailAddress.toLowerCase(),clientId:client.client_id,clientSecret:client.client_secret||'',refreshToken,historyId:'',gapPossible:false});
 console.log('認可情報を本人の端末に保存しました。./setup.sh で受信箱を起動している場合はGmail同期が自動で始まります。');
}
async function run(){
 const config=readConfig(),agent=new GmailAgent(config,save);
 console.log(`Gmail同期を開始: ${config.email}`);
 while(running){
  try{const sync=await agent.sync(),reply=await agent.reply();if(sync.gapPossible)console.error('Gmail履歴に不足の可能性があります。元のGmailを確認してください。');if(reply?.status==='uncertain')console.error('Gmail送信結果が不明です。Gmailの送信済みを確認してください。')}
  catch(e){console.error(`Gmail同期エラー: ${e.message}`);try{await agent.bridge('heartbeat','POST',{error:String(e.message).slice(0,120),gapPossible:true})}catch{}}
  if(running)await sleep(60000);
 }
}

try{
 const command=process.argv[2];
 if(command==='connect')await connect(process.argv[3]);
 else if(command==='run')await run();
 else throw Error('使い方: node scripts/gmail-agent.mjs connect <OAuth JSON> | run');
}catch(e){console.error(e.message);process.exitCode=1}
