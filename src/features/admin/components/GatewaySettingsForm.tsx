import { useState } from 'react';
import styles from './AdminManagementPanel.module.css';

export function GatewaySettingsForm({ baseUrl, onSaved }: { baseUrl: string; onSaved: () => Promise<void> }) {
  const [url, setUrl] = useState(baseUrl);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  async function save(reset = false) {
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch('/api/admin/gateway-settings', {
        method: reset ? 'DELETE' : 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        ...(reset ? {} : { body: JSON.stringify({ baseUrl: url, apiKey: key }) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || '保存网关失败');
      setKey('');
      setUrl(data.baseUrl);
      setNotice(reset ? '已恢复环境变量配置。' : '已保存；后续请求使用新配置，连接与模型可用性以目录检查为准。');
      await onSaved();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '保存网关失败');
    } finally { setBusy(false); }
  }
  return <form style={{ display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={event => { event.preventDefault(); void save(); }}>
    <p>填写模型网关地址和服务端密钥。留空密钥可保留当前密钥。提交过任务后，网关地址绑定到原来的任务和账单。</p>
    <label className={styles.formLabel}>网关地址<input className={styles.formInput} type="url" aria-label="网关地址" value={url} disabled={busy} onChange={event => setUrl(event.target.value)} placeholder="https://gateway.example/v1" required /></label>
    <label className={styles.formLabel}>新 API Key<input className={styles.formInput} aria-label="网关新 API Key" type="password" autoComplete="new-password" value={key} disabled={busy} onChange={event => setKey(event.target.value)} placeholder="留空保留当前密钥" /></label>
    <div className={styles.gatewayActions}>
      <button className={styles.primaryBtn} type="submit" disabled={busy}>保存主网关</button>
      <button className={styles.actionBtn} type="button" disabled={busy} onClick={() => void save(true)}>恢复环境配置</button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </form>;
}
