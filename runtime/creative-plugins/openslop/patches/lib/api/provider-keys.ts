import type { User } from '@supabase/supabase-js';
import type { ProviderKeyRecord, ValidationResult } from '@/lib/connectors/provider-key';
export class MissingProviderKeyError extends Error { constructor(readonly provider: string) { super('生成服务尚未由管理员配置'); } }
export const hasApiAccess = (_user: unknown) => true;
export async function listProviderKeys(_user: unknown): Promise<ProviderKeyRecord[]> { return [{ provider: 'openslop', last4: '', status: 'valid', verifiedAt: null, createdAt: '' }]; }
export type ProviderKeysView = { providerKeys: ProviderKeyRecord[] };
export type ProviderKeyCheck = ProviderKeysView & { validation: ValidationResult };
export async function providerKeysView(user: User) { return { providerKeys: await listProviderKeys(user) }; }
export async function providerKeyCheck(user: User, validation: ValidationResult) { return { ...(await providerKeysView(user)), validation }; }
const managedOnly = async (..._args: unknown[]): Promise<never> => { throw new Error('API 凭据由 Greenroom 管理员统一配置'); };
export const saveProviderKey = managedOnly, readProviderKey = managedOnly, deleteProviderKey = managedOnly, setKeyStatus = managedOnly;
