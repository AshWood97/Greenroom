/** The editor's transport for the shared Revideo scene. */
export type PlayerEvent='frameupdate'|'play'|'pause'|'volumechange'|'mutechange'|'fullscreenchange';
export interface NativePlayer {
  getCurrentFrame():number;isPlaying():boolean;play():void;pause():void;toggle():void;seekTo(frame:number):void;
  getVolume():number;setVolume(volume:number):void;isMuted():boolean;mute():void;unmute():void;
  isFullscreen():boolean;requestFullscreen():void;exitFullscreen():void;getContainerNode():HTMLElement|null;
  addEventListener(event:PlayerEvent,listener:(event:any)=>void):void;removeEventListener(event:PlayerEvent,listener:(event:any)=>void):void;
}
