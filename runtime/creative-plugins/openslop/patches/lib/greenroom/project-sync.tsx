"use client";
import {useEffect,useState} from 'react';
import {useSlateStatic} from 'slate-react';
import {useProjectId} from '@/lib/project/project-provider';
import {useProjectStoreHandle} from '@/lib/project/project-store-provider';
import {useGenerationQueue} from '@/lib/generation/generation-queue-provider';
import {createProjectDocument} from '@/lib/project/project-document';
import {parseSavedProject} from '@/lib/project/saved-project';
import {setManagedProject} from '@/lib/generation/generate-for-element';
import {toastError} from '@/lib/toast-error';
export function ManagedProjectSync(){
  const projectId=useProjectId(),editor=useSlateStatic(),store=useProjectStoreHandle(),queue=useGenerationQueue();
  const [warnings,setWarnings]=useState<Record<string,string>>({});
  useEffect(()=>{setManagedProject(projectId);const source=new EventSource((process.env.NEXT_PUBLIC_GREENROOM_BASE_PATH||'/plugins/openslop')+'/api/greenroom/projects/'+projectId+'/events');const document=createProjectDocument({editor,store,queue});source.onmessage=event=>{try{const {project,change,tasks}=JSON.parse(event.data);
    if(change==='tasks'){for(const task of tasks){setWarnings(previous=>{const next={...previous},message=task.queryError||task.outputError||task.archiveError;if(message)next[task.jobId]=`${message}${task.platformTaskId?' · '+task.platformTaskId:''}`;else delete next[task.jobId];return next;});if(task.elementId){if(task.status==='pending'||task.status==='processing')queue.restoreManagedGeneration(task.elementId,{status:'generating',startedAt:Date.now(),connectorType:task.connectorType||null});else if(task.status==='failed')queue.restoreManagedGeneration(task.elementId,{status:'idle',startedAt:null,error:task.error||'服务商未返回具体失败原因'});}}return;}
    const saved=parseSavedProject(project);if(change==='document'){document.write(saved);return;}for(const [elementId,snapshot] of Object.entries(saved.generation))queue.restoreManagedGeneration(elementId,snapshot);
  }catch(error){toastError(error,'同步工程');}};return()=>source.close();},[projectId,editor,store,queue]);
  return Object.keys(warnings).length?<div role="status" className="fixed bottom-4 right-4 z-50 max-w-md rounded-lg border border-border bg-card p-3 text-label text-foreground">{Object.entries(warnings).map(([id,message])=><p key={id}>{message}</p>)}</div>:null;
}
