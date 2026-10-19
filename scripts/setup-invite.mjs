import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from '../src/store.mjs';
import {masterFromEnv} from '../src/security.mjs';
import {normalizeEmail,validEmail} from '../src/auth.mjs';

const email=normalizeEmail(process.argv[2]);
if(!validEmail(email)){
 console.error('Usage: node scripts/setup-invite.mjs EMAIL');
 process.exit(2);
}
if(process.env.INBOX_OWNER_EMAIL&&email!==normalizeEmail(process.env.INBOX_OWNER_EMAIL)){
 console.error('This is a personal instance; setup the owner only.');
 process.exit(2);
}
const dir=dirname(fileURLToPath(import.meta.url));
const store=new Store(process.env.INBOX_DB||join(dir,'../inbox.sqlite'),masterFromEnv());
try{
 const result=store.tx(()=>{
  const user=store.passwordUser(email);
  if(user?.password_hash)return {email,status:'already_active'};
  // A rerun must yield a usable code without leaving older setup codes valid.
  store.db.prepare('UPDATE invitations SET used_at=? WHERE email=? AND used_at IS NULL').run(new Date().toISOString(),email);
  return {status:'invited',...store.createInvite(email)};
 });
 console.log(JSON.stringify(result));
}finally{store.close()}
