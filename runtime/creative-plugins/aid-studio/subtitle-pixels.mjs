/** Preserve the original timeline's pixel-size setting through local composition. */
export function patchSubtitlePixels(patch, java) {
  patch(java + '/compose/dto/ComposeGroupDto.java', '    private String subtitle;', `    private String subtitle;

    /** Server-derived timeline size in output pixels; not a new public group parameter. */
    @com.fasterxml.jackson.annotation.JsonIgnore
    private Integer subtitleFontSize;`);
  for (const name of ['ComposeGroup', 'ComposeTrackItem']) {
    const anchor = name === 'ComposeGroup' ? '    private String subtitle;' : '    private String subtitleText;';
    patch(java + '/compose/domain/' + name + '.java', anchor, anchor + `

    /** Timeline subtitle size in output pixels; null retains the configured legacy default. */
    private Integer subtitleFontSize;`);
  }
  const video = java + '/compose/service/impl/VideoComposeServiceImpl.java';
  patch(video, '        List<ComposeGroupDto> groups = request.getGroups();\n        // 本次请求携带的工程优先',
    '        List<ComposeGroupDto> groups = request.getGroups();\n        for (ComposeGroupDto group : groups) group.setSubtitleFontSize(null);\n        // 本次请求携带的工程优先');
  patch(video, `            if (Objects.isNull(subtitle)) {
                continue;
            }
            AidGenRecord selectedVideo`, `            if (Objects.isNull(subtitle)) {
                continue;
            }
            // Same pixel bounds as EpisodeTimelineServiceImpl.normalizeForSave.
            group.setSubtitleFontSize(subtitle.getFontSize() == null ? null
                    : Math.max(12, Math.min(120, subtitle.getFontSize())));
            AidGenRecord selectedVideo`);
  patch(video, '            group.setSubtitleCues(dto.getSubtitleCues());', `            group.setSubtitleCues(dto.getSubtitleCues());
            group.setSubtitleFontSize(dto.getSubtitleFontSize());`);
  patch(video, '            raw.append("|B:").append(normalizeFingerprintUrl(group.getBgmUrl()));', `            if (group.getSubtitleFontSize() != null && (StrUtil.isNotBlank(group.getSubtitle())
                    || CollectionUtil.isNotEmpty(group.getSubtitleCues()))) {
                raw.append("|SPX:").append(group.getSubtitleFontSize());
            }
            raw.append("|B:").append(normalizeFingerprintUrl(group.getBgmUrl()));`);
  const core = java + '/compose/service/impl/CoreComposeServiceImpl.java';
  patch(core, 'appendTimedSubtitleItems(tracks, group.getSubtitleCues(), cursor, segDur, subtitleMaxChars);',
    'appendTimedSubtitleItems(tracks, group.getSubtitleCues(), cursor, segDur, subtitleMaxChars, group.getSubtitleFontSize());');
  patch(core, 'appendSubtitleItems(tracks, group.getSubtitle(), cursor, segDur, segAudioDur, subtitleMaxChars);',
    'appendSubtitleItems(tracks, group.getSubtitle(), cursor, segDur, segAudioDur, subtitleMaxChars, group.getSubtitleFontSize());');
  patch(core, 'double segDuration, double voiceDuration, int maxChars) {',
    'double segDuration, double voiceDuration, int maxChars, Integer fontSize) {');
  patch(core, 'double segDuration, int maxChars) {',
    'double segDuration, int maxChars, Integer fontSize) {');
  for (const indent of ['            ', '                ']) {
    patch(core, '\n' + indent + 'item.setSubtitleText(screen);',
      '\n' + indent + 'item.setSubtitleText(screen);\n' + indent + 'item.setSubtitleFontSize(fontSize);');
  }
  const renderer = java + '/media/provider/impl/LocalFfmpegVideoProviderClient.java';
  patch(renderer, '.append("fontcolor=white:fontsize=").append(resolveSubtitleFontSize(config.getSubtitleFontSize()))',
    '.append("fontcolor=white:fontsize=").append(resolveSubtitleFontSize(item.getSubtitleFontSize(), config.getSubtitleFontSize()))');
  patch(renderer, '    private String resolveSubtitleFontSize(String configured)', `    private String resolveSubtitleFontSize(Integer pixels, String configured)
    {
        if (pixels == null) return resolveSubtitleFontSize(configured);
        if (pixels < 12 || pixels > 120) throw new IllegalArgumentException("字幕字号无效");
        return Integer.toString(pixels);
    }

    private String resolveSubtitleFontSize(String configured)`);
}
