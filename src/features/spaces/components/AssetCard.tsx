import React from 'react';
import { Trash2, ExternalLink, User, Clock, Sparkles, UploadCloud } from 'lucide-react';
import styles from './AssetCard.module.css';
import { Asset } from '../types/space';
import { getTypeIcon, getTypeLabel } from '../constants/assetTypes';

interface AssetCardProps {
  asset: Asset;
  isOwner: boolean;
  canDelete: boolean;
  onView: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
}

export const AssetCard: React.FC<AssetCardProps> = ({
  asset,
  isOwner,
  canDelete,
  onView,
  onDelete,
}) => {
  return (
    <div className={styles.assetCard}>
      <div className={styles.cardTopRow}>
        <div className={styles.badgesLeft}>
          <span className={styles.typeBadge}>
            {getTypeIcon(asset.type)}
            <span style={{ marginLeft: 4 }}>{getTypeLabel(asset.type)}</span>
          </span>
          {asset.source === 'deepseek_harness' && (
            <span className={styles.harnessBadge}>
              <Sparkles size={11} />
              <span>DeepSeek Harness</span>
            </span>
          )}
          {asset.source === 'asset_service' && (
            <span className={styles.serviceBadge}>
              <UploadCloud size={11} />
              <span>资产微服务</span>
            </span>
          )}
        </div>
      </div>

      <h3 className={styles.cardTitle}>{asset.title}</h3>
      <p className={styles.cardDesc}>{asset.description}</p>

      {asset.mediaMeta?.fileUrl && (
        <>
          {asset.type === 'image' && (
            <div className={styles.cardMediaThumbnail}>
              <img
                src={asset.mediaMeta.thumbnailUrl || asset.mediaMeta.fileUrl}
                alt={asset.title}
                className={styles.cardMediaImage}
                loading="lazy"
              />
            </div>
          )}
          {asset.type === 'video' && (
            <div className={styles.cardMediaThumbnail}>
              <video
                src={asset.mediaMeta.fileUrl}
                className={styles.cardMediaVideo}
                controls
                preload="metadata"
              />
            </div>
          )}
          {asset.type === 'audio' && (
            <div className={styles.cardMediaAudioBox}>
              <audio
                src={asset.mediaMeta.fileUrl}
                controls
                style={{ width: '100%', height: '32px' }}
              />
            </div>
          )}
        </>
      )}

      <div className={styles.metaRow}>
        <div className={styles.authorBox}>
          <div className={styles.authorAvatar} style={{ background: asset.avatarBgColor }}>
            {asset.avatarInitials}
          </div>
          <span className={styles.authorName}>
            {asset.ownerName}
            {isOwner && ' (您)'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Clock size={11} />
          <span>
            {new Date(asset.createdAt).toLocaleDateString('zh-CN', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        </div>
      </div>

      <div className={styles.cardActions}>
        {!isOwner && (
          <div className={styles.contributed}>
            <User size={12} />
            <span>由 {asset.ownerName} 贡献</span>
          </div>
        )}

        <button
          type="button"
          className={styles.viewBtn}
          onClick={() => onView(asset)}
          title="查看资产内容与 DSH 调度元数据"
        >
          <span>详情</span>
          <ExternalLink size={12} />
        </button>

        {canDelete && (
          <button
            type="button"
            className={styles.deleteBtn}
            onClick={() => onDelete(asset)}
            title="删除资产"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
};
