const realFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const url=String(input);
 if(url==='https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/oauth2/v2.0/devicecode')return Response.json({device_code:'test-device-private',user_code:'TESTCODE',verification_uri:'https://microsoft.com/devicelogin',expires_in:60,interval:5});
 if(url==='https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/oauth2/v2.0/token')return Response.json({access_token:'test-access-private',refresh_token:'test-refresh-private',expires_in:3600,scope:'User.Read Chat.Read ChatMessage.Send offline_access'});
 if(url==='https://graph.microsoft.com/v1.0/me')return Response.json({id:'33333333-3333-4333-8333-333333333333',displayName:'Teams Owner'});
 return realFetch(input,init);
};
