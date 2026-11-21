import { useEffect, useState } from 'react';
import styles from './AdminManagementPanel.module.css';
import { ModelProfile, ModelProfileFields } from './ModelProfileFields';

const PROTOCOLS = {
  llm: [['openai-completions', 'Chat Completions'], ['openai-responses', 'Responses']],
  image: [['openai-images', 'Images API']],
  tts: [['openai-speech', 'Speech API']],
  video: [],
  embedding: [['openai-embeddings', 'Embeddings API']],
  rerank: [['cohere-rerank', 'Cohere Rerank']],
} as const;
const KINDS = {
  llm: '文字', image: '生图', tts: '音频 / 语音', video: '视频', embedding: '向量', rerank: '重排',
} as const;
type Kind = keyof typeof KINDS;
export type ProviderModel = {
  id: string; name?: string; modality?: Kind; protocol?: string; profile?: ModelProfile;
};
export interface Provider {
  id: string; name: string; baseUrl: string; modelPrefix: string; isActive: boolean;
  models: ProviderModel[]; pluginIds: string[] | null;
}

export function ProviderEditor({ provider, onClose, onSaved }: {
  provider?: Provider; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(provider?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [isActive, setActive] = useState(provider?.isActive ?? true);
  const [pluginIds, setPluginIds] = useState<string[] | null>(provider?.pluginIds ?? null);
  const [models, setModels] = useState<ProviderModel[]>(provider?.models ?? []);
  const [plugins, setPlugins] = useState<Array<{id: string; title: string; status?: string}>>([]);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/admin/creative-plugins', { credentials: 'same-origin' }).then(response => response.json())
      .then(body => setPlugins(body.data?.plugins ?? [])).catch(() => setError('插件目录加载失败'));
  }, []);

  function patchModel(index: number, model: Partial<ProviderModel>) {
    setModels(current => current.map((entry, position) => position === index ? { ...entry, ...model } : entry));
  }

  async function request(discover = false) {
    setBusy(true);
    setError('');
    try {
      const path = discover ? '/api/admin/providers/test' : '/api/admin/providers' + (provider ? '/' + provider.id : '');
      const body = discover
        ? (key || baseUrl !== provider?.baseUrl ? { baseUrl, apiKey: key } : { providerId: provider?.id })
        : { name, baseUrl, apiKey: key, isActive, pluginIds, models: models.map(model => ({
          ...model, id: model.id.trim(), protocol: model.protocol ?? PROTOCOLS[model.modality ?? 'llm'][0]?.[0],
        })) };
      const response = await fetch(path, {
        method: provider && !discover ? 'PUT' : 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || data.success === false) throw new Error(data.detail || data.message || '无法保存供应商');
      if (discover) setDiscovered(data.models ?? []);
      else {
        await onSaved();
        onClose();
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <div className={styles.modalOverlay}>
    <form className={styles.modalContent} role="dialog" aria-modal="true" aria-labelledby="provider-editor-title"
      onSubmit={event => { event.preventDefault(); void request(); }}>
      <h3 id="provider-editor-title">{provider ? '编辑供应商' : '添加供应商'}</h3>
      <label className={styles.formLabel}>供应商名称
        <input className={styles.formInput} required value={name} onChange={event => setName(event.target.value)} />
      </label>
      <label className={styles.formLabel}>Base URL
        <input className={styles.formInput} type="url" required value={baseUrl} placeholder="https://api.example.com/v1"
          onChange={event => setBaseUrl(event.target.value)} />
      </label>
      <label className={styles.formLabel}>API Key
        <input className={styles.formInput} type="password" autoComplete="new-password" required={!provider} value={key}
          placeholder={provider ? '留空保留当前 Key' : ''} onChange={event => setKey(event.target.value)} />
      </label>
      <label className={styles.formLabel}>可用范围
        <select className={styles.formInput} value={pluginIds === null ? 'global' : 'restricted'}
          onChange={event => setPluginIds(event.target.value === 'global' ? null : [])}>
          <option value="global">全局可选</option>
          <option value="restricted">仅指定插件</option>
        </select>
      </label>
      {pluginIds !== null && <fieldset className={styles.formGroup}>
        <legend>允许使用的插件</legend>
        {plugins.filter(plugin => plugin.status !== 'awaiting-authorization').map(plugin => <label key={plugin.id}>
          <input type="checkbox" checked={pluginIds.includes(plugin.id)}
            onChange={event => setPluginIds(event.target.checked ? [...pluginIds, plugin.id] :
              pluginIds.filter(id => id !== plugin.id))} /> {plugin.title}
        </label>)}
      </fieldset>}
      <label><input type="checkbox" checked={isActive} onChange={event => setActive(event.target.checked)} /> 启用供应商</label>
      <div className={styles.gatewayActions}>
        <button type="button" className={styles.actionBtn} onClick={() => void request(true)} disabled={busy || !baseUrl}>拉取模型目录</button>
        <button type="button" className={styles.actionBtn} onClick={() => setModels([...models, {id: '', modality: 'llm'}])}>手动添加模型</button>
      </div>
      {discovered.length > 0 && <label className={styles.formLabel}>从供应商目录添加
        <select className={styles.formInput} value="" onChange={event => {
          if (event.target.value) setModels([...models, {id: event.target.value, modality: 'llm'}]);
        }}>
          <option value="">选择模型后指定能力和协议</option>
          {discovered.filter(id => !models.some(model => model.id === id)).map(id => <option key={id}>{id}</option>)}
        </select>
      </label>}
      {models.map((model, index) => {
        const kind = model.modality ?? 'llm';
        const protocols = PROTOCOLS[kind];
        return <fieldset className={styles.formGroup} key={index}>
          <legend>模型 {index + 1}</legend>
          <label className={styles.formLabel}>模型 ID
            <input className={styles.formInput} required value={model.id} onChange={event => patchModel(index, {id: event.target.value})} />
          </label>
          <label className={styles.formLabel}>能力
            <select className={styles.formInput} value={kind} onChange={event => {
              const modality = event.target.value as Kind;
              patchModel(index, { modality, protocol: PROTOCOLS[modality][0]?.[0], profile: undefined });
            }}>
              {Object.entries(KINDS).filter(([id]) => id !== 'video' || kind === 'video').map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
          </label>
          {protocols.length > 0 && <label className={styles.formLabel}>协议
            <select className={styles.formInput} value={model.protocol ?? protocols[0]?.[0]}
              onChange={event => patchModel(index, { protocol: event.target.value })}>
              {protocols.map(([id, label]) => <option value={id} key={id}>{label}</option>)}
            </select>
          </label>}
          {(kind === 'llm' || kind === 'image') && <details>
            <summary>模型参数</summary>
            <ModelProfileFields kind={kind} value={model.profile ?? {}} onChange={profile => patchModel(index, { profile })} />
          </details>}
          <button type="button" className={styles.actionBtn} onClick={() => setModels(models.filter((_, i) => i !== index))}>移除此模型</button>
        </fieldset>;
      })}
      {error && <p role="alert">{error}</p>}
      <div className={styles.modalFooter}>
        <button type="button" className={styles.actionBtn} onClick={onClose}>取消</button>
        <button className={styles.primaryBtn} disabled={busy}>保存供应商</button>
      </div>
    </form>
  </div>;
}
