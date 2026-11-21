import { AuthSession, MemberUser } from '../types/auth';
import { VALID_MEMBERS } from '../constants/members';

export class MfaRequired extends Error {
  readonly challengeId: string;

  constructor(challengeId: string) {
    super('需要验证码');
    this.name = 'MfaRequired';
    this.challengeId = challengeId;
  }
}

export interface AuthOptions {
  registrationEnabled: boolean;
  rosterSize: number;
  emailsConfigured: number;
  externalAuthActive: boolean;
  externalAuthAvailable: boolean;
  localMemberName: string | null;
}

interface MeResponse {
  user_info?: {
    user: MemberUser;
    email?: string;
    loginAt?: string;
  };
  members?: MemberUser[];
  detail?: string;
  external_auth_active?: boolean;
  external_auth_available?: boolean;
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string };
    if (body.detail) return body.detail;
  } catch {
    // 非 JSON 错误保持通用文案
  }
  return fallback;
}

function sessionFrom(body: MeResponse): AuthSession {
  if (!body.user_info?.user) {
    throw new Error('认证服务未返回成员资料');
  }
    return {
      user: body.user_info.user,
      email: body.user_info.email,
      loginAt: body.user_info.loginAt || new Date().toISOString(),
      externalAuthActive: Boolean(body.external_auth_active),
      externalAuthAvailable: Boolean(body.external_auth_available),
    };
  }

// Cookie-mutating requests must finish in issue order. Web Locks also orders
// cooperating tabs; browsers without it retain the same-tab queue.
let sessionRequests: Promise<void> = Promise.resolve();
let logoutInFlight: Promise<void> | null = null;

async function sessionRequest(url: string, init: RequestInit): Promise<Response> {
  const request = () => fetch(url, init);
  // Register immediately: waiting for a tab-local promise first would let a
  // later request in another tab acquire the global lock ahead of this one.
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request('greenroom-auth-session-mutation', request);
  }
  const pending = sessionRequests.then(request);
  sessionRequests = pending.then(() => undefined, () => undefined);
  return pending;
}

export const authService = {
  async options(): Promise<AuthOptions> {
    const response = await fetch('/api/auth/options', { credentials: 'same-origin' });
      if (!response.ok) {
        throw new Error(await readError(response, '登录配置暂时不可用，请稍后刷新'));
      }
      const body = (await response.json()) as {
        registration_enabled?: boolean;
        roster_size?: number;
        emails_configured?: number;
        external_auth_active?: boolean;
        external_auth_available?: boolean;
        local_member_name?: string | null;
      };
      return {
        registrationEnabled: Boolean(body.registration_enabled),
        rosterSize: body.roster_size ?? VALID_MEMBERS.length,
        emailsConfigured: body.emails_configured ?? 0,
        externalAuthActive: Boolean(body.external_auth_active),
        externalAuthAvailable: Boolean(body.external_auth_available),
        localMemberName: body.local_member_name || null,
      };
  },

  async developmentLogin(): Promise<AuthSession> {
    const response = await sessionRequest('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(await readError(response, '本机开发登录失败，请稍后重试'));
    }
    return sessionFrom((await response.json()) as MeResponse);
  },

  async login(
    account: string,
    password: string,
    mode: 'external' | 'internal' = 'external',
    feishuName?: string,
  ): Promise<AuthSession> {
    const payload = mode === 'internal'
      ? { username: account.trim(), password }
      : { email: account.trim(), password, feishu_name: feishuName?.trim() || undefined };
    const response = await sessionRequest('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(await readError(response, '登录失败，请核对邮箱和密码'));
    }
    const body = (await response.json()) as MeResponse & {
      mfa_required?: boolean;
      challenge_id?: string;
    };
    if (body.mfa_required) {
      if (!body.challenge_id) {
        throw new Error('认证服务要求验证码，但未返回挑战编号');
      }
      throw new MfaRequired(body.challenge_id);
    }
    return sessionFrom(body);
  },

  async verifyMfa(challengeId: string, code: string, feishuName?: string): Promise<AuthSession> {
    const response = await sessionRequest('/api/auth/mfa', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challenge_id: challengeId,
        code,
        feishu_name: feishuName?.trim() || undefined,
      }),
    });
    if (!response.ok) {
      throw new Error(await readError(response, '验证码无效或已过期'));
    }
    return sessionFrom((await response.json()) as MeResponse);
  },

  async restore(attempt = 0): Promise<{ session: AuthSession; members: MemberUser[] } | null> {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (response.status === 401) {
      if (attempt > 0) return null;
      const refreshed = await sessionRequest('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!refreshed.ok) return null;
      return this.restore(attempt + 1);
    }
    if (!response.ok) return null;
    const body = (await response.json()) as MeResponse;
    if (!body.user_info?.user) return null;
    return {
      session: sessionFrom(body),
      members: body.members || [],
    };
  },

  logout(): Promise<void> {
    if (logoutInFlight) return logoutInFlight;
    logoutInFlight = (async () => {
      const response = await sessionRequest('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new Error(await readError(response, '退出未完成，请重试'));
      }
    })().finally(() => { logoutInFlight = null; });
    return logoutInFlight;
  },
};
