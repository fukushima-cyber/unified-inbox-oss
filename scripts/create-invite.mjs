import {Store} from '../src/store.mjs';
import {masterFromEnv} from '../src/security.mjs';
import {normalizeEmail,validEmail} from '../src/auth.mjs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const email=normalizeEmail(process.argv[2]);
if(!validEmail(email)){console.error('Usage: node scripts/create-invite.mjs EMAIL');process.exit(2)}
if(process.env.INBOX_OWNER_EMAIL&&email!==normalizeEmail(process.env.INBOX_OWNER_EMAIL)){console.error('This is a personal instance; invite the owner only.');process.exit(2)}
const dir=dirname(fileURLToPath(import.meta.url));
const store=new Store(process.env.INBOX_DB||join(dir,'../inbox.sqlite'),masterFromEnv());
try{console.log(JSON.stringify(store.createInvite(email)))}finally{store.close()}
