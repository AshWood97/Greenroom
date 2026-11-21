const $ = id => document.getElementById(id);
const state = { projectId: new URL(location.href).searchParams.get('projectId') || '', review: null, cutId: '', pending: null, refreshRequest: 0, refreshApplied: 0, projectEpoch: 0 };
const video = $('video'), second = $('second');
const currentCut = () => state.review?.cuts.find(cut => cut.id === state.cutId);
const status = text => { $('status').textContent = text || ''; };
async function api(path, data) {
  const response = await fetch(path, data === undefined ? { credentials: 'same-origin' } : {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'greenroom-review' }, body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '审阅请求失败（HTTP ' + response.status + '）');
  return result;
}
function safely(fn) { return (...args) => { try { return Promise.resolve(fn(...args)).catch(error => status(error.message)); } catch (error) { status(error.message); } }; }
function option(value, label) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
function selectCut(id) {
  const cut = state.review.cuts.find(item => item.id === id);
  if (!cut) return;
  state.cutId = id; $('cut').value = id; video.src = cut.video;
  $('download').href = cut.video;
  $('download').download = 'take-one-' + cut.id + '.mp4';
  $('primary-label').textContent = cut.label + ' · ' + cut.width + '×' + cut.height + ' · ' + cut.fps + 'fps';
  $('seek').max = String(Math.max(0, Math.ceil(cut.duration * cut.fps) - 1));
  $('seek').value = '0'; $('send').disabled = false;
  clearPending(); updateTime(); renderNotes();
}
function selectCompare(id) {
  const cut = state.review?.cuts.find(item => item.id === id);
  $('comparison').hidden = !cut;
  if (cut) { second.src = cut.video; $('secondary-label').textContent = cut.label; }
  else { second.pause(); second.removeAttribute('src'); second.load(); }
}
function sync() {
  if (!$('comparison').hidden && Number.isFinite(second.duration)) {
    const target = Math.min(video.currentTime, second.duration);
    if (Math.abs(second.currentTime - target) > 1 / (currentCut()?.fps || 30)) second.currentTime = target;
    second.playbackRate = video.playbackRate;
  }
}
function updateTime() {
  const fps = currentCut()?.fps || 30;
  $('time').textContent = video.currentTime.toFixed(3) + 's · 第 ' + Math.round(video.currentTime * fps) + ' 帧';
  $('seek').value = String(Math.round(video.currentTime * fps)); sync();
}
function step(amount) {
  const cut = currentCut(); if (!cut) return;
  video.pause(); video.currentTime = Math.max(0, Math.min(cut.duration - 1 / cut.fps, (Math.round(video.currentTime * cut.fps) + amount) / cut.fps));
}
function clearPending() { state.pending = null; $('note-form').hidden = true; $('pin').hidden = true; $('note-text').value = ''; }
function beginNote(t, x = null, y = null) {
  if (!currentCut()) return;
  video.pause(); state.pending = { t, x, y }; $('note-form').hidden = false;
  $('note-position').textContent = t === null ? '整片意见' : `${t.toFixed(3)}s · 第 ${Math.round(t * currentCut().fps)} 帧${x === null ? '' : ' · 已标记画面位置'}`;
  $('pin').hidden = x === null;
  if (x !== null) { $('dot').setAttribute('cx', String(x * 100)); $('dot').setAttribute('cy', String(y * 100)); }
  $('note-text').focus();
}
function snapshot() {
  if (!video.videoWidth || !state.pending || state.pending.t === null) return undefined;
  const canvas = document.createElement('canvas'); canvas.width = Math.min(1280, video.videoWidth); canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
  const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, canvas.width, canvas.height);
  if (state.pending.x !== null) {
    context.beginPath(); context.arc(state.pending.x * canvas.width, state.pending.y * canvas.height, Math.max(7, canvas.width / 80), 0, Math.PI * 2);
    context.fillStyle = '#ed6b56'; context.fill(); context.strokeStyle = '#fff'; context.lineWidth = 2; context.stroke();
  }
  return canvas.toDataURL('image/jpeg', 0.82);
}
function renderNotes() {
  const host = $('notes'); host.replaceChildren();
  for (const note of state.review?.notes || []) {
    const article = document.createElement('article'); article.className = 'note' + (note.done ? ' resolved' : '');
    const top = document.createElement('div'); top.className = 'note-top';
    const label = document.createElement('span'); label.textContent = note.cut + ' · ' + (note.t === null ? '整片' : note.t.toFixed(3) + 's / 帧 ' + note.frame) + ' · ' + (note.done ? '已回应并解决' : '待处理'); top.append(label);
    if (note.t !== null) {
      const seek = document.createElement('button'); seek.type = 'button'; seek.textContent = '定位';
      seek.addEventListener('click', () => { if (state.cutId !== note.cutId) selectCut(note.cutId); video.pause(); video.currentTime = note.t; }); top.append(seek);
    }
    const content = document.createElement('p'); content.textContent = note.text; article.append(top, content);
    if (note.shot) { const image = document.createElement('img'); image.src = note.shot; image.alt = '批注画面快照'; image.loading = 'lazy'; article.append(image); }
    for (const reply of note.replies || []) {
      const section = document.createElement('div'); section.className = 'reply';
      const title = document.createElement('small'); const cut = state.review.cuts.find(item => item.id === reply.cutId);
      title.textContent = '制作回应' + (cut ? ' · ' + cut.label : '') + (reply.resolved ? ' · 已解决' : '');
      const words = document.createElement('p'); words.textContent = reply.text; section.append(title, words); article.append(section);
    }
    host.append(article);
  }
  const sent = [...(state.review?.events || [])].reverse().find(event => event.type === 'notes/sent');
  $('sent').textContent = sent ? '最近发送：' + new Date(sent.at).toLocaleString() + ' · ' + sent.open + ' 条待处理' : '保存后点击“发送本版意见”，制作会话可读取逐条意见与快照。';
}
async function refresh() {
  const projectId = state.projectId, epoch = state.projectEpoch, request = ++state.refreshRequest;
  if (!projectId) return;
  const current = () => epoch === state.projectEpoch && request > state.refreshApplied;
  let review;
  try { review = await api('api/review?projectId=' + encodeURIComponent(projectId)); }
  catch (error) {
    if (!current()) return;
    state.refreshApplied = request;
    throw error;
  }
  if (!current()) return;
  state.refreshApplied = request;
  if (state.review?.revision === review.revision) return;
  const oldIds = (state.review?.cuts || []).map(item => item.id).join(',');
  state.review = review;
  $('production-status').textContent = (review.production?.jobs || []).filter(job => job.error || job.lastQueryError || job.archiveError)
    .map(job => `${job.label} · ${job.status} · 任务 ${job.platformTaskId || job.jobId}\n${job.error || job.lastQueryError || job.archiveError}`).join('\n\n');
  $('empty').hidden = Boolean(review.cuts.length); $('players').hidden = !review.cuts.length;
  if (oldIds !== review.cuts.map(item => item.id).join(',')) {
    $('cut').replaceChildren(...review.cuts.map(cut => option(cut.id, cut.label)));
    const compare = $('compare').value; $('compare').replaceChildren(option('', '不比较'), ...review.cuts.map(cut => option(cut.id, cut.label)));
    $('compare').value = compare;
    if (!review.cuts.some(cut => cut.id === state.cutId)) selectCut(review.cuts[0]?.id); else $('cut').value = state.cutId;
  }
  renderNotes();
}
$('project').addEventListener('change', safely(async () => {
  state.projectEpoch++;
  state.projectId = $('project').value; state.review = null; state.cutId = ''; video.pause(); selectCompare('');
  video.removeAttribute('src'); video.load(); $('download').removeAttribute('href'); $('download').removeAttribute('download');
  $('compare').replaceChildren(option('', '不比较')); $('cut').replaceChildren(); $('send').disabled = true; $('notes').replaceChildren();
  for (const id of ['status', 'production-status', 'sent', 'primary-label', 'secondary-label']) $(id).textContent = '';
  $('empty').hidden = false; $('players').hidden = true; clearPending();
  const url = new URL(location.href); url.searchParams.set('projectId', state.projectId); history.replaceState(null, '', url); await refresh();
}));
$('cut').addEventListener('change', () => selectCut($('cut').value));
$('compare').addEventListener('change', () => selectCompare($('compare').value));
$('back').addEventListener('click', () => step(-1)); $('forward').addEventListener('click', () => step(1));
$('seek').addEventListener('input', () => { video.pause(); video.currentTime = Number($('seek').value) / currentCut().fps; });
video.addEventListener('timeupdate', updateTime); video.addEventListener('seeked', updateTime);
second.addEventListener('loadedmetadata', sync);
video.addEventListener('play', safely(async () => { if (!$('comparison').hidden) { sync(); await second.play(); } }));
video.addEventListener('pause', () => second.pause());
video.addEventListener('error', () => status('成片读取失败' + (video.error?.message ? '：' + video.error.message : '')));
$('stage').addEventListener('click', event => {
  const box = video.getBoundingClientRect();
  if (event.clientY > box.bottom - 46) return;
  beginNote(video.currentTime, Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)));
});
$('frame-note').addEventListener('click', () => beginNote(video.currentTime)); $('film-note').addEventListener('click', () => beginNote(null));
$('cancel').addEventListener('click', clearPending);
$('note-form').addEventListener('submit', safely(async event => {
  event.preventDefault(); if (!state.pending) return;
  const text = $('note-text').value.trim(); if (!text) return;
  await api('api/notes', { projectId: state.projectId, cutId: state.cutId, text, ...state.pending, ...(state.pending.t === null ? {} : { shot: snapshot() }) });
  clearPending(); status('批注已保存'); await refresh();
}));
$('send').addEventListener('click', safely(async () => {
  await api('api/send', { projectId: state.projectId, cutId: state.cutId }); status('本版意见已发送'); await refresh();
}));
document.addEventListener('keydown', event => {
  if (['TEXTAREA', 'INPUT', 'SELECT'].includes(event.target.tagName)) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1); }
});
safely(async () => {
  const { projects } = await api('api/projects');
  $('project').append(...projects.map(project => option(project.projectId, project.title)));
  if (state.projectId) { $('project').value = state.projectId; await refresh(); }
})();
setInterval(safely(refresh), 5000);
