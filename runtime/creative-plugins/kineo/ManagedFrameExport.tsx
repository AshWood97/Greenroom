import React, {useLayoutEffect, useRef, useState} from 'react';
import {useParams} from 'react-router-dom';
import {Button} from '@/components/ui/button';
import {useProjectEdit} from '@/pages/project-edit/context/ProjectEditContext';
import {useStoryboard} from '@/stores/storyboard/storyboard-store';
import {useProjectStore} from '@/stores';
import {flushProjectStorage} from '@/stores/project/project-store';
import {request, runJob, waitForJob, managedStorage, flushManagedStorage} from '@/greenroom-browser';
import {frameExportPlan, submitFrameExport, frameExportResult, restoredFrameExportResult} from '@/greenroom-editor-export.mjs';

export default function ManagedFrameExport() {
  const {projectId} = useParams();
  const {state, actions} = useProjectEdit();
  const owner = useRef<object | null>(null), locked = useRef<object | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [receipt, setReceipt] = useState<any>(null), [result, setResult] = useState<any>(null);
  const [useStillImages, setUseStillImages] = useState(false);
  const [useOriginalAudio, setUseOriginalAudio] = useState(false);
  const [useFrameDurations, setUseFrameDurations] = useState(false);
  const frames = useStoryboard(s => s.frames);
  const videoFrames = (frames as any[]).filter(f => f.videoUrl);
  const key = 'kineo-frame-export:' + projectId;
  useLayoutEffect(() => {
    owner.current = {};
    locked.current = null; setBusy(false);
    setUseStillImages(false); setUseOriginalAudio(false); setUseFrameDurations(false);
    const saved = managedStorage.getItem(key);
    const prior = saved ? JSON.parse(saved) : null;
    setReceipt(prior); setResult(restoredFrameExportResult(prior,projectId)); setError('');
    return () => { owner.current = null; };
  }, [key]);
  async function exportFrames(resume = false) {
    if (locked.current || !projectId) return;
    const token = owner.current, active = () => !!token && owner.current === token;
    locked.current = token; setBusy(true); setError(''); setResult(null);
    const remember = async (value: any) => {
      managedStorage.setItem(key, JSON.stringify(value));
      if (active()) setReceipt(value);
      await flushManagedStorage();
    };
    let job: any, task: any;
    try {
      if (resume) {
        if (receipt?.projectId !== projectId) throw new Error('保存的导出记录不属于当前工程，未查询其它工程任务');
        if (receipt?.taskId) job = {id:receipt.taskId};
        else {
          const tasks = await request('/business',{method:'POST',body:JSON.stringify({operation:'list_tasks',arguments:{projectId}})});
          job = tasks.find((t: any) => t.submissionId === receipt?.submissionId);
          if (!job) throw new Error('尚未查到原受理记录；不会自动重投，请保留提交编号核查');
          await remember({...receipt,taskId:job.id});
        }
      } else {
        const frames = structuredClone(useStoryboard.getState().frames);
        const composition = structuredClone(state.composition), audioConfig = structuredClone(state.audioConfig);
        const project = useProjectStore.getState().projects.find(p => p.id === projectId);
        const plan = frameExportPlan(project,frames,composition,audioConfig,useStillImages,useOriginalAudio,useFrameDurations);
        task = await submitFrameExport({plan,active,runJob,remember,submissionId:'kineo-export:'+crypto.randomUUID(),save:async () => {
          await actions.saveFrames(frames);
          if (!active()) throw new Error('工程已切换，未提交导出');
          useProjectStore.getState().updateProject(projectId,{composition,audioConfig});
          await flushProjectStorage();
        }});
      }
      if (!task) task = await waitForJob(job);
      const value = frameExportResult(task,projectId);
      await remember({submissionId:task.submissionId,projectId,taskId:task.id,result:value});
      if (active()) setResult(value);
    } catch (e) {
      const originalId = job?.id || (e as any)?.taskId;
      if (originalId) {
        try {
          const task = await request('/tasks/' + encodeURIComponent(originalId));
          if (['failed','cancelled'].includes(task.status)) await remember({projectId,submissionId:task.submissionId,taskId:task.id,status:task.status});
        } catch { /* Keep the original receipt when the query itself fails. */ }
      }
      if (active()) setError(e instanceof Error ? e.message : String(e));
    }
    finally { if (locked.current === token) locked.current = null; if (active()) setBusy(false); }
  }
  return <section className="space-y-3" aria-label="原生图帧导出">
    <p className="text-sm text-slate-300">按当前图帧与配音导出 MP4（720p）。使用原工程分镜素材、时长及可支持的合成配置；不生成新素材，不发布到平台。</p>
    <p className="text-xs text-slate-400">支持整句对白字幕、图帧原配音和从零循环的背景音乐。视频片段、转场、关键帧和独立音效时间轴不能由此出口完整还原，会明确阻止导出；上方演示音轨控件不写入工程，不能作为导出设置。</p>
    <label className="block"><input type="checkbox" checked={useFrameDurations} disabled={busy} onChange={e => setUseFrameDurations(e.target.checked)}/> 本次按原分镜时长导出，不使用全局默认时长（不修改合成配置，转场/效果限制不变）</label>
    {videoFrames.length > 0 && <label className="block"><input type="checkbox" checked={useStillImages} disabled={busy} onChange={e => setUseStillImages(e.target.checked)}/> 本次明确改用静态图帧，不采用以下已有视频及其内嵌声音：{videoFrames.map(f => f.id).join('、')}（仍保留原视频）</label>}
    {!state.audioConfig.backgroundMusic && (frames as any[]).some(f => f.audioUrl) && <label className="block"><input type="checkbox" checked={useOriginalAudio} disabled={busy} onChange={e => setUseOriginalAudio(e.target.checked)}/> 本次使用原分镜配音原音量，不应用工程主音量/对白音量（无背景音乐时原生渲染不支持这些增益）</label>}
    <Button disabled={busy || (!!receipt && !result && !['failed','cancelled','not-submitted'].includes(receipt.status))} onClick={() => void exportFrames()}>{busy ? '正在保存 / 等待原生导出…' : '按当前图帧与配音导出'}</Button>
    {receipt && <><p role="status">原提交：{receipt.submissionId} {receipt.status === 'not-submitted' && '（页面切换，未提交）'} {receipt.taskId && <>任务：{receipt.taskId}</>}</p><Button disabled={busy} variant="outline" onClick={() => void exportFrames(true)}>查询原导出（不重投）</Button></>}
    {error && <p role="alert">{error}</p>}
    {result && <div><video controls src={result.url} className="max-w-full"/><a href={result.url} download={`${projectId}.mp4`}>下载实际 MP4</a><p>{result.bytes} 字节 · 实际时长 {result.duration} 秒</p></div>}
  </section>;
}
