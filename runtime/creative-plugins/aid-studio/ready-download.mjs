/** Expose the existing owner-checked attachment download without another export. */
export function patchReadyDownload(patch) {
  const base = 'frontend/web/components/create/';
  const hook = base + 'create-flow-shell/useCreateFlowPublishExport.ts';
  patch(hook, '  const currentExportStatus = useCreationStore((s) => s.currentExportStatus)',
    '  const currentExportStatus = useCreationStore((s) => s.currentExportStatus)\n  const currentEpisodeEditorId = useCreationStore((s) => s.currentEpisodeEditorId)');
  patch(hook, '  const saveExportedVideoToLocal = useCallback(async () => {',
    '  const saveExportedVideoToLocal = useCallback(async (currentEditorId?: number) => {');
  patch(hook, '    const editorId = Number(exportedEpisodeEditorIdRef.current ?? s.currentEpisodeEditorId)',
    '    const editorId = Number(currentEditorId ?? exportedEpisodeEditorIdRef.current ?? s.currentEpisodeEditorId)');
  patch(hook, "    const messageKey = 'export'\n    try {", `    const messageKey = currentEditorId === undefined ? 'export' :
      \`download-exported-video:\${s.currentProjectId}:\${s.currentEpisodeId}:\${editorId}\`
    const isCurrentDownloadScope = () => {
      const current = useCreationStore.getState()
      return currentEditorId === undefined || current.currentProjectId === s.currentProjectId &&
        current.currentEpisodeId === s.currentEpisodeId &&
        current.currentEpisodeEditorId === s.currentEpisodeEditorId
    }
    try {`);
  patch(hook, "      if (String(useCreationStore.getState().currentPendingVideoUrl || '').trim()) {",
    "      if (!isCurrentDownloadScope()) return\n      if (String(useCreationStore.getState().currentPendingVideoUrl || '').trim()) {");
  patch(hook, '      const err = e as { msg?: string; message?: string }',
    '      if (!isCurrentDownloadScope()) return\n      const err = e as { msg?: string; message?: string }');
  patch(hook, '      saveExportedLocalLoadingRef.current = false',
    '      if (!isCurrentDownloadScope()) message.destroy(messageKey)\n      saveExportedLocalLoadingRef.current = false');
  patch(hook, '  /** 导出完整视频：合成成功后不再弹窗，直接自动保存至本地 */', `  const downloadExportedVideoDisabled = currentExportStatus !== 2 ||
    !Number.isSafeInteger(currentEpisodeEditorId) || Number(currentEpisodeEditorId) <= 0 ||
    !(String(currentPendingVideoUrl || '').trim() || String(currentFinalVideoUrl || '').trim())

  /** Download only the current ready editor; never re-export or publish. */
  const onDownloadExportedVideo = useCallback(async () => {
    setExportMenuOpen(false)
    if (previewExportBusyRef.current || saveExportedLocalLoadingRef.current) return
    const current = useCreationStore.getState()
    const editorId = current.currentEpisodeEditorId
    if (current.currentExportStatus !== 2 || !Number.isSafeInteger(editorId) || Number(editorId) <= 0 ||
        !(String(current.currentPendingVideoUrl || '').trim() || String(current.currentFinalVideoUrl || '').trim())) {
      message.warning('暂无已导出的成片，请等待当前导出完成')
      return
    }
    // Capture this editor synchronously; a previous export's ref is not authority.
    await saveExportedVideoToLocal(Number(editorId))
  }, [saveExportedVideoToLocal])

  /** 导出完整视频：合成成功后不再弹窗，直接自动保存至本地 */`);
  patch(hook, '    onExportFullVideo,\n    onExportSegments,',
    '    onExportFullVideo,\n    onExportSegments,\n    onDownloadExportedVideo,\n    downloadExportedVideoDisabled,');
  const toolbar = base + 'create-flow-shell/CreateFlowToolbar.tsx';
  patch(toolbar, '  onExportSegments: () => void',
    '  onExportSegments: () => void\n  onDownloadExportedVideo: () => void\n  downloadExportedVideoDisabled: boolean');
  patch(toolbar, '        {props.isPreviewStep ? (\n          <Dropdown', `        {props.isPreviewStep ? (
          <Button
            size="large"
            className="toolbar-btn-draft"
            disabled={props.previewExportBusy || props.downloadExportedVideoDisabled}
            onClick={props.onDownloadExportedVideo}
          >
            下载已导出视频
          </Button>
        ) : null}
        {props.isPreviewStep ? (
          <Dropdown`);
  patch(base + 'CreateFlowShell.tsx', '            onExportSegments={() => void publishExport.onExportSegments()}',
    '            onExportSegments={() => void publishExport.onExportSegments()}\n            onDownloadExportedVideo={() => void publishExport.onDownloadExportedVideo()}\n            downloadExportedVideoDisabled={publishExport.downloadExportedVideoDisabled}');
}
