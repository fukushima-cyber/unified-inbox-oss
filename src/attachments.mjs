export const MAX_FILE_BYTES=4*1024*1024;
export const MAX_TOTAL_BYTES=6*1024*1024;
export const MAX_FILES=3;
export const attachmentProviders=new Set(['gmail','chatwork','slack']);

export function normalizeAttachments(input,provider){
 if(input==null)return [];
 if(!Array.isArray(input)||input.length>MAX_FILES)throw Error('invalid_attachments');
 if(input.length&&!attachmentProviders.has(provider))throw Error('attachments_not_supported');
 if(provider==='chatwork'&&input.length>1)throw Error('too_many_attachments');
 let total=0;
 return input.map(file=>{
  if(!file||typeof file.name!=='string'||typeof file.type!=='string'||typeof file.data!=='string')throw Error('invalid_attachment');
  const name=file.name.replace(/[\r\n\\/\x00-\x1f\x7f]/g,'').trim();
  if(!name||name.length>180||Buffer.byteLength(name)>240)throw Error('invalid_attachment_name');
  const type=file.type||'application/octet-stream';
  if(!/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type)||type.length>100)throw Error('invalid_attachment_type');
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data))throw Error('invalid_attachment_data');
  const bytes=Buffer.from(file.data,'base64');
  if(!bytes.length||bytes.length>MAX_FILE_BYTES)throw Error('attachment_too_large');
  total+=bytes.length;if(total>MAX_TOTAL_BYTES)throw Error('attachments_too_large');
  return {name,type,data:bytes.toString('base64'),size:bytes.length};
 });
}
