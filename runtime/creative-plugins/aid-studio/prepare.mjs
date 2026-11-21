import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { patchManagedParameters } from './managed-parameters.mjs';
import { patchManagedDownload } from './managed-download.mjs';
import { patchSubtitlePixels } from './subtitle-pixels.mjs';
import { patchClientApiUrl } from './client-api-url.mjs';
import { patchReadyDownload } from './ready-download.mjs';
const root = resolve(process.argv[2]);
const patch = (file, before, after) => {
  const path = join(root, file), source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`AID integration target changed: ${file}`);
  writeFileSync(path, source.replaceAll(before, after));
};
const java = 'aid-interface/aid-interface-main/src/main/java/com/aid';
mkdirSync(join(root, java, 'greenroom'), { recursive: true });
for (const file of ['GreenroomQueue.java', 'GreenroomImageProvider.java', 'GreenroomVideoProvider.java', 'GreenroomTextProvider.java', 'GreenroomAudioProvider.java', 'GreenroomCompose.java', 'GreenroomModelParameters.java']) {
  cpSync(new URL(file, import.meta.url), join(root, java, 'greenroom', file));
}
patchManagedParameters(patch, java);
patchManagedDownload(patch, java);
patchSubtitlePixels(patch, java);
patchReadyDownload(patch);
const controller = join(root, 'aid-business/aid-business-main/src/main/java/com/aid/greenroom/GreenroomController.java');
mkdirSync(dirname(controller), { recursive: true });
cpSync(new URL('GreenroomController.java', import.meta.url), controller);
const filter = 'aid-business/aid-business-framework/src/main/java/com/aid/framework/security/filter';
cpSync(new URL('GreenroomIdentity.java', import.meta.url), join(root, filter, 'GreenroomIdentity.java'));
patch(filter + '/JwtAuthenticationTokenFilter.java', '    private TokenService tokenService;', '    private TokenService tokenService;\n    @Autowired private GreenroomIdentity greenroomIdentity;');
patch(filter + '/JwtAuthenticationTokenFilter.java', 'LoginUser loginUser = tokenService.getLoginUser(request);',
  'boolean managed = "true".equals(System.getenv("GREENROOM_MANAGED"));\n        LoginUser loginUser = managed ? greenroomIdentity.resolve(request) : tokenService.getLoginUser(request);');
patch(filter + '/JwtAuthenticationTokenFilter.java', '            tokenService.verifyToken(loginUser);', '            if (!managed) tokenService.verifyToken(loginUser);');
for (const name of ['Image', 'Video', 'Text', 'Audio']) {
  patch(java + `/media/dto/Media${name}GenerateRequest.java`, `public class Media${name}GenerateRequest {`,
    `public class Media${name}GenerateRequest {\n    @com.fasterxml.jackson.annotation.JsonIgnore\n    private String greenroomSubmissionId;`);
}
const generation = java + '/media/service/impl/MediaGenerationServiceImpl.java';
patch(generation, 'submitResult = client.submit(modelConfig, imgReq);', 'imgReq.setGreenroomSubmissionId("aid:" + task.getId());\n                imgReq.setUserId(task.getUserId());\n                submitResult = client.submit(modelConfig, imgReq);');
patch(generation, 'submitResult = client.submit(modelConfig, vidReq);', 'vidReq.setGreenroomSubmissionId("aid:" + task.getId());\n                vidReq.setUserId(task.getUserId());\n                submitResult = client.submit(modelConfig, vidReq);');
patch(generation, 'submitResult = useNonStream', 'textReq.setGreenroomSubmissionId("aid:" + task.getId());\n                textReq.setUserId(task.getUserId());\n                submitResult = useNonStream');
patch(generation, 'submitResult = audioClient.submit(modelConfig, audioReq);', 'audioReq.setGreenroomSubmissionId("aid:" + task.getId());\n                submitResult = audioClient.submit(modelConfig, audioReq);');
patch(generation, '            client.streamChat(modelConfig, request, new TextStreamCallbacks() {', '            request.setGreenroomSubmissionId("aid:" + task.getId());\n            client.streamChat(modelConfig, request, new TextStreamCallbacks() {');
// In managed mode assets stay in the member broker. No shared-service fetch of
// an expiring or private member URL is needed before the owning adapter submits it.
let source = readFileSync(join(root, generation), 'utf8');
source = source.replace(/^(\s*)modelOutboundResourcePreparer\.prepare\(([^;]+)\);/gm,
  '$1if (!"true".equals(System.getenv("GREENROOM_MANAGED"))) modelOutboundResourcePreparer.prepare($2);');
writeFileSync(join(root, generation), source);
const modelBusiness = java + '/model/service/impl/AiModelBusinessServiceImpl.java';
patch(modelBusiness, 'public class AiModelBusinessServiceImpl implements IAiModelBusinessService\n{', 'public class AiModelBusinessServiceImpl implements IAiModelBusinessService\n{\n    @org.springframework.beans.factory.annotation.Autowired private com.aid.greenroom.GreenroomQueue greenroomQueue;');
patch(modelBusiness, '        return result;', '        return greenroomQueue.filterModels(result);');
patch(java + '/model/util/AiModelClientDisplaySorter.java', '        List<AiModelVO> sorted = models == null ? new ArrayList<>() : new ArrayList<>(models);', '        List<AiModelVO> sorted = models == null ? new ArrayList<>() : new ArrayList<>(models);\n        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) return sorted;');
patch(java + '/model/util/AiModelClientDisplaySorter.java', '            copy.setModels(sortedModels(source.getModels()));', '            copy.setModels(sortedModels(source.getModels()));\n            if ("true".equals(System.getenv("GREENROOM_MANAGED")) && !copy.getModels().isEmpty()) copy.setDefaultModelCode(copy.getModels().get(0).getModelCode());');
const modelConfig = java + '/service/impl/AiModelConfigServiceImpl.java';
patch(modelConfig, '    private Long getCurrentUserIdSafe() {', '    private Long getCurrentUserIdSafe() {\n        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) { try { return com.aid.common.utils.SecurityUtils.getUserId(); } catch (RuntimeException error) { return null; } }');
patch(modelConfig, '    public AiModelConfigVo selectByCategoryWithHighestPriority(String category) {', `    public AiModelConfigVo selectByCategoryWithHighestPriority(String category) {
        if ("true".equals(System.getenv("GREENROOM_MANAGED")) && getCurrentUserIdSafe()!=null) {
            Long id=com.aid.common.utils.spring.SpringUtils.getBean(com.aid.greenroom.GreenroomQueue.class).defaultModel(category,getCurrentUserIdSafe());
            return id==null?null:buildConfigVo(aidAiModelService.getById(id));
        }`);
patch(modelConfig, '    private AiModelConfigVo buildConfigVo(AidAiModel model, Long userId, boolean existingTask) {', `    private AiModelConfigVo buildConfigVo(AidAiModel model, Long userId, boolean existingTask) {
        if ("true".equals(System.getenv("GREENROOM_MANAGED")) && model!=null && userId!=null && !existingTask)
            com.aid.common.utils.spring.SpringUtils.getBean(com.aid.greenroom.GreenroomQueue.class).requireModel(model.getId(),userId);`);
patch(java + '/storyboard/video/impl/ConfigurableAsyncVideoReferenceStrategy.java', '        return modelConfig != null', '        if (modelConfig!=null && "greenroom-video".equals(modelConfig.getProtocol())) return true;\n        return modelConfig != null');
const completion = java + '/media/service/impl/TaskCompletionServiceImpl.java';
patch(completion, 'casWrapper.set(AidMediaTask::getOriginUrl, taskResult.getResultUrl());',
  'casWrapper.set(AidMediaTask::getOriginUrl, taskResult.getResultUrl());\n            if (task.getProtocol() != null && task.getProtocol().startsWith("greenroom-")) casWrapper.set(AidMediaTask::getOssUrl, taskResult.getResultUrl());');
patch(completion, 'persistResultManifest(task, normalizeResultUrls(taskResult), userStr);',
  `persistResultManifest(task, normalizeResultUrls(taskResult), userStr);
                if (task.getProtocol() != null && task.getProtocol().startsWith("greenroom-")) {
                    java.util.List<String> managedUrls = normalizeResultUrls(taskResult);
                    for (int resultIndex = 0; resultIndex < managedUrls.size(); resultIndex++) {
                        LambdaUpdateWrapper<AidMediaResult> managedUpdate = new LambdaUpdateWrapper<>();
                        managedUpdate.eq(AidMediaResult::getTaskId, task.getId()).eq(AidMediaResult::getResultIndex, resultIndex);
                        managedUpdate.set(AidMediaResult::getOssUrl, managedUrls.get(resultIndex));
                        aidMediaResultMapper.update(null, managedUpdate);
                    }
                }`);
const localRenderer = java + '/media/provider/impl/LocalFfmpegVideoProviderClient.java';
patch(localRenderer, '        Path output = null;', `        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) {
            ComposeJobPlan plan = readPlan(request);
            AidMediaTask task = taskMapper.selectById(plan.getTaskId());
            String id = com.aid.common.utils.spring.SpringUtils.getBean(com.aid.greenroom.GreenroomQueue.class)
                .submit("aid:" + plan.getTaskId(), "compose", task.getUserId(), Map.of("composePlan", JSON.parseObject(JSON.toJSONString(plan))));
            return ProviderSubmitResult.builder().providerTaskId(id).build();
        }
        Path output = null;`);
patch(localRenderer, '        // 本地任务在 submit 内以退出码 + ffprobe 同步确认终态；若进程重启未收口，由 PENDING 看门狗重新排队。', `        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) return com.aid.common.utils.spring.SpringUtils.getBean(com.aid.greenroom.GreenroomQueue.class).query(providerTaskId);
        // 本地任务在 submit 内以退出码 + ffprobe 同步确认终态；若进程重启未收口，由 PENDING 看门狗重新排队。`);
patch(localRenderer, '    private ComposeJobPlan readPlan(MediaVideoGenerateRequest request)', `    public double probeManagedInputDuration(String input) throws Exception {
        return probeInputDuration(configManager.getMpsProperties(), input);
    }

    public void renderManaged(ComposeJobPlan plan, Path output) throws Exception {
        MpsProperties config = configManager.getMpsProperties();
        ProcessResult result = run(buildCommand(config, plan, output), config.getFfmpegTimeoutSeconds());
        if (result.exitCode() != 0) throw new IOException(abbreviate(result.output()));
        if (!Files.isRegularFile(output) || Files.size(output) <= 0 || probeDuration(config, output) <= 0) throw new IOException("FFmpeg 未生成有效成片");
    }

    private ComposeJobPlan readPlan(MediaVideoGenerateRequest request)`);
const episodeExport = java + '/compose/dto/EpisodeExportRequest.java';
patch(episodeExport, 'public class EpisodeExportRequest {', `public class EpisodeExportRequest {
    @io.swagger.v3.oas.annotations.media.Schema(hidden = true)
    @com.fasterxml.jackson.annotation.JsonProperty(value = "_greenroomVideoProbeUrls", access = com.fasterxml.jackson.annotation.JsonProperty.Access.WRITE_ONLY)
    private java.util.Map<String, String> greenroomVideoProbeUrls;`);
const videoCompose = java + '/compose/service/impl/VideoComposeServiceImpl.java';
patch(videoCompose, 'request.getGroups(), freshEditor, userId);',
  'request.getGroups(), freshEditor, userId, request.getGreenroomVideoProbeUrls());');
patch(videoCompose, 'AidEpisodeEditor editor, Long userId) {\n        Set<Long> storyboardIds = new LinkedHashSet<>();',
  'AidEpisodeEditor editor, Long userId, Map<String, String> greenroomVideoProbeUrls) {\n        Set<Long> storyboardIds = new LinkedHashSet<>();');
patch(videoCompose, `            if (Objects.isNull(selected.getVideoDuration()) || selected.getVideoDuration() <= 0) {
                log.error("接口2 当前分镜视频时长无效, storyboardId={}, recordId={}",
                        group.getStoryboardId(), selected.getId());
                throw new ServiceException("视频时长有误");
            }
            String selectedUrl = mediaUrlResolver.toFullUrl(selected.getFileUrl());
            boolean videoChanged = !Objects.equals(normalizeFingerprintUrl(group.getVideoUrls().get(0)),
                    normalizeFingerprintUrl(selectedUrl));`, `            String selectedUrl = mediaUrlResolver.toFullUrl(selected.getFileUrl());
            boolean videoChanged = !Objects.equals(normalizeFingerprintUrl(group.getVideoUrls().get(0)),
                    normalizeFingerprintUrl(selectedUrl));
            if (Objects.isNull(selected.getVideoDuration()) || selected.getVideoDuration() <= 0) {
                String probeUrl = greenroomVideoProbeUrls == null ? null : greenroomVideoProbeUrls.get(selected.getFileUrl());
                if (!"true".equals(System.getenv("GREENROOM_MANAGED")) || videoChanged || probeUrl == null) {
                    throw new ServiceException("视频时长有误");
                }
                long seconds;
                try {
                    seconds = (long) Math.ceil(com.aid.common.utils.spring.SpringUtils
                            .getBean(com.aid.media.provider.impl.LocalFfmpegVideoProviderClient.class)
                            .probeManagedInputDuration(probeUrl));
                } catch (Exception error) {
                    throw new ServiceException("视频时长读取失败");
                }
                int updated = aidGenRecordMapper.update(null, Wrappers.<AidGenRecord>lambdaUpdate()
                        .eq(AidGenRecord::getId, selected.getId())
                        .eq(AidGenRecord::getStoryboardId, group.getStoryboardId())
                        .eq(AidGenRecord::getUserId, userId)
                        .eq(AidGenRecord::getFileUrl, selected.getFileUrl())
                        .eq(AidGenRecord::getStatus, 1)
                        .eq(AidGenRecord::getDelFlag, "0")
                        .and(w -> w.isNull(AidGenRecord::getVideoDuration).or().le(AidGenRecord::getVideoDuration, 0))
                        .set(AidGenRecord::getVideoDuration, seconds));
                if (updated != 1) throw new ServiceException("视频时长有误");
                selected.setVideoDuration(seconds);
            }`);
patch(java + '/compose/config/MpsConfigManager.java', '    public MpsProperties getMpsProperties() {', `    public MpsProperties getMpsProperties() {
        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) {
            MpsProperties managed = new MpsProperties(); managed.setEnabled(true); managed.setProcessMode(MODE_LOCAL_FFMPEG);
            managed.setFfmpegPath("/usr/bin/ffmpeg"); managed.setFfprobePath("/usr/bin/ffprobe");
            managed.setFfmpegFontFile("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"); return managed;
        }`);
patch(java + '/compose/config/MpsConfigManager.java', '    public boolean isConfigured() {', '    public boolean isConfigured() {\n        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) return true;');
patch('aid-common/src/main/java/com/aid/common/aid/oss/config/OssConfigManager.java', '    public OssProperties getOssProperties()\n    {', `    public OssProperties getOssProperties()
    {
        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) {
            OssProperties managed = new OssProperties(); managed.setEnabled(true); managed.setUploadMode("local");
            managed.setResourceAccessDomain("http://127.0.0.1:18807"); return managed;
        }`);
patch('aid-common/src/main/java/com/aid/common/aid/oss/util/MediaUrlResolver.java', '        String lower = path.toLowerCase();', '        if (path.startsWith("/creative-managed/media/")) return path;\n        String lower = path.toLowerCase();');
patch(java + '/compose/service/impl/CoreComposeServiceImpl.java', '        normalizeCommandUrls(command);', '        if (!"true".equals(System.getenv("GREENROOM_MANAGED"))) normalizeCommandUrls(command);');
patch(java + '/compose/service/impl/ComposeBillingServiceImpl.java', '    public BigDecimal resolveUnitPrice(String tier) {', '    public BigDecimal resolveUnitPrice(String tier) {\n        if ("true".equals(System.getenv("GREENROOM_MANAGED"))) return BigDecimal.ZERO;');
patch(java + '/media/service/impl/MinimaxMusicGenerationService.java', '!MODELS.contains(input.getModelCode())', '(!"true".equals(System.getenv("GREENROOM_MANAGED")) && !MODELS.contains(input.getModelCode()))');
patch(java + '/compose/service/impl/VoicePreviewServiceImpl.java', '                log.info("试听上游失败, providerTaskId={}, err={}", providerTaskId, result.getErrorMessage());\n                throw new RuntimeException("试听失败");', '                log.info("试听上游失败, providerTaskId={}, err={}", providerTaskId, result.getErrorMessage());\n                throw new RuntimeException(java.util.Objects.toString(result.getErrorMessage(), "服务商未返回具体失败原因"));');
patch(java + '/compose/service/impl/VoicePreviewServiceImpl.java', '        throw new RuntimeException("试听超时");', '        throw new RuntimeException("试听查询达到上限，保留原任务编号 " + providerTaskId);');
patch('frontend/web/next.config.ts', 'const nextConfig: NextConfig = {', "const nextConfig: NextConfig = {\n  basePath: '/plugins/aid-studio',");
patch('frontend/web/next.config.ts', "'http://127.0.0.1:8080'", "'http://127.0.0.1:18827'");
// Standalone output is only valid for the development/Node runtime branch; the
// static export branch keeps its own output, so the patch stays inside it.
patch('frontend/web/next.config.ts', "        /** 开发/Node 运行时：请求走 `/url` 前缀由 Next 代理转发到后端。 */\n        async rewrites() {",
  "        /** 开发/Node 运行时：请求走 `/url` 前缀由 Next 代理转发到后端。 */\n        output: 'standalone',\n        async rewrites() {");
patch('frontend/web/utils/api.ts', '  baseURL: resolvedApiBaseURL,', "  baseURL: '/plugins/aid-studio/url',");
patchClientApiUrl(patch);
patch('frontend/web/stores/user.ts', "  token: '',", "  token: 'greenroom-managed',");
patch('frontend/web/stores/user.ts', "const token = localStorage.getItem('token') || ''", "const token = 'greenroom-managed'");
// Keep preference/creation controls, remove only API credential configuration.
function visit(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) visit(path);
    else if (/\.(tsx|ts)$/.test(item.name) && !/\.test\./.test(item.name) && item.name !== 'next.config.ts') {
      let text = readFileSync(path, 'utf8');
      text = text.replace(/(['"])\/url\//g, '$1/plugins/aid-studio/url/');
      writeFileSync(path, text);
    }
  }
}
visit(join(root, 'frontend/web'));
mkdirSync(join(root, 'greenroom'), { recursive: true });
cpSync(new URL('host.mjs', import.meta.url), join(root, 'greenroom/host.mjs'));
