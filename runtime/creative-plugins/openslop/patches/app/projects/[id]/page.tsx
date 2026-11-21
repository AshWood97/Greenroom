import { notFound } from 'next/navigation';
import { loadTranscript } from '@/lib/api/conversations';
import { listProviderKeys } from '@/lib/api/provider-keys';
import { parseSavedProject } from '@/lib/project/saved-project';
import { getProject, readRow, member } from '@/lib/greenroom/store';
import { AccountSchema } from '@/lib/user/account';
import { ManagedModels } from '@/lib/greenroom/managed-models';
import { catalog } from '@/lib/greenroom/catalog';
import ProjectEditor from './project-editor';
export const dynamic = 'force-dynamic';
export default async function ProjectPage({params}:{params:Promise<{id:string}>}) {
  const {id}=await params; let project; try {project=await getProject(id);} catch {notFound();}
  const defaults=await readRow('account','defaults');
  return <ManagedModels config={await catalog()}><ProjectEditor key={id} projectId={id} initial={parseSavedProject(project)} initialTranscript={await loadTranscript(id,member.id)} account={AccountSchema.parse({...member,user_metadata:{...member.user_metadata,models:defaults?.models||{}}})} providerKeys={await listProviderKeys(member)}/></ManagedModels>;
}
