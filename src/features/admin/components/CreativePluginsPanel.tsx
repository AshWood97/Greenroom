import React, { useEffect, useState } from 'react';
import { RefreshCw, Save, Sparkles } from 'lucide-react';
import adminStyles from './AdminManagementPanel.module.css';
import styles from './ApiManagementPanel.module.css';
import { Provider } from './ProviderEditor';

const KINDS = [
  ['llm', '文本'], ['image', '图像'], ['video', '视频'], ['tts', '语音'],
  ['music', '音乐'], ['embedding', '向量'], ['rerank', '重排'],
] as const;
type Kind = typeof KINDS[number][0];
const BINDINGS = [['llm', '文字供应商'], ['image', '生图供应商'], ['tts', '音频 / 语音供应商']] as const;
type Bindings = Partial<Record<typeof BINDINGS[number][0], string>>;
type Selection = Record<Kind, string[]>;
interface Model { id: string; label: string; providerId?: string; capabilities: Record<string, unknown> }
interface Plugin {
  id: string; title: string; group: string; configured: boolean;
  status?: string; reason?: string; builtin?: boolean; bindings: Bindings;
  selected: Selection; parameters: Record<string, Record<string, string | number | boolean>>;
}
interface Catalog {
  releaseReady: boolean; aigcSkillsReady: boolean; plugins: Plugin[]; models: Record<Kind, Model[]>;
  providers: Provider[]; catalogError: string | null;
}
const DEFAULTS_HINT = '{"llm":{"temperature":0.7},"tts":{"voice":"alloy","speed":1,"response_format":"mp3"}}';

async function api(path: string, options?: RequestInit) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  const result = await response.json();
  if (!response.ok || result.success === false) throw new Error(result.detail || result.error || '操作未完成');
  return result;
}

export const CreativePluginsPanel: React.FC = () => {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [pluginId, setPluginId] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [parameters, setParameters] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const [bindings, setBindings] = useState<Bindings>({});

  const choosePlugin = (plugin: Plugin) => {
    setPluginId(plugin.id);
    setSelection(plugin.selected);
    setBindings(plugin.bindings);
    setParameters(JSON.stringify(plugin.parameters, null, 2));
  };
  const load = async () => {
    try {
      const data: Catalog = (await api('/api/admin/creative-plugins')).data;
      setCatalog(data);
      const plugin = data.plugins.find((item) => item.id === pluginId) || data.plugins[0];
      if (plugin) choosePlugin(plugin);
    } catch (error) {
      setNotice({ error: true, message: (error as Error).message });
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async (reset = false) => {
    if (!selection || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/admin/creative-plugins/${encodeURIComponent(pluginId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: reset ? null : selection, parameters: reset ? {} : JSON.parse(parameters) }),
      });
      await load();
      setNotice({ error: false, message: reset ? '已恢复继承平台模型和默认参数。' : '已保存，后续新任务使用此配置。' });
    } catch (error) {
      setNotice({ error: true, message: (error as Error).message });
    } finally { setBusy(false); }
  };

  const saveBindings = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await api(`/api/admin/creative-plugins/${encodeURIComponent(pluginId)}/providers`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bindings),
      });
      await load();
      setNotice({ error: false, message: '供应商绑定已保存，后续请求使用新配置。' });
    } catch (error) {
      setNotice({ error: true, message: (error as Error).message });
    } finally { setBusy(false); }
  };

  if (!catalog || !selection) return <section className={adminStyles.sectionCard}>
    <p>{notice?.message || '正在加载 AI 剧插件配置…'}</p>
    {notice && <button className={adminStyles.actionBtn} onClick={() => void load()}>重新加载</button>}
  </section>;

  const plugin = catalog.plugins.find((item) => item.id === pluginId);
  const modelsFor = (kind: Kind) => {
    const binding = BINDINGS.some(([id]) => id === kind) ? plugin?.bindings[kind as keyof Bindings] : undefined;
    return catalog.models[kind].filter(model => {
      if (binding) return model.providerId === binding;
      if (!model.providerId) return true;
      const provider = catalog.providers.find(item => item.id === model.providerId);
      return provider && (provider.pluginIds === null || provider.pluginIds.includes(pluginId));
    });
  };
  return <div>
    <section className={adminStyles.sectionCard}>
      <div className={adminStyles.sectionHeader}>
        <h3 className={adminStyles.sectionTitle}><Sparkles size={18} />AI 剧插件统一配置</h3>
        <button type="button" className={adminStyles.actionBtn} disabled={busy} onClick={() => void load()}><RefreshCw size={14} />刷新</button>
      </div>
      <p className={styles.sectionHint}>当前统一配置目录含 {catalog.plugins.filter((item) => item.group !== 'ai-drama-skills').length} 个应用、{catalog.plugins.filter((item) => item.group === 'ai-drama-skills').length} 套 AIGC Skills；开放与待授权状态以各项为准。T8 和火宝的其他设置保留在各自栏目。</p>
      {catalog.catalogError && <p className={styles.noticeError}>{catalog.catalogError}</p>}
      <label className={adminStyles.formLabel} htmlFor="creative-plugin">选择插件</label>
      <select id="creative-plugin" className={adminStyles.formInput} value={pluginId} disabled={busy}
        onChange={(event) => { const next = catalog.plugins.find((item) => item.id === event.target.value); if (next) choosePlugin(next); }}>
        {catalog.plugins.map((item) => <option key={item.id} value={item.id} disabled={item.status === 'awaiting-authorization'}>{item.title} · {item.group === 'ai-drama-skills' ? 'AIGC Skills' : 'AI剧综合工具'}</option>)}
      </select>
      <fieldset className={adminStyles.formGroup} disabled={busy}>
        <legend>供应商绑定</legend>
        {BINDINGS.map(([kind, title]) => {
          const choices = catalog.providers.filter(provider => provider.isActive
            && (provider.pluginIds === null || provider.pluginIds.includes(pluginId))
            && provider.models.some(model => (model.modality ?? 'llm') === kind));
          return <label key={kind} className={adminStyles.formLabel}>{title}
            <select className={adminStyles.formInput} value={bindings[kind] ?? ''}
              onChange={event => {
                const next = { ...bindings };
                if (event.target.value) next[kind] = event.target.value;
                else delete next[kind];
                setBindings(next);
              }}>
              <option value="">继承默认网关</option>
              {bindings[kind] && !choices.some(provider => provider.id === bindings[kind]) &&
                <option value={bindings[kind]}>原供应商不可用</option>}
              {choices.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
            </select>
          </label>;
        })}
        <button className={adminStyles.primaryBtn} type="button" onClick={() => void saveBindings()}>保存供应商绑定</button>
      </fieldset>
      {!plugin?.builtin && <>
      <p className={styles.sectionHint}>{plugin?.configured ? '使用本插件已保存的模型范围。' : '当前继承平台可用模型。'} 模型首项作为默认；清空某类后保存会关闭该能力。用户明确填写的创作参数优先于默认值。</p>
      <div className={styles.modelGrid}>
        {KINDS.map(([kind, label]) => <div className={styles.modelBlock} key={kind}>
          <h4 className={styles.modelBlockTitle}>{label}模型</h4>
          <div className={styles.modelChips}>
            {modelsFor(kind).map((model) => <button type="button" disabled={busy} key={model.id}
              className={`${styles.modelChip} ${selection[kind].includes(model.id) ? '' : styles.modelChipOff}`}
              aria-pressed={selection[kind].includes(model.id)} title={model.id}
              onClick={() => setSelection({ ...selection, [kind]: selection[kind].includes(model.id)
                ? selection[kind].filter((id) => id !== model.id) : [...selection[kind], model.id] })}>
                {model.label}{kind === 'image' && modelsFor(kind).some((item) => item.label === model.label && item.id !== model.id) ? ` (${model.id})` : ''}
              </button>)}
            {!modelsFor(kind).length && <span className={styles.sectionHint}>{kind === 'music' ? '尚无已核实的文本生音乐模型' : '尚未配置可用模型'}</span>}
          </div>
          {selection[kind].length > 0 && <label className={adminStyles.formLabel}>默认模型
            <select className={adminStyles.formInput} value={selection[kind][0]} disabled={busy}
              onChange={(event) => setSelection({ ...selection, [kind]: [event.target.value, ...selection[kind].filter((id) => id !== event.target.value)] })}>
              {selection[kind].map((id) => {
                const model = modelsFor(kind).find((item) => item.id === id);
                if (kind !== 'image' || !model) return <option key={id} value={id}>{id}{model ? '' : '（已不可用）'}</option>;
                // Image channels sharing one name keep the full id in the option text.
                const ambiguous = modelsFor(kind).some((item) => item.label === model.label && item.id !== id);
                return <option key={id} value={id}>{model.label}{ambiguous ? ` (${id})` : ''}</option>;
              })}
            </select>
          </label>}
        </div>)}
      </div>
      <label className={adminStyles.formLabel} htmlFor="creative-defaults">默认创作参数（JSON）</label>
      <textarea id="creative-defaults" className={adminStyles.formInput} rows={7} value={parameters}
        placeholder={DEFAULTS_HINT} spellCheck={false} disabled={busy} onChange={(event) => setParameters(event.target.value)} />
      <p className={adminStyles.formHelp}>按 llm、image、video、tts、music、embedding、rerank 分类填写。仅接受创作参数，API 地址与密钥在「额外供应商」中管理。</p>
      <div className={adminStyles.sectionActions}>
        <button type="button" className={adminStyles.primaryBtn} disabled={busy} onClick={() => void save()}><Save size={14} />保存插件配置</button>
        <button type="button" className={adminStyles.actionBtn} disabled={busy} onClick={() => void save(true)}>恢复继承平台</button>
      </div>
      </>}
    </section>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? styles.noticeError : styles.noticeOk}>{notice.message}</p>}
  </div>;
};
