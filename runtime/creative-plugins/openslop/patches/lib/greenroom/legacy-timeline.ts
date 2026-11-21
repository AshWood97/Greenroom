import { parseXmlTag } from '@/lib/canvas/parse-xml-tag';

// Old projects stored an in-point plus a timeline length. The new editor stores
// an in/out pair; videos may also have held or looped past their media end.
export function migrateLegacyTimeline(script: string): string {
  return script.replace(/<([a-z_][\w-]*)\b([^<>]*?)>/g, (tag, name: string, rest: string) => {
    if (!['video', 'narration', 'character', 'music', 'sound'].includes(name)) return tag;
    const attrs = parseXmlTag(name + rest).attributes;
    if (!Object.hasOwn(attrs, 'timelineDuration')) return tag;
    const cleaned = tag.replace(/\s+timelineDuration="[^"]*"/g, '');
    if (Object.hasOwn(attrs, 'trimEnd')) return cleaned;
    const duration = Number(attrs.timelineDuration.trim());
    if (!attrs.timelineDuration.trim() || !Number.isFinite(duration)) return cleaned;
    const parsedStart = Number(attrs.trimStart?.trim());
    const start = attrs.trimStart?.trim() && Number.isFinite(parsedStart) ? Math.max(0, parsedStart) : 0;
    const length = Math.max(1, duration);
    const hold = name === 'video' ? ` holdDuration="${length}"` : '';
    return cleaned.replace(/>$/, ` trimEnd="${start + length}"${hold}>`);
  });
}

// Render jobs freeze their original layout before they are queued. Resume that
// snapshot with the same played/held spans instead of rebuilding a newer edit.
export function migrateLegacyRenderLayout(layout: any): any {
  let changed = false;
  const migrate = (sequence: any) => {
    const element = sequence?.element;
    if (!element || typeof element.trimDurationSec === 'number' || typeof element.durationSec !== 'number') return sequence;
    changed = true;
    const remaining = Math.max(0, element.mediaDurationSec - element.trimStartSec);
    const trimDurationSec = Math.max(0, Math.min(element.durationSec, remaining));
    const captions = element.captions && { ...element.captions, trimIndexOffset: element.captions.firstWordIndex ?? 0 };
    const next = { ...element, trimDurationSec, ...(captions ? { captions } : {}) };
    const visual = element.layer === 'visual';
    return { ...sequence, element: next, duration: visual && element.type !== 'image' ? Math.min(sequence.duration, trimDurationSec) : sequence.duration, minDuration: visual ? sequence.duration : 0 };
  };
  const series = layout.series.map(migrate);
  const sequences = Object.fromEntries(Object.entries(layout.sequences).map(([key, value]: [string, any]) => [key, value?.map(migrate)]));
  return changed ? { ...layout, series, sequences, captions: layout.captions ?? true } : layout;
}
