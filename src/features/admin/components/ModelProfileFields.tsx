import { useState } from 'react';
import styles from './AdminManagementPanel.module.css';

export interface ModelProfile {
  size?: string;
  quality?: string;
  complexity?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  reasoningLevels?: string[];
  defaultReasoning?: string;
  reasoningMap?: Record<string, string>;
}

const SIZE_OPTIONS = ['512x512', '1024x1024', '1536x1024', '1024x1536', '2048x2048'];
const QUALITY_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const COMPLEXITY_OPTIONS = ['low', 'medium', 'high'];
const REASONING_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const IMAGE_FIELDS = [
  ['size', '图片尺寸', SIZE_OPTIONS],
  ['quality', '渲染质量', QUALITY_OPTIONS],
  ['complexity', '图片规划复杂度', COMPLEXITY_OPTIONS],
] as const;

export function ModelProfileFields({ kind, value, onChange }: {
  kind: 'llm' | 'image'; value: ModelProfile; onChange: (value: ModelProfile) => void;
}) {
  const levels = value.reasoningLevels ?? [];
  if (kind === 'image') {
    return <div className={styles.formGroup}>
      {IMAGE_FIELDS.map(([field, label, options]) => <label key={field} className={styles.formLabel}>
        {label}
        <select className={styles.formInput} value={value[field] ?? ''} onChange={event =>
          onChange({ ...value, [field]: event.target.value || undefined })}>
          <option value="">继承默认</option>
          {options.map(option => <option key={option}>{option}</option>)}
        </select>
      </label>)}
    </div>;
  }

  const changeLevel = (level: string, checked: boolean) => {
    const next = REASONING_LEVELS.filter(candidate => candidate === level ? checked : levels.includes(candidate));
    const map = Object.fromEntries(Object.entries(value.reasoningMap ?? {}).filter(([key]) => next.includes(key)));
    onChange({ ...value, reasoningLevels: next, reasoningMap: map,
      defaultReasoning: next.includes(value.defaultReasoning ?? '') ? value.defaultReasoning : undefined });
  };
  return <div className={styles.formGroup}>
    {([['contextWindow', '上下文窗口'], ['maxTokens', '最大输出 Token']] as const).map(([field, label]) =>
      <label className={styles.formLabel} key={field}>{label}
        <input type="number" min={1} max={10000000} className={styles.formInput}
          value={value[field] ?? ''} placeholder="继承模型默认值"
          onChange={event => onChange({ ...value, [field]: event.target.value ? Number(event.target.value) : undefined })} />
      </label>)}
    <details open>
      <summary>高级设置</summary>
      <fieldset className={styles.formGroup}>
        <legend>接收的输入</legend>
        <label><input type="checkbox" checked disabled /> 文字</label>
        <label><input type="checkbox" checked={value.input?.includes('image') ?? false}
          onChange={event => onChange({ ...value, input: event.target.checked ? ['text', 'image'] : ['text'] })} /> 图片</label>
      </fieldset>
      <fieldset className={styles.formGroup}>
        <legend>可选推理深度</legend>
        <div className={styles.gatewayActions}>{REASONING_LEVELS.map(level => <label key={level}>
          <input type="checkbox" checked={levels.includes(level)} onChange={event => changeLevel(level, event.target.checked)} /> {level}
        </label>)}</div>
      </fieldset>
      <label className={styles.formLabel}>默认推理深度
        <select className={styles.formInput} value={value.defaultReasoning ?? ''} onChange={event =>
          onChange({ ...value, defaultReasoning: event.target.value || undefined })}>
          <option value="">继承模型默认值</option>
          {levels.map(level => <option key={level}>{level}</option>)}
        </select>
      </label>
      {levels.length > 0 && <details>
        <summary>供应商推理值映射</summary>
        {levels.map(level => <label className={styles.formLabel} key={level}>{level}
          <input className={styles.formInput} placeholder={level} value={value.reasoningMap?.[level] ?? ''}
            onChange={event => {
              const map = { ...value.reasoningMap };
              if (event.target.value) map[level] = event.target.value;
              else delete map[level];
              onChange({ ...value, reasoningMap: map });
            }} />
        </label>)}
      </details>}
    </details>
  </div>;
}

export function GatewayModelEditor({ model, onClose, onSaved }: {
  model: { id: string; label: string; kind: 'llm' | 'image'; profile: ModelProfile };
  onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [profile, setProfile] = useState(model.profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async (reset = false) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/gateway-model-profile', {
        method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: model.id, profile: reset ? {} : profile }),
      });
      if (!response.ok) throw new Error((await response.json()).detail || '保存失败');
      await onSaved();
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <div className={styles.modalOverlay}>
    <form className={styles.modalContent} role="dialog" aria-modal="true" aria-labelledby="model-profile-title"
      onSubmit={event => { event.preventDefault(); void save(); }}>
      <h3 id="model-profile-title">模型设置 · {model.label}</h3>
      <p className={styles.formHelp}>{model.id}</p>
      <ModelProfileFields kind={model.kind} value={profile} onChange={setProfile} />
      {error && <p role="alert">{error}</p>}
      <div className={styles.modalFooter}>
        <button className={styles.actionBtn} type="button" onClick={() => void save(true)} disabled={busy}>恢复默认</button>
        <button className={styles.actionBtn} type="button" onClick={onClose}>取消</button>
        <button className={styles.primaryBtn} disabled={busy}>保存</button>
      </div>
    </form>
  </div>;
}
