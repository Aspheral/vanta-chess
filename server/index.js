import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { handleCoach } from './coach.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
const publicFile=path=>['/index.html','/sw.js','/manifest.webmanifest','/coach-config.json'].includes(path)||/^\/(src|icons)\/[a-zA-Z0-9_./-]+$/.test(path);
const tokenMatches=(a,b)=>Boolean(a&&b&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b)));

export function createCoachServer({apiKey=process.env.OPENAI_API_KEY,model=process.env.OPENAI_COACH_MODEL||'gpt-4.1-mini',accessToken=process.env.COACH_ACCESS_TOKEN||'',allowedOrigin=process.env.COACH_ALLOWED_ORIGIN||'',fetchImpl=fetch,requestLimit=200}={}) {
  const clients=new Map();let dailyCount=0,day='',active=0;
  return http.createServer(async(req,res)=>{
    const origin=req.headers.origin;
    const localHost=/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host||'');
    const sameOrigin=origin===`http://${req.headers.host}`||origin===`https://${req.headers.host}`;
    const originAllowed=!origin||sameOrigin||origin===allowedOrigin;
    const reject=(status,message)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({message}));};
    try {
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/api/coach') {
        if(!originAllowed)return reject(403,'This site is not allowed to use the coach.');
        if(origin&&origin===allowedOrigin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');}
        if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type, Authorization'});return res.end();}
        if(req.method!=='POST')return reject(405,'Use POST.');
        // A publicly reachable server requires a separate coach access token.
        // Never use an OpenAI API key as this browser token.
        if((accessToken||!localHost)&&!tokenMatches(req.headers.authorization?.replace(/^Bearer /,''),accessToken))return reject(401,'Enter the coach access token in Connection settings.');
        if(!(req.headers['content-type']||'').startsWith('application/json'))return reject(415,'Use JSON.');
        const now=Date.now(),today=new Date(now).toISOString().slice(0,10);
        if(day!==today){day=today;dailyCount=0;clients.clear();}
        const id=req.socket.remoteAddress;let bucket=clients.get(id);
        if(!bucket||now-bucket.start>60000){bucket={start:now,count:0};clients.set(id,bucket);}
        if(active>=3||bucket.count>=30||dailyCount>=requestLimit)return reject(429,'The coach request limit has been reached. Try again later.');
        const buffers=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>12000)return reject(413,'Request too large.');buffers.push(chunk);}
        bucket.count++;dailyCount++;active++;
        const abort=new AbortController();res.on('close',()=>abort.abort());
        try {
          const response=await handleCoach(new Request('http://localhost/api/coach',{method:'POST',body:Buffer.concat(buffers),signal:abort.signal}),{apiKey,model,fetchImpl});
          res.writeHead(response.status,Object.fromEntries(response.headers));
          if(response.body)for await(const chunk of response.body){if(res.destroyed)break;res.write(chunk);}
          res.end();
        } finally {active--;}
        return;
      }
      if(!['GET','HEAD'].includes(req.method))return reject(405,'Method not allowed.');
      const path=decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname);
      const file=resolve(root,'.'+path);
      if(!publicFile(path)||!file.startsWith(root)||path.split('/').some(p=>p==='..'||p.startsWith('.'))||!types[extname(file)])return reject(404,'Not found.');
      const body=await readFile(file);
      res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
      res.end(req.method==='HEAD'?undefined:body);
    } catch {if(!res.headersSent)reject(404,'Not found.');else res.end();}
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT)||4173;
  if(!['127.0.0.1','localhost'].includes(host)&&!process.env.COACH_ACCESS_TOKEN)throw new Error('Set COACH_ACCESS_TOKEN before exposing this server publicly.');
  createCoachServer().listen(port,host,()=>console.log(`Vanta coach: http://${host}:${port}`));
}
