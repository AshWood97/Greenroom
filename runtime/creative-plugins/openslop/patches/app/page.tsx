import ProjectsList from './components/projects/projects-list';
import { listProviderKeys } from '@/lib/api/provider-keys';
import { AccountSchema } from '@/lib/user/account';
import { UserProvider } from '@/lib/user/user-provider';
import { listRows, readRow, member } from '@/lib/greenroom/store';
import { ManagedModels } from '@/lib/greenroom/managed-models';
import { catalog } from '@/lib/greenroom/catalog';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const projects = (await listRows('projects')).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const config = await catalog();
  const defaults=await readRow('account','defaults');
  return <ManagedModels config={config}><UserProvider account={AccountSchema.parse({...member,user_metadata:{...member.user_metadata,models:defaults?.models||{}}})} providerKeys={await listProviderKeys(member)}><ProjectsList initialProjects={projects} /></UserProvider></ManagedModels>;
}
