import React, { useState } from 'react';
import {
  X,
  Copy,
  Check,
  Download,
  BrainCircuit,
  Wrench,
} from 'lucide-react';
import styles from './AssetCard.module.css';
import { Asset } from '../types/space';
import { getTypeLabel } from '../constants/assetTypes';

interface AssetDetailModalProps {
  asset: Asset;
  onClose: () => void;
}

export const AssetDetailModal: React.FC<AssetDetailModalProps> = ({
  asset,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyContent = () => {
    navigator.clipboard.writeText(asset.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={styles.detailModalOverlay} onClick={onClose}>
      <div className={styles.detailModalCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={styles.typeBadge}>{getTypeLabel(asset.type)}</span>
            </div>
            <h2 style={{ fontSize: '18px', color: '#f1f5f9', margin: '8px 0 4px 0' }}>
              {asset.title}
            </h2>
            <div style={{ fontSize: '13px', color: '#94a3b8' }}>{asset.description}</div>
          </div>
          <button type="button" className={styles.deleteBtn} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className={styles.detailBody}>
          {asset.mediaMeta?.fileUrl && (
            <div>
              <div className={styles.mediaDetailViewer}>
                {asset.type === 'image' && (
                  <img
                    src={asset.mediaMeta.fileUrl}
                    alt={asset.title}
                    style={{
                      maxWidth: '100%',
                      maxHeight: '420px',
                      objectFit: 'contain',
                      borderRadius: '6px',
                    }}
                  />
                )}
                {asset.type === 'video' && (
                  <video
                    src={asset.mediaMeta.fileUrl}
                    controls
                    style={{
                      width: '100%',
                      maxHeight: '440px',
                      borderRadius: '6px',
                    }}
                  />
                )}
                {asset.type === 'audio' && (
                  <audio
                    src={asset.mediaMeta.fileUrl}
                    controls
                    style={{ width: '100%' }}
                  />
                )}
                {asset.type !== 'image' &&
                  asset.type !== 'video' &&
                  asset.type !== 'audio' && (
                    <div style={{ color: '#94a3b8', fontSize: '13px', padding: 20 }}>
                      二进制或文档资产，点击下方按钮下载或外部查看
                    </div>
                  )}
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 10,
                  padding: '8px 12px',
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  borderRadius: '8px',
                  fontSize: '12px',
                  color: '#94a3b8',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                  <span>
                    文件名: <strong>{asset.mediaMeta.fileName}</strong>
                  </span>
                  <span>
                    大小: {(asset.mediaMeta.fileSize / 1024 / 1024).toFixed(2)} MB
                  </span>
                  {asset.mediaMeta.storageAssetId && (
                    <span style={{ color: '#38bdf8' }}>
                      统一资产ID: {asset.mediaMeta.storageAssetId}
                    </span>
                  )}
                </div>
                <a
                  href={asset.mediaMeta.fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  download={asset.mediaMeta.fileName}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    color: '#38bdf8',
                    textDecoration: 'none',
                    fontWeight: 600,
                  }}
                >
                  <Download size={13} />
                  <span>下载/打开源文件</span>
                </a>
              </div>
            </div>
          )}

          {asset.content && (
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 8,
                }}
              >
                <span style={{ fontSize: '13px', fontWeight: 600, color: '#cbd5e1' }}>
                  资产内容预览
                </span>
                <button
                  type="button"
                  className={styles.viewBtn}
                  onClick={handleCopyContent}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  <span>{copied ? '已复制' : '复制内容'}</span>
                </button>
              </div>
              <pre className={styles.contentBlock}>{asset.content}</pre>
            </div>
          )}

          {asset.generationMeta && (
            <div className={styles.metaInfoBox}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  color: '#10b981',
                  fontWeight: 600,
                }}
              >
                <BrainCircuit size={15} />
                <span>DeepSeek Harness 智能体调度元数据</span>
              </div>
              <div>
                <strong>调度模型：</strong> {asset.generationMeta.model}
              </div>
              <div>
                <strong>生成 Prompt：</strong> {asset.generationMeta.prompt}
              </div>
              {asset.generationMeta.toolCalls && (
                <div>
                  <strong>触发的 DSH 工具：</strong>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                    {asset.generationMeta.toolCalls.map((tc, idx) => (
                      <span
                        key={idx}
                        style={{
                          background: 'rgba(14,165,233,0.1)',
                          border: '1px solid rgba(14,165,233,0.3)',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          color: '#38bdf8',
                          fontSize: '11px',
                        }}
                      >
                        <Wrench size={10} style={{ display: 'inline', marginRight: 4 }} />
                        {tc.toolName}: {tc.resultSummary}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
