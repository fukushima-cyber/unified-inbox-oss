import {DatabaseSync} from 'node:sqlite';
import {normalizeEmail,validEmail} from '../src/auth.mjs';
const owner=normalizeEmail(process.argv[2]);
if(!validEmail(owner)){console.error('Invalid owner email');process.exit(2)}
const db=new DatabaseSync('inbox.sqlite',{readOnly:true});
try{
 const users=db.prepare('SELECT email FROM users').all();
 if(users.some(user=>normalizeEmail(user.email)!==owner)){
  console.error('The existing database contains another user. Keep it as a separate shared deployment.');
  process.exitCode=1;
 }
}finally{db.close()}
