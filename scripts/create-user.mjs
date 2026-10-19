import {Store} from '../src/store.mjs';
import {masterFromEnv} from '../src/security.mjs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const email=process.argv[2];if(!email||!email.includes('@')){console.error('Usage: node scripts/create-user.mjs EMAIL');process.exit(2)}
const dir=dirname(fileURLToPath(import.meta.url));const s=new Store(process.env.INBOX_DB||join(dir,'../inbox.sqlite'),masterFromEnv());const u=s.createUser(email);console.log(JSON.stringify(u));s.close();
