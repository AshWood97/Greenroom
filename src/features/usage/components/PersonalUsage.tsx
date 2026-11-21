import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ReceiptText, RefreshCw, X } from 'lucide-react';
import styles from './PersonalUsage.module.css';

interface Consumption {
  actualChargeCents: number | null;
  settledRequests: number;
  pendingRequests: number;
  unavailableRequests: number;
}

interface UsageResponse {
  summary: Consumption & {
    totalRequests: number;
    topModels: Array<Consumption & { model: string; providerType: string; requests: number }>;
  };
  logs: Array<{
    id: string;
    timestamp: number;
    model: string;
    providerType: string;
    actualChargeCents: number | null;
    settlementStatus: string;
  }>;
}

const formatCharge = (cents: number | null) => cents == null ? '—' :
  (cents / 100).toLocaleString('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 5 });

const settlementLabel = (status: string) => ({
  pending: '待结算', unsettled: '尚未结算', unavailable: '账单暂不可用',
  charged: '已扣费', refunded: '已退款', partially_refunded: '部分退款',
  discounted: '已优惠', rounded_zero: '已结算', free: '免费', settled: '已结算',
} as Record<string, string>)[status] || '无供应商账单';

export const PersonalUsage: React.FC<{ userId: string; className?: string }> = ({ userId, className }) => {
  const [open, setOpen] = useState(false);
  const [timeRange, setTimeRange] = useState('all');
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError('');
    fetch(`/api/usage/me?timeRange=${timeRange}`, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.detail || '个人消耗暂不可用');
        if (!controller.signal.aborted) setData(body);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '个人消耗暂不可用');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, userId, timeRange, attempt]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      trigger.current?.focus();
    };
  }, [open]);

  return (
    <>
      <button ref={trigger} type="button" className={className || styles.trigger} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <ReceiptText size={14} /><span>我的消耗</span>
      </button>
      {open && createPortal(
        <div className={styles.backdrop} onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className={styles.panel} role="dialog" aria-modal="true" aria-label="我的消耗" aria-busy={loading}>
            <header className={styles.header}>
              <h2><ReceiptText size={20} />我的消耗 <span>人民币 CNY</span></h2>
              <button ref={closeButton} type="button" className={styles.iconButton} onClick={() => setOpen(false)} aria-label="关闭我的消耗"><X size={20} /></button>
            </header>
            <div className={styles.toolbar}>
              <p>仅展示您本人的消费记录。</p>
              <label>时间范围 <select value={timeRange} onChange={(event) => setTimeRange(event.target.value)}>
                <option value="all">全部</option><option value="today">最近 24 小时</option>
                <option value="7d">最近 7 天</option><option value="30d">最近 30 天</option>
              </select></label>
              <button type="button" className={styles.iconButton} onClick={() => setAttempt((value) => value + 1)} disabled={loading} aria-label="刷新个人消耗"><RefreshCw size={16} />刷新</button>
            </div>
            {loading && <p role="status" className={styles.notice}>正在查询个人消耗…</p>}
            {error && <p role="alert" className={styles.notice}>{error}</p>}
            {data && (
              <>
                <div className={styles.metrics}>
                  <div><span>已结算净消费</span><strong>{formatCharge(data.summary.actualChargeCents)}</strong><small>{data.summary.settledRequests} 次已结算</small></div>
                  <div><span>总调用次数</span><strong>{data.summary.totalRequests}</strong><small>当前时间范围</small></div>
                  <div><span>待结算 / 待同步</span><strong>{data.summary.pendingRequests} / {data.summary.unavailableRequests}</strong><small>未计入已结算金额</small></div>
                </div>
                <p className={styles.explanation}>金额来自实际结算账单，已扣除退款；未结算或暂不可用的金额显示为“—”。</p>
                <h3>按模型查看</h3>
                <div className={styles.tableWrapper}><table>
                  <thead><tr><th>模型</th><th>调用次数</th><th>已结算（CNY）</th></tr></thead>
                  <tbody>{data.summary.topModels.length ? data.summary.topModels.map((model) => (
                    <tr key={model.model}><td>{model.model}</td><td>{model.requests}</td><td>{formatCharge(model.actualChargeCents)}</td></tr>
                  )) : <tr><td colSpan={3} className={styles.empty}>暂无调用记录</td></tr>}</tbody>
                </table></div>
                <h3>最近调用（最多 20 条）</h3>
                <div className={styles.tableWrapper}><table>
                  <thead><tr><th>时间</th><th>模型</th><th>净消费（CNY）</th><th>结算状态</th></tr></thead>
                  <tbody>{data.logs.length ? data.logs.map((log) => (
                    <tr key={log.id}>
                      <td>{new Date(log.timestamp * 1000).toLocaleString('zh-CN')}</td><td>{log.model}</td>
                      <td>{formatCharge(log.actualChargeCents)}</td>
                      <td>{log.providerType === 'external_provider' ? '第三方通道' : settlementLabel(log.settlementStatus)}</td>
                    </tr>
                  )) : <tr><td colSpan={4} className={styles.empty}>暂无调用记录</td></tr>}</tbody>
                </table></div>
              </>
            )}
          </section>
        </div>, document.body,
      )}
    </>
  );
};
