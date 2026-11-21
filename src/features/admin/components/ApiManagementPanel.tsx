import React, { useEffect, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Check,
  Cpu,
  Globe,
  Image as ImageIcon,
  KeyRound,
  MessageSquare,
  AudioLines,
  Binary,
  Boxes,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  Video as VideoIcon,
  GripVertical,
} from 'lucide-react';
import adminStyles from './AdminManagementPanel.module.css';
import styles from './ApiManagementPanel.module.css';
import { Provider, ProviderEditor } from './ProviderEditor';
import { GatewayModelEditor, ModelProfile } from './ModelProfileFields';
import { CanvasSettingsPanel } from './CanvasSettingsPanel';
import { RunningHubManagementCard } from './RunningHubManagementCard';
import { GatewaySettingsForm } from './GatewaySettingsForm';
import { CreativePluginsPanel } from './CreativePluginsPanel';

type ModelKind = 'llm' | 'image' | 'video';
type MenuSection = 'overview' | 'providers' | 'canvas' | 'creative';
const DEFAULT_TAB_ORDER: MenuSection[] = ['overview', 'providers', 'canvas', 'creative'];

interface ModelOption {
  id: string;
  label: string;
  capabilities?: Record<string, unknown>;
}

const DIRECTORY_KINDS = [
  { kind: 'llm', label: '文字', icon: MessageSquare },
  { kind: 'image', label: '图片', icon: ImageIcon },
  { kind: 'audio', label: '音频', icon: AudioLines },
  { kind: 'video', label: '视频', icon: VideoIcon },
  { kind: 'embedding', label: '向量', icon: Binary },
  { kind: 'moderation', label: '内容审核', icon: ShieldAlert },
  { kind: 'rerank', label: '重排', icon: Activity },
  { kind: 'other', label: '其他', icon: Boxes },
] as const;

interface DirectoryModel extends ModelOption {
  kind: typeof DIRECTORY_KINDS[number]['kind'];
  connected: boolean;
}

interface ManagedApi {
  baseUrl: string;
  configured: boolean;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
  models: string[];
  source: string;
}

interface ApiCatalog {
  gateway: ManagedApi;
  models: Record<ModelKind, ModelOption[]>;
  directory: DirectoryModel[] | null;
  providers: Provider[];
  modelProfiles: Record<string, ModelProfile>;
  catalogError: string | null;
}

interface ProviderTestState {
  loading: boolean;
  message: string;
  ok?: boolean;
  models?: string[];
}

export const ApiManagementPanel: React.FC<{ showLocalModels?: boolean }> = ({ showLocalModels }) => {
  const [activeSection, setActiveSection] = useState<MenuSection>('overview');
  const [tabOrder, setTabOrder] = useState<MenuSection[]>(() => {
    try {
      const saved = localStorage.getItem('greenroom_api_tabs_order');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (
          Array.isArray(parsed) &&
          parsed.length === DEFAULT_TAB_ORDER.length &&
          DEFAULT_TAB_ORDER.every((t) => parsed.includes(t))
        ) {
          return parsed as MenuSection[];
        }
      }
    } catch {}
    return DEFAULT_TAB_ORDER;
  });

  const [draggedTab, setDraggedTab] = useState<MenuSection | null>(null);
  const [dragOverTab, setDragOverTab] = useState<MenuSection | null>(null);

  const handleDragStart = (e: React.DragEvent, id: MenuSection) => {
    setDraggedTab(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  };

  const handleDragOver = (e: React.DragEvent, id: MenuSection) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverTab !== id) {
      setDragOverTab(id);
    }
  };

  const handleDrop = (e: React.DragEvent, targetId: MenuSection) => {
    e.preventDefault();
    if (!draggedTab || draggedTab === targetId) {
      setDraggedTab(null);
      setDragOverTab(null);
      return;
    }
    const newOrder = [...tabOrder];
    const fromIndex = newOrder.indexOf(draggedTab);
    const toIndex = newOrder.indexOf(targetId);
    if (fromIndex !== -1 && toIndex !== -1) {
      newOrder.splice(fromIndex, 1);
      newOrder.splice(toIndex, 0, draggedTab);
      setTabOrder(newOrder);
      try {
        localStorage.setItem('greenroom_api_tabs_order', JSON.stringify(newOrder));
      } catch {}
    }
    setDraggedTab(null);
    setDragOverTab(null);
  };

  const handleDragEnd = () => {
    setDraggedTab(null);
    setDragOverTab(null);
  };

  const [catalog, setCatalog] = useState<ApiCatalog | null>(null);
  const [modelSearch, setModelSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [editingProvider, setEditingProvider] = useState<Provider | 'new' | null>(null);
  const [editingModel, setEditingModel] = useState<Parameters<typeof GatewayModelEditor>[0]['model'] | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, ProviderTestState>>({});

  const loadCatalog = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const response = await fetch('/api/admin/api-catalog', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('无权访问 API 管理');
      const result = await response.json();
      if (!result.success) throw new Error('加载 API 与模型目录失败');
      const data = result.data as ApiCatalog;
      setCatalog(data);
    } catch (err: any) {
      setErrorMsg(err.message || '加载 API 与模型目录失败');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadCatalog();
  }, []);

  const handleTestProvider = async (providerId: string) => {
    setTestStatus((previous) => ({
      ...previous,
      [providerId]: { loading: true, message: '正在测试并拉取模型...' },
    }));
    try {
      const response = await fetch('/api/admin/providers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ providerId }),
      });
      const data = await response.json();
      setTestStatus((previous) => ({
        ...previous,
        [providerId]: {
          loading: false,
          message: data.message,
          ok: data.success,
          models: Array.isArray(data.models) ? data.models : [],
        },
      }));
    } catch (err: any) {
      setTestStatus((previous) => ({
        ...previous,
        [providerId]: { loading: false, message: `连接失败: ${err.message}`, ok: false },
      }));
    }
  };

  const handleDeleteProvider = async (providerId: string) => {
    if (!window.confirm('确定要删除此第三方 Provider 配置吗？')) return;
    try {
      const response = await fetch(`/api/admin/providers/${providerId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (response.ok) {
        await loadCatalog();
      } else {
        const errJson = await response.json();
        alert(errJson.detail || '删除失败');
      }
    } catch (err: any) {
      alert(`删除失败: ${err.message}`);
    }
  };

  if (isLoading && !catalog) {
    return (
      <div className={adminStyles.sectionCard}>
        <div className={styles.loadingRow}>
          <RefreshCw size={14} className={styles.spin} />
          正在读取平台 API 接入状态与模型目录...
        </div>
      </div>
    );
  }

  if (errorMsg || !catalog) {
    return (
      <div className={adminStyles.sectionCard}>
        <div className={styles.errorRow}>
          <ShieldAlert size={18} />
          <span>{errorMsg || '此页面需要管理员权限'}</span>
        </div>
        <button type="button" className={adminStyles.actionBtn} onClick={() => void loadCatalog()}>
          重新加载
        </button>
      </div>
    );
  }

  const activeProviders = catalog.providers.filter((provider) => provider.isActive);
  return (
    <div className={styles.panelContainer}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>
            <KeyRound size={18} />
            <span>API 管理与模型接入</span>
            <span className={adminStyles.adminBadge}>管理员专属</span>
          </h2>
          <div className={styles.subtitle}>
            查看平台接入的 API 与模型，统一调整各创作插件的模型、默认参数、第三方路由和 T8 画布设置。
          </div>
        </div>
        <button
          type="button"
          className={adminStyles.refreshBtn}
          onClick={() => void loadCatalog()}
          disabled={isLoading}
        >
          <RefreshCw size={13} className={isLoading ? styles.spin : undefined} />
          <span>刷新</span>
        </button>
      </div>

      <nav className={adminStyles.subTabsNav}>
        {tabOrder.map((tabKey) => {
          let icon = <Globe size={15} />;
          let label = '接入总览';

          if (tabKey === 'overview') {
            icon = <Globe size={15} />;
            label = '接入总览';
          } else if (tabKey === 'providers') {
            icon = <KeyRound size={15} />;
            label = `额外供应商 (${activeProviders.length} 活跃)`;
          } else if (tabKey === 'canvas') {
            icon = <MessageSquare size={15} />;
            label = 'T8 画布设置';
          } else if (tabKey === 'creative') {
            icon = <Sparkles size={15} />;
            label = 'AI 剧插件';
          }

          const isDragging = draggedTab === tabKey;
          const isDragOver = dragOverTab === tabKey;

          return (
            <button
              key={tabKey}
              type="button"
              draggable
              onDragStart={(e) => handleDragStart(e, tabKey)}
              onDragOver={(e) => handleDragOver(e, tabKey)}
              onDrop={(e) => handleDrop(e, tabKey)}
              onDragEnd={handleDragEnd}
              className={`${adminStyles.subTabBtn} ${adminStyles.subTabBtnDraggable} ${
                activeSection === tabKey ? adminStyles.subTabBtnActive : ''
              } ${isDragging ? adminStyles.subTabBtnDragging : ''} ${
                isDragOver ? adminStyles.subTabBtnDropTarget : ''
              }`}
              onClick={() => setActiveSection(tabKey)}
              title="点击切换视图，按住可自由拖拽调整顺序"
            >
              <GripVertical size={13} className={adminStyles.tabGrip} />
              {icon}
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      {activeSection === 'overview' && (
        <>
          <section className={styles.gatewaySection} aria-labelledby="default-model-gateway">
            <div className={styles.cardTop}>
              <h2 className={styles.gatewayHeading} id="default-model-gateway"><Cpu size={20} />默认模型网关</h2>
              <span className={catalog.gateway.configured ? styles.badgeOk : styles.badgeWarn}>
                {catalog.gateway.configured ? '已接入' : '未配置'}
              </span>
            </div>
            <p className={styles.gatewayDescription}>DSH 和各插件默认继承此网关。Key 仅保存在服务端。</p>
            <div className={styles.gatewayDetails}>
              <dl>
                <div><dt>网关地址</dt><dd>{catalog.gateway.baseUrl || '未配置'}</dd></div>
                <div><dt>API Key</dt><dd>{catalog.gateway.apiKeyMasked || '未配置'}</dd></div>
                <div><dt>配置来源</dt><dd>{catalog.gateway.source}</dd></div>
              </dl>
              <GatewaySettingsForm baseUrl={catalog.gateway.baseUrl} onSaved={loadCatalog} />
            </div>
            <div className={styles.directory}>
              <div className={styles.cardTop}>
                <h3 className={styles.directoryHeading}>按 Key 拉取的模型目录</h3>
                {catalog.directory && <span className={styles.kindCount}>{catalog.directory.length} 个型号</span>}
              </div>
              {catalog.catalogError ? (
                <p className={styles.warningBox}><AlertCircle size={14} />{catalog.catalogError}</p>
              ) : !catalog.directory?.length ? (
                <p className={styles.cardNote}>{catalog.gateway.configured ? '网关未返回模型。' : '保存默认网关后自动拉取模型。'}</p>
              ) : (
                <>
                  <div className={styles.directoryTools}>
                    <input type="search" aria-label="搜索模型" placeholder="搜索模型名称或 ID" value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)} />
                    <span className={styles.cardNote}>带「已接入」标记的型号已接入 Greenroom，其余为供应商目录条目。</span>
                  </div>
                  <div className={styles.modelGrid}>
                    {DIRECTORY_KINDS.map(({ kind, label, icon: Icon }) => {
                      const query = modelSearch.trim().toLowerCase();
                      const options = catalog.directory?.filter(model => model.kind === kind
                        && (!query || `${model.id} ${model.label}`.toLowerCase().includes(query))) || [];
                      if (!options.length) return null;
                      return (
                        <section key={kind} className={styles.modelBlock} aria-label={label}>
                          <div className={styles.modelBlockHeader}>
                            <span className={styles.modelBlockTitle}><Icon size={14} />{label}</span>
                            <span className={styles.kindCount}>{options.length} 个</span>
                          </div>
                          <div className={`${styles.modelChips} ${styles.directoryChips}`}>
                            {options.map(model => (
                              <span className={styles.modelChip} key={model.id} title={model.id}>
                                <span>{model.label}</span>
                                {model.connected && <span className={styles.modelChipBadge}>已接入</span>}
                                {model.connected && (model.kind === 'llm' || model.kind === 'image' && model.id.startsWith('gpt-image-2.6-')) && <button
                                  className={styles.profileButton} type="button"
                                  aria-label={`设置模型 ${model.label}`}
                                  onClick={() => setEditingModel({ ...model, kind: model.kind as 'llm' | 'image',
                                    profile: catalog.modelProfiles[model.id] ?? (model.kind === 'image'
                                      ? { size: '1024x1024', quality: 'low', complexity: 'low' } : {}) })}>设置</button>}

                              </span>
                            ))}
                          </div>
                        </section>
                      );
                    })}
                  </div>
                  {modelSearch.trim() && !catalog.directory.some(model =>
                    `${model.id} ${model.label}`.toLowerCase().includes(modelSearch.trim().toLowerCase())) &&
                    <p className={styles.cardNote}>没有匹配的型号。</p>}
                </>
              )}
            </div>
          </section>

          <section className={styles.additionalAccess} aria-labelledby="additional-model-access">
            <h2 className={styles.directoryHeading} id="additional-model-access">额外接入与插件设置</h2>
            <div className={styles.cardsGrid}>
            <div className={styles.apiCard}>
              <div className={styles.cardTop}>
                <div className={styles.cardName}><KeyRound size={15} />额外供应商</div>
                <span className={activeProviders.length ? styles.badgeInfo : styles.badgeMuted}>
                  {activeProviders.length ? `${activeProviders.length} 个已启用` : '未接入'}
                </span>
              </div>
              {catalog.providers.length ? (
                catalog.providers.map((provider) => (
                  <div className={styles.cardRow} key={provider.id}>
                    <span>{provider.name}</span>
                    <span className={styles.cardVal}>{provider.modelPrefix || '无前缀'}</span>
                  </div>
                ))
              ) : (
                <div className={styles.cardNote}>尚未配置第三方服务。</div>
              )}
              <div className={styles.cardNote}>
                可添加多个供应商。支持前缀路由的接口可显式选择对应供应商。
              </div>
              <button type="button" className={adminStyles.actionBtn} onClick={() => setActiveSection('providers')}>管理供应商</button>
            </div>

            <div className={styles.apiCard}>
              <div className={styles.cardTop}>
                <div className={styles.cardName}><Globe size={15} />T8 画布</div>
                <span className={styles.badgeInfo}>平台目录</span>
              </div>
              <div className={styles.cardRow}>
                <span>文本模型</span>
                <span className={styles.cardVal}>{catalog.models.llm.length} 个</span>
              </div>
              <div className={styles.cardRow}>
                <span>图像模型</span>
                <span className={styles.cardVal}>{catalog.models.image.length} 个</span>
              </div>
              <div className={styles.cardRow}>
                <span>视频模型</span>
                <span className={styles.cardVal}>{catalog.models.video.length} 个</span>
              </div>
              <div className={styles.cardNote}>
                独立画布 API Key、RunningHub 与字体设置可在「T8 画布设置」中调整。
              </div>
            </div>


          </div>

          {showLocalModels && (
            <section className={styles.apiCard} aria-label="自定义模型 API">
              <div className={styles.cardTop}>
                <div className={styles.cardName}><KeyRound size={15} />自定义模型 API</div>
                <a className={adminStyles.actionBtn} href="/local-models/">配置与测试</a>
              </div>
              <div className={styles.cardNote}>
                配置自己的模型接口并在本机单独测试，不会更改默认模型网关。
              </div>
            </section>
          )}

          </section>
        </>
      )}

      {activeSection === 'providers' && (
        <>
          <RunningHubManagementCard />
          <div className={adminStyles.sectionCard}>
          <div className={adminStyles.sectionHeader}>
            <div>
              <h3 className={adminStyles.sectionTitle}>
                <KeyRound size={18} />
                <span>额外供应商</span>
              </h3>
              <div className={styles.sectionHint}>
                每个供应商独立保存 Key，可供全局选择，也可只提供给指定插件。
              </div>
            </div>
            <button
              type="button"
              className={adminStyles.primaryBtn}
              onClick={() => setEditingProvider('new')}
            >
              <Plus size={14} />
              <span>接入第三方 API</span>
            </button>
          </div>

          {catalog.providers.length > 0 ? (
            <div className={adminStyles.providerCardsGrid}>
              {catalog.providers.map((provider) => {
                const test = testStatus[provider.id];
                return (
                  <div key={provider.id} className={adminStyles.providerCard}>
                    <div className={adminStyles.providerCardHeader}>
                      <div>
                        <div className={adminStyles.providerName}>{provider.name}</div>
                        <div className={styles.providerId}>ID: {provider.id}</div>
                      </div>
                      <span className={adminStyles.providerPrefixTag}>
                        前缀: {provider.modelPrefix || '无前缀'}
                      </span>
                    </div>

                    <div className={adminStyles.providerDetails}>
                      <div className={adminStyles.providerDetailRow}>
                        <span>Base URL:</span>
                        <span className={styles.providerValue}>{provider.baseUrl}</span>
                      </div>
                      <div className={adminStyles.providerDetailRow}>
                        <span>API Key:</span>
                        <span className={styles.providerValue}>已保存</span>
                      </div>
                      <div>
                        <span>已声明模型:</span>
                        <div className={adminStyles.providerModelsList}>
                          {provider.models && provider.models.length > 0 ? (
                            provider.models.map((model, modelIndex) => (
                              <span key={modelIndex} className={adminStyles.paramTag}>
                                {provider.modelPrefix}{model.id} ({model.modality || 'llm'})
                              </span>
                            ))
                          ) : (
                            <span className={styles.emptyHint}>未声明子模型</span>
                          )}
                        </div>
                      </div>
                    </div>

                    {test && (
                      <div
                        className={`${styles.testResult} ${test.ok ? styles.testResultOk : styles.testResultError}`}
                      >
                        {test.ok ? <Check size={12} /> : <AlertCircle size={12} />}
                        <span>{test.message}</span>
                      </div>
                    )}

                    {test?.models && test.models.length > 0 && (
                      <div>
                        <div className={styles.pulledTitle}>拉取到的模型</div>
                        <div className={styles.pulledList}>
                          {test.models.map((modelId) => (
                            <span key={modelId} className={styles.modelChip}>{modelId}</span>
                          ))}
                        </div>
                      </div>
                    )}

                    <span className={styles.cardNote}>{provider.pluginIds === null ? '全局可选' : `仅 ${provider.pluginIds.length} 个插件可用`}</span>
                    <div className={adminStyles.providerActions}>
                      <button type="button" className={adminStyles.actionBtn} onClick={() => setEditingProvider(provider)}>编辑供应商</button>
                      <button
                        type="button"
                        className={adminStyles.actionBtn}
                        onClick={() => void handleTestProvider(provider.id)}
                        disabled={test?.loading}
                      >
                        <Activity size={12} />
                        <span>{test?.loading ? '拉取中...' : '测试并拉取模型'}</span>
                      </button>
                      <button
                        type="button"
                        className={`${adminStyles.actionBtn} ${adminStyles.deleteBtn}`}
                        onClick={() => void handleDeleteProvider(provider.id)}
                      >
                        <Trash2 size={12} />
                        <span>删除</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.providerEmpty}>
              尚未配置第三方 API。
            </div>
          )}
        </div>
        </>
      )}

      {activeSection === 'canvas' && <CanvasSettingsPanel />}
      {activeSection === 'creative' && <CreativePluginsPanel />}

      {editingProvider && <ProviderEditor provider={editingProvider === 'new' ? undefined : editingProvider}
        onClose={() => setEditingProvider(null)} onSaved={loadCatalog} />}
      {editingModel && <GatewayModelEditor model={editingModel}
        onClose={() => setEditingModel(null)} onSaved={loadCatalog} />}
    </div>
  );
};
