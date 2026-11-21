import React, { useEffect, useState } from 'react';
import {
  LogOut,
  ShieldCheck,
  Sparkles,
  Cpu,
  Lock,
  Globe,
  Sliders,
  KeyRound,
  Users,
} from 'lucide-react';
import styles from './AdminDashboard.module.css';
import greenroomIcon from '../../../assets/greenroom-icon.png';
import { AuthSession, MemberUser } from '../../auth/types/auth';
import { SharedSpacePage } from '../../spaces/components/SharedSpacePage';
import { SpaceStats } from '../../spaces/types/space';
import { spaceService } from '../../spaces/services/spaceService';
import { FeishuCliPanel } from '../../feishu/components/FeishuCliPanel';
import { AdminManagementPanel } from './AdminManagementPanel';
import { ApiManagementPanel } from './ApiManagementPanel';
import { PersonalUsage } from '../../usage/components/PersonalUsage';
import { HarnessModal } from '../../agent-harness/components/HarnessModal';

interface AdminDashboardProps {
  session: AuthSession;
  members: MemberUser[];
  onLogout: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  session,
  members,
  onLogout,
}) => {
  const { user } = session;
  const isSoleAdmin = user.id === 'user_greenroom_local';

  const [activeTab, setActiveTab] = useState<'workspace' | 'shared' | 'api' | 'admin'>(() => new URLSearchParams(window.location.search).get('panel') === 'api' ? 'api' : 'workspace');
  const [isHarnessOpen, setIsHarnessOpen] = useState(false);

  const [stats, setStats] = useState<SpaceStats>({
    myTotal: 0,
    spaceTotal: 0,
  });

  useEffect(() => {
    let cancelled = false;
    spaceService.getStats(user.id).then((next) => {
      if (!cancelled) setStats(next);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const [runtime, setRuntime] = useState<{ ready: boolean; version?: string }>({ ready: false });
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/harness/status', { credentials: 'same-origin', signal: controller.signal })
      .then(response => response.ok ? response.json() : { ready: false })
      .then(setRuntime).catch(() => undefined);
    return () => controller.abort();
  }, [user.id]);

  const formattedLoginTime = new Date(session.loginAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className={styles.dashboardContainer}>
      {/* Top Navbar */}
      <header className={styles.navbar}>
        <div className={styles.navBrand}>
          <img className={styles.brandIcon} src={greenroomIcon} width={38} height={38} alt="" />
          <div className={styles.brandTitles}>
            <span className={styles.brandName}>Greenroom {__APP_VERSION__}</span>
            <span className={styles.brandTag}>
              <span className={styles.brandTagDot} />
              DSH 运行时与空间隔离模式
            </span>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className={styles.navTabs}>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === 'workspace' ? styles.navTabBtnActive : ''}`}
            onClick={() => setActiveTab('workspace')}
          >
            <Sparkles size={14} />
            <span>空间工作台</span>
          </button>
          <button
            type="button"
            className={`${styles.navTabBtn} ${activeTab === 'shared' ? styles.navTabBtnActive : ''}`}
            onClick={() => setActiveTab('shared')}
          >
            <Users size={14} />
            <span>全员空间</span>
          </button>
          {isSoleAdmin && (
            <button
              type="button"
              className={`${styles.navTabBtn} ${styles.navTabBtnAdmin} ${activeTab === 'api' ? styles.navTabBtnActive : ''}`}
              onClick={() => setActiveTab('api')}
            >
              <KeyRound size={14} />
              <span>API 管理</span>
            </button>
          )}
          {isSoleAdmin && (
            <button
              type="button"
              className={`${styles.navTabBtn} ${styles.navTabBtnAdmin} ${activeTab === 'admin' ? styles.navTabBtnActive : ''}`}
              onClick={() => setActiveTab('admin')}
            >
              <Sliders size={14} />
              <span>系统治理</span>
            </button>
          )}
        </nav>

        <div className={styles.navRight}>
          <button
            type="button"
            className={styles.generateNavBtn}
            onClick={() => setIsHarnessOpen(true)}
            title="进入 DSH 智能工作台生成媒体资产"
          >
            <Sparkles size={15} />
            <span>通过 DeepSeek Harness 智能生成</span>
          </button>

          {/* User Profile */}
          <div className={styles.userProfile}>
            <div
              className={styles.avatar}
              style={{
                background: user.avatarBgColor,
                color: user.avatarTextColor,
              }}
            >
              {user.avatarInitials}
            </div>
            <div className={styles.userInfo}>
              <span className={styles.userName}>{user.displayName}</span>
              <span
                className={`${styles.roleBadge} ${
                  user.role === '群主'
                    ? styles.roleBadgeOwner
                    : user.role === '管理员'
                    ? styles.roleBadgeAdmin
                    : ''
                }`}
              >
                {user.role}
              </span>
            </div>
          </div>

          <PersonalUsage userId={user.id} className={styles.logoutBtn} />
          <button
            type="button"
            className={styles.logoutBtn}
            onClick={onLogout}
            title="退出当前登录"
          >
            <LogOut size={16} />
            <span>退出</span>
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className={styles.mainContent}>
        {activeTab === 'shared' && <SharedSpacePage user={user} members={members} />}

        {activeTab === 'api' && isSoleAdmin && (
          <ApiManagementPanel showLocalModels={user.id === 'user_greenroom_local'} />
        )}

        {activeTab === 'admin' && isSoleAdmin && <AdminManagementPanel />}

        {activeTab === 'workspace' && (
          <>
            {/* Welcome Banner & Stats */}
            <section className={styles.welcomeBanner}>
              <div className={styles.bannerDecorGlow} />
              <div className={styles.bannerText}>
                <h1 className={styles.bannerTitle}>
                  欢迎，<span className={styles.bannerUserHighlight}>{user.displayName}</span>
                </h1>
                <p className={styles.bannerDesc}>
                  您当前已进入属于您的工作区。系统通过 <strong>DeepSeek Harness</strong> 驱动智能体调度与工具扩展；
                  全部成员共用唯一的全员空间，您创建的资产会归入您本人的目录。
                </p>
              </div>

              <div className={styles.bannerStats}>
                <div className={styles.statItem}>
                  <div className={styles.statValue}>{members.length}</div>
                  <div className={styles.statLabel}>团队名单</div>
                </div>
                <div className={styles.statItem}>
                  <div className={styles.statValue} style={{ color: '#10b981' }}>
                    {stats.myTotal}
                  </div>
                  <div className={styles.statLabel}>
                    <Lock size={10} style={{ display: 'inline', marginRight: 3 }} />
                    我贡献的资产
                  </div>
                </div>
                <div className={styles.statItem}>
                  <div className={styles.statValue} style={{ color: '#38bdf8' }}>
                    {stats.spaceTotal}
                  </div>
                  <div className={styles.statLabel}>
                    <Globe size={10} style={{ display: 'inline', marginRight: 3 }} />
                    全员空间资产
                  </div>
                </div>
                <div className={styles.statItem}>
                  <div className={styles.statValue} style={{ color: '#a855f7', fontSize: '18px' }}>
                    <Cpu size={16} style={{ display: 'inline', marginRight: 4 }} />
                    {runtime.ready ? 'DSH 就绪' : 'DSH 待就绪'}
                  </div>
                  <div className={styles.statLabel}>官方 WebUI {runtime.version || ''}</div>
                </div>
              </div>
            </section>

            {/* Feishu CLI Section */}
            <section>
              <FeishuCliPanel isAdmin={isSoleAdmin} />
            </section>

            {isSoleAdmin && session.externalAuthAvailable && (
              <section className={styles.membersSection}>
                <div className={styles.sectionTitleRow}>
                  <h2 className={styles.sectionTitle}>
                    <ShieldCheck size={18} />
                    对外统一认证
                  </h2>
                </div>
                <p className={styles.sectionSubtitle}>
                  {session.externalAuthActive
                    ? '已激活。成员使用统一认证邮箱登录。'
                    : '已接入，尚未激活。激活由部署配置完成，控制台不能开启。'}
                </p>
              </section>
            )}

            {/* Member Directory */}
            <section className={styles.membersSection}>
              <div className={styles.sectionTitleRow}>
                <h2 className={styles.sectionTitle}>
                  <ShieldCheck size={18} />
                  团队成员名单与空间状态 (共 {members.length} 人)
                </h2>
                <span className={styles.sectionSubtitle}>
                  换人必须退出后重新登录，不能在浏览器里切换身份
                </span>
              </div>

              <div className={styles.memberTableGrid}>
                {members.map((member) => {
                  const isCurrent = member.id === user.id;
                  return (
                    <div
                      key={member.id}
                      className={`${styles.memberItem} ${
                        isCurrent ? styles.memberItemCurrent : ''
                      }`}
                    >
                      <div
                        className={styles.memberItemAvatar}
                        style={{
                          background: member.avatarBgColor,
                          color: member.avatarTextColor,
                        }}
                      >
                        {member.avatarInitials}
                      </div>
                      <div className={styles.memberItemMeta}>
                        <div className={styles.memberItemName}>
                          {member.displayName}
                          {isCurrent && ' (当前)'}
                        </div>
                        <div className={styles.memberItemSub}>
                          {member.role === '群主'
                            ? '群主 · 最高权限'
                            : '团队成员'} · {session.externalAuthActive ? (member.accountStatus === 'configured' ? '邮箱已配置' : '未预置邮箱') : '本地访问'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className={styles.footer}>
        <div>Greenroom · DeepSeek Harness 智能调度与多租户空间隔离平台</div>
        <div>
          登录时间: {formattedLoginTime}
          {session.email ? ` · ${session.email}` : ''}
        </div>
      </footer>

      <HarnessModal
        user={user}
        isOpen={isHarnessOpen}
        onClose={() => setIsHarnessOpen(false)}
      />
    </div>
  );
};
