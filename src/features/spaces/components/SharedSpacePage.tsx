import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Layers,
  Search,
  Users,
  Check,
} from 'lucide-react';
import styles from './SharedSpacePage.module.css';
import { MemberUser } from '../../auth/types/auth';
import { Asset, AssetType } from '../types/space';
import { spaceService } from '../services/spaceService';
import { ASSET_TYPE_ORDER, getTypeIcon, getTypeLabel } from '../constants/assetTypes';
import { AssetCard } from './AssetCard';
import { AssetDetailModal } from './AssetDetailModal';

interface SharedSpacePageProps {
  user: MemberUser;
  members: MemberUser[];
}

interface MemberGroup {
  ownerId: string;
  displayName: string;
  avatarInitials: string;
  avatarBgColor: string;
  assets: Asset[];
}

export const SharedSpacePage: React.FC<SharedSpacePageProps> = ({ user, members }) => {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<AssetType | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedOwners, setExpandedOwners] = useState<string[]>([]);
  const [viewingAsset, setViewingAsset] = useState<Asset | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2800);
  };

  const loadData = () => {
    spaceService
      .getSharedAssets()
      .then(setAssets)
      .catch((err: unknown) =>
        showToast(err instanceof Error ? err.message : '全员空间加载失败')
      );
  };

  useEffect(() => {
    loadData();
  }, []);

  const groups = useMemo<MemberGroup[]>(() => {
    const map = new Map<string, MemberGroup>();
    assets.forEach((asset) => {
      const existing = map.get(asset.ownerId);
      if (existing) {
        existing.assets.push(asset);
        return;
      }
      const member = members.find((m) => m.id === asset.ownerId);
      map.set(asset.ownerId, {
        ownerId: asset.ownerId,
        displayName: member?.displayName || asset.ownerName,
        avatarInitials: member?.avatarInitials || asset.avatarInitials,
        avatarBgColor: member?.avatarBgColor || asset.avatarBgColor,
        assets: [asset],
      });
    });
    return Array.from(map.values()).sort((a, b) => b.assets.length - a.assets.length);
  }, [assets, members]);

  const visibleAssets = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    return assets.filter((asset) => {
      if (selectedOwnerId && asset.ownerId !== selectedOwnerId) return false;
      if (selectedType && asset.type !== selectedType) return false;
      if (keyword) {
        const haystack = `${asset.title} ${asset.description} ${asset.ownerName}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
  }, [assets, selectedOwnerId, selectedType, searchQuery]);

  const toggleExpanded = (ownerId: string) => {
    setExpandedOwners((prev) =>
      prev.includes(ownerId) ? prev.filter((id) => id !== ownerId) : [...prev, ownerId]
    );
  };

  const selectMember = (ownerId: string) => {
    setSelectedOwnerId(ownerId);
    setSelectedType(null);
  };

  const selectType = (ownerId: string, type: AssetType) => {
    setSelectedOwnerId(ownerId);
    setSelectedType(type);
  };

  const selectRoot = () => {
    setSelectedOwnerId(null);
    setSelectedType(null);
  };

  const handleDelete = async (asset: Asset) => {
    if (!window.confirm(`确定要删除资产「${asset.title}」吗？此操作无法撤销。`)) return;
    const res = await spaceService.deleteAsset(asset.id);
    showToast(res.message);
    if (res.success) loadData();
  };

  const breadcrumb: string[] = ['全员空间'];
  if (selectedOwnerId) {
    const group = groups.find((g) => g.ownerId === selectedOwnerId);
    if (group) breadcrumb.push(group.displayName);
  }
  if (selectedType) breadcrumb.push(getTypeLabel(selectedType));

  return (
    <div className={styles.pageContainer}>
      {toastMessage && (
        <div className={styles.toast}>
          <Check size={16} />
          <span>{toastMessage}</span>
        </div>
      )}

      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderText}>
          <h2 className={styles.pageTitle}>
            <Users size={18} />
            全员空间
          </h2>
          <p className={styles.pageDesc}>
            全部成员共享的唯一资产空间，按「成员目录 → 类型」两级归类：图片、视频、音频等媒体资产与方案、提示词、工作流等文档资产集中沉淀。
          </p>
        </div>
      </div>

      <div className={styles.bodyLayout}>
        <aside className={styles.treePanel}>
          <div className={styles.treeHeader}>
            <Layers size={14} />
            <span>成员目录</span>
          </div>

          <button
            type="button"
            className={`${styles.treeRow} ${styles.rootRow} ${
              !selectedOwnerId && !selectedType ? styles.treeRowActive : ''
            }`}
            onClick={selectRoot}
          >
            <FolderOpen size={14} />
            <span className={styles.treeLabel}>全部成员</span>
            <span className={styles.treeCount}>{assets.length}</span>
          </button>

          {groups.map((group) => {
            const expanded = expandedOwners.includes(group.ownerId);
            const typeCounts = ASSET_TYPE_ORDER.map((type) => ({
              type,
              count: group.assets.filter((asset) => asset.type === type).length,
            })).filter((item) => item.count > 0);
            const memberActive = selectedOwnerId === group.ownerId;

            return (
              <div key={group.ownerId} className={styles.treeBranch}>
                <div className={styles.treeRowWrap}>
                  <button
                    type="button"
                    className={styles.expandBtn}
                    onClick={() => toggleExpanded(group.ownerId)}
                    title={expanded ? '收起' : '展开'}
                  >
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button
                    type="button"
                    className={`${styles.treeRow} ${styles.memberRow} ${
                      memberActive && !selectedType ? styles.treeRowActive : ''
                    }`}
                    onClick={() => selectMember(group.ownerId)}
                  >
                    <span
                      className={styles.treeAvatar}
                      style={{ background: group.avatarBgColor }}
                    >
                      {group.avatarInitials}
                    </span>
                    <span className={styles.treeLabel}>{group.displayName}</span>
                    <span className={styles.treeCount}>{group.assets.length}</span>
                  </button>
                </div>

                {expanded && (
                  <div className={styles.typeList}>
                    {typeCounts.map(({ type, count }) => (
                      <button
                        key={type}
                        type="button"
                        className={`${styles.treeRow} ${styles.typeRow} ${
                          memberActive && selectedType === type ? styles.treeRowActive : ''
                        }`}
                        onClick={() => selectType(group.ownerId, type)}
                      >
                        <span className={styles.typeIcon}>{getTypeIcon(type)}</span>
                        <span className={styles.treeLabel}>{getTypeLabel(type)}</span>
                        <span className={styles.treeCount}>{count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        <section className={styles.contentPanel}>
          <div className={styles.contentHeader}>
            <div className={styles.breadcrumb}>
              {breadcrumb.map((crumb, index) => (
                <React.Fragment key={crumb}>
                  {index > 0 && <span className={styles.crumbSep}>/</span>}
                  <span
                    className={`${styles.crumb} ${
                      index === breadcrumb.length - 1 ? styles.crumbCurrent : ''
                    }`}
                  >
                    {crumb}
                  </span>
                </React.Fragment>
              ))}
            </div>
            <div className={styles.searchBox}>
              <Search size={15} color="#64748b" />
              <input
                type="text"
                className={styles.searchInput}
                placeholder="在全员空间中搜索资产或成员..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {visibleAssets.length === 0 ? (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>
                <Layers size={24} />
              </div>
              <div className={styles.emptyTitle}>该目录下暂无资产</div>
              <div className={styles.emptyDesc}>
                可切换其他成员目录，或通过顶部「通过 DeepSeek Harness 智能生成」创作新内容。
              </div>
            </div>
          ) : (
            <div className={styles.assetGrid}>
              {visibleAssets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  isOwner={asset.ownerId === user.id}
                  canDelete={asset.ownerId === user.id || user.role === '群主'}
                  onView={setViewingAsset}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {viewingAsset && (
        <AssetDetailModal asset={viewingAsset} onClose={() => setViewingAsset(null)} />
      )}
    </div>
  );
};
