import {readFileSync} from 'node:fs';
import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
export const token=()=>randomBytes(32).toString('base64url');
export const hash=x=>createHash('sha256').update(String(x)).digest('hex');
export const same=(a,b)=>{const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&timingSafeEqual(x,y)};
export const master=x=>{if(!/^[a-f0-9]{64}$/i.test(x??''))throw Error('INBOX_MASTER_KEY: 32-byte hex required');return Buffer.from(x,'hex')};
export const masterFromEnv=()=>master(process.env.INBOX_MASTER_KEY_FILE?readFileSync(process.env.INBOX_MASTER_KEY_FILE,'utf8').trim():process.env.INBOX_MASTER_KEY);
export function seal(key,s){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,c.update(String(s)),c.final(),c.getAuthTag()]).toString('base64url')}
export function open(key,s){const b=Buffer.from(s,'base64url'),c=createDecipheriv('aes-256-gcm',key,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString()}
export const slackSignature=(key,ts,body)=>'v0='+createHmac('sha256',key).update(`v0:${ts}:${body}`).digest('hex');
export const chatworkSignature=(key,body)=>createHmac('sha256',Buffer.from(key,'base64')).update(body).digest('base64');
