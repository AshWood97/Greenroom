import React, { useEffect, useState } from 'react';
import {
  Terminal,
  ShieldCheck,
  ExternalLink,
  RefreshCw,
  LogOut,
  FileText,
  Folder,
  Calendar,
  CheckSquare,
  User,
  AlertCircle,
  Users,
  CheckCircle2,
  Clock,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import styles from './FeishuCliPanel.module.css';
import { feishuService } from '../services/feishuService';
import {
  FeishuStatusResponse,
  FeishuAuthStartResponse,
  FeishuRosterStatusResponse,
} from '../types/feishu';

interface FeishuCliPanelProps {
  isAdmin?: boolean;
}

export const FeishuCliPanel: React.FC<FeishuCliPanelProps> = ({ isAdmin = false }) => {
  const [rosterData, setRosterData] = useState<FeishuRosterStatusResponse | null>(null);
  const [isLoadingRoster, setIsLoadingRoster] = useState(false);
  const [isRosterExpanded, setIsRosterExpanded] = useState(false);

  const [status, setStatus] = useState<FeishuStatusResponse | null>(null);
  const [isLoadingPersonal, setIsLoadingPersonal] = useState(true);
  const [authPending, setAuthPending] = useState<FeishuAuthStartResponse | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [executingAction, setExecutingAction] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ action: string; data: any } | null>(null);

  const refreshRoster = async () => {
    if (!isAdmin) return;
    setIsLoadingRoster(true);
    try {
      const res = await feishuService.getRosterStatus();
      setRosterData(res);
    } catch (err: any) {
      setErrorMsg(err.message || '获取全员飞书授权状态失败');
    } finally {
      setIsLoadingRoster(false);
    }
  };

  const refreshPersonalStatus = async () => {
    try {
      setErrorMsg(null);
      const res = await feishuService.getStatus();
      setStatus(res);
      if (res.is_logged_in) {
        setAuthPending(null);
      }
    } catch (err: any) {
      setErrorMsg(err.message || '获取个人飞书状态失败');
    } finally {
      setIsLoadingPersonal(false);
    }
  };

  useEffect(() => {
    refreshPersonalStatus();
    if (isAdmin) {
      refreshRoster();
    }
  }, [isAdmin]);

  const handleStartAuth = async () => {
    setErrorMsg(null);
    try {
      const res = await feishuService.startAuth();
      setAuthPending(res);
    } catch (err: any) {
      setErrorMsg(err.message || '发起授权失败');
    }
  };

  const handlePollAuth = async () => {
    setIsPolling(true);
    setErrorMsg(null);
    try {
      const res = await feishuService.pollAuth();
      if (res.status === 'ready') {
        setAuthPending(null);
        await refreshPersonalStatus();
        if (isAdmin) await refreshRoster();
      } else {
        setErrorMsg(res.message || '仍在等待飞书授权确认');
      }
    } catch (err: any) {
      setErrorMsg(err.message || '轮询授权结果失败');
    } finally {
      setIsPolling(false);
    }
  };

  const handleLogout = async () => {
    if (!window.confirm('确认撤销并退出当前飞书 CLI 授权吗？')) return;
    try {
      setErrorMsg(null);
      await feishuService.logout();
      setLastResult(null);
      setAuthPending(null);
      await refreshPersonalStatus();
      if (isAdmin) await refreshRoster();
    } catch (err: any) {
      setErrorMsg(err.message || '退出失败');
    }
  };

  const handleRunAction = async (action: string) => {
    setExecutingAction(action);
    setErrorMsg(null);
    try {
      const res = await feishuService.execAction(action);
      setLastResult({ action, data: res.result || res.error });
    } catch (err: any) {
      setErrorMsg(err.message || '执行命令失败');
    } finally {
      setExecutingAction(null);
    }
  };

  const isLoggedIn = status?.is_logged_in;
  const user = status?.user;

  return (
    <div className={styles.panelContainer}>
      <div className={styles.card}>
        {/* Header */}
        <div className={styles.cardHeader}>
          <div className={styles.titleArea}>
            <div className={styles.iconCircle}>
              <Terminal size={20} />
            </div>
            <div>
              <h2 className={styles.title}>
                {isAdmin ? '飞书 CLI 全员授权治理与工具箱' : '飞书 CLI 授权与工具箱'}
              </h2>
              <div className={styles.subtitle}>
                基于官方 @larksuite/cli · 成员多租户沙箱隔离 · 凭据受控保护
              </div>
            </div>
          </div>

          <div>
            {isAdmin ? (
              <span className={`${styles.badge} ${styles.badgeSuccess}`}>
                <span className={styles.badgeDot} />
                管理员全屏看板
              </span>
            ) : isLoggedIn ? (
              <span className={`${styles.badge} ${styles.badgeSuccess}`}>
                <span className={styles.badgeDot} />
                飞书已授权
              </span>
            ) : (
              <span className={`${styles.badge} ${styles.badgeWarning}`}>
                <span className={styles.badgeDot} />
                未绑定飞书
              </span>
            )}
          </div>
        </div>

        {errorMsg && (
          <div className={styles.errorAlert} style={{ marginBottom: 16 }}>
            <AlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Admin Sub Navigation */}
        {isAdmin && (
          <div className={styles.tabSwitchBar}>
            <div className={`${styles.tabSwitchBtn} ${styles.tabSwitchBtnActive}`}>
              <Users size={15} />
              <span>
                全员飞书授权大盘 (
                {rosterData ? `${rosterData.summary.authorizedCount}/${rosterData.summary.total}` : '加载中'}
                )
              </span>
            </div>
          </div>
        )}

        {/* Admin Roster Overview */}
        {isAdmin && (
          <div>
            {isLoadingRoster && !rosterData ? (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: '16px 0' }}>
                正在加载团队全员飞书授权状态...
              </div>
            ) : rosterData ? (
              <>
                {/* Stats Grid */}
                <div className={styles.overviewStatsGrid}>
                  <div className={styles.statCard}>
                    <div className={styles.statCardHeader}>
                      <Users size={14} color="#38bdf8" />
                      <span>全员受邀名册</span>
                    </div>
                    <div className={styles.statNumber} style={{ color: '#38bdf8' }}>
                      {rosterData.summary.total} 人
                    </div>
                    <div className={styles.statSub}>{rosterData.summary.total} 个独立容器沙箱一一映射</div>
                  </div>

                  <div className={styles.statCard}>
                    <div className={styles.statCardHeader}>
                      <CheckCircle2 size={14} color="#10b981" />
                      <span>已完成飞书授权</span>
                    </div>
                    <div className={styles.statNumber} style={{ color: '#34d399' }}>
                      {rosterData.summary.authorizedCount} / {rosterData.summary.total}
                    </div>
                    <div className={styles.statSub}>
                      覆盖率 {Math.round((rosterData.summary.authorizedCount / rosterData.summary.total) * 100)}%
                    </div>
                  </div>

                  <div className={styles.statCard}>
                    <div className={styles.statCardHeader}>
                      <Clock size={14} color="#f59e0b" />
                      <span>未绑定或待确认</span>
                    </div>
                    <div className={styles.statNumber} style={{ color: '#fbbf24' }}>
                      {rosterData.summary.unboundCount} 人
                    </div>
                    <div className={styles.statSub}>成员可在 DSH 设置中随时发起设备码授权</div>
                  </div>

                  <div className={styles.statCard}>
                    <div className={styles.statCardHeader}>
                      <ShieldCheck size={14} color="#a855f7" />
                      <span>运行环境隔离</span>
                    </div>
                    <div className={styles.statNumber} style={{ fontSize: 18, color: '#c084fc' }}>
                      {rosterData.summary.cliAvailable ? '官方 CLI 就绪' : 'CLI 待安装'}
                    </div>
                    <div className={styles.statSub}>凭据存储于专属私有目录 · 严禁跨用户泄露</div>
                  </div>
                </div>

                {/* Roster Members 2-Column Grid */}
                {(() => {
                  const visibleMembers = !isRosterExpanded
                    ? rosterData.members.slice(0, 6)
                    : rosterData.members;

                  return (
                    <>
                      <div className={styles.rosterGrid}>
                        {visibleMembers.map((m) => (
                          <div key={m.id} className={styles.rosterMemberCard}>
                            <div className={styles.memberCardHeader}>
                              <div className={styles.memberCell}>
                                <div
                                  className={styles.memberAvatar}
                                  style={{
                                    background: m.avatarBgColor,
                                    color: m.avatarTextColor,
                                  }}
                                >
                                  {m.avatarInitials}
                                </div>
                                <div className={styles.memberInfo}>
                                  <div className={styles.memberNameRow}>
                                    <span className={styles.memberName}>{m.displayName}</span>
                                    <span
                                      className={`${styles.roleBadge} ${
                                        m.role === '群主'
                                          ? styles.roleBadgeOwner
                                          : styles.roleBadgeMember
                                      }`}
                                    >
                                      {m.role}
                                    </span>
                                  </div>
                                  <span className={styles.memberId}>{m.id}</span>
                                </div>
                              </div>

                              <div>
                                {m.status === 'ready' && (
                                  <span className={`${styles.statusPill} ${styles.statusReady}`}>
                                    <CheckCircle2 size={12} />
                                    已授权
                                  </span>
                                )}
                                {m.status === 'pending' && (
                                  <span className={`${styles.statusPill} ${styles.statusPending}`}>
                                    <Clock size={12} />
                                    授权确认中
                                  </span>
                                )}
                                {m.status === 'expired' && (
                                  <span className={`${styles.statusPill} ${styles.statusExpired}`}>
                                    <AlertCircle size={12} />
                                    凭证已过期
                                  </span>
                                )}
                                {m.status === 'unbound' && (
                                  <span className={`${styles.statusPill} ${styles.statusUnbound}`}>
                                    未绑定
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className={styles.memberDetailsGrid}>
                              <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>授权飞书账号</span>
                                <span
                                  className={styles.detailValue}
                                  style={{ fontWeight: m.user?.userName ? 600 : 'normal' }}
                                  title={m.user?.userName || '-'}
                                >
                                  {m.user?.userName || '-'}
                                </span>
                              </div>
                              <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>脱敏 OpenID</span>
                                <span
                                  className={`${styles.detailValue} ${styles.mono}`}
                                  title={m.user?.openId || '-'}
                                >
                                  {m.user?.openId || '-'}
                                </span>
                              </div>
                              <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>有效截止时间</span>
                                <span className={styles.detailValue}>
                                  {m.user?.expiresAt
                                    ? new Date(m.user.expiresAt).toLocaleDateString('zh-CN', {
                                        month: '2-digit',
                                        day: '2-digit',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })
                                    : m.isLoggedIn
                                    ? '长期有效'
                                    : '-'}
                                </span>
                              </div>
                              <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>已授予权限 (Scopes)</span>
                                <div className={styles.detailValue}>
                                  {m.user?.scopes && m.user.scopes.length > 0 ? (
                                    <div className={styles.scopesListCompact}>
                                      {m.user.scopes.map((s, idx) => (
                                        <span key={idx} className={styles.scopeTagCompact}>
                                          {s}
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    <span style={{ color: 'var(--color-text-muted)' }}>-</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>

                      {rosterData.members.length > 6 && (
                        <div className={styles.expandToggleWrapper}>
                          <button
                            type="button"
                            className={styles.expandToggleBtn}
                            onClick={() => setIsRosterExpanded(!isRosterExpanded)}
                          >
                            <span>
                              {isRosterExpanded
                                ? '收起名单'
                                : `展开查看全部 (${rosterData.members.length} 人)`}
                            </span>
                            {isRosterExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                          </button>
                        </div>
                      )}
                    </>
                  );
                })()}

                <div className={styles.bottomBar}>
                  <button
                    type="button"
                    className={styles.pollBtn}
                    onClick={refreshRoster}
                    disabled={isLoadingRoster}
                  >
                    <RefreshCw size={14} className={isLoadingRoster ? styles.spin : ''} />
                    <span>刷新全员状态</span>
                  </button>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                    数据源于各沙箱隔离配置 · 仅管理员徐子寒具备全局只读巡检权限
                  </div>
                </div>
              </>
            ) : null}
          </div>
        )}

        {/* Non-admin Personal CLI Panel */}
        {!isAdmin && (
          <div>
            {isLoadingPersonal ? (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13, padding: '16px 0' }}>
                正在加载个人飞书 CLI 状态...
              </div>
            ) : (
              <>
                {/* Not Logged In */}
                {!isLoggedIn && (
                  <div className={styles.unauthBox}>
                    <div className={styles.unauthDesc}>
                      {isAdmin ? '管理员（徐子寒）尚未绑定个人飞书账号。' : '您尚未绑定飞书账号。'}
                      通过飞书官方 Device Flow（设备码模式）授权，您可在当前独立的 Greenroom 空间内安全使用飞书文档、云盘、日历与待办工具。
                      <br />
                      <strong>安全隔离承诺：</strong>您的飞书凭据存储于专属隔离目录，不进前端，不进日志，不跨用户共享。
                    </div>

                    {!authPending ? (
                      <button
                        type="button"
                        className={styles.authBtn}
                        onClick={handleStartAuth}
                      >
                        <ShieldCheck size={16} />
                        <span>发起飞书设备码授权</span>
                      </button>
                    ) : (
                      <div className={styles.deviceBox}>
                        <div className={styles.deviceTitle}>请在飞书中确认以下授权码：</div>
                        <div className={styles.userCodeRow}>
                          <div className={styles.userCodeBadge}>{authPending.user_code}</div>
                          <a
                            href={authPending.verification_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.openLinkBtn}
                          >
                            <ExternalLink size={14} />
                            <span>打开飞书授权页面</span>
                          </a>
                          <button
                            type="button"
                            className={styles.pollBtn}
                            onClick={handlePollAuth}
                            disabled={isPolling}
                          >
                            <RefreshCw size={14} className={isPolling ? styles.spin : ''} />
                            <span>{isPolling ? '正在检测...' : '我已完成授权'}</span>
                          </button>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                          授权链接有效期 {Math.round(authPending.expires_in / 60)} 分钟。授权完成后点击“我已完成授权”即可立即激活。
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Logged In Info */}
                {isLoggedIn && user && (
                  <>
                    <div className={styles.profileGrid}>
                      <div className={styles.profileItem}>
                        <div className={styles.profileLabel}>已授权用户名</div>
                        <div className={styles.profileVal}>{user.userName || '未知'}</div>
                      </div>
                      <div className={styles.profileItem}>
                        <div className={styles.profileLabel}>飞书 OpenID</div>
                        <div className={styles.profileVal}>{user.openId || '已隐匿'}</div>
                      </div>
                      <div className={styles.profileItem}>
                        <div className={styles.profileLabel}>凭据有效截止</div>
                        <div className={styles.profileVal}>
                          {user.expiresAt ? new Date(user.expiresAt).toLocaleString('zh-CN') : '长期有效'}
                        </div>
                      </div>
                    </div>

                    {user.scopes && user.scopes.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
                          已授予最小权限范围（Scopes）：
                        </div>
                        <div className={styles.scopesList}>
                          {user.scopes.map((scope, idx) => (
                            <span key={idx} className={styles.scopeTag}>
                              {scope}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Quick Command Tools */}
                    <div className={styles.toolsSection}>
                      <div className={styles.toolsTitle}>可用受控飞书指令（直接通过专属 CLI 隔离执行）：</div>
                      <div className={styles.toolsGrid}>
                        <button
                          type="button"
                          className={styles.toolBtn}
                          onClick={() => handleRunAction('whoami')}
                          disabled={executingAction !== null}
                        >
                          <User size={14} />
                          <span>检查当前身份 (whoami)</span>
                        </button>
                        <button
                          type="button"
                          className={styles.toolBtn}
                          onClick={() => handleRunAction('docs_list')}
                          disabled={executingAction !== null}
                        >
                          <FileText size={14} />
                          <span>文档列表 (docs list)</span>
                        </button>
                        <button
                          type="button"
                          className={styles.toolBtn}
                          onClick={() => handleRunAction('drive_list')}
                          disabled={executingAction !== null}
                        >
                          <Folder size={14} />
                          <span>云盘列表 (drive list)</span>
                        </button>
                        <button
                          type="button"
                          className={styles.toolBtn}
                          onClick={() => handleRunAction('calendar_list')}
                          disabled={executingAction !== null}
                        >
                          <Calendar size={14} />
                          <span>日程日历 (calendar list)</span>
                        </button>
                        <button
                          type="button"
                          className={styles.toolBtn}
                          onClick={() => handleRunAction('task_list')}
                          disabled={executingAction !== null}
                        >
                          <CheckSquare size={14} />
                          <span>我的待办 (task list)</span>
                        </button>
                      </div>
                    </div>

                    {/* Execution Output */}
                    {lastResult && (
                      <div className={styles.resultBox}>
                        <div className={styles.resultHeader}>
                          <span>指令执行输出: {lastResult.action}</span>
                          <button
                            type="button"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: 'var(--color-text-muted)',
                              cursor: 'pointer',
                            }}
                            onClick={() => setLastResult(null)}
                          >
                            清除
                          </button>
                        </div>
                        <pre className={styles.resultPre}>
                          {typeof lastResult.data === 'string'
                            ? lastResult.data
                            : JSON.stringify(lastResult.data, null, 2)}
                        </pre>
                      </div>
                    )}

                    {/* Bottom Actions */}
                    <div className={styles.bottomBar}>
                      <button
                        type="button"
                        className={styles.pollBtn}
                        onClick={refreshPersonalStatus}
                      >
                        <RefreshCw size={14} />
                        <span>刷新状态</span>
                      </button>
                      <button
                        type="button"
                        className={styles.logoutBtn}
                        onClick={handleLogout}
                      >
                        <LogOut size={14} />
                        <span>退出并撤销飞书授权</span>
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
