import {makeScene2D,Node,Img,Video} from '@revideo/2d';
import {useScene,useThread,waitFor} from '@revideo/core';
import type {RenderLayout,Sequence} from '@/lib/render/types';
import {CONTENT_TYPES} from '@/lib/canvas/types';
import {motionComponents,coverScale} from '@/lib/render/motion-effects';
import {totalDuration} from '@/lib/render/sequences';
import {wordsAt,type CaptionWord} from '@/lib/captions/caption-layout';
import {spaceBetween} from '@/lib/captions/word-spacing';
import {layoutCaptions} from '@/lib/render/caption-rule';
import {frameSpan,toSeconds} from '@/lib/render/frames';
import {captionFontStack,loadCaptionFonts} from '@/lib/captions/caption-fonts';
import {captionFontSizePx} from '@/lib/captions/caption-style';

const clamp=(x:number)=>Math.max(0,Math.min(1,x));
class CoverImage extends Img {
  protected async draw(context:CanvasRenderingContext2D){const parent=this.parent() as Film;const size=this.naturalSize();const scale=Math.max(parent.layout.width/size.x,parent.layout.height/size.y);this.size([size.x*scale,size.y*scale]);await super.draw(context);}
}
class CoverVideo extends Video {
  protected async draw(context:CanvasRenderingContext2D){const parent=this.parent() as Film;const media=this.mediaElement();const scale=Math.max(parent.layout.width/(media.videoWidth||1),parent.layout.height/(media.videoHeight||1));this.size([(media.videoWidth||1)*scale,(media.videoHeight||1)*scale]);await super.draw(context);}
}
class Film extends Node {
  readonly picture:HTMLCanvasElement=document.createElement('canvas');
  readonly filtered:HTMLCanvasElement=document.createElement('canvas');
  readonly flipping:HTMLCanvasElement=document.createElement('canvas');
  readonly media=new Map<Sequence,Img|Video>();
  readonly grain=new Image();
  readonly captionSequences:ReturnType<typeof layoutCaptions>;
  constructor(readonly layout:RenderLayout,readonly seconds:()=>number,publicBase:string,renderCaptions:boolean){
    super({});this.captionSequences=renderCaptions?layoutCaptions(layout):[];this.picture.width=this.filtered.width=this.flipping.width=layout.width;this.picture.height=this.filtered.height=this.flipping.height=layout.height;
    if(layout.filmGrain)this.grain.src=publicBase+'/effects/tri-x-400-grain.jpg';
    for(const sequence of [...layout.series,...Object.values(layout.sequences).flatMap(value=>value||[])]){
      const element=sequence.element;if(element.layer!=='visual')continue;let media:Img|Video;
      if(CONTENT_TYPES[element.type].outputKind==='image')media=new CoverImage({src:element.url});
      else media=new CoverVideo({src:element.url,volume:0,play:false,time:()=>{
        const local=Math.max(0,this.seconds()-sequence.start),play=Math.max(1/layout.fps,element.trimDurationSec);return element.trimStartSec+(element.loop?local%play:Math.min(local,Math.max(0,play-1/layout.fps)));
      }});
      this.media.set(sequence,media);this.add(media);
    }
  }
  private async flip(ctx:CanvasRenderingContext2D,sequence:Sequence,angle:number){
    if(Math.abs(angle)>=Math.PI/2)return;const {width:w,height:h}=this.layout,source=this.flipping.getContext('2d')!;source.clearRect(0,0,w,h);await this.clip(source,sequence);
    const cosine=Math.cos(angle),sine=Math.sin(angle),perspective=1000;
    for(let x=0;x<w;x+=2){const x1=x-w/2,x2=Math.min(w,x+2)-w/2,p1=perspective/(perspective+sine*x1),p2=perspective/(perspective+sine*x2),left=w/2+cosine*x1*p1,right=w/2+cosine*x2*p2,height=h*(p1+p2)/2;ctx.drawImage(this.flipping,x,0,Math.min(2,w-x),h,left,(h-height)/2,Math.max(.01,right-left+.3),height);}
  }
  private async clip(ctx:CanvasRenderingContext2D,sequence:Sequence,transition?:number){
    const local=this.seconds()-sequence.start;if(local<0||local>=totalDuration(sequence))return;
    const {width:w,height:h,fps}=this.layout;ctx.save();
    if(transition!==undefined){const p=clamp(transition);switch(this.layout.transitionType){
      case 'fade':ctx.globalAlpha=p;break;
      case 'slide':ctx.translate(-w*(1-p),0);break;
      case 'wipe':ctx.beginPath();ctx.rect(0,0,w*p,h);ctx.clip();break;
      case 'flip':ctx.translate(w/2,h/2);ctx.scale(Math.max(0.001,p<0.5?0:Math.sin((p-.5)*Math.PI)),1);ctx.translate(-w/2,-h/2);break;
      case 'clockWipe':{const radius=Math.hypot(w,h);ctx.beginPath();ctx.moveTo(w/2,h/2);ctx.arc(w/2,h/2,radius,-Math.PI/2,-Math.PI/2+p*2*Math.PI);ctx.closePath();ctx.clip();break;}
      case 'iris':ctx.beginPath();ctx.arc(w/2,h/2,Math.hypot(w,h)/2*p,0,2*Math.PI);ctx.clip();break;
    }}
    ctx.translate(w/2,h/2);
    const element=sequence.element;if(element.layer==='visual'){
      const {tx,ty,rotation,extraScale}=motionComponents(element.motion,Math.floor(local*fps),Math.round(totalDuration(sequence)*fps));
      const scale=element.motion==='none'?1:coverScale(tx,ty,rotation,Math.max(w/h,h/w))+.005+extraScale;
      ctx.translate(tx*w/100,ty*h/100);ctx.scale(scale,scale);ctx.rotate(rotation*Math.PI/180);await this.media.get(sequence)?.render(ctx);
    }
    ctx.restore();
  }
  private captions(ctx:CanvasRenderingContext2D,words:CaptionWord[]){
    const style=this.layout.captionStyle,{width:w,height:h}=this.layout;if(!words.length)return;
    const font=captionFontSizePx(style.fontSize,h),paddingX=0,paddingY=0,maxWidth=w*.84,lineHeight=font*1.25;
    const fontFor=(textStyle:any)=>`${textStyle.italic?'italic ':''}${textStyle.bold?700:400} ${font}px ${captionFontStack(style.font)}`;
    const items=words.map((word,index)=>{const text=style.casing==='upper'?word.text.toUpperCase():style.casing==='lower'?word.text.toLowerCase():word.text;const paint=word.active?style.activeWord:style.base;ctx.font=fontFor(paint);const width=ctx.measureText(text).width+paddingX*2,gap=ctx.measureText(spaceBetween(words[index-1]?.text,word.text)).width;return {word,text,paint,width,gap};});
    const lines:typeof items[]=[[]];let length=0;for(const item of items){if(length&&length+item.gap+item.width>maxWidth){lines.push([]);length=0;}lines.at(-1)!.push(item);length+=item.width+(length?item.gap:0);}
    const totalHeight=lines.length*lineHeight+(lines.length-1)*font*.1;let y=style.alignY==='top'?h*.06:style.alignY==='middle'?(h-totalHeight)/2:h*.94-totalHeight;
    ctx.save();ctx.textBaseline='top';ctx.lineJoin='round';ctx.letterSpacing=(-font*.01)+'px';
    for(const line of lines){const width=line.reduce((sum,item,index)=>sum+item.width+(index?item.gap:0),0);let x=style.alignX==='left'?w*.08:style.alignX==='right'?w*.92-width:(w-width)/2;
      for(const [index,item] of line.entries()){if(index)x+=item.gap;{const paint=item.paint;ctx.font=fontFor(paint);if(paint.background){ctx.fillStyle=paint.background;ctx.beginPath();ctx.roundRect(x,y,item.width,font+paddingY*2,font*.12);ctx.fill();}
        ctx.shadowColor='rgba(0,0,0,.55)';ctx.shadowBlur=.2*font;ctx.shadowOffsetY=.08*font;
        if(paint.border){ctx.strokeStyle=paint.border.color;ctx.lineWidth=paint.border.width*.0025*2*font;ctx.strokeText(item.text,x+paddingX,y+paddingY);}
        ctx.fillStyle=paint.fill;ctx.fillText(item.text,x+paddingX,y+paddingY);ctx.shadowBlur=ctx.shadowOffsetY=0;
        if(paint.underline){ctx.fillRect(x+paddingX,y+font+paddingY,item.width-paddingX*2,Math.max(1,font*.055));}
      }x+=item.width;}y+=lineHeight+font*.1;
    }ctx.restore();
  }
  protected async draw(context:CanvasRenderingContext2D){
    const {width:w,height:h}=this.layout,ctx=this.picture.getContext('2d')!;ctx.clearRect(0,0,w,h);ctx.fillStyle='black';ctx.fillRect(0,0,w,h);
    for(let index=0;index<this.layout.series.length;index++){
      const sequence=this.layout.series[index],local=this.seconds()-sequence.start;
      if(this.layout.transitionType==='flip'){
        if(index+1<this.layout.series.length){const p=(this.seconds()-this.layout.series[index+1].start)/this.layout.transitionDurationSec;if(p>=0&&p<1){await this.flip(ctx,sequence,p*Math.PI);continue;}}
        if(index>0&&local>=0&&local<this.layout.transitionDurationSec){await this.flip(ctx,sequence,(local/this.layout.transitionDurationSec-1)*Math.PI);continue;}
      }
      if(this.layout.transitionType==='slide'&&index+1<this.layout.series.length){const p=(this.seconds()-this.layout.series[index+1].start)/this.layout.transitionDurationSec;if(p>=0&&p<1){ctx.save();ctx.translate(w*p,0);await this.clip(ctx,sequence);ctx.restore();continue;}}
      await this.clip(ctx,sequence,index>0&&this.layout.transitionDurationSec>0&&local<this.layout.transitionDurationSec?local/this.layout.transitionDurationSec:undefined);
    }
    for(const sequence of Object.values(this.layout.sequences).flatMap(value=>value||[]))await this.clip(ctx,sequence);
    const frame=Math.round(this.seconds()*this.layout.fps);
    for(const {line,start,duration} of this.captionSequences){const {from,durationInFrames}=frameSpan(start,duration,this.layout.fps);if(frame>=from&&frame<from+durationInFrames)this.captions(ctx,wordsAt(line.tokens,line.startMs/1000+toSeconds(frame-from,this.layout.fps)));}
    if(this.layout.rgbSplit){
      const fx=this.filtered.getContext('2d')!;const source=ctx.getImageData(0,0,w,h),target=fx.createImageData(w,h),a=source.data,b=target.data;
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const at=(y*w+x)*4,left=(y*w+Math.max(0,x-1))*4,right=(y*w+Math.min(w-1,x+1))*4;b[at]=x===w-1?0:a[right];b[at+1]=a[at+1];b[at+2]=x===0?0:a[left+2];b[at+3]=a[at+3];}fx.putImageData(target,0,0);ctx.clearRect(0,0,w,h);ctx.drawImage(this.filtered,0,0);
    }
    if(this.layout.filmGrain){if(!this.grain.complete)await new Promise<void>((resolve,reject)=>{this.grain.onload=()=>resolve();this.grain.onerror=()=>reject(new Error('胶片颗粒素材加载失败'));});if(this.grain.naturalWidth){const frame=Math.floor(this.seconds()*this.layout.fps),scale=Math.max(1,w/2048,h/2048),pw=2048*scale,ph=2048*scale,x=(frame*7919%1009)/1009*(pw-w),y=(frame*3571%1013)/1013*(ph-h);ctx.save();ctx.globalCompositeOperation='overlay';ctx.globalAlpha=.2;ctx.drawImage(this.grain,-x,-y,pw,ph);ctx.restore();}}
    context.drawImage(this.picture,-w/2,-h/2,w,h);
  }
}
export default makeScene2D('openslop',function*(view){
  const layout=useScene().variables.get<RenderLayout>('layout',{} as RenderLayout)(),publicBase=useScene().variables.get<string>('publicBase','/plugins/openslop')();
  yield loadCaptionFonts(file=>publicBase+'/fonts/'+file,[layout.captionStyle.font]);
  const time=useThread().time,renderCaptions=useScene().variables.get<boolean>('renderCaptions',true)();view.add(new Film(layout,time,publicBase,renderCaptions));yield* waitFor(layout.totalFrames/layout.fps);
});
