import { readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { prepareManagedUI } from './managed-ui.mjs';
const root = resolve(process.argv[2]);
function patch(file, before, after) {
  const path = join(root, file), source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error('Open AI Canvas integration target changed: ' + file);
  writeFileSync(path, source.replace(before, after));
}
cpSync(new URL('greenroom.go', import.meta.url), join(root, 'backend/internal/app/greenroom.go'));
cpSync(new URL('greenroom_test.go', import.meta.url), join(root, 'backend/internal/app/greenroom_test.go'));
cpSync(new URL('greenroom-drama.go', import.meta.url), join(root, 'backend/internal/app/greenroom_drama.go'));
cpSync(new URL('greenroom-drama-repository.go', import.meta.url), join(root, 'backend/internal/repository/greenroom_drama.go'));
// Preserve native status/msg while exposing the same already-sanitized reason to
// the existing DSH transport, which reads message for non-2xx responses.
for (let index = 0; index < 2; index++) patch('backend/internal/handler/response.go', 'body := gin.H{"code": code, "data": nil, "msg": message}', 'body := gin.H{"code": code, "data": nil, "msg": message, "message": message}');
cpSync(new URL('greenroom-response_test.go', import.meta.url), join(root, 'backend/internal/handler/greenroom_response_test.go'));
cpSync(new URL('greenroom-resource.go', import.meta.url), join(root, 'backend/internal/app/greenroom_resource.go'));
cpSync(new URL('greenroom-resource-repository.go', import.meta.url), join(root, 'backend/internal/repository/greenroom_resource.go'));
cpSync(new URL('greenroom-resource_test.go', import.meta.url), join(root, 'backend/internal/app/greenroom_resource_test.go'));
patch('backend/internal/app/resource_store.go', '\t\tbody, err := os.Open(filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))', '\t\tbody, err := os.Open(filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey)))\n\t\tif errors.Is(err, os.ErrNotExist) && s.greenroomRestoreMissingResource(userID, resource) { body, err = os.Open(filepath.Join(s.dataDir, "resources", filepath.FromSlash(resource.ObjectKey))) }');
patch('backend/internal/app/service.go', '\ts.hydrateTaskProviderRequestID(task)\n\treturn taskForOutput(*task), nil', '\tif !greenroomAuthoritativeTextReference(task) { s.hydrateTaskProviderRequestID(task) }\n\treturn s.greenroomTaskOutput(*task), nil');
patch('backend/internal/app/service.go', 'if strings.TrimSpace(tasks[index].ProviderRequestID) != "" {', 'if strings.TrimSpace(tasks[index].ProviderRequestID) != "" || greenroomAuthoritativeTextReference(&tasks[index]) {');
patch('backend/internal/app/service.go', 'type CreateTaskRequest struct {', 'type CreateTaskRequest struct {\n\tgreenroomTaskID string');
patch('backend/internal/handler/routes.go', '\t\treq.TraceID = TraceID(c)', '\t\treq.SetGreenroomTaskID(c.GetHeader("X-Greenroom-Task-ID"))\n\t\treq.TraceID = TraceID(c)');
patch('backend/internal/app/auth_bridge.go', 'func (s *Service) CurrentUser(cookieValue string) (*model.User, error) {', 'func (s *Service) CurrentUser(cookieValue string) (*model.User, error) {\n\tif greenroomEnabled() { return s.greenroomUser() }');
patch('backend/internal/app/task_lifecycle.go', '\tif task.MediaRecoveryJSON != "" {', '\tif err := s.greenroomTaskRetryGuard(task); err != nil { return nil, err }\n\tif task.MediaRecoveryJSON != "" {');
patch('backend/internal/app/task_creation.go', 'func (s *Service) CreateTask(userID string, req CreateTaskRequest) (*model.Task, error) {', 'func (s *Service) CreateTask(userID string, req CreateTaskRequest) (*model.Task, error) {\n\tif greenroomEnabled() { return s.createGreenroomTask(userID, req) }\n\treturn s.createTask(userID, req)\n}\n\nfunc (s *Service) createTask(userID string, req CreateTaskRequest) (*model.Task, error) {');
// Keep upstream admission, storage quotas, Agent approvals and pipeline metadata;
// only the model authority and billing belong to the Greenroom broker.
patch('backend/internal/app/task_creation.go', '\tif !workflowProviderTask {\n\t\trouted, normalizedInput, err = s.resolveTaskModelSelection', '\tif !workflowProviderTask && !greenroomEnabled() {\n\t\trouted, normalizedInput, err = s.resolveTaskModelSelection');
patch('backend/internal/app/task_creation.go', '\tif isTextReplayTaskRequest(normalizedInput) {', '\tif !greenroomEnabled() && isTextReplayTaskRequest(normalizedInput) {');
patch('backend/internal/app/task_creation.go', '\tif err := s.ValidateTaskCapability(normalizedInput); err != nil {\n\t\treturn nil, err\n\t}', '\tif !greenroomEnabled() {\n\t\tif err := s.ValidateTaskCapability(normalizedInput); err != nil { return nil, err }\n\t}');
patch('backend/internal/app/task_creation.go', '\tif req.admission != nil {\n\t\ttask.ID = req.admission.ID', '\tif req.greenroomTaskID != "" { task.ID = req.greenroomTaskID }\n\tif req.admission != nil {\n\t\ttask.ID = req.admission.ID');
patch('backend/internal/app/task_creation.go', 'func (s *Service) requireCustomChannelsForTaskInput(input map[string]any) error {', 'func (s *Service) requireCustomChannelsForTaskInput(input map[string]any) error {\n\tif greenroomEnabled() { return nil }');
patch('backend/internal/app/provider.go', 'func (s *Service) resolveProviderConfig(config providerConfig) (providerConfig, error) {', 'func (s *Service) resolveProviderConfig(config providerConfig) (providerConfig, error) {\n\tif greenroomEnabled() { return greenroomConfig(config), nil }');
patch('backend/internal/app/provider.go', 'type providerConfig struct {', 'type providerConfig struct {\n\tGreenroomParameters map[string]any `json:"greenroomParameters,omitempty"`');
// Managed channel IDs are catalog selectors, not native SystemChannel rows.
// Empty native channel identity retains the existing host-scoped default slot.
patch('backend/internal/app/admin_api_call_log.go', 'if log.TaskID != "" && (log.RequestKind == "create" || log.RequestKind == "poll" || log.RequestKind == "cancel") {', 'if log.TaskID != "" && !s.greenroomPreserveProviderState(log.TaskID) && (log.RequestKind == "create" || log.RequestKind == "poll" || log.RequestKind == "cancel") {');
patch('backend/internal/app/provider_errors.go', '\t\tif metadata.ChannelID != "" && service != nil {', '\t\tif greenroomEnabled() && task.Provider == "greenroom" { metadata.ChannelID = "" }\n\t\tif metadata.ChannelID != "" && service != nil {');
patch('backend/internal/app/provider_text_stream.go', 'func requestTextProvider(ctx context.Context, config providerConfig, path string, body map[string]interface{}, protocol string, stream bool, onDelta func(string)) (providerTextResult, error) {', 'func requestTextProvider(ctx context.Context, config providerConfig, path string, body map[string]interface{}, protocol string, stream bool, onDelta func(string)) (providerTextResult, error) {\n\tbody = greenroomTextBody(config, body)');
patch('backend/internal/app/provider_text_agent.go', 'func postAgentRequest(ctx context.Context, input canvasGenerationInput, path string, body map[string]interface{}, protocol string) (map[string]interface{}, error) {', 'func postAgentRequest(ctx context.Context, input canvasGenerationInput, path string, body map[string]interface{}, protocol string) (map[string]interface{}, error) {\n\tbody = greenroomTextBody(input.Config, body)');
patch('backend/internal/app/provider.go', '\tconfig, err := s.resolveProviderConfig(input.Config)', '\tif err := greenroomValidateThinkingLevel(input.TextOptions.ThinkingLevel); err != nil { return nil, err }\n\tif greenroomEnabled() && input.Mode != "text" {\n\t\tif input.Mode == "image" { if err := s.applyGenerationStyleProfile(userID, taskProjectID, &input); err != nil { return nil, err } }\n\t\treturn s.runGreenroomMedia(ctx, userID, input, rawInput)\n\t}\n\tconfig, err := s.resolveProviderConfig(input.Config)');
patch('backend/internal/app/model_router_attempts.go', 'func (s *Service) beginTaskRouteAttempt(task *model.Task) (*model.RouteAttempt, error) {', 'func (s *Service) beginTaskRouteAttempt(task *model.Task) (*model.RouteAttempt, error) {\n\tif greenroomEnabled() { return nil, nil }');
patch('backend/internal/app/task_worker.go', 'func (s *Service) shouldDeferProviderTask(task model.Task, decryptedInput string, err error) bool {', 'func (s *Service) shouldDeferProviderTask(task model.Task, decryptedInput string, err error) bool {\n\tif greenroomEnabled() {\n\t\tvar pending providerStatePendingError\n\t\treturn task.ProviderRequestID != "" && errors.As(err, &pending) && pending.TaskID == task.ProviderRequestID && time.Since(task.CreatedAt) < time.Hour\n\t}');
patch('backend/internal/app/model_catalog.go', 'func (s *Service) ModelCatalog(access *userGroupAccess, intent *ModelRequestIntent) (*ModelCatalogResponse, error) {', 'func (s *Service) ModelCatalog(access *userGroupAccess, intent *ModelRequestIntent) (*ModelCatalogResponse, error) {\n\tif greenroomEnabled() { return s.greenroomCatalog(intent) }');
patch('backend/internal/app/logical_model_quote.go', 'func (s *Service) QuoteChannelModel(userID string, req ChannelModelQuoteRequest) (*LogicalModelQuote, error) {', 'func (s *Service) QuoteChannelModel(userID string, req ChannelModelQuoteRequest) (*LogicalModelQuote, error) {\n\tif greenroomEnabled() { return s.greenroomQuote(req) }');
patch('backend/internal/app/finance.go', 'func (s *Service) taskBillingOrder(userID string, task *model.Task, input map[string]any) (*model.BillingOrder, error) {', 'func (s *Service) taskBillingOrder(userID string, task *model.Task, input map[string]any) (*model.BillingOrder, error) {\n\tif greenroomEnabled() { return nil, nil }');
// Managed drama uses the existing gateway admission and receipt authority, not
// a native channel database, wallet or locally invented credit conversion policy.
patch('backend/internal/app/drama_models.go', 'func (s *Service) dramaChoiceIssue(access *userGroupAccess, choice DramaModelChoice, capability string) string {', 'func (s *Service) dramaChoiceIssue(access *userGroupAccess, choice DramaModelChoice, capability string) string {\n\tif greenroomEnabled() { return s.greenroomDramaChoiceIssue(choice, capability) }');
patch('backend/internal/app/drama_models.go', 'func (s *Service) dramaVideoProfile(choice DramaModelChoice) (dramaVideoProfile, error) {', 'func (s *Service) dramaVideoProfile(choice DramaModelChoice) (dramaVideoProfile, error) {\n\tif greenroomEnabled() { return s.greenroomDramaVideoProfile(choice) }');
patch('backend/internal/app/drama_models.go', 'func (s *Service) dramaImageSpec(choice DramaModelChoice) (CapabilitySpec, map[string]any, bool) {', 'func (s *Service) dramaImageSpec(choice DramaModelChoice) (CapabilitySpec, map[string]any, bool) {\n\tif greenroomEnabled() { return s.greenroomDramaImageSpec(choice) }');
patch('backend/internal/app/drama_models.go', 'func (s *Service) dramaImageRequestFor(choice DramaModelChoice, ratio, tier string) dramaImageRequest {', 'func (s *Service) dramaImageRequestFor(choice DramaModelChoice, ratio, tier string) dramaImageRequest {\n\tif greenroomEnabled() {\n\t\tif issue := s.greenroomDramaChoiceIssue(choice, "image"); issue != "" { return dramaImageRequest{Issue: issue} }; return dramaImageRequest{Size: ratio, Resolution: tier}\n\t}');
patch('backend/internal/app/drama_types.go', '\t\tif err := ValidateThinkingLevelRequest(level); err != nil {', '\t\tif err := greenroomValidateThinkingLevel(level); err != nil { return err }\n\t\tif err := ValidateThinkingLevelRequest(level); err != nil {');
patch('backend/internal/app/drama_types.go', 'func (s DramaSettings) normalized() DramaSettings {', 'func (s DramaSettings) normalized() DramaSettings {\n\tif greenroomEnabled() && s.VideoContinuity == "" { s.VideoContinuity = DramaContinuityParallel }');
patch('backend/internal/app/drama_canvas.go', 'func (s *Service) dramaBudgetExhausted(production *model.DramaProduction) (bool, error) {', 'func (s *Service) dramaBudgetExhausted(production *model.DramaProduction) (bool, error) {\n\tif greenroomEnabled() { return false, nil }');
patch('backend/internal/app/drama_service.go', 'func (s *Service) prepareDramaCreation(userID string, projectID string, req CreateDramaRequest) (*dramaCreation, error) {', 'func (s *Service) prepareDramaCreation(userID string, projectID string, req CreateDramaRequest) (*dramaCreation, error) {\n\tif greenroomEnabled() && req.BudgetMicrocredits != 0 { return nil, BadAuthRequest("托管短剧由星网统一计费，不设置本地积分钱包预算") }');
patch('backend/internal/app/drama_actions.go', 'func (s *Service) UpdateDramaSettings(userID string, projectID string, req UpdateDramaSettingsRequest) (DramaSummary, error) {', 'func (s *Service) UpdateDramaSettings(userID string, projectID string, req UpdateDramaSettingsRequest) (DramaSummary, error) {\n\tif greenroomEnabled() && req.BudgetMicrocredits != nil && *req.BudgetMicrocredits != 0 { return DramaSummary{}, BadAuthRequest("托管短剧由星网统一计费，不设置本地积分钱包预算") }');
patch('backend/internal/app/drama_orchestrator.go', 'budgeted := r.production.BudgetMicrocredits > 0 && len(queued) > 0', 'budgeted := !greenroomEnabled() && r.production.BudgetMicrocredits > 0 && len(queued) > 0');
patch('backend/internal/app/drama_models.go', '\tif err != nil || quote == nil {\n\t\treturn 0, false\n\t}', '\tif err != nil || quote == nil || (greenroomEnabled() && quote.Estimated) {\n\t\treturn 0, false\n\t}');
patch('backend/internal/app/drama_orchestrator.go', 'func (r *dramaRun) taskCost(task *model.Task) (int64, error) {', 'func (r *dramaRun) taskCost(task *model.Task) (int64, error) {\n\tif greenroomEnabled() && task.Provider == "greenroom" { return greenroomTaskCost(task) }');
patch('backend/internal/app/drama_types.go', 'type DramaJobAttempt struct {', 'type DramaJobAttempt struct {\n\tCostConfirmed bool `json:"costConfirmed,omitempty"`');
patch('backend/internal/app/drama_types.go', 'type DramaJobView struct {', 'type DramaJobView struct {\n\tCostConfirmed bool `json:"costConfirmed,omitempty"`');
patch('backend/internal/app/drama_orchestrator.go', 'func recordDramaAttempt(job *model.DramaJob, taskID, status, reason string, cost int64) {', 'func recordDramaAttempt(job *model.DramaJob, taskID, status, reason string, cost int64, confirmed ...bool) {');
patch('backend/internal/app/drama_orchestrator.go', 'attempts = append(attempts, DramaJobAttempt{TaskID: taskID,', 'attempts = append(attempts, DramaJobAttempt{CostConfirmed: len(confirmed) > 0 && confirmed[0], TaskID: taskID,');
patch('backend/internal/app/drama_service.go', '\tvar attempts []DramaJobAttempt\n\t_ = json.Unmarshal([]byte(job.AttemptsJSON), &attempts)', '\ts.greenroomRefreshDramaReceipt(job)\n\tvar attempts []DramaJobAttempt\n\t_ = json.Unmarshal([]byte(job.AttemptsJSON), &attempts)');
patch('backend/internal/app/drama_service.go', '\tviews := make([]DramaJobView, 0, len(jobs))', '\ts.greenroomRefreshDramaReceipts(jobs)\n\tviews := make([]DramaJobView, 0, len(jobs))');
patch('backend/internal/app/drama_service.go', 'view := DramaJobView{ID: job.ID,', 'view := DramaJobView{CostConfirmed: greenroomDramaCostConfirmed(job), ID: job.ID,');
// Persist the actual text gateway request ID before reading its body/SSE. A
// query of its receipt never sends chat/completions again.
patch('backend/internal/app/provider_http_client.go', 'func apiURL(baseURL string, path string) string {', 'func apiURL(baseURL string, path string) string {\n\tif greenroomEnabled() && strings.TrimRight(baseURL, "/") == greenroomURL() { return greenroomURL() + "/" + strings.TrimLeft(path, "/") }');
patch('backend/internal/app/provider_http_client.go', '\tdefer resp.Body.Close()\n\tif resp.ContentLength > responseLimit {', '\tdefer resp.Body.Close()\n\tif err := greenroomBindTextReceipt(req, resp); err != nil { return nil, "", err }\n\tif resp.ContentLength > responseLimit {');
patch('backend/internal/app/provider_http_client.go', '\tresp, err := client.Do(req)', '\tif err := greenroomCheckTextReplay(req); err != nil { return nil, "", err }\n\tresp, err := client.Do(req)');
patch('backend/internal/app/provider_http_client.go', '\tif resp.StatusCode < 200 || resp.StatusCode >= 300 {', '\tif err := greenroomTextValidationFailure(req, resp, data); err != nil { return nil, "", err }\n\tif resp.StatusCode < 200 || resp.StatusCode >= 300 {');
patch('backend/internal/app/drama_orchestrator.go', 'func (r *dramaRun) settleTaskAttempt(job *model.DramaJob, task *model.Task, reason string) error {', 'func (r *dramaRun) settleTaskAttempt(job *model.DramaJob, task *model.Task, reason string) error {\n\tif greenroomEnabled() && task.Provider == "greenroom" { return r.greenroomSettleTaskAttempt(job, task, reason) }');
patch('backend/internal/app/task_timeline.go', 'type timelineRenderResult struct {', 'type timelineRenderResult struct {\n\tManagedAsset map[string]any `json:"managedAsset,omitempty"`');
patch('backend/internal/app/task_render.go', '\tpayload, err := json.Marshal(result)', '\tif greenroomEnabled() {\n\t\tasset, archiveErr := s.greenroomArchiveResource(ctx, task.UserID, resource.ID); if archiveErr != nil { return w.failTimelineTask(task, "私有成片归档失败", archiveErr.Error()) }; result.ManagedAsset = asset\n\t}\n\tpayload, err := json.Marshal(result)');
// Platform-controlled model configuration cannot be enabled by a native UI preference.
patch('backend/internal/app/platform_bridge.go', 'func (s *Service) FeatureAvailability() (*PublicFeatureAvailability, error) {\n\treturn s.platformDomain().FeatureAvailability()', 'func (s *Service) FeatureAvailability() (*PublicFeatureAvailability, error) {\n\tif greenroomEnabled() {\n\t\tvalue, err := s.platformDomain().FeatureAvailability(); if err != nil { return nil, err }; value.CustomChannelsEnabled = false; value.FrontendModelsEnabled = false; return value, nil\n\t}\n\treturn s.platformDomain().FeatureAvailability()');
patch('web/vite.config.ts', 'export default defineConfig({', "export default defineConfig({\n    base: '/plugins/open-ai-canvas/',");
patch('web/src/router.tsx', '\n]);', "\n], { basename: '/plugins/open-ai-canvas' });");
patch('web/src/services/canvas-realtime-client.ts', 'canvasRealtimeURL(apiBase: string,', 'canvasRealtimeURL(_apiBase: string,');
patch('web/src/services/canvas-realtime-client.ts', '    const url = new URL(`${apiBase.replace(/\\/+$/, "")}/canvas-projects/${encodeURIComponent(canvasId)}/realtime`, pageURL);', '    const url = new URL("/plugins/open-ai-canvas/_greenroom/socket", pageURL);\n    url.searchParams.set("path", `/api/canvas-projects/${encodeURIComponent(canvasId)}/realtime`);');
patch('web/src/pages/settings/index.tsx', '    return configSections.some((section) => section.key === value);', '    return configSections.some((section) => section.key === value && !["channels", "runninghub", "storage"].includes(section.key));');
patch('web/src/pages/settings/index.tsx', '.filter((section) => section.key !== "runninghub" || runningHubPluginEnabled)', '.filter((section) => !["channels", "runninghub", "storage"].includes(section.key))');
// Public inspiration catalogs and their bundled thumbnails live under the same plugin mount.
patch('web/src/services/inspiration-catalog.ts', '    const response = await fetch(url, { headers: { Accept: "application/json" } });', '    const response = await fetch(url.startsWith("/inspirations/") ? "/plugins/open-ai-canvas" + url : url, { headers: { Accept: "application/json" } });');
patch('web/src/services/inspiration-catalog.ts', '    return entries as CreationInspiration[];', '    return (entries as CreationInspiration[]).map((entry) => typeof entry.image === "string" && entry.image.startsWith("/inspiration-thumbs/") ? { ...entry, image: "/plugins/open-ai-canvas" + entry.image } : entry);');
// Discover cast created after an initially empty/ready query while production runs.
patch('web/src/pages/projects/studio/use-studio.ts', 'import { useCallback, useMemo, useRef, useState } from "react";', 'import { useCallback, useEffect, useMemo, useRef, useState } from "react";');
patch('web/src/pages/projects/studio/use-studio.ts', '        refetchInterval: (state) => (active && state.state.data?.cast.some((cast) => cast.imageStatus !== "ready" && cast.imageStatus !== "failed" && !cast.locked) ? 4_000 : false),', '        refetchInterval: (state) => (active || state.state.data?.cast.some((cast) => (cast.imageStatus === "queued" || cast.imageStatus === "running") && !cast.locked) ? 4_000 : false),');
patch('web/src/pages/projects/studio/use-studio.ts', '    const byId = useMemo(() => new Map((query.data?.cast || []).map((cast) => [cast.id, cast] as const)), [query.data]);', `    const previousProduction = useRef({ projectId, active });
    useEffect(() => {
        // Summary polls faster than cast: read the final snapshot before stopping.
        if (projectId && previousProduction.current.projectId === projectId && previousProduction.current.active && !active) {
            void query.refetch();
        }
        previousProduction.current = { projectId, active };
    }, [projectId, active, query.refetch]);
    const byId = useMemo(() => new Map((query.data?.cast || []).map((cast) => [cast.id, cast] as const)), [query.data]);`);
// Native media/SSE/WebSocket URLs use the same mounted prefix as the original API.
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) && entry.name !== 'canvas-realtime-client.ts') {
      const source = readFileSync(path, 'utf8').replace(/(["'`])\/api(?=[/"'`])/g, '$1/plugins/open-ai-canvas/api');
      writeFileSync(path, source);
    }
  }
}
visit(join(root, 'web/src'));
prepareManagedUI(patch);
mkdirSync(join(root, 'greenroom'), { recursive: true });
cpSync(new URL('host.mjs', import.meta.url), join(root, 'greenroom/host.mjs'));
