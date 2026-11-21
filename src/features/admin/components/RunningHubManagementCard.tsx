import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Plus,
  Power,
  RefreshCw,
  Save,
  Trash2,
  Zap,
} from 'lucide-react';
import adminStyles from './AdminManagementPanel.module.css';
import styles from './RunningHubManagementCard.module.css';

export interface RunningHubKeyItem {
  id: string;
  site: 'cn' | 'intl';
  apiKey: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
  exhaustedUntil: number;
  isExhausted: boolean;
  createdAt?: number;
  updatedAt?: number;
}

interface KeyTestState {
  loading: boolean;
  remainCoins?: string | null;
  remainMoney?: string | null;
  currency?: string | null;
  currentTasks?: string | null;
  message?: string;
  ok?: boolean;
}

export const RunningHubManagementCard: React.FC = () => {
  const [activeSite, setActiveSite] = useState<'intl' | 'cn'>('intl');
  const [keysBySite, setKeysBySite] = useState<{ cn: RunningHubKeyItem[]; intl: RunningHubKeyItem[] }>({
    cn: [],
    intl: [],
  });
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [testStates, setTestStates] = useState<Record<string, KeyTestState>>({});
  const [batchInput, setBatchInput] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);

  const loadKeys = async () => {
    setIsLoading(true);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/runninghub/keys', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('加载 RunningHub 凭据失败');
      const result = await response.json();
      if (result.success && result.data) {
        setKeysBySite({
          cn: result.data.cn || [],
          intl: result.data.intl || [],
        });
      }
    } catch (err: any) {
      setNotice({ error: true, message: err?.message || '加载 RunningHub 凭据失败，请重试' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadKeys();
  }, []);

  const currentKeys = keysBySite[activeSite] || [];

  const handleToggleKeyVisible = (id: string) => {
    setVisibleKeys((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCopy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {}
  };

  const handleToggleActive = (id: string) => {
    setKeysBySite((prev) => ({
      ...prev,
      [activeSite]: prev[activeSite].map((k) =>
        k.id === id ? { ...k, isActive: !k.isActive } : k
      ),
    }));
  };

  const handleLabelChange = (id: string, newLabel: string) => {
    setKeysBySite((prev) => ({
      ...prev,
      [activeSite]: prev[activeSite].map((k) =>
        k.id === id ? { ...k, label: newLabel } : k
      ),
    }));
  };

  const handleDeleteKey = (id: string) => {
    setKeysBySite((prev) => ({
      ...prev,
      [activeSite]: prev[activeSite].filter((k) => k.id !== id),
    }));
  };

  const handleAddBatchKeys = () => {
    const raw = batchInput.trim();
    if (!raw) return;
    const splitKeys = raw
      .split(/[\n,;，；]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 5);

    if (splitKeys.length === 0) return;

    const existingKeys = keysBySite[activeSite];
    const newItems: RunningHubKeyItem[] = splitKeys.map((k, idx) => ({
      id: `temp_${Date.now()}_${idx}`,
      site: activeSite,
      apiKey: k,
      label: `${activeSite === 'cn' ? '国内版' : '海外版'} Key #${existingKeys.length + idx + 1}`,
      isActive: true,
      sortOrder: existingKeys.length + idx,
      exhaustedUntil: 0,
      isExhausted: false,
    }));

    setKeysBySite((prev) => ({
      ...prev,
      [activeSite]: [...prev[activeSite], ...newItems],
    }));
    setBatchInput('');
  };

  const handleTestKey = async (keyItem: RunningHubKeyItem) => {
    setTestStates((prev) => ({
      ...prev,
      [keyItem.id]: { loading: true, message: '检测中...' },
    }));
    try {
      const response = await fetch('/api/admin/runninghub/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          site: activeSite,
          keyId: keyItem.id.startsWith('temp_') ? undefined : keyItem.id,
          apiKey: keyItem.id.startsWith('temp_') ? keyItem.apiKey : undefined,
        }),
      });
      const data = await response.json();
      setTestStates((prev) => ({
        ...prev,
        [keyItem.id]: {
          loading: false,
          ok: data.success,
          remainCoins: data.remainCoins,
          remainMoney: data.remainMoney,
          currency: data.currency,
          currentTasks: data.currentTasks,
          message: data.message,
        },
      }));
    } catch (err: any) {
      setTestStates((prev) => ({
        ...prev,
        [keyItem.id]: {
          loading: false,
          ok: false,
          message: err?.message || '网络连接超时',
        },
      }));
    }
  };

  const handleTestAllKeys = async () => {
    for (const keyItem of currentKeys) {
      if (keyItem.isActive) {
        await handleTestKey(keyItem);
      }
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/runninghub/keys', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          site: activeSite,
          keys: currentKeys.map((k, index) => ({
            id: k.id.startsWith('temp_') ? undefined : k.id,
            apiKey: k.apiKey,
            label: k.label,
            isActive: k.isActive,
            sortOrder: index,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data?.error || data?.message || '保存失败');
      }
      setNotice({ error: false, message: `已成功保存 ${activeSite === 'cn' ? '国内版' : '海外版'} RunningHub Key 池配置` });
      if (data.data) {
        setKeysBySite({
          cn: data.data.cn || [],
          intl: data.data.intl || [],
        });
      }
    } catch (err: any) {
      setNotice({ error: true, message: err?.message || '保存失败，请检查网络或参数' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className={styles.cardContainer}>
      <div className={styles.header}>
        <div className={styles.titleArea}>
          <h3 className={styles.title}>
            <Zap size={18} color="#38bdf8" />
            <span>RunningHub 凭据与轮询调度 (国内外双池)</span>
          </h3>
          <div className={styles.subtitle}>
            分别管理 RunningHub 海外站 (runninghub.ai) 与国内站 (runninghub.cn) 的 API Key。系统按轮询调度自动均衡；单 Key 额度耗尽（如每日 100 积分用完或返回 416/812）自动平滑接力至下一 Key；优先海外站，全部耗尽自动降级至国内站。
          </div>
        </div>

        <div className={styles.siteNav}>
          <button
            type="button"
            className={`${styles.siteBtn} ${activeSite === 'intl' ? styles.siteBtnActive : ''}`}
            onClick={() => setActiveSite('intl')}
          >
            <Globe size={14} />
            <span>海外版 (runninghub.ai)</span>
            <span className={styles.siteBadge}>{keysBySite.intl.length}</span>
          </button>
          <button
            type="button"
            className={`${styles.siteBtn} ${activeSite === 'cn' ? styles.siteBtnActive : ''}`}
            onClick={() => setActiveSite('cn')}
          >
            <span>🇨🇳 国内版 (runninghub.cn)</span>
            <span className={styles.siteBadge}>{keysBySite.cn.length}</span>
          </button>
        </div>
      </div>

      <div className={styles.infoBar}>
        <div className={styles.infoLeft}>
          <span>当前服务域:</span>
          <span className={styles.domainTag}>
            {activeSite === 'intl' ? 'https://www.runninghub.ai' : 'https://www.runninghub.cn'}
          </span>
          <span className={styles.statsText}>
            ({activeSite === 'intl' ? '优先区域' : '备用降级区域'} · 共 {currentKeys.length} 个 Key，
            {currentKeys.filter((k) => k.isActive).length} 个活跃中)
          </span>
        </div>

        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => void handleTestAllKeys()}
          disabled={isLoading || currentKeys.length === 0}
          title="依次测试所有活跃 Key 的余额与有效性"
        >
          <Activity size={13} />
          <span>测试全部余额</span>
        </button>
      </div>

      <div className={styles.keysList}>
        {currentKeys.length > 0 ? (
          currentKeys.map((keyItem, index) => {
            const isVisible = visibleKeys[keyItem.id] || false;
            const isCopied = copiedId === keyItem.id;
            const test = testStates[keyItem.id];

            return (
              <div
                key={keyItem.id}
                className={`${styles.keyCard} ${!keyItem.isActive ? styles.keyCardInactive : ''}`}
              >
                <div className={styles.keyCardTop}>
                  <div className={styles.keyMeta}>
                    <span className={styles.orderBadge}>#{index + 1}</span>
                    <input
                      type="text"
                      className={styles.keyLabelInput}
                      value={keyItem.label}
                      onChange={(e) => handleLabelChange(keyItem.id, e.target.value)}
                      placeholder="Key 备注名称"
                    />
                    {!keyItem.isActive ? (
                      <span className={styles.statusInactive}>已停用</span>
                    ) : keyItem.isExhausted ? (
                      <span className={styles.statusExhausted}>
                        <AlertCircle size={11} />
                        <span>额度冷却中 (跳过)</span>
                      </span>
                    ) : (
                      <span className={styles.statusReady}>
                        <Check size={11} />
                        <span>就绪 (轮询中)</span>
                      </span>
                    )}
                  </div>

                  <div className={styles.keyActions}>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => void handleTestKey(keyItem)}
                      disabled={test?.loading}
                      title="在线检测余额与可用性"
                    >
                      <Activity size={12} className={test?.loading ? styles.spin : undefined} />
                      <span>{test?.loading ? '检测中' : '测试余额'}</span>
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => handleToggleActive(keyItem.id)}
                      title={keyItem.isActive ? '停用此 Key' : '启用此 Key'}
                    >
                      <Power size={12} />
                      <span>{keyItem.isActive ? '停用' : '启用'}</span>
                    </button>
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => handleDeleteKey(keyItem.id)}
                      title="从当前池中移除"
                    >
                      <Trash2 size={12} />
                      <span>删除</span>
                    </button>
                  </div>
                </div>

                <div className={styles.keyInputRow}>
                  <input
                    type={isVisible ? 'text' : 'password'}
                    className={styles.keyInput}
                    value={keyItem.apiKey}
                    readOnly={!keyItem.id.startsWith('temp_')}
                    onChange={(e) => {
                      if (keyItem.id.startsWith('temp_')) {
                        const val = e.target.value;
                        setKeysBySite((prev) => ({
                          ...prev,
                          [activeSite]: prev[activeSite].map((k) =>
                            k.id === keyItem.id ? { ...k, apiKey: val } : k
                          ),
                        }));
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => handleToggleKeyVisible(keyItem.id)}
                    title={isVisible ? '隐藏' : '显示'}
                  >
                    {isVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    onClick={() => void handleCopy(keyItem.id, keyItem.apiKey)}
                    title="复制 API Key"
                  >
                    {isCopied ? <Check size={13} color="#34d399" /> : <Copy size={13} />}
                    <span>{isCopied ? '已复制' : '复制'}</span>
                  </button>
                </div>

                {test && (
                  <div className={styles.balanceRow}>
                    {test.ok ? (
                      <>
                        <span className={styles.coinBadge}>
                          积分: {test.remainCoins ?? '0'}
                        </span>
                        <span className={styles.moneyBadge}>
                          现金: {test.remainMoney ?? '0.00'} {test.currency || ''}
                        </span>
                        <span className={styles.balanceMsg}>{test.message}</span>
                      </>
                    ) : (
                      <span className={styles.balanceError}>{test.message}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className={styles.infoBar}>
            当前尚未配置任何 {activeSite === 'cn' ? '国内版' : '海外版'} Key。
          </div>
        )}
      </div>

      <div className={styles.addKeySection}>
        <div className={styles.addKeyTitle}>
          <Plus size={14} />
          <span>添加新 Key（可单条输入，或粘贴多条由逗号、分号、换行分隔）</span>
        </div>
        <textarea
          className={styles.addKeyTextarea}
          placeholder="例如: 0f61068fb38843e4a993847ef34f5b75, a7c35c090cb94b989f3ac00fa1834b06"
          value={batchInput}
          onChange={(e) => setBatchInput(e.target.value)}
        />
        <div className={styles.addKeyBottom}>
          <button
            type="button"
            className={adminStyles.actionBtn}
            onClick={handleAddBatchKeys}
            disabled={!batchInput.trim()}
          >
            <Plus size={13} />
            <span>添加至当前 Key 池</span>
          </button>
        </div>
      </div>

      <div className={styles.bottomBar}>
        <div>
          {notice && (
            <div className={`${styles.notice} ${notice.error ? styles.noticeError : styles.noticeOk}`}>
              {notice.error ? <AlertCircle size={14} /> : <Check size={14} />}
              <span>{notice.message}</span>
            </div>
          )}
        </div>

        <button
          type="button"
          className={adminStyles.primaryBtn}
          onClick={() => void handleSave()}
          disabled={isSaving}
        >
          {isSaving ? <RefreshCw size={14} className={styles.spin} /> : <Save size={14} />}
          <span>{isSaving ? '正在保存...' : '保存 Key 池配置'}</span>
        </button>
      </div>
    </div>
  );
};
