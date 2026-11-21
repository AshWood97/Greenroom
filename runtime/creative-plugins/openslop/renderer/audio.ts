import type {RenderLayout,Sequence} from '@/lib/render/types';
import {audioFadeSec} from '@/lib/render/audio-fade';
import {audioVolume} from '@/lib/render/audio-volume';
import {CONTENT_TYPES} from '@/lib/canvas/types';
import {totalDuration} from '@/lib/render/sequences';
export type AudioTrack={url:string;start:number;duration:number;trim:number;gain:number;loop:boolean;playSec:number;envelopeFrames:number;fadeFrames:number;fps:number};
export function audioTracks(layout:RenderLayout):AudioTrack[]{
  const all:Sequence[]=[...layout.series,...Object.values(layout.sequences).flatMap(value=>value||[])];
  return all.filter(({element})=>element.layer==='audio'||CONTENT_TYPES[element.type].outputKind==='video').map(sequence=>{const {element,start}=sequence,duration=totalDuration(sequence);return {url:element.url,start,duration,trim:element.trimStartSec,gain:element.volume/10,loop:element.layer==='visual'&&element.loop,playSec:Math.max(1/layout.fps,element.trimDurationSec),envelopeFrames:Math.round(duration*layout.fps),fadeFrames:element.layer==='audio'?Math.round(audioFadeSec(element)*layout.fps):0,fps:layout.fps};});
}
export function trackVolume(track:AudioTrack,seconds:number){const volume=audioVolume(track.gain,track.envelopeFrames,track.fadeFrames);return typeof volume==='number'?volume:volume(seconds*track.fps);}
