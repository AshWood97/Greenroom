import React, { useEffect, useRef, useState } from 'react';
import { Download, Eye, EyeOff, KeyRound, Save, Sliders, Trash2, Upload } from 'lucide-react';
import adminStyles from './AdminManagementPanel.module.css';
import styles from './CanvasSettingsPanel.module.css';

const FONT_PRESETS = [
  { id: 'readable', label: '清晰推荐', description: '优先使用中文 UI 字体，缩小时更稳。' },
  { id: 'system', label: '系统默认', description: '跟随浏览器和系统 UI 字体。' },
  { id: 'theme', label: '跟随主题', description: '使用当前画布主题指定的字体。' },
  { id: 'custom', label: '自定义', description: '输入本机已安装的字体。' },
] as const;

const KEY_SLOTS = [
  { name: 'zhenzhenApiKey', label: '贞贞的AI工坊（海外）API Key', description: 'AI工坊海外独立服务 · 通用后备', baseUrl: 'https://ai.t8star.org' },
  { name: 'zhenzhenSd2ApiKey', label: '贞贞的平价AI小屋 API Key', description: '平价AI小屋独立服务', baseUrl: 'https://api.seedance.nz' },
  { name: 'rhApiKey', label: 'RH APIKEY 国内', description: 'RunningHub 国内站应用', baseUrl: 'https://www.runninghub.cn' },
  { name: 'rhIntlApiKey', label: 'RH APIKEY 海外', description: 'RunningHub 海外站应用', baseUrl: 'https://www.runninghub.ai' },
  { name: 'llmApiKey', label: 'LLM 独立 API Key', description: '当前 LLM 由平台网关托管，此项不覆盖平台网关配置。', baseUrl: 'https://ai.t8star.org' },
] as const;

type FontPreset = typeof FONT_PRESETS[number]['id'];
type KeyName = typeof KEY_SLOTS[number]['name'];

interface CanvasSettings {
  uiFontPreset: FontPreset;
  customUiFont: string;
  configuredKeys: Record<KeyName, boolean>;
}

interface RawCanvasSettings {
  uiFontPreset: FontPreset;
  customUiFont: string;
  keys: Record<KeyName, string>;
}

const READABLE_FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
const SYSTEM_FONT = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

async function fetchRawSettings(): Promise<RawCanvasSettings> {
  const response = await fetch('/api/admin/canvas-settings/raw', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('读取画布设置失败，请重试');
  const result = await response.json();
  if (!result.success) throw new Error('读取画布设置失败，请重试');
  return result.data;
}

export const CanvasSettingsPanel: React.FC = () => {
  const [settings, setSettings] = useState<CanvasSettings | null>(null);
  const [keyInputs, setKeyInputs] = useState<Partial<Record<KeyName, string>>>({});
  const [visibleKeys, setVisibleKeys] = useState<Partial<Record<KeyName, boolean>>>({});
  const [clearKeys, setClearKeys] = useState<KeyName[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'export' | 'import' | KeyName | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const loadSettings = async () => {
    setIsLoading(true);
    setNotice(null);
    try {
      const response = await fetch('/api/admin/canvas-settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (!result.success) throw new Error();
      setSettings(result.data);
    } catch {
      setNotice({ error: true, message: '加载画布设置失败，请重试' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  const handleSave = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings || busy) return;
    setBusy('save');
    setNotice(null);
    const keys: Partial<Record<KeyName, string>> = {};
    for (const { name } of KEY_SLOTS) {
      const value = keyInputs[name]?.trim();
      if (value) keys[name] = value;
    }
    try {
      const response = await fetch('/api/admin/canvas-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ uiFontPreset: settings.uiFontPreset, customUiFont: settings.customUiFont, keys, clearKeys }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (!result.success) throw new Error();
      setSettings(result.data);
      setKeyInputs({});
      setVisibleKeys({});
      setClearKeys([]);
      setNotice({ error: false, message: '已保存，成员重新加载画布后生效。' });
    } catch {
      setNotice({ error: true, message: '保存画布设置失败，请重试' });
    } finally {
      setBusy(null);
    }
  };

  const handleReveal = async (name: KeyName) => {
    if (visibleKeys[name] || keyInputs[name] || clearKeys.includes(name) || !settings?.configuredKeys[name]) {
      setVisibleKeys((previous) => ({ ...previous, [name]: !previous[name] }));
      return;
    }
    setBusy(name);
    setNotice(null);
    try {
      const raw = await fetchRawSettings();
      setKeyInputs((previous) => ({ ...previous, [name]: raw.keys[name] }));
      setVisibleKeys((previous) => ({ ...previous, [name]: true }));
    } catch {
      setNotice({ error: true, message: '读取 API Key 失败，请重试' });
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('import');
    setNotice(null);
    try {
      const imported = JSON.parse(await file.text()) as RawCanvasSettings;
      if (!FONT_PRESETS.some(({ id }) => id === imported.uiFontPreset)
        || typeof imported.customUiFont !== 'string'
        || !imported.keys
        || KEY_SLOTS.some(({ name }) => typeof imported.keys[name] !== 'string')) {
        throw new Error();
      }
      setSettings((previous) => previous && ({ ...previous, uiFontPreset: imported.uiFontPreset, customUiFont: imported.customUiFont }));
      setKeyInputs(Object.fromEntries(KEY_SLOTS.map(({ name }) => [name, imported.keys[name].trim()])));
      setClearKeys(KEY_SLOTS.filter(({ name }) => !imported.keys[name].trim()).map(({ name }) => name));
      setVisibleKeys({});
      setNotice({ error: false, message: '已导入，点击保存后生效；文件中的空密钥将清除对应配置。' });
    } catch {
      setNotice({ error: true, message: '导入失败，请选择从画布设置导出的 JSON 文件' });
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy('export');
    setNotice(null);
    try {
      const raw = await fetchRawSettings();
      const url = URL.createObjectURL(new Blob([JSON.stringify(raw, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'greenroom-canvas-settings.json';
      link.click();
      URL.revokeObjectURL(url);
      setNotice({ error: false, message: '已导出已保存的配置，文件包含完整 API Key，请妥善保管。' });
    } catch {
      setNotice({ error: true, message: '导出画布设置失败，请重试' });
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) {
    return <div className={adminStyles.sectionCard}>正在加载画布设置...</div>;
  }

  if (!settings) {
    return (
      <div className={adminStyles.sectionCard}>
        <p className={styles.error} role="alert">{notice?.message || '加载画布设置失败'}</p>
        <button type="button" className={adminStyles.actionBtn} onClick={() => void loadSettings()}>重新加载</button>
      </div>
    );
  }

  const previewFont = settings.uiFontPreset === 'custom'
    ? settings.customUiFont || READABLE_FONT
    : settings.uiFontPreset === 'system' ? SYSTEM_FONT : settings.uiFontPreset === 'theme' ? 'inherit' : READABLE_FONT;

  return (
    <form className={adminStyles.sectionCard} onSubmit={handleSave} autoComplete="off">
      <div className={adminStyles.sectionHeader}>
        <h3 className={adminStyles.sectionTitle}><Sliders size={18} />画布统一设置</h3>
        <span className={styles.help}>统一配置所有成员的画布，成员重新加载画布后生效。</span>
      </div>

      <fieldset className={styles.fields} disabled={busy !== null}>
        <section className={styles.fontSection} aria-labelledby="canvas-font-title">
          <h4 id="canvas-font-title" className={styles.sectionTitle}>界面字体</h4>
          <div className={styles.fontOptions}>
            {FONT_PRESETS.map((preset) => (
              <button
                type="button"
                key={preset.id}
                aria-pressed={settings.uiFontPreset === preset.id}
                className={`${styles.fontOption} ${settings.uiFontPreset === preset.id ? styles.fontOptionActive : ''}`}
                onClick={() => setSettings({ ...settings, uiFontPreset: preset.id })}
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
          <label className={styles.label} htmlFor="canvas-custom-font">自定义字体栈</label>
          <div className={styles.inputRow}>
            <input
              id="canvas-custom-font"
              className={adminStyles.formInput}
              value={settings.customUiFont}
              placeholder={'"Microsoft YaHei UI", sans-serif'}
              onChange={(event) => setSettings({ ...settings, customUiFont: event.target.value, uiFontPreset: 'custom' })}
            />
            <button type="button" className={adminStyles.actionBtn} onClick={() => setSettings({ ...settings, uiFontPreset: 'readable', customUiFont: '' })}>恢复推荐</button>
          </div>
          <div className={styles.preview} style={{ fontFamily: previewFont }}>
            <strong>界面字体预览</strong>
            <span>贞贞无限画布 · 节点文字 12px / 14px / 16px · 缩小时看边缘是否清楚</span>
          </div>
        </section>

        <section className={styles.keysSection} aria-labelledby="canvas-keys-title">
          <h4 id="canvas-keys-title" className={styles.sectionTitle}><KeyRound size={15} />API Key 设置（通用 + 分类独立）</h4>
          <p className={styles.help}>LLM、图像和视频模型继续由平台网关统一提供；以下 Key 用于画布对应的独立服务。</p>
          <p className={styles.help}>留空保留已有 Key，输入新值替换；点击清除并保存后删除。</p>
          {KEY_SLOTS.map((slot) => {
            const clearing = clearKeys.includes(slot.name);
            const configured = settings.configuredKeys[slot.name];
            const status = clearing ? '待清除' : keyInputs[slot.name]?.trim() ? '待保存' : configured ? '已配置' : '未配置';
            return (
              <div className={styles.keyField} key={slot.name}>
                <div className={styles.keyHeading}>
                  <label className={styles.label} htmlFor={`canvas-${slot.name}`}>{slot.label}</label>
                  <span className={clearing ? styles.error : styles.help}>{status}</span>
                </div>
                <p className={styles.help}>{slot.description}</p>
                <div className={styles.inputRow}>
                  <input
                    id={`canvas-${slot.name}`}
                    className={adminStyles.formInput}
                    type={visibleKeys[slot.name] ? 'text' : 'password'}
                    value={keyInputs[slot.name] || ''}
                    placeholder={clearing ? '保存后清除' : configured ? '已配置，留空保留' : '请输入 API Key'}
                    spellCheck={false}
                    onChange={(event) => {
                      setKeyInputs((previous) => ({ ...previous, [slot.name]: event.target.value }));
                      setClearKeys((previous) => previous.filter((name) => name !== slot.name));
                    }}
                  />
                  <button
                    type="button"
                    className={adminStyles.actionBtn}
                    aria-label={`${visibleKeys[slot.name] ? '隐藏' : '显示'}${slot.label}`}
                    title={visibleKeys[slot.name] ? '隐藏 Key' : '显示 Key'}
                    onClick={() => void handleReveal(slot.name)}
                  >
                    {visibleKeys[slot.name] ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    type="button"
                    className={`${adminStyles.actionBtn} ${adminStyles.deleteBtn}`}
                    aria-label={clearing ? `撤销清除${slot.label}` : `清除${slot.label}`}
                    title={clearing ? '撤销清除' : '清除 Key'}
                    disabled={!configured && !keyInputs[slot.name] && !clearing}
                    onClick={() => {
                      setKeyInputs((previous) => ({ ...previous, [slot.name]: '' }));
                      setVisibleKeys((previous) => ({ ...previous, [slot.name]: false }));
                      setClearKeys((previous) => clearing ? previous.filter((name) => name !== slot.name) : [...previous, slot.name]);
                    }}
                  >
                    {clearing ? '撤销清除' : <Trash2 size={15} />}
                  </button>
                </div>
                <span className={styles.help}>Base URL 锁定：<a href={slot.baseUrl} target="_blank" rel="noreferrer">{slot.baseUrl}</a></span>
              </div>
            );
          })}
        </section>

        <div className={styles.footer}>
          <input ref={importInput} type="file" accept=".json,application/json" hidden onChange={(event) => void handleImport(event)} />
          <button type="button" className={adminStyles.actionBtn} onClick={() => importInput.current?.click()}><Upload size={14} />导入设置</button>
          <button type="button" className={adminStyles.actionBtn} onClick={() => void handleExport()}><Download size={14} />{busy === 'export' ? '正在导出...' : '导出设置'}</button>
          <button type="submit" className={adminStyles.primaryBtn}><Save size={14} />{busy === 'save' ? '正在保存...' : '保存'}</button>
        </div>
      </fieldset>

      {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? styles.error : styles.success}>{notice.message}</p>}
    </form>
  );
};
