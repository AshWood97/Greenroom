import {createServer} from 'node:http';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {handle,restore} from './backend';
const port=Number(process.env.PORT||18809),nextPort=port+100,base=(process.env.GREENROOM_BASE_PATH||'/plugins/openslop').replace(/\/$/,'');
const next=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(nextPort)],{env:{...process.env,PORT:String(nextPort),NEXT_TELEMETRY_DISABLED:'1'},stdio:'inherit'});
const server=createServer(async(incoming,outgoing)=>{
  try{
    const url=new URL(incoming.url||'/',`http://127.0.0.1:${port}`),normalized=url.pathname.startsWith(base+'/')?url.pathname.slice(base.length):url.pathname;
    // The launcher must not expose a ready UI while only the API is listening.
    if(normalized==='/api/greenroom/lifecycle'){
      try{
        const ready=await fetch(`http://127.0.0.1:${nextPort}${base}`,{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(800)});
        if(ready.status<200||ready.status>=400)throw new Error('frontend not ready');
      }catch{
        outgoing.writeHead(503,{'content-type':'application/json'});outgoing.end(JSON.stringify({known:false,busy:true,error:'OpenSlop 界面正在启动'}));return;
      }
    }
    if(['/api/','/greenroom/','/media/','/renders/','/assets/','/health'].some(prefix=>normalized.startsWith(prefix))){
      const controller=new AbortController();outgoing.on('close',()=>controller.abort());const request=new Request(url,{method:incoming.method,headers:incoming.headers as HeadersInit,signal:controller.signal,...(!['GET','HEAD'].includes(incoming.method||'GET')?{body:Readable.toWeb(incoming) as any,duplex:'half'}:{})} as RequestInit);
      const response=await handle(request);if(response){outgoing.writeHead(response.status,Object.fromEntries(response.headers));if(response.body){const body=Readable.fromWeb(response.body as any);outgoing.on('close',()=>body.destroy());body.on('error',()=>outgoing.destroy());body.pipe(outgoing);}else outgoing.end();return;}
    }
    const path=url.pathname.startsWith(base+'/')||url.pathname===base?url.pathname:base+(url.pathname==='/'?'':url.pathname);
    const upstream=httpRequest({host:'127.0.0.1',port:nextPort,path:path+url.search,method:incoming.method,headers:incoming.headers},result=>{outgoing.writeHead(result.statusCode||502,result.headers);result.pipe(outgoing);});upstream.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(503);outgoing.end('OpenSlop 正在启动');});incoming.pipe(upstream);
  }catch(error:any){if(!outgoing.headersSent)outgoing.writeHead(500,{'content-type':'application/json'});outgoing.end(JSON.stringify({error:error.message}));}
});
server.listen(port,'0.0.0.0',()=>{void restore();});
function close(){server.close();next.kill('SIGTERM');}
process.on('SIGTERM',close);process.on('SIGINT',close);next.on('exit',code=>{server.close();process.exit(code||0);});
