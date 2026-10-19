const SCOPE='offline_access User.Read Chat.Read ChatMessage.Send';
const GRAPH='https://graph.microsoft.com/v1.0/me';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function teamsAppConfig(clientId,tenantId){
 if(!uuid.test(String(clientId||''))||!uuid.test(String(tenantId||'')))throw Error('invalid_teams_app_config');
 return {clientId,tenantId};
}
const endpoint=(tenant,path)=>`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/${path}`;
const form=(values)=>new URLSearchParams(values);

export async function startTeamsDeviceCode(config,fetcher=fetch){
 teamsAppConfig(config.clientId,config.tenantId);
 const response=await fetcher(endpoint(config.tenantId,'devicecode'),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form({client_id:config.clientId,scope:SCOPE}),signal:AbortSignal.timeout(12000)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok||!result.device_code||!result.user_code)throw Error(`teams_device_${String(result.error||response.status).slice(0,50)}`);
 const uri=new URL(result.verification_uri||'');
 if(uri.protocol!=='https:'||!['microsoft.com','www.microsoft.com'].includes(uri.hostname)||uri.pathname!=='/devicelogin')throw Error('invalid_teams_verification_url');
 return {deviceCode:result.device_code,userCode:result.user_code,verificationUri:uri.href,expiresAt:Date.now()+Number(result.expires_in||900)*1000,interval:Math.max(5,Number(result.interval||5))};
}

export async function pollTeamsDeviceCode(config,deviceCode,fetcher=fetch){
 const response=await fetcher(endpoint(config.tenantId,'token'),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form({client_id:config.clientId,grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:deviceCode}),signal:AbortSignal.timeout(12000)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok){if(['authorization_pending','slow_down'].includes(result.error))return {status:'pending',slowDown:result.error==='slow_down'};throw Error(`teams_oauth_${String(result.error||response.status).slice(0,50)}`)}
 if(!result.access_token||!result.refresh_token)throw Error('teams_oauth_missing_tokens');
 const scopes=new Set(String(result.scope||'').split(' '));
 if(!['User.Read','Chat.Read','ChatMessage.Send'].every(scope=>scopes.has(scope)))throw Error('teams_oauth_missing_scopes');
 return {status:'connected',accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:new Date(Date.now()+Number(result.expires_in||3600)*1000).toISOString()};
}

export async function refreshTeamsToken(config,refreshToken,fetcher=fetch){
 const response=await fetcher(endpoint(config.tenantId,'token'),{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form({client_id:config.clientId,grant_type:'refresh_token',refresh_token:refreshToken,scope:SCOPE}),signal:AbortSignal.timeout(12000)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok||!result.access_token){const error=Error(`teams_refresh_${String(result.error||response.status).slice(0,50)}`);error.permanent=['invalid_grant','interaction_required'].includes(result.error);throw error}
 return {accessToken:result.access_token,refreshToken:result.refresh_token||refreshToken,expiresAt:new Date(Date.now()+Number(result.expires_in||3600)*1000).toISOString()};
}

export async function teamsProfile(accessToken,fetcher=fetch){
 const response=await fetcher(GRAPH,{headers:{authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(12000)});
 const result=await response.json().catch(()=>({}));
 if(!response.ok||!uuid.test(String(result.id||'')))throw Error(`teams_profile_${response.status}`);
 return {id:result.id,displayName:String(result.displayName||result.userPrincipalName||'Teams').slice(0,200)};
}
