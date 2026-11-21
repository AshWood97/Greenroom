/** @jsxImportSource react */
import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@revideo/player-react';
import project from './project';
import type {Player as CorePlayer} from '@revideo/core';
import type {RenderLayout} from '@/lib/render/types';
import {audioTracks,trackVolume} from './audio';
const post=(value:any)=>parent.postMessage({openslopPlayer:true,...value},location.origin);
function Preview(){
  const [layout,setLayout]=useState<RenderLayout|null>(null),[playing,setPlaying]=useState(false),[volume,setVolume]=useState(1),[current,setCurrent]=useState(0);const core=useRef<CorePlayer|null>(null),audios=useRef<{track:ReturnType<typeof audioTracks>[number];audio:HTMLAudioElement}[]>([]),state=useRef({playing:false,volume:1});state.current={playing,volume};
  useEffect(()=>{const receive=(event:MessageEvent)=>{if(event.source!==parent||event.origin!==location.origin||!event.data?.openslopControl)return;const data=event.data;if(data.layout){setLayout(data.layout);setPlaying(false);}if(data.action==='play'){setPlaying(true);core.current?.togglePlayback(true);}if(data.action==='pause'){setPlaying(false);core.current?.togglePlayback(false);audios.current.forEach(({audio})=>audio.pause());}if(data.action==='seek'){setCurrent(data.seconds);core.current?.requestSeek(Math.round(data.seconds*(data.fps||layout?.fps||24)));}if(data.action==='volume')setVolume(data.volume);};window.addEventListener('message',receive);post({ready:true});return()=>window.removeEventListener('message',receive);},[layout]);
  useEffect(()=>{audios.current.forEach(({audio})=>audio.pause());audios.current=layout?audioTracks(layout).map(track=>{const audio=new Audio(track.url);audio.preload='auto';return {track,audio};}):[];return()=>audios.current.forEach(({audio})=>{audio.pause();audio.removeAttribute('src');audio.load();});},[layout]);
  const update=(seconds:number)=>{
    if(!layout)return;for(const {track,audio} of audios.current){const local=seconds-track.start,active=local>=0&&local<track.duration&&(track.loop||local<track.playSec);if(!active||!state.current.playing){audio.pause();continue;}
      const target=track.trim+(track.loop?local%track.playSec:local);if(Math.abs(audio.currentTime-target)>.12)audio.currentTime=target;audio.volume=Math.max(0,Math.min(1,trackVolume(track,local)*state.current.volume));if(audio.paused)void audio.play().catch(error=>post({error:String(error.message)}));}
    post({frame:Math.round(seconds*layout.fps),playing:state.current.playing});
    if(seconds>=(layout.totalFrames-1)/layout.fps){setPlaying(false);core.current?.togglePlayback(false);audios.current.forEach(({audio})=>audio.pause());post({playing:false});}
  };
  return layout?<Player project={project} variables={{layout,renderCaptions:false,publicBase:location.pathname.split('/greenroom-player/')[0]}} playing={playing} currentTime={current} volume={0} looping={false} fps={layout.fps} width={layout.width} height={layout.height} controls={false} onTimeUpdate={update} onPlayerReady={player=>{core.current=player;post({mounted:true});}}/>:null;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
