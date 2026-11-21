import {readRow,listRows,writeRow} from '@/lib/greenroom/store';
/** The member sidecar owns accepted task bindings; the root adapter queries their original platform task. */
export async function getJob(id:string){return readRow('jobs',id);}
export async function listProjectJobs(projectId:string){return (await listRows('jobs')).filter(job=>job.projectId===projectId);}
export async function saveJob(job:{jobId:string;[key:string]:unknown}){await writeRow('jobs',job.jobId,job);return job;}
