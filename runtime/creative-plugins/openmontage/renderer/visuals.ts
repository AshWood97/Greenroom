/* Native Canvas artwork drawn by Revideo. No Remotion runtime or user code. */
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const spring = (seconds: number) => 1 - Math.exp(-seconds * 8) * Math.cos(seconds * 11);
const palette = ['#7C3AED', '#EC4899', '#06B6D4', '#F59E0B', '#10B981', '#EF4444'];
const theme = (custom: any) => ({ backgroundColor: '#0F172A', surfaceColor: '#1E293B', textColor: '#F8FAFC',
  mutedTextColor: '#94A3B8', primaryColor: '#7C3AED', accentColor: '#EC4899', chartColors: palette, ...custom });

function label(c: CanvasRenderingContext2D, value: any, x: number, y: number, size: number, ink: string,
               align: CanvasTextAlign = 'center', maxWidth = 1500) {
  c.font = `700 ${size}px "Noto Sans CJK SC", "Noto Sans", sans-serif`;
  c.textAlign = align; c.textBaseline = 'middle'; c.fillStyle = ink;
  const words = String(value ?? '').split(/(\s+|(?<=[\u3400-\u9fff]))/u);
  let line = '', row = 0;
  for (const word of words) {
    if (line && c.measureText(line + word).width > maxWidth) { c.fillText(line, x, y + row++ * size * 1.3); line = word.trimStart(); }
    else line += word;
  }
  c.fillText(line, x, y + row * size * 1.3);
}
function box(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, ink: string, radius = 18) {
  c.fillStyle = ink; c.beginPath(); c.roundRect(x, y, w, h, radius); c.fill();
}
function background(c: CanvasRenderingContext2D, width: number, height: number, seconds: number, t: any) {
  c.fillStyle = t.backgroundColor; c.fillRect(0, 0, width, height);
  const gradient = c.createRadialGradient(width * (.3 + Math.sin(seconds / 10) * .2), height * .4, 0, width * .5, height * .5, width * .8);
  gradient.addColorStop(0, t.primaryColor + '28'); gradient.addColorStop(1, '#00000000');
  c.fillStyle = gradient; c.fillRect(0, 0, width, height);
}
function numeric(value: any, progress: number) {
  const raw = String(value ?? ''); const match = raw.match(/^([^\d-]*)(-?[\d,.]+)(.*)$/);
  if (!match) return raw;
  const count = Number(match[2].replaceAll(',', ''));
  return match[1] + (count * clamp(progress)).toLocaleString(undefined, { maximumFractionDigits: match[2].includes('.') ? 1 : 0 }) + match[3];
}
function terminal(c: CanvasRenderingContext2D, cut: any, age: number, w: number, h: number, t: any) {
  box(c, w * .08, h * .09, w * .84, h * .82, '#0B0F1A');
  for (let i = 0; i < 3; i++) { c.fillStyle = ['#EF4444', '#EAB308', '#22C55E'][i]; c.beginPath(); c.arc(w * .11 + i * 28, h * .13, 8, 0, Math.PI * 2); c.fill(); }
  label(c, cut.terminalTitle || 'Terminal', w / 2, h * .13, h * .025, t.mutedTextColor);
  let cursor = 0; const rows: string[] = [];
  for (const step of cut.steps || []) {
    const length = step.kind === 'cmd' ? (step.typeSpeed ?? .035) * step.text.length + (step.holdSeconds ?? .3)
      : step.kind === 'pause' ? step.seconds : step.kind === 'out' ? .08 + (step.holdSeconds ?? .15) : 0;
    if (age >= cursor) {
      if (step.kind === 'cmd') rows.push((cut.prompt || '$') + ' ' + step.text.slice(0, Math.floor((age - cursor) / (step.typeSpeed ?? .035))));
      if (step.kind === 'out') rows.push(step.text);
      if (step.kind === 'pill' && age - cursor < (step.durationSeconds ?? 2.2)) {
        box(c, w * .62, h * .77, w * .27, h * .07, step.color || t.accentColor); label(c, step.text, w * .755, h * .805, h * .023, '#fff');
      }
    }
    cursor += length;
  }
  rows.slice(-16).forEach((row, index) => label(c, row, w * .12, h * (.22 + index * .038), h * .027,
    row.startsWith(cut.prompt || '$') ? '#E2E8F0' : '#94A3B8', 'left', w * .75));
}
function screenshot(c: CanvasRenderingContext2D, cut: any, age: number, w: number, h: number, t: any) {
  let cursor = 0, point = cut.cursorStartAt || [.85, .2];
  for (const step of cut.screenshotSteps || []) {
    const duration = step.seconds ?? step.durationSeconds ?? (step.kind === 'type_into' ? step.text.length * (step.typeSpeed ?? .04) : .5);
    const p = clamp((age - cursor) / duration), started = age >= cursor;
    if (started) {
      const r = step.region || { x: 0, y: 0, w: 1, h: 1 };
      if (step.kind === 'cursor_move') point = [point[0] + (step.to[0] - point[0]) * p, point[1] + (step.to[1] - point[1]) * p];
      if (step.kind === 'type_into') label(c, step.text.slice(0, Math.floor(step.text.length * p)), r.x * w, (r.y + r.h / 2) * h,
        (step.fontSize || .022) * h, step.color || t.textColor, 'left', r.w * w);
      if (step.kind === 'bubble_append') {
        box(c, r.x * w, r.y * h, r.w * w, r.h * h, step.role === 'user' ? '#2563EB' : '#202C3B');
        label(c, step.stream ? step.text.slice(0, Math.floor(step.text.length * p)) : step.text, (r.x + .02) * w,
          (r.y + .03) * h, (step.fontSize || .022) * h, '#fff', 'left', (r.w - .04) * w);
      }
      if (age < cursor + duration) {
        if (step.kind === 'highlight_box') { c.strokeStyle = step.color || t.accentColor; c.lineWidth = 4; c.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h); }
        if (step.kind === 'click_pulse') { const at = step.at || point; c.strokeStyle = step.color || t.accentColor; c.globalAlpha = 1 - p; c.beginPath(); c.arc(at[0] * w, at[1] * h, 10 + p * 30, 0, Math.PI * 2); c.stroke(); c.globalAlpha = 1; }
        if (step.kind === 'typing_dots') for (let i = 0; i < 3; i++) { c.fillStyle = step.color || '#fff'; c.beginPath(); c.arc(step.at[0] * w + i * 16, step.at[1] * h + Math.sin(age * 9 + i) * 4, 4, 0, Math.PI * 2); c.fill(); }
        if (step.kind === 'callout_balloon') { box(c, step.anchor[0] * w, step.anchor[1] * h - 90, w * .3, 70, step.color || '#2563EB'); label(c, step.text, step.anchor[0] * w + w * .15, step.anchor[1] * h - 55, h * .022, '#fff', 'center', w * .28); }
      }
    }
    cursor += duration;
  }
  c.fillStyle = '#fff'; c.strokeStyle = '#111'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(point[0] * w, point[1] * h); c.lineTo(point[0] * w + 6, point[1] * h + 25); c.lineTo(point[0] * w + 21, point[1] * h + 18); c.closePath(); c.fill(); c.stroke();
}

export function paintScene(c: CanvasRenderingContext2D, cut: any, age: number, w: number, h: number, custom: any) {
  const t = theme(custom), accent = cut.accentColor || t.accentColor, ink = cut.color || t.textColor;
  const type = cut.type, p = clamp(age / .9), reveal = spring(age), mid = w / 2;
  const hasMedia = cut.source || cut.backgroundImage || cut.backgroundVideo || cut.images?.length;
  if (!hasMedia) background(c, w, h, age, { ...t, backgroundColor: cut.backgroundColor || t.backgroundColor });
  if ((cut.backgroundImage || cut.backgroundVideo) && type !== 'screenshot_scene') { c.fillStyle = `rgba(0,0,0,${cut.backgroundOverlay ?? .55})`; c.fillRect(0, 0, w, h); }
  if (type === 'terminal_scene') return terminal(c, cut, age, w, h, t);
  if (type === 'screenshot_scene') {
    const size = cut.screenshotSize || { width: 1920, height: 1080 };
    const scale = Math.min(w / size.width, h / size.height), sw = size.width * scale, sh = size.height * scale;
    c.save(); c.translate((w - sw) / 2, (h - sh) / 2); screenshot(c, cut, age, sw, sh, t); c.restore();
    return;
  }
  if (type === 'anime_scene' || !type) {
    if (cut.vignette !== false) { const v = c.createRadialGradient(mid, h / 2, h * .3, mid, h / 2, w * .7); v.addColorStop(0, '#00000000'); v.addColorStop(1, '#00000099'); c.fillStyle = v; c.fillRect(0, 0, w, h); }
    if (cut.lightingFrom || cut.lightingTo) { c.globalAlpha = .14; c.fillStyle = age / (cut.out_seconds - cut.in_seconds) < .5 ? cut.lightingFrom || '#fff' : cut.lightingTo || '#fff'; c.fillRect(0, 0, w, h); c.globalAlpha = 1; }
    if (cut.particles && cut.particles !== 'none') {
      c.fillStyle = cut.particleColor || '#FFDDAA'; c.globalAlpha = cut.particleIntensity ?? .6;
      for (let i = 0; i < (cut.particleCount || 20); i++) { const x = ((i * 137.5 + Math.sin(i + age * .4) * 40) % w + w) % w; const y = ((i * 81.3 - age * (12 + i % 15)) % h + h) % h; c.beginPath(); c.arc(x, y, 1.5 + i % 4, 0, Math.PI * 2); c.fill(); }
      c.globalAlpha = 1;
    }
    return;
  }
  c.save(); c.translate(mid, h / 2); c.scale(.94 + .06 * reveal, .94 + .06 * reveal); c.translate(-mid, -h / 2);
  if (type === 'text_card' || type === 'hero_title' || type === 'title') {
    label(c, cut.text, mid, h * .44, cut.fontSize || h * .085, ink, 'center', w * .82);
    label(c, cut.heroSubtitle || cut.subtitle || '', mid, h * .66, h * .033, t.mutedTextColor, 'center', w * .8);
    c.fillStyle = accent; c.fillRect(mid - 70, h * .58, 140 * p, 5);
  } else if (type === 'stat_card') {
    label(c, numeric(cut.stat, p), mid, h * .43, h * .15, accent);
    label(c, cut.subtitle || '', mid, h * .63, h * .04, ink, 'center', w * .8);
  } else if (type === 'callout') {
    box(c, w * .12, h * .23, w * .76, h * .54, cut.cardBackgroundColor || t.surfaceColor);
    c.fillStyle = accent; c.fillRect(w * .12, h * .23, 8, h * .54);
    label(c, cut.title || '', w * .17, h * .34, h * .04, accent, 'left', w * .66);
    label(c, cut.text, w * .17, h * .47, cut.fontSize || h * .045, ink, 'left', w * .66);
  } else if (type === 'comparison') {
    [0, 1].forEach(index => { box(c, w * (.08 + index * .46), h * .25, w * .38, h * .5, cut.cardBackgroundColor || t.surfaceColor);
      label(c, index ? cut.rightLabel : cut.leftLabel, w * (.27 + index * .46), h * .37, h * .035, t.mutedTextColor);
      label(c, index ? cut.rightValue : cut.leftValue, w * (.27 + index * .46), h * .52, h * .07, index ? accent : ink); });
    label(c, cut.title || '', mid, h * .14, h * .05, ink);
  } else if (type === 'bar_chart' || type === 'chart') {
    const data = cut.chartData || [], max = Math.max(1, ...data.map((d: any) => Number(d.value))), bar = w * .7 / Math.max(1, data.length);
    data.forEach((d: any, i: number) => { const height = Number(d.value) / max * h * .5 * p, x = w * .15 + i * bar;
      box(c, x, h * .75 - height, bar * .65, height, (cut.chartColors || t.chartColors)[i % t.chartColors.length], 5);
      label(c, d.label || d.name || '', x + bar * .325, h * .81, h * .023, ink, 'center', bar);
      if (cut.showValues !== false) label(c, numeric(d.value, p), x + bar * .325, h * .71 - height, h * .025, ink); });
  } else if (type === 'line_chart') {
    const series = cut.chartSeries || [], points = series.flatMap((s: any) => s.data || s.points || []), max = Math.max(1, ...points.map((d: any) => Number(d.value ?? d.y ?? d)));
    series.forEach((s: any, index: number) => { const data = s.data || s.points || []; c.strokeStyle = s.color || t.chartColors[index % t.chartColors.length]; c.lineWidth = 5; c.beginPath();
      data.slice(0, Math.max(1, Math.ceil(data.length * p))).forEach((d: any, i: number) => { const x = w * .12 + i / Math.max(1, data.length - 1) * w * .76, y = h * .76 - Number(d.value ?? d.y ?? d) / max * h * .52; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke(); });
    label(c, cut.xLabel || '', mid, h * .86, h * .025, ink); label(c, cut.yLabel || '', w * .12, h * .16, h * .025, ink);
  } else if (type === 'pie_chart') {
    const data = cut.chartData || [], total = data.reduce((s: number, d: any) => s + Number(d.value), 0) || 1; let angle = -Math.PI / 2;
    data.forEach((d: any, i: number) => { const end = angle + Number(d.value) / total * Math.PI * 2 * p; c.fillStyle = (cut.chartColors || t.chartColors)[i % t.chartColors.length]; c.beginPath(); c.moveTo(mid, h / 2); c.arc(mid, h / 2, h * .3, angle, end); c.closePath(); c.fill(); angle = end; });
    if (cut.donut) { c.fillStyle = cut.backgroundColor || t.backgroundColor; c.beginPath(); c.arc(mid, h / 2, h * .19, 0, Math.PI * 2); c.fill(); label(c, cut.centerValue || '', mid, h * .48, h * .06, ink); label(c, cut.centerLabel || '', mid, h * .55, h * .025, t.mutedTextColor); }
    if (cut.showLegend !== false) data.forEach((d: any, i: number) => label(c, `${d.label || d.name}: ${d.value}`, w * .84, h * (.28 + i * .07), h * .025, t.chartColors[i % t.chartColors.length], 'center', w * .25));
  } else if (type === 'kpi_grid') {
    const columns = cut.columns || 3, data = cut.chartData || [], rows = Math.ceil(data.length / columns);
    data.forEach((d: any, index: number) => { const x = w * .1 + index % columns * w * .8 / columns, y = h * .2 + Math.floor(index / columns) * h * .65 / rows, cw = w * .75 / columns, ch = h * .55 / rows;
      box(c, x, y, cw, ch, t.surfaceColor); label(c, d.label || d.name, x + cw / 2, y + ch * .25, h * .025, t.mutedTextColor); label(c, numeric(d.value, p), x + cw / 2, y + ch * .55, h * .055, accent); label(c, d.change || d.trend || '', x + cw / 2, y + ch * .8, h * .023, '#10B981'); });
  } else if (type === 'progress_bar' || type === 'progress') {
    const value = cut.progress > 1 ? cut.progress / 100 : cut.progress; box(c, w * .12, h * .47, w * .76, h * .07, t.surfaceColor); box(c, w * .12, h * .47, w * .76 * clamp(value * p), h * .07, cut.progressColor || accent);
    label(c, cut.progressLabel || `${Math.round(value * p * 100)}%`, mid, h * .36, h * .055, ink);
  }
  c.restore();
}

export function paintOverlays(c: CanvasRenderingContext2D, plan: any, seconds: number, w: number, h: number) {
  const t = theme(plan.themeConfig || {});
  for (const overlay of plan.overlays || []) {
    if (seconds < overlay.in_seconds || seconds >= overlay.out_seconds) continue;
    const age = seconds - overlay.in_seconds, accent = overlay.accentColor || t.accentColor;
    if (overlay.type === 'hero_title') { label(c, overlay.text, w / 2, h * .45, h * .09, t.textColor, 'center', w * .8); label(c, overlay.subtitle || '', w / 2, h * .62, h * .035, accent); }
    else {
      const lower = String(overlay.position).includes('bottom'), right = String(overlay.position).includes('right');
      const x = right ? w * .75 : w * .06, y = lower ? h * .82 : h * .08;
      box(c, x, y, w * .21, h * .1, '#102035DD');
      const value = overlay.type === 'provider_chip' ? (overlay.providers || [])[Math.floor(age / (overlay.cycleSeconds || 2)) % (overlay.providers?.length || 1)] : overlay.text;
      label(c, value || '', x + w * .105, y + h * .05, h * .027, accent, 'center', w * .19);
    }
  }
  const options = plan.captions || {}, sentence = options.mode === 'sentence';
  const captions = Array.isArray(options) ? options : (sentence ? options.segments : options.words) || [];
  const active = captions.findIndex((word: any) => seconds >= (word.startMs ?? word.start * 1000) / 1000 && seconds < (word.endMs ?? word.end * 1000) / 1000);
  if (active >= 0) {
    const count = options.wordsPerPage || 7, size = options.fontSize || h * .048;
    const single = sentence || options.mode === 'word-by-word';
    const start = single ? active : Math.floor(active / count) * count;
    const words = captions.slice(start, single ? start + 1 : start + count);
    c.save(); c.font = `800 ${size}px ${JSON.stringify(options.font || 'Noto Sans CJK SC')},sans-serif`;
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.lineWidth = Math.max(2, size * .08);
    c.strokeStyle = options.outlineColor || '#0B0D12';
    const rows: {text: string, active: boolean, width: number}[][] = [[]];
    for (let index = 0; index < words.length; index++) {
      const chunks = sentence ? String(words[index].text).split(/(\n)|\s+|(?<=[\u3400-\u9fff])/u).filter(Boolean) : [words[index].word ?? words[index].text];
      for (const text of chunks) {
        let row = rows[rows.length - 1];
        if (text === '\n') { if (row.length) rows.push([]); continue; }
        const width = c.measureText(text + ' ').width;
        if (row.length && (row.length >= count || row.reduce((sum, token) => sum + token.width, 0) + width > w * .88)) { rows.push([]); row = rows[rows.length - 1]; }
        row.push({text, width, active: !sentence && start + index === active});
      }
    }
    const populated = rows.filter(row => row.length), lineHeight = size * 1.3;
    const centerY = options.position === 'top-center' ? h * .16 : options.position === 'center' ? h * .5 : h * .84;
    populated.forEach((row, index) => {
      const width = row.reduce((sum, token) => sum + token.width, 0);
      let x = (w - width) / 2;
      const y = centerY + (index - (populated.length - 1) / 2) * lineHeight;
      if (options.background) { c.fillStyle = options.background; c.fillRect(x - size * .2, y - lineHeight / 2, width + size * .4, lineHeight); }
      for (const token of row) {
        c.strokeText(token.text, x, y);
        c.fillStyle = token.active && options.mode !== 'word-by-word' ? (options.highlightColor || '#FFD400') : (options.color || '#fff');
        c.fillText(token.text, x, y); x += token.width;
      }
    });
    c.restore();
  }
}
