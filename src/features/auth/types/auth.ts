export type MemberRole = '群主' | '管理员' | '成员';

export interface MemberUser {
  id: string;
  name: string;
  displayName: string;
  role: MemberRole;
  avatarInitials: string;
  avatarBgColor: string;
  avatarTextColor: string;
  aliases?: string[];
  accountStatus?: 'configured' | 'pending';
}

/** Browser-visible session. The credential itself stays in an HttpOnly cookie. */
export interface AuthSession {
  user: MemberUser;
  email?: string;
  loginAt: string;
  externalAuthActive?: boolean;
  externalAuthAvailable?: boolean;
}
