import {readFile,writeFile,mkdir,cp,symlink} from 'node:fs/promises';
import {dirname,join,basename,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {renderVideo} from '@revideo/renderer';
import {audioTracks} from './audio';
import {fadeRamp} from '@/lib/render/fade-ramp';
import {renderScale} from '@/lib/render/resolutions';
async function main(){
const input=JSON.parse(await readFile(process.argv[2],'utf8')),app=process.cwd(),layout=input.layout;
const folder=dirname(input.output),work=join(folder,'scene');await mkdir(work,{recursive:true});
await writeFile(join(work,'project.ts'),`import {makeProject} from '@revideo/core';import scene from './scene?scene';export default makeProject({scenes:[scene],settings:${JSON.stringify({rendering:{fps:layout.fps,resolutionScale:renderScale(input.resolution||'1080p')},preview:{fps:layout.fps}})}});`);await cp(join(app,'greenroom','renderer','scene.tsx'),join(work,'scene.tsx'));await symlink(join(app,'node_modules'),join(work,'node_modules'),'dir').catch((error:any)=>{if(error.code!=='EEXIST')throw error;});
const publicBase='';
const localUrl=(value:string)=>value.startsWith('/')?(process.env.GREENROOM_SELF_URL||'http://127.0.0.1:18809')+value:value;
for(const sequence of [...layout.series,...Object.values(layout.sequences).flatMap((value:any)=>value||[])])sequence.element.url=localUrl(sequence.element.url);
const silent=join(folder,'picture.mp4');process.chdir(work);
await renderVideo({projectFile:'./project.ts',variables:{layout,publicBase},settings:{outDir:folder,outFile:'picture.mp4',workers:1,logProgress:false,projectSettings:{size:{x:layout.width,y:layout.height},range:[0,layout.totalFrames/layout.fps]},puppeteer:{executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']},viteConfig:{cacheDir:join(folder,'vite-cache'),publicDir:join(app,'public'),resolve:{alias:{'@':app}},optimizeDeps:{include:['@revideo/core','@revideo/2d','@revideo/renderer/lib/client/render']},server:{fs:{allow:[app,work]}}},progressCallback:(_worker,progress)=>process.stdout.write('progress:'+progress*.9+'\n')}});
function command(command:string,args:string[]){return new Promise<void>((resolve,reject)=>{const child=spawn(command,args,{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',value=>error=(error+value).slice(-3000));child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error)));});}
const tracks=audioTracks(layout),usable:typeof tracks=[];
for(const track of tracks){const hasAudio=await new Promise<boolean>((done,reject)=>{let out='';const child=spawn(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-select_streams','a:0','-show_entries','stream=codec_type','-of','csv=p=0',track.url]);child.stdout.on('data',value=>out+=value);child.on('error',reject);child.on('exit',code=>code===0?done(out.trim()==='audio'):reject(new Error('读取音轨失败')));});if(hasAudio)usable.push(track);}
if(!usable.length){await cp(silent,input.output);}else{
  const args=['-y','-i',silent];for(const track of usable)args.push('-i',track.url);
  const filters:string[]=[];
  usable.forEach((track,index)=>{
    const label='a'+index,parts=[`atrim=start=${track.trim}:duration=${track.playSec}`,'asetpts=PTS-STARTPTS','aresample=48000'];
    if(track.loop)parts.push(`aloop=loop=-1:size=${Math.max(1,Math.round(track.playSec*48000))}`);
    parts.push('aresample=48000',`atrim=duration=${track.duration}`,`volume=${track.gain}`);
    const ramp=fadeRamp(track.envelopeFrames,track.fadeFrames);if(ramp){const fadeIn=ramp.input[1]/track.fps,fadeOut=(ramp.input.at(-1)!-ramp.input.at(-2)!)/track.fps;parts.push(`afade=t=in:st=0:d=${fadeIn}`,`afade=t=out:st=${ramp.input.at(-2)!/track.fps}:d=${fadeOut}`);}
    parts.push(`adelay=${Math.round(track.start*1000)}:all=1`);filters.push(`[${index+1}:a]${parts.join(',')}[${label}]`);
  });
  filters.push(usable.map((_,index)=>`[a${index}]`).join('')+`amix=inputs=${usable.length}:normalize=0:duration=longest,apad,atrim=duration=${layout.totalFrames/layout.fps}[audio]`);
  args.push('-filter_complex',filters.join(';'),'-map','0:v','-map','[audio]','-c:v','copy','-c:a','aac','-b:a','192k','-t',String(layout.totalFrames/layout.fps),'-movflags','+faststart',input.output);await command(process.env.FFMPEG_PATH||'ffmpeg',args);
}
process.stdout.write('progress:1\n');
}
main().catch(error=>{process.stderr.write(String(error.message||error)+'\n',()=>process.exit(1));});
