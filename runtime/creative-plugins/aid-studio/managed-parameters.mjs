// Fixed-source patches: keep all native ownership, agent/model pools and declared parameter guards.
export function patchManagedParameters(patch, java) {
  const resolver = java + '/projectgenconfig/service/impl/ProjectGenConfigResolverImpl.java';
  patch(resolver, '        boolean aspectRatioExplicit = StrUtil.isNotBlank(aspectRatio);', `        boolean aspectRatioExplicit = StrUtil.isNotBlank(aspectRatio);
        boolean resolutionFromProject = false;
        boolean aspectRatioFromProject = false;`);
  patch(resolver, '                    resolution = StrUtil.trim(saved.getResolution());', `                    resolution = StrUtil.trim(saved.getResolution());
                    resolutionFromProject = StrUtil.isNotBlank(resolution);`);
  patch(resolver, '                    aspectRatio = StrUtil.trim(saved.getAspectRatio());', `                    aspectRatio = StrUtil.trim(saved.getAspectRatio());
                    aspectRatioFromProject = StrUtil.isNotBlank(aspectRatio);`);
  patch(resolver, '            boolean supportsAspectRatio = Boolean.TRUE.equals(modelConfig.getSupportsAspectRatio());', `            boolean omitSize = com.aid.greenroom.GreenroomModelParameters.undeclaredImage(modelConfig,
                    scene.getCapabilityScene(), "sizeOptions", "defaultSize");
            boolean omitRatio = com.aid.greenroom.GreenroomModelParameters.undeclaredImage(modelConfig,
                    scene.getCapabilityScene(), "aspectRatioOptions", "defaultAspectRatio");
            if (omitSize && (resolutionExplicit || resolutionFromProject)) throw new ServiceException("清晰度不支持");
            if (omitRatio && (aspectRatioExplicit || aspectRatioFromProject)) throw new ServiceException("画面比例不支持");
            if (omitSize) resolution = null;
            if (omitRatio) aspectRatio = null;
            boolean supportsAspectRatio = !omitRatio && Boolean.TRUE.equals(modelConfig.getSupportsAspectRatio());`);
  patch(resolver, '            if (!resolutionExplicit)\n            {\n                resolution = ModelCapabilityResolver.coerceImageSceneSize(', '            if (!resolutionExplicit && !omitSize)\n            {\n                resolution = ModelCapabilityResolver.coerceImageSceneSize(');
  patch(resolver, '            if (scene.isNeedResolution() && StrUtil.isBlank(resolution))\n            {\n                log.error', '            if (scene.isNeedResolution() && !omitSize && StrUtil.isBlank(resolution))\n            {\n                log.error');
  patch(resolver, 'if (scene.isNeedResolution() && !optionHit(resolution, sizeOptions))', 'if (scene.isNeedResolution() && !omitSize && !optionHit(resolution, sizeOptions))');

  const project = java + '/projectgenconfig/service/impl/ProjectGenConfigServiceImpl.java';
  patch(project, '        if (scene.isNeedResolution())\n        {\n            vo.setResolution', `        boolean managedDefault = SOURCE_DEFAULT.equals(vo.getSource());
        boolean omitSize = managedDefault && com.aid.greenroom.GreenroomModelParameters.undeclaredImage(modelConfig,
                scene.getCapabilityScene(), "sizeOptions", "defaultSize");
        boolean omitRatio = managedDefault && com.aid.greenroom.GreenroomModelParameters.undeclaredImage(modelConfig,
                scene.getCapabilityScene(), "aspectRatioOptions", "defaultAspectRatio");
        if (omitSize) vo.setResolution(null);
        if (omitRatio) vo.setAspectRatio(null);
        if (scene.isNeedResolution() && !omitSize)
        {
            vo.setResolution`);
  patch(project, 'if (scene.isNeedAspectRatio() && Boolean.TRUE.equals(modelConfig.getSupportsAspectRatio()))\n        {\n            vo.setAspectRatio', 'if (scene.isNeedAspectRatio() && !omitRatio && Boolean.TRUE.equals(modelConfig.getSupportsAspectRatio()))\n        {\n            vo.setAspectRatio');

  const business = java + '/model/service/impl/AiModelBusinessServiceImpl.java';
  patch(business, '        Map<Long, String> providerNameMap = providers.stream()', `        Map<Long, String> providerCodeMap = providers.stream()
                .collect(Collectors.toMap(AidAiProvider::getId, AidAiProvider::getProviderCode));
        Map<Long, String> providerNameMap = providers.stream()`);
  for (const call of ['result.add(buildModelVo(model,', 'AiModelVO item = buildModelVo(projected,']) {
    patch(business, call + '\n                    providerNameMap.get(model.getProviderId()),', call + '\n                    providerCodeMap.get(model.getProviderId()), providerNameMap.get(model.getProviderId()),');
  }
  patch(business, 'private AiModelVO buildModelVo(AidAiModel model, String providerName, String providerLogo, BigDecimal globalFactor)', 'private AiModelVO buildModelVo(AidAiModel model, String providerCode, String providerName, String providerLogo, BigDecimal globalFactor)');
  patch(business, '        normalizeCapabilityForDisplay(vo);', '        normalizeCapabilityForDisplay(vo);\n        com.aid.greenroom.GreenroomModelParameters.clearDisplay(vo, model, providerCode);');
}
