// Shared SSE decoder. Handles split UTF-8, split events, and CRLF framing.
export async function* readEvents(body) {
  if(!body)throw new Error('Missing response stream');
  const reader=body.getReader(),decoder=new TextDecoder();let pending='';
  try {
    while(true) {
      const {value,done}=await reader.read();
      pending+=done?decoder.decode():decoder.decode(value,{stream:true});
      if(pending.length>65536)throw new Error('Event too large');
      let match;
      while((match=/\r?\n\r?\n/.exec(pending))) {
        const block=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
        const data=block.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
        if(data&&data!=='[DONE]')yield JSON.parse(data);
      }
      if(done)break;
    }
  } finally { await reader.cancel().catch(()=>{});reader.releaseLock(); }
}
