"use client";
import {useEffect,useMemo,useRef,useState} from 'react';
import type {RenderLayout} from '@/lib/render/types';
import type {NativePlayer,PlayerEvent} from './native-player';
import {usePlayerControl} from './player-control-context';
import {usePlayerFrame} from './use-player-state';
import {EditableCaptionLine} from './editable-caption-line';
import {layoutCaptions} from '@/lib/render/caption-rule';
import {wordsAt} from '@/lib/captions/caption-layout';
import {captionFontSizePx} from '@/lib/captions/caption-style';
import {frameSpan,toSeconds} from '@/lib/render/frames';
import {ActiveSceneSync} from './active-scene-sync';
import {PlayPauseFlash} from './play-pause-flash';
import {toastError} from '@/lib/toast-error';
export function ProjectPreview({layout}:{layout:RenderLayout}){
  const iframe=useRef<HTMLIFrameElement>(null),container=useRef<HTMLDivElement>(null),layoutRef=useRef(layout);layoutRef.current=layout;
  const {player,registerPlayer}=usePlayerControl(),[flash,setFlash]=useState<{key:number;playing:boolean}|null>(null);
  const [size,setSize]=useState({width:layout.width,height:layout.height});
  useEffect(()=>{const node=container.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    let frame=0,playing=false,volume=1,muted=false;const listeners=new Map<PlayerEvent,Set<(value:any)=>void>>();
    const emit=(type:PlayerEvent,detail:Record<string,unknown>={})=>listeners.get(type)?.forEach(listener=>listener({detail}));
    const send=(value:any)=>iframe.current?.contentWindow?.postMessage({openslopControl:true,...value},location.origin);
    const handle:NativePlayer={getCurrentFrame:()=>frame,isPlaying:()=>playing,play(){playing=true;send({action:'play'});emit('play');},pause(){playing=false;send({action:'pause'});emit('pause');},toggle(){playing?this.pause():this.play();},seekTo(value){frame=Math.max(0,Math.min(layoutRef.current.totalFrames-1,Math.round(value)));send({action:'seek',seconds:frame/layoutRef.current.fps,fps:layoutRef.current.fps});emit('frameupdate',{frame});},getVolume:()=>volume,setVolume(value){volume=Math.max(0,Math.min(1,value));send({action:'volume',volume:muted?0:volume});emit('volumechange',{volume});},isMuted:()=>muted,mute(){muted=true;send({action:'volume',volume:0});emit('mutechange',{isMuted:muted});},unmute(){muted=false;send({action:'volume',volume});emit('mutechange',{isMuted:muted});},isFullscreen:()=>document.fullscreenElement===container.current,requestFullscreen(){void container.current?.requestFullscreen();},exitFullscreen(){void document.exitFullscreen();},getContainerNode:()=>container.current,addEventListener(type,listener){if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(listener);},removeEventListener(type,listener){listeners.get(type)?.delete(listener);}};
    const receive=(event:MessageEvent)=>{if(event.source!==iframe.current?.contentWindow||event.origin!==location.origin||!event.data?.openslopPlayer)return;const data=event.data;if(data.ready){send({layout:layoutRef.current});}if(data.mounted){handle.seekTo(frame);send({action:'volume',volume:muted?0:volume});}if(data.frame!==undefined){frame=data.frame;emit('frameupdate',{frame});}if(data.playing!==undefined&&data.playing!==playing){playing=data.playing;emit(playing?'play':'pause');}if(data.error)toastError(new Error(data.error),'播放器');};
    const fullscreen=()=>emit('fullscreenchange',{isFullscreen:handle.isFullscreen()});window.addEventListener('message',receive);document.addEventListener('fullscreenchange',fullscreen);registerPlayer(handle);
    return()=>{send({action:'pause'});window.removeEventListener('message',receive);document.removeEventListener('fullscreenchange',fullscreen);registerPlayer(null);};
  },[registerPlayer]);
  useEffect(()=>{iframe.current?.contentWindow?.postMessage({openslopControl:true,layout},location.origin);},[layout]);
  const toggle=()=>{if(!player)return;const playing=!player.isPlaying();player.toggle();setFlash(previous=>({key:(previous?.key||0)+1,playing}));};
  return <div ref={container} className="relative h-full w-full bg-on-media"><iframe ref={iframe} src={(process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop')+'/greenroom-player/preview.html'} title="OpenSlop Revideo preview" className="h-full w-full border-0"/><button type="button" aria-label="Play or pause" className="absolute inset-0 cursor-pointer focus-ring focus-visible:ring-inset" onClick={toggle}/><div className="pointer-events-none absolute" style={{width:layout.width,height:layout.height,left:(size.width-layout.width*Math.min(size.width/layout.width,size.height/layout.height))/2,top:(size.height-layout.height*Math.min(size.width/layout.width,size.height/layout.height))/2,transform:`scale(${Math.min(size.width/layout.width,size.height/layout.height)})`,transformOrigin:"top left"}}>{player&&<PreviewCaptions layout={layout}/>}</div><PlayPauseFlash flash={flash}/><ActiveSceneSync/></div>;
}

function PreviewCaptions({layout}:{layout:RenderLayout}){
  const frame=usePlayerFrame(),captions=useMemo(()=>layoutCaptions(layout),[layout]);
  return captions.map(({element,line,start,duration})=>{
    const {from,durationInFrames}=frameSpan(start,duration,layout.fps);
    if(frame<from||frame>=from+durationInFrames)return null;
    return <EditableCaptionLine key={`${element.id}-${start}`} style={layout.captionStyle} words={wordsAt(line.tokens,line.startMs/1000+toSeconds(frame-from,layout.fps))} fontSizePx={captionFontSizePx(layout.captionStyle.fontSize,layout.height)} element={element} firstWordIndex={line.firstWordIndex}/>;
  });
}
