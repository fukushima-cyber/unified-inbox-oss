import {backup,DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {chmodSync,existsSync,linkSync,unlinkSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const destination=process.argv[2];
if(!destination){console.error('Usage: node scripts/backup.mjs DESTINATION.sqlite');process.exit(2)}
process.umask(0o077);
const target=resolve(destination);
if(existsSync(target)){console.error('Backup destination already exists');process.exit(2)}
const dir=dirname(fileURLToPath(import.meta.url));
const sourcePath=process.env.INBOX_DB||join(dir,'../inbox.sqlite');
if(!existsSync(sourcePath)){console.error('Source database does not exist');process.exit(2)}
const temporary=`${target}.tmp-${randomUUID()}`;
let source;
try{
 source=new DatabaseSync(sourcePath);
 const pages=await backup(source,temporary);
 const check=new DatabaseSync(temporary);
 try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('backup_integrity_failed')}finally{check.close()}
 chmodSync(temporary,0o600);
 linkSync(temporary,target);
 console.log(JSON.stringify({destination:target,pages}));
}finally{
 source?.close();
 if(existsSync(temporary))unlinkSync(temporary);
}
