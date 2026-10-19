import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.mjs';
import {teamsAppConfig,startTeamsDeviceCode,pollTeamsDeviceCode,refreshTeamsToken,teamsProfile} from '../src/teams-oauth.mjs';

const config={clientId:'11111111-1111-4111-8111-111111111111',tenantId:'22222222-2222-4222-8222-222222222222'};
test('Teams device authorization validates identity, scopes and local token custody',async()=>{
 assert.deepEqual(teamsAppConfig(config.clientId,config.tenantId),config);
 assert.throws(()=>teamsAppConfig('bad',config.tenantId),/invalid_teams_app_config/);
 const calls=[];
 const fake=async(url,init)=>{
  calls.push({url,init});
  if(url.endsWith('/devicecode'))return Response.json({device_code:'private-device-code',user_code:'PUBLICCODE',verification_uri:'https://microsoft.com/devicelogin',expires_in:900,interval:5});
  if(url.endsWith('/token')&&init.body.get('grant_type').includes('device_code'))return Response.json({access_token:'private-access',refresh_token:'private-refresh',expires_in:3600,scope:'User.Read Chat.Read ChatMessage.Send offline_access'});
  if(url.endsWith('/token'))return Response.json({access_token:'next-access',refresh_token:'next-refresh',expires_in:3600});
  if(url.endsWith('/me'))return Response.json({id:'33333333-3333-4333-8333-333333333333',displayName:'Owner'});
  throw Error(String(url));
 };
 const device=await startTeamsDeviceCode(config,fake);
 assert.equal(device.userCode,'PUBLICCODE');
 const token=await pollTeamsDeviceCode(config,device.deviceCode,fake);
 assert.equal(token.status,'connected');
 const profile=await teamsProfile(token.accessToken,fake);
 assert.equal(profile.displayName,'Owner');
 const refreshed=await refreshTeamsToken(config,token.refreshToken,fake);
 assert.equal(refreshed.refreshToken,'next-refresh');
 const store=new Store(':memory:',randomBytes(32)),user=store.createUser('owner@example.test');
 const connection=store.addConnection(user.id,{provider:'teams',externalAccountId:profile.id,displayName:profile.displayName,credential:token.accessToken});
 store.saveTeamsOauth(user.id,connection.id,{...config,refreshToken:token.refreshToken,expiresAt:new Date().toISOString()});
 assert.equal(store.teamsOauthDue(new Date(Date.now()+1000).toISOString()).refreshToken,'private-refresh');
 assert.ok(!JSON.stringify(store.db.prepare('SELECT * FROM teams_oauth').get()).includes('private-refresh'));
 store.close();
 assert.ok(calls.some(x=>String(x.url).endsWith('/me')));
});
