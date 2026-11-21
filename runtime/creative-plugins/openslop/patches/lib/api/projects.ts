import { readRow } from '@/lib/greenroom/store';
export async function ownsProject(id: string) { return (await readRow('projects', id)) !== null; }
