export interface FeishuUser {
  openId?: string;
  userName?: string;
  tokenStatus?: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
  scopes?: string[];
}

export interface FeishuStatusResponse {
  available: boolean;
  is_logged_in: boolean;
  appId?: string;
  brand?: string;
  message: string;
  user?: FeishuUser | null;
}

export interface FeishuAuthStartResponse {
  verification_url: string;
  user_code: string;
  expires_in: number;
}

export interface FeishuAuthPollResponse {
  status: 'ready' | 'pending';
  message: string;
  user?: FeishuUser;
}

export interface FeishuExecResponse {
  success: boolean;
  action: string;
  returncode: number;
  result?: any;
  error?: string | null;
}

export interface FeishuMemberStatus {
  id: string;
  name: string;
  displayName: string;
  role: string;
  avatarInitials: string;
  avatarBgColor: string;
  avatarTextColor: string;
  isLoggedIn: boolean;
  status: 'ready' | 'pending' | 'unbound' | 'expired';
  statusText: string;
  user?: {
    userName?: string;
    openId?: string;
    expiresAt?: string;
    scopes?: string[];
  } | null;
}

export interface FeishuRosterStatusResponse {
  summary: {
    total: number;
    authorizedCount: number;
    unboundCount: number;
    cliAvailable: boolean;
  };
  members: FeishuMemberStatus[];
}
