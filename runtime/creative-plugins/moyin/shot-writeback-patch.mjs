import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function patchManagedShotWriteback(root) {
  const path = join(root, 'src/components/panels/script/shot-list.tsx');
  let source = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const reactImport = 'import { useState, useCallback } from "react";';
  const stateAnchor = '  const [generatingShotId, setGeneratingShotId] = useState<string | null>(null);';
  if (!source.includes(reactImport) || !source.includes(stateAnchor)) throw new Error('魔因镜头 pending 状态适配位置已变化');
  source = source.replace(reactImport, 'import { useState, useCallback, useRef } from "react";');
  source = source.replace(stateAnchor, stateAnchor + `
  // UI-only ownership: never persist pending flags in the full native project.
  const greenroomPending = useRef(new Map<string, symbol>());
  const [greenroomPendingKeys, setGreenroomPendingKeys] = useState<Set<string>>(() => new Set());
  const greenroomPendingKey = (id: string) => JSON.stringify([projectId, id]);
  const greenroomClaimShots = (ids: string[]) => {
    if (!(globalThis as any).greenroomCatalog) return () => {};
    const keys = ids.map(greenroomPendingKey);
    if (keys.some(key => greenroomPending.current.has(key))) return null;
    const owner = Symbol();
    for (const key of keys) greenroomPending.current.set(key, owner);
    setGreenroomPendingKeys(new Set(greenroomPending.current.keys()));
    return () => {
      for (const key of keys) if (greenroomPending.current.get(key) === owner) greenroomPending.current.delete(key);
      setGreenroomPendingKeys(new Set(greenroomPending.current.keys()));
    };
  };`);
  const start = source.indexOf('  // Handle single shot image generation');
  const end = source.indexOf('  // Handle character variation change');
  if (start < 0 || end < start) throw new Error('魔因镜头生成 UI 适配位置已变化');
  let handlers = source.slice(start, end);
  // Completion, failure and progress all persist the entire native script store.
  // The managed server is the sole writer for generated shot selection. Manual
  // edits below these handlers keep their original updateShot implementation.
  if ((handlers.match(/\bupdateShot\(/g) || []).length !== 11 || (handlers.match(/\bsetBatchProgress\(/g) || []).length !== 4) throw new Error('魔因镜头生成 UI 回写数量已变化');
  if ((handlers.match(/\n\s+apiKey,/g) || []).length !== 3) throw new Error('魔因镜头项目绑定适配位置已变化');
  handlers = handlers.replace(/(\n\s+)apiKey,/g, '$1greenroomProjectId: projectId,$1apiKey,');
  handlers = handlers.replace(/\b(updateShot|setBatchProgress)\(/g, 'if (!(globalThis as any).greenroomCatalog) $1(');
  if ((handlers.match(/    setGeneratingShotId\(shot.id\);/g) || []).length !== 2 || (handlers.match(/      setGeneratingShotId\(null\);/g) || []).length !== 2) throw new Error('魔因镜头 pending 生命周期适配位置已变化');
  handlers = handlers.replaceAll('    setGeneratingShotId(shot.id);', '    const releasePending = greenroomClaimShots([shot.id]);\n    if (!releasePending) return;\n    setGeneratingShotId(shot.id);');
  handlers = handlers.replaceAll('      setGeneratingShotId(null);', '      releasePending();\n      setGeneratingShotId(null);');
  const batchStart = handlers.indexOf('  // Handle batch image generation');
  if (batchStart < 0) throw new Error('魔因批量 pending 生命周期适配位置已变化');
  let batch = handlers.slice(batchStart);
  const batchFilter = "const pendingShots = shots.filter(s => s.imageStatus !== 'completed');";
  const batchEmpty = "toast.info('所有镜头已生成图片');";
  const batchBegin = '    setIsGenerating(true);';
  const batchStop = '    setIsGenerating(false);';
  const batchEnd = '    toast.success(`批量生成完成: ${completed}/${pendingShots.length}`);';
  // Validate both ends before editing either. The pinned native file has a
  // blank line after setIsGenerating(true); do not depend on adjacent lines.
  for (const anchor of [batchFilter, batchEmpty, batchBegin, batchStop, batchEnd]) {
    if (batch.split(anchor).length !== 2) throw new Error('魔因批量 pending 生命周期适配位置已变化');
  }
  if (!(batch.indexOf(batchBegin) < batch.indexOf(batchStop) && batch.indexOf(batchStop) < batch.indexOf(batchEnd))) throw new Error('魔因批量 pending 生命周期顺序已变化');
  batch = batch.replace(batchFilter, "const pendingShots = shots.filter(s => s.imageStatus !== 'completed' && (!(globalThis as any).greenroomCatalog || !greenroomPending.current.has(greenroomPendingKey(s.id))));");
  batch = batch.replace(batchEmpty, "toast.info((globalThis as any).greenroomCatalog && shots.some(s => s.imageStatus !== 'completed') ? '镜头已有生成任务，请查看后台任务' : '所有镜头已生成图片');");
  batch = batch.replace(batchBegin, '    const releasePending = greenroomClaimShots(pendingShots.map(shot => shot.id));\n    if (!releasePending) return;\n    setIsGenerating(true);\n    try {');
  batch = batch.replace(batchStop, '');
  batch = batch.replace(batchEnd, batchEnd + '\n    } finally { releasePending(); setIsGenerating(false); }');
  handlers = handlers.slice(0, batchStart) + batch;
  const rendering = source.slice(end).replace('isGenerating={generatingShotId === shot.id}', 'isGenerating={(globalThis as any).greenroomCatalog ? greenroomPendingKeys.has(greenroomPendingKey(shot.id)) : generatingShotId === shot.id}');
  if (rendering === source.slice(end)) throw new Error('魔因镜头 pending 展示适配位置已变化');
  writeFileSync(path, source.slice(0, start) + handlers + rendering);

  // Record script reads only when the native merge adopts them. A shot refresh
  // retains its additional project/edit guard; ordinary hydration keeps its
  // original merge behavior while establishing a fresh renderer generation.
  const storagePath = join(root, 'src/lib/project-storage.ts');
  let storage = readFileSync(storagePath, 'utf8').replaceAll('\r\n', '\n');
  const sectionStart = storage.indexOf('export function createProjectScopedStorage(');
  const sectionEnd = storage.indexOf('// ==================== Split Storage', sectionStart);
  if (sectionStart < 0 || sectionEnd < sectionStart) throw new Error('魔因项目存储适配位置已变化');
  let section = storage.slice(sectionStart, sectionEnd);
  const getItem = '    getItem: async (name: string): Promise<string | null> => {';
  if (!section.includes(getItem) || (section.match(/return fileStorage.getItem\(name\);/g) || []).length !== 2 || !section.includes('return projectData;')) throw new Error('魔因项目读取适配位置已变化');
  section = section.replace(getItem, getItem + `
      const refresh = storeName === 'script' ? ((globalThis as any).greenroomShotReadOnlyRefresh || (globalThis as any).greenroomBeginScriptRead?.()) : undefined;
      const refreshId = refresh?.id;
      const greenroomRead = (key: string) => refreshId ? (window as any).fileStorage.getItem(key, refreshId) : fileStorage.getItem(key);
      const readResult = async (value: string | null | Promise<string | null>) => {
        try {
          const raw = await value;
          if (!raw || !refreshId) { if (refresh?.ordinary) refresh.cancel(); return raw; }
          const parsed = JSON.parse(raw);
          const state = parsed.state ?? parsed;
          state.__greenroomShotRefresh = refreshId;
          return JSON.stringify(parsed);
        } catch (error) { if (refresh?.ordinary) refresh.cancel(); throw error; }
      };`);
  section = section.replaceAll('return fileStorage.getItem(name);', 'return readResult(greenroomRead(name));').replace('const projectData = await fileStorage.getItem(projectKey);', 'let projectData;\n      try { projectData = await greenroomRead(projectKey); } catch (error) { if (refresh?.ordinary) refresh.cancel(); throw error; }').replace('return projectData;', 'return readResult(projectData);');
  writeFileSync(storagePath, storage.slice(0, sectionStart) + section + storage.slice(sectionEnd));

  const storePath = join(root, 'src/stores/script-store.ts');
  let store = readFileSync(storePath, 'utf8').replaceAll('\r\n', '\n');
  const merge = '      merge: (persisted: any, current: any) => {';
  if (!store.includes(merge)) throw new Error('魔因镜头刷新合并位置已变化');
  store = store.replace(merge, merge + `
        if (persisted?.__greenroomShotRefresh) {
          const { __greenroomShotRefresh: id, ...data } = persisted;
          persisted = data;
          const refresh = (globalThis as any).greenroomShotRefreshes?.get(id);
          if (!refresh?.isCurrent(current.activeProjectId)) { refresh?.cancel?.(); return current; }
          refresh.accept();
        }`);
  const anchor = '      onRehydrateStorage: () => (state, error) => {';
  const startCallback = store.indexOf(anchor);
  const endCallback = store.indexOf('        });\n      },', startCallback);
  if (startCallback < 0 || endCallback < startCallback) throw new Error('魔因镜头只读刷新适配位置已变化');
  let callback = store.slice(startCallback, endCallback + '        });\n      },'.length);
  callback = callback.replace(anchor, `      onRehydrateStorage: () => {
        const refresh = (globalThis as any).greenroomShotReadOnlyRefresh;
        return (state, error) => {
        if (refresh) return;`).replace('        });\n      },', '        });\n        };\n      },');
  writeFileSync(storePath, store.slice(0, startCallback) + callback + store.slice(endCallback + '        });\n      },'.length));
}
