import React, { useEffect, useState } from 'react';
import {
  ShieldAlert,
  Cpu,
  Users,
  Sliders,
  CheckCircle2,
  Clock,
  BarChart3,
  RefreshCw,
  Activity,
  Image as ImageIcon,
  Video as VideoIcon,
  MessageSquare,
} from 'lucide-react';
import styles from './AdminManagementPanel.module.css';

interface ActualConsumption {
  actualChargeCents: number | null;
  actualCurrency: string;
  settledRequests: number;
  pendingRequests: number;
  unavailableRequests: number;
}

const formatCharge = (cents: number | null) => cents == null ? '—' :
  (cents / 100).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 5 });

const settlementLabel = (status: string) => ({
  pending: '待结算', unsettled: '尚未结算', unavailable: '账单暂不可用',
  charged: '已扣费', refunded: '已退款', partially_refunded: '部分退款',
  discounted: '已优惠', rounded_zero: '已结算', free: '免费', settled: '已结算',
} as Record<string, string>)[status] || '无供应商账单';

const sourceLabel = (source: string) => ({ t8: 'T8', huobao: '火宝短剧', creative: 'AI剧插件', 'managed-chat': '托管对话' } as Record<string, string>)[source] || '历史调用';
const modalityLabels: Record<string, string> = {
  llm: 'LLM 文本', image: '图像', video: '视频', tts: '语音', music: '音乐', embedding: '向量', rerank: '重排',
};
const modalityClass = (modality: string) => ({ image: styles.badgeImage, video: styles.badgeVideo, llm: styles.badgeLlm } as Record<string, string>)[modality] || '';

interface AdminOverview {
  admin: string;
  buildSha: string;
  environment: string;
  dshVersion: string;
  externalAuthActive: boolean;
  providersCount: number;
  activeProvidersCount: number;
  usageSummary: ActualConsumption & {
    totalRequests: number;
    totalLlmTokens: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalImageCount: number;
    totalVideoCount: number;
    totalVideoSeconds: number;
    modalityBreakdown: Record<string, number>;
    topModels: Array<ActualConsumption & {
      model: string;
      modality: string;
      providerType: string;
      requests: number;
      tokens: number;
      videoSeconds: number;
    }>;
  };
  members: Array<{
    id: string;
    name: string;
    displayName: string;
    role: string;
    accountStatus: string;
    email?: string;
  }>;
  stats: {
    rosterCount: number;
    configuredCount: number;
    publicAssetsCount: number;
    totalSlots: number;
  };
}

interface MemberUsage extends ActualConsumption {
  id: string;
  name: string;
  displayName: string;
  role: string;
  avatarInitials: string;
  avatarBgColor: string;
  avatarTextColor: string;
  totalRequests: number;
  llmTokens: number;
  promptTokens: number;
  completionTokens: number;
  imageCount: number;
  imageParameterProfiles: Array<{
    params: Record<string, any>;
    count: number;
  }>;
  videoCount: number;
  videoSeconds: number;
  videoParameterProfiles: Array<{
    params: Record<string, any>;
    count: number;
  }>;
}

interface AuditLog {
  id: string;
  timestamp: number;
  memberId: string;
  modality: string;
  model: string;
  providerType: string;
  providerId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  parameters: Record<string, any>;
  durationSeconds: number;
  status: string;
  durationMs: number;
  source: string;
  referenceId: string | null;
  actualChargeCents: number | null;
  actualCurrency: string | null;
  settlementStatus: string;
}

interface AdminParams {
  buildSha: string;
  environment: string;
  dshVersion: string;
  cookieSecure: boolean;
  externalAuthEnabled: boolean;
  authServiceUrl: string;
  authTenantId: string;
  authAudience: string;
  assetServiceUrl: string;
  gatewayServiceUrl: string;
  dataDir: string;
  storageBudgetGiB: number;
  storageHeadroomGiB: number;
  slotBudgetGiB: number;
  appBudgetGiB: number;
  managedApi: {
    baseUrl: string;
    configured: boolean;
    apiKeyConfigured: boolean;
    apiKeyMasked: string | null;
    models: string[];
    source: string;
  };
}

export const AdminManagementPanel: React.FC = () => {
  const [activeSubTab, setActiveSubTab] = useState<'analytics' | 'members' | 'logs' | 'infra'>('analytics');
  const [timeRange, setTimeRange] = useState<'today' | '7d' | '30d' | 'all'>('all');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [membersUsage, setMembersUsage] = useState<MemberUsage[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [logsTotal, setLogsTotal] = useState(0);
  const [params, setParams] = useState<AdminParams | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters for logs
  const [logFilterMember, setLogFilterMember] = useState<string>('');
  const [logFilterModality, setLogFilterModality] = useState<string>('');

  const fetchData = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const ovRes = await fetch(`/api/admin/overview?timeRange=${timeRange}`, { credentials: 'same-origin' });
      if (!ovRes.ok) throw new Error('无权访问系统治理面板');
      const ovData = await ovRes.json();
      const [memRes, logsRes, prRes] = await Promise.all([
        fetch(`/api/admin/usage/members?timeRange=${timeRange}`, { credentials: 'same-origin' }),
        fetch(`/api/admin/usage/logs?limit=50&offset=0${logFilterMember ? `&memberId=${logFilterMember}` : ''}${logFilterModality ? `&modality=${logFilterModality}` : ''}`, { credentials: 'same-origin' }),
        fetch('/api/admin/params', { credentials: 'same-origin' }),
      ]);

      const [memData, logsData, prData] = await Promise.all([
        memRes.ok ? memRes.json() : { members: [] },
        logsRes.ok ? logsRes.json() : { logs: [], total: 0 },
        prRes.ok ? prRes.json() : null,
      ]);

      setOverview(ovData);
      setMembersUsage(memData.members || []);
      setLogs(logsData.logs || []);
      setLogsTotal(logsData.total || 0);
      setParams(prData);
    } catch (err: any) {
      setErrorMsg(err.message || '加载系统参数失败');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [timeRange, logFilterMember, logFilterModality]);

  if (isLoading && !overview) {
    return (
      <div className={styles.sectionCard}>
        <div style={{ color: 'var(--color-text-muted)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshCw size={14} className={styles.refreshIconSpin} />
          正在加载管理员专属系统配置与多模态用量大盘...
        </div>
      </div>
    );
  }

  if (errorMsg || !overview) {
    return (
      <div className={styles.sectionCard}>
        <div style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ShieldAlert size={18} />
          <span>{errorMsg || '此页面需要管理员权限'}</span>
        </div>
      </div>
    );
  }

  const usage = overview.usageSummary;

  return (
    <div className={styles.panelContainer}>
      {/* Top Header & Governance Bar */}
      <div className={styles.governanceHeader}>
        <div className={styles.governanceTitleGroup}>
          <h2 className={styles.governanceMainTitle}>
            <span>群主系统治理中心</span>
            <span className={styles.adminBadge}>管理员</span>
          </h2>
          <div className={styles.governanceSubTitle}>
            统一审计 {overview.stats.rosterCount} 位成员多模态实际用量、调用流水与 DSH 沙箱运行状态
          </div>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.timeRangeTabs}>
            {(['today', '7d', '30d', 'all'] as const).map((range) => (
              <button
                key={range}
                type="button"
                className={`${styles.timeRangeBtn} ${timeRange === range ? styles.timeRangeBtnActive : ''}`}
                onClick={() => setTimeRange(range)}
              >
                {range === 'today' ? '今日' : range === '7d' ? '近7天' : range === '30d' ? '近30天' : '全部'}
              </button>
            ))}
          </div>

          <button type="button" className={styles.refreshBtn} onClick={fetchData} title="刷新数据">
            <RefreshCw size={13} />
            <span>刷新</span>
          </button>
        </div>
      </div>

      {/* Sub-Navigation Tabs */}
      <nav className={styles.subTabsNav}>
        <button
          type="button"
          className={`${styles.subTabBtn} ${activeSubTab === 'analytics' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveSubTab('analytics')}
        >
          <BarChart3 size={15} />
          <span>全员用量大盘</span>
        </button>
        <button
          type="button"
          className={`${styles.subTabBtn} ${activeSubTab === 'members' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveSubTab('members')}
        >
          <Users size={15} />
          <span>成员用量透视 ({overview.stats.rosterCount}人)</span>
        </button>
        <button
          type="button"
          className={`${styles.subTabBtn} ${activeSubTab === 'logs' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveSubTab('logs')}
        >
          <Activity size={15} />
          <span>实时调用流水 ({logsTotal})</span>
        </button>
        <button
          type="button"
          className={`${styles.subTabBtn} ${activeSubTab === 'infra' ? styles.subTabBtnActive : ''}`}
          onClick={() => setActiveSubTab('infra')}
        >
          <Cpu size={15} />
          <span>基础设施与 DSH 沙箱</span>
        </button>
      </nav>

      {/* TAB 1: 全员用量大盘 */}
      {activeSubTab === 'analytics' && (
        <>
          <div className={styles.metricsGrid}>
            <div className={styles.metricCard}>
              <div className={styles.metricLabel}>
                <MessageSquare size={14} color="#38bdf8" />
                <span>LLM 文本 Token 吞吐</span>
              </div>
              <div className={styles.metricValue} style={{ color: '#38bdf8' }}>
                {(usage.totalLlmTokens || 0).toLocaleString()}
              </div>
              <div className={styles.metricSub}>
                输入: {(usage.totalPromptTokens || 0).toLocaleString()} · 输出: {(usage.totalCompletionTokens || 0).toLocaleString()}
              </div>
            </div>

            <div className={styles.metricCard}>
              <div className={styles.metricLabel}>
                <ImageIcon size={14} color="#f472b6" />
                <span>图像生成总次数</span>
              </div>
              <div className={styles.metricValue} style={{ color: '#f472b6' }}>
                {usage.totalImageCount || 0} <span style={{ fontSize: 13, fontWeight: 'normal' }}>张</span>
              </div>
              <div className={styles.metricSub}>
                按尺寸与步数真实参数统计
              </div>
            </div>

            <div className={styles.metricCard}>
              <div className={styles.metricLabel}>
                <VideoIcon size={14} color="#c084fc" />
                <span>视频生成总时长</span>
              </div>
              <div className={styles.metricValue} style={{ color: '#c084fc' }}>
                {usage.totalVideoSeconds || 0} <span style={{ fontSize: 13, fontWeight: 'normal' }}>秒</span>
              </div>
              <div className={styles.metricSub}>
                共 {usage.totalVideoCount || 0} 次渲染调用
              </div>
            </div>

            <div className={styles.metricCard}>
              <div className={styles.metricLabel}>
                <Activity size={14} color="#34d399" />
                <span>已结算消耗（CNY）</span>
              </div>
              <div className={styles.metricValue} style={{ color: '#34d399' }}>
                {formatCharge(usage.actualChargeCents)}
              </div>
              <div className={styles.metricSub}>
                {usage.totalRequests || 0} 次请求 · {usage.settledRequests || 0} 次已结算
                <br />
                {usage.pendingRequests || 0} 次待结算 · {usage.unavailableRequests || 0} 次账单待同步
              </div>
            </div>
          </div>

          {/* Model Popularity Ranking */}
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>
                <BarChart3 size={18} />
                <span>多模态模型热度与用量分布排行</span>
              </h3>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                按实际调用频次与模态参数汇总
              </span>
            </div>

            <div className={styles.tableWrapper}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>模型名称</th>
                    <th>模态</th>
                    <th>提供通道</th>
                    <th>请求次数</th>
                    <th>Token 消耗量</th>
                    <th>视频生成秒数</th>
                    <th>已结算（CNY）</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.topModels && usage.topModels.length > 0 ? (
                    usage.topModels.map((tm, idx) => (
                      <tr key={idx}>
                        <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{tm.model}</td>
                        <td>
                          <span
                            className={`${styles.modalityBadge} ${modalityClass(tm.modality)}`}
                          >
                            {modalityLabels[tm.modality] || tm.modality}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`${styles.providerBadge} ${
                              tm.providerType === 'external_provider'
                                ? styles.providerExternal
                                : styles.providerInternal
                            }`}
                          >
                            {tm.providerType === 'external_provider' ? '第三方 API' : '默认网关'}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace' }}>{tm.requests} 次</td>
                        <td style={{ fontFamily: 'monospace', color: '#38bdf8' }}>
                          {tm.tokens > 0 ? tm.tokens.toLocaleString() : '-'}
                        </td>
                        <td style={{ fontFamily: 'monospace', color: '#c084fc' }}>
                          {tm.videoSeconds > 0 ? `${tm.videoSeconds}s` : '-'}
                        </td>
                        <td style={{ fontFamily: 'monospace' }}>{formatCharge(tm.actualChargeCents)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '24px 0' }}>
                        暂无调用记录。成员发起工作流或工作台模型对话后，将自动呈现。
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* TAB 2: 成员用量透视 */}
      {activeSubTab === 'members' && (
        <div className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>
              <Users size={18} />
              <span>{overview.stats.rosterCount} 位成员多模态实际用量透视矩阵</span>
            </h3>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              按供应商实际账单统计金额，待结算记录单独显示
            </span>
          </div>

          <div className={styles.tableWrapper}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>成员</th>
                  <th>角色</th>
                  <th>总请求数</th>
                  <th>LLM Tokens (提示/补全)</th>
                  <th>生图次数与参数画像</th>
                  <th>视频生成与参数画像</th>
                  <th>已结算（CNY）</th>
                </tr>
              </thead>
              <tbody>
                {membersUsage.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: '50%',
                            background: m.avatarBgColor,
                            color: m.avatarTextColor,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        >
                          {m.avatarInitials}
                        </div>
                        <div>
                          <div style={{ fontWeight: 600 }}>{m.displayName}</div>
                          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>
                            {m.id}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span
                        style={{
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          background: m.role === '群主' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                          color: m.role === '群主' ? '#f59e0b' : 'var(--color-text-secondary)',
                        }}
                      >
                        {m.role}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{m.totalRequests} 次</td>
                    <td>
                      <div style={{ fontFamily: 'monospace', color: '#38bdf8', fontWeight: 600 }}>
                        {m.llmTokens.toLocaleString()}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                        入: {m.promptTokens.toLocaleString()} / 出: {m.completionTokens.toLocaleString()}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontWeight: 600, color: '#f472b6' }}>{m.imageCount} 张</span>
                        {m.imageParameterProfiles && m.imageParameterProfiles.length > 0 ? (
                          <div className={styles.paramTagGroup}>
                            {m.imageParameterProfiles.map((p, pIdx) => {
                              const sizeStr = p.params?.size || '默认尺寸';
                              const qStr = p.params?.quality ? ` (${p.params.quality})` : '';
                              return (
                                <span key={pIdx} className={styles.paramTag}>
                                  {sizeStr}{qStr} × {p.count}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>无生图调用</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span style={{ fontWeight: 600, color: '#c084fc' }}>
                          {m.videoSeconds}s ({m.videoCount} 次)
                        </span>
                        {m.videoParameterProfiles && m.videoParameterProfiles.length > 0 ? (
                          <div className={styles.paramTagGroup}>
                            {m.videoParameterProfiles.map((p, pIdx) => {
                              const resStr = p.params?.resolution || '标准画质';
                              const durStr = p.params?.duration ? `${p.params.duration}s` : '';
                              return (
                                <span key={pIdx} className={styles.paramTag}>
                                  {resStr} {durStr} × {p.count}
                                </span>
                              );
                            })}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>无视频调用</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontFamily: 'monospace', fontWeight: 600 }}>{formatCharge(m.actualChargeCents)}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                        {m.pendingRequests || 0} 次待结算 · {m.unavailableRequests || 0} 次待同步
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: 实时调用流水 */}
      {activeSubTab === 'logs' && (
        <div className={styles.sectionCard}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>
              <Activity size={18} />
              <span>多模态调用审计流水记录</span>
            </h3>
            <div className={styles.sectionActions}>
              <select
                className={styles.formInput}
                style={{ padding: '4px 8px', fontSize: 12 }}
                value={logFilterMember}
                onChange={(e) => setLogFilterMember(e.target.value)}
              >
                <option value="">全部成员</option>
                {overview.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName} ({m.name})
                  </option>
                ))}
              </select>

              <select
                className={styles.formInput}
                style={{ padding: '4px 8px', fontSize: 12 }}
                value={logFilterModality}
                onChange={(e) => setLogFilterModality(e.target.value)}
              >
                <option value="">全部模态</option>
                {Object.entries(modalityLabels).map(([modality, label]) => <option key={modality} value={modality}>{label}</option>)}
              </select>
            </div>
          </div>

          <div className={styles.tableWrapper}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>调用成员</th>
                  <th>模型</th>
                  <th>模态</th>
                  <th>路由通道</th>
                  <th>实际消耗明细</th>
                  <th>供应商结算（CNY）</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {logs.length > 0 ? (
                  logs.map((log) => {
                    const timeStr = new Date(log.timestamp * 1000).toLocaleString('zh-CN', {
                      month: '2-digit',
                      day: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    });
                    return (
                      <tr key={log.id}>
                        <td style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                          {timeStr}
                        </td>
                        <td style={{ fontWeight: 600 }} title={log.memberId}>
                          {overview.members.find((member) => member.id === log.memberId)?.displayName || log.memberId}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontWeight: 600 }}>{log.model}</td>
                        <td>
                          <span
                            className={`${styles.modalityBadge} ${modalityClass(log.modality)}`}
                          >
                            {modalityLabels[log.modality] || log.modality}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`${styles.providerBadge} ${
                              log.providerType === 'external_provider'
                                ? styles.providerExternal
                                : styles.providerInternal
                            }`}
                          >
                            {log.providerType === 'external_provider' ? '第三方' : '默认网关'}
                          </span>
                          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{sourceLabel(log.source)}</div>
                        </td>
                        <td>
                          {log.modality === 'llm' ? (
                            <span style={{ fontFamily: 'monospace', color: '#38bdf8' }}>
                              {log.totalTokens.toLocaleString()} Tokens (入: {log.promptTokens} / 出: {log.completionTokens})
                            </span>
                          ) : log.modality === 'video' ? (
                            <span style={{ fontSize: 12, color: '#c084fc' }}>
                              时长: {log.durationSeconds}s, 参数: {JSON.stringify(log.parameters)}
                            </span>
                          ) : (
                            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                              参数: {JSON.stringify(log.parameters)}
                            </span>
                          )}
                        </td>
                        <td title={log.referenceId || '未取得网关账单编号'}>
                          <div style={{ fontFamily: 'monospace' }}>{formatCharge(log.actualChargeCents)}</div>
                          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{settlementLabel(log.settlementStatus)}</div>
                        </td>
                        <td style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--color-text-muted)' }}>
                          {log.durationMs}ms
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'center', color: 'var(--color-text-muted)', padding: '24px 0' }}>
                      暂无符合条件的审计流水
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: 基础设施与 DSH 沙箱 */}
      {activeSubTab === 'infra' && (
        <>
          <div className={styles.sectionCard}>
            <div className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>
                <Cpu size={18} />
                <span>{overview.stats.rosterCount} 位成员多租户工作区映射矩阵</span>
              </h3>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                DSH 沙箱分配与租户运行隔离
              </span>
            </div>

            <div className={styles.tableWrapper}>
              <table className={styles.dataTable}>
                <thead>
                  <tr>
                    <th>成员 ID</th>
                    <th>显示名</th>
                    <th>角色</th>
                    <th>邮箱映射状态</th>
                    <th>DSH 实例分配</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.members.map((m, idx) => (
                    <tr key={m.id}>
                      <td style={{ fontFamily: 'monospace' }}>{m.id}</td>
                      <td style={{ fontWeight: 600 }}>{m.displayName}</td>
                      <td>
                        <span
                          style={{
                            padding: '2px 8px',
                            borderRadius: 4,
                            fontSize: 11,
                            background: m.role === '群主' ? 'rgba(245, 158, 11, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                            color: m.role === '群主' ? '#f59e0b' : 'var(--color-text-secondary)',
                          }}
                        >
                          {m.role}
                        </span>
                      </td>
                      <td>
                        {m.accountStatus === 'configured' ? (
                          <span style={{ color: '#10b981', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle2 size={12} />
                            {m.email || '已配置'}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <Clock size={12} />
                            未预置邮箱
                          </span>
                        )}
                      </td>
                      <td style={{ fontFamily: 'monospace', color: '#38bdf8' }}>
                        greenroom-dsh-{(idx + 1).toString().padStart(2, '0')} (1 GiB)
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {params && (
            <div className={styles.sectionCard}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.sectionTitle}>
                  <Sliders size={18} />
                  <span>系统运行参数与中台拓扑配置</span>
                </h3>
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  参数受控注入 · 后端同步执行
                </span>
              </div>

              <div>
                <div className={styles.paramRow}>
                  <span className={styles.paramKey}>AUTH_TENANT_ID</span>
                  <span className={styles.paramVal}>{params.authTenantId || '未配置'}</span>
                </div>
                <div className={styles.paramRow}>
                  <span className={styles.paramKey}>AUTH_SERVICE_URL</span>
                  <span className={styles.paramVal}>{params.authServiceUrl || '未配置'}</span>
                </div>
                <div className={styles.paramRow}>
                  <span className={styles.paramKey}>ASSET_SERVICE_URL</span>
                  <span className={styles.paramVal}>{params.assetServiceUrl || '未配置'}</span>
                </div>
                <div className={styles.paramRow}>
                  <span className={styles.paramKey}>GATEWAY_SERVICE_URL</span>
                  <span className={styles.paramVal}>{params.gatewayServiceUrl || '未配置'}</span>
                </div>
                <div className={styles.paramRow}>
                  <span className={styles.paramKey}>STORAGE_BUDGET</span>
                  <span className={styles.paramVal}>
                    {params.storageBudgetGiB} GiB (主应用 {params.appBudgetGiB}G + {overview.stats.rosterCount} 成员 {params.slotBudgetGiB}G)
                  </span>
                </div>
                <div className={styles.paramRow}>
                  <span className={styles.paramKey}>COOKIE_SECURE</span>
                  <span className={styles.paramVal}>{params.cookieSecure ? 'true (__Host- 严格安全 Cookie)' : 'false'}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};
