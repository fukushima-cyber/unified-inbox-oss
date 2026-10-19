import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const config=process.env.INBOX_GMAIL_AGENT_CONFIG||join(root,'secrets/gmail-agent.json');
let stopping=false,agent=null,lastAgentStart=0;
const server=spawn(process.execPath,['src/server.mjs'],{cwd:root,env:process.env,stdio:'inherit'});

function startAgent(){
 if(stopping||agent||!existsSync(config)||Date.now()-lastAgentStart<60000)return;
 lastAgentStart=Date.now();
 agent=spawn(process.execPath,['scripts/gmail-agent.mjs','run'],{cwd:root,env:process.env,stdio:'inherit'});
 agent.on('error',error=>console.error(`Gmailエージェントを起動できません: ${error.message}`));
 agent.on('exit',(code,signal)=>{
  agent=null;
  if(!stopping)console.error(`Gmailエージェントが停止しました (${signal||code})。1分後に再起動します。`);
 });
}
const interval=setInterval(startAgent,3000);
startAgent();
function stop(signal='SIGTERM'){
 if(stopping)return;
 stopping=true;clearInterval(interval);
 if(agent)agent.kill(signal);
 if(server.exitCode===null)server.kill(signal);
}
process.on('SIGINT',()=>stop('SIGINT'));
process.on('SIGTERM',()=>stop('SIGTERM'));
server.on('error',error=>{console.error(`受信箱を起動できません: ${error.message}`);stop()});
server.on('exit',(code,signal)=>{
 stop();
 process.exitCode=code|| (signal&&signal!=='SIGTERM'&&signal!=='SIGINT'?1:0);
});
