import { Img, Node, Video, makeScene2D } from '@revideo/2d';
import { createSignal, tween, useScene } from '@revideo/core';
import { paintScene, paintOverlays } from './visuals';

type Plan = { width: number; height: number; duration: number; cuts: any[]; [key: string]: any };

export default makeScene2D('openmontage', function* (view) {
  const plan = useScene().variables.get<Plan>('plan', { width: 1920, height: 1080, duration: 1, cuts: [] })();
  const clock = createSignal(0);
  const width = plan.width, height = plan.height;
  view.fill(plan.themeConfig?.backgroundColor || '#0F172A');

  class Artwork extends Node {
    constructor(private readonly drawArtwork: (context: CanvasRenderingContext2D) => void) { super({}); }
    protected async draw(context: CanvasRenderingContext2D) {
      context.save(); context.translate(-width / 2, -height / 2);
      this.drawArtwork(context); context.restore();
      await super.draw(context);
    }
  }
  const opacity = (cut: any) => {
    const age = clock() - cut.in_seconds, length = cut.out_seconds - cut.in_seconds;
    if (age < 0 || age >= length) return 0;
    const time = cut.transition_duration ?? 0.27;
    const start = ['cut', 'none'].includes(cut.transition_in) ? 1 : Math.min(1, age / time);
    const end = ['cut', 'none'].includes(cut.transition_out) ? 1 : Math.min(1, (length - age) / time);
    return Math.max(0, Math.min(start, end));
  };
  function media(parent: Node, cut: any, src: string, index = 0, count = 1) {
    if (!src) return;
    const age = () => Math.max(0, clock() - cut.in_seconds);
    const length = cut.out_seconds - cut.in_seconds;
    const p = () => Math.min(1, age() / length);
    const animation = cut.animation || cut.transform?.animation || (cut.type === 'anime_scene' ? 'ken-burns' : 'static');
    const scale = () => ({ 'zoom-in': 1 + p() * .15, 'zoom-out': 1.15 - p() * .15,
      'ken-burns': 1 + p() * .18, 'ken-burns-slow-zoom': 1 + p() * .18,
      'pan-left': 1.12, 'pan-right': 1.12, 'drift-up': 1.1, 'drift-down': 1.1, parallax: 1.12 }[animation] || 1) * (cut.transform?.scale || 1);
    const position = () => [
      animation === 'pan-left' ? 35 - p() * 70 : animation === 'pan-right' ? -35 + p() * 70 : animation.includes('ken-burns') ? -22 * p() : animation === 'parallax' ? 6 - p() * 12 : 0,
      animation === 'drift-up' ? 22 - p() * 44 : animation === 'drift-down' ? -22 + p() * 44 : animation === 'parallax' ? 14 - p() * 28 : animation.includes('ken-burns') ? -14 * p() : 0,
    ] as [number, number];
    const visible = () => {
      if (count === 1) return 1;
      const span = length / count;
      const start = index * span;
      return Math.max(0, Math.min(1, (age() - start) / .3 + 1, (start + span - age()) / .3 + (index === count - 1 ? 1 : 0)));
    };
    const isVideo = /\.(?:mp4|webm|mov|mkv)(?:$|\?)/i.test(src);
    const dimensions = plan.mediaSizes?.[src] || { width, height };
    const fit = cut.type === 'screenshot_scene' ? Math.min(width / dimensions.width, height / dimensions.height)
      : Math.max(width / dimensions.width, height / dimensions.height);
    const mediaWidth = dimensions.width * fit, mediaHeight = dimensions.height * fit;
    if (isVideo) parent.add(new Video({ src, width: mediaWidth, height: mediaHeight, volume: 0,
      time: () => (cut.source_in_seconds || cut.backgroundVideoStart || 0) + age() * (cut.speed || 1),
      scale, position, opacity: visible, loop: cut.loop || false }));
    else parent.add(new Img({ src, width: mediaWidth, height: mediaHeight, scale, position, opacity: visible }));
  }
  for (const cut of plan.cuts) {
    const group = new Node({ opacity: () => opacity(cut) });
    view.add(group);
    if (cut.type === 'anime_scene' && cut.images?.length) cut.images.forEach((src: string, index: number) => media(group, cut, src, index, cut.images.length));
    else media(group, cut, cut.backgroundVideo || cut.backgroundImage || (!cut.type ? cut.source : ''));
    group.add(new Artwork((context) => paintScene(context, cut, Math.max(0, clock() - cut.in_seconds), width, height, plan.themeConfig || {})));
  }
  view.add(new Artwork((context) => paintOverlays(context, plan, clock(), width, height)));
  yield* tween(plan.duration, value => clock(value * plan.duration));
});
