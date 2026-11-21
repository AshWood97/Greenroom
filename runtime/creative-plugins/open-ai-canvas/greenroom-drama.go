package app

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func (s *Service) greenroomDramaModel(choice DramaModelChoice, kind string) (map[string]any, map[string]any, error) {
	if choice.ChannelID != "greenroom" || choice.ModelKey == "" || choice.LogicalModelID != "" {
		return nil, nil, errors.New("请选择平台托管模型")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	settings, err := greenroomSettings(ctx)
	if err != nil {
		return nil, nil, err
	}
	models, err := greenroomModels(ctx, settings, greenroomKind(kind))
	if err != nil {
		return nil, nil, err
	}
	for _, item := range models {
		if item["id"] == choice.ModelKey {
			parameters, _ := settings["parameters"].(map[string]any)
			defaults, _ := parameters[greenroomKind(kind)].(map[string]any)
			return item, defaults, nil
		}
	}
	return nil, nil, errors.New("管理员未批准该模型，请重新选择")
}

func (s *Service) greenroomDramaChoiceIssue(choice DramaModelChoice, capability string) string {
	_, _, err := s.greenroomDramaModel(choice, capability)
	if err != nil {
		return err.Error()
	}
	return ""
}

func (s *Service) greenroomDramaVideoProfile(choice DramaModelChoice) (dramaVideoProfile, error) {
	item, defaults, err := s.greenroomDramaModel(choice, "video")
	if err != nil {
		return dramaVideoProfile{}, err
	}
	video := greenroomVideoCapability(item, defaults)
	return dramaVideoProfile{Durations: production.DurationOptions{Values: video.Duration.Values}, Operations: video.Operations, MaxImages: video.References.MaxImages, video: video}, nil
}

// Catalog and drama use the same already-fetched managed metadata. These are
// gateway request parameters, not assertions that an unverified provider supports
// every combination. Unknown advanced references are not enabled automatically.
func greenroomVideoCapability(item, defaults map[string]any) *VideoCapabilityConfig {
	caps, _ := item["capabilities"].(map[string]any)
	duration := 5 // the managed request/segment default, NOT a provider maximum
	if n, err := strconv.Atoi(stringValue(defaults["duration"])); err == nil && n > 0 {
		duration = n
	}
	values := []int{duration}
	if raw, ok := caps["durations"].([]any); ok && len(raw) > 0 {
		values = nil
		for _, v := range raw {
			if n, err := strconv.Atoi(stringValue(v)); err == nil && n > 0 {
				values = append(values, n)
			}
		}
		if len(values) == 0 {
			values = []int{duration}
		}
	}
	video := &VideoCapabilityConfig{Duration: VideoDurationConfig{Selection: "enum", Values: values, Default: duration},
		Ratios: production.AspectRatios, DefaultRatio: "16:9", Resolutions: []string{}, Operations: []string{"text_to_video"}, DefaultOperation: "text_to_video"}
	if ratio := stringValue(defaults["aspect_ratio"]); ratio != "" {
		video.DefaultRatio = ratio
	}
	if resolution := stringValue(defaults["resolution"]); resolution != "" {
		video.Resolutions = []string{resolution}
		video.DefaultResolution = resolution
	}
	if caps["verification_status"] == "verified" {
		if caps["firstFrame"] == true || caps["supportsFirstFrame"] == true {
			video.Operations = append(video.Operations, "image_to_video")
			video.References.MaxImages = 1
		}
		if n, err := strconv.Atoi(stringValue(caps["maxReferenceImages"])); err == nil && n > 0 {
			video.References.MaxImages = n
			video.Operations = append(video.Operations, "reference_to_video")
		}
	}
	return video
}

func (s *Service) greenroomDramaImageSpec(choice DramaModelChoice) (CapabilitySpec, map[string]any, bool) {
	_, _, err := s.greenroomDramaModel(choice, "image")
	if err != nil {
		return CapabilitySpec{}, nil, false
	}
	values := make([]any, 0, len(dramaAssetRatios))
	for _, ratio := range dramaAssetRatios {
		values = append(values, ratio)
	}
	return CapabilitySpec{Capability: "image", Options: map[string]OptionConstraint{"size": {Values: values}}}, map[string]any{"size": "16:9"}, true
}

// Existing numeric job fields carry micro-CNY only in managed drama views.
// They do not feed the native credit wallet, price policy or budget admission.
func greenroomTaskCost(task *model.Task, timeout ...time.Duration) (int64, error) {
	if strings.TrimSpace(task.ProviderRequestID) == "" || len(task.ProviderRequestID) > 256 || strings.IndexFunc(task.ProviderRequestID, unicode.IsControl) >= 0 {
		return 0, errors.New("星网请求编号尚未确认，费用未知；保留原任务")
	}
	duration := 5 * time.Second
	if len(timeout) > 0 {
		duration = timeout[0]
	}
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()
	receipt, err := greenroomRequest(ctx, "/usage/receipts?reference_id="+url.QueryEscape(task.ProviderRequestID), nil, "")
	if err != nil {
		return 0, err
	}
	if receipt["referenceId"] != task.ProviderRequestID || receipt["settled"] != true || receipt["currency"] != "CNY" || receipt["netCents"] == nil {
		return 0, errors.New("星网费用回执尚未结算；保留原任务并继续查询")
	}
	encoded, err := json.Marshal(receipt["netCents"])
	if err != nil {
		return 0, err
	}
	amount, ok := new(big.Rat).SetString(string(encoded))
	if !ok || amount.Sign() < 0 {
		return 0, errors.New("星网回执金额无效")
	}
	amount.Mul(amount, big.NewRat(10_000, 1))
	if !amount.IsInt() || !amount.Num().IsInt64() {
		return 0, errors.New("星网回执金额超出可显示精度")
	}
	return amount.Num().Int64(), nil
}

func greenroomDramaCostConfirmed(job model.DramaJob) bool {
	if !greenroomEnabled() || job.TaskID == "" {
		return false
	}
	var attempts []DramaJobAttempt
	if json.Unmarshal([]byte(job.AttemptsJSON), &attempts) != nil {
		return false
	}
	for _, attempt := range attempts {
		if attempt.TaskID == job.TaskID {
			return attempt.CostConfirmed
		}
	}
	return false
}

func greenroomTextRequest(req *http.Request) bool {
	return greenroomEnabled() && req.Method == http.MethodPost && strings.HasSuffix(req.URL.Path, "/chat/completions") && strings.HasPrefix(req.URL.String(), greenroomURL()+"/")
}

func greenroomCheckTextReplay(req *http.Request) error {
	if !greenroomTextRequest(req) {
		return nil
	}
	metadata, ok := req.Context().Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.Service == nil || metadata.TaskID == "" {
		return nil
	}
	task, err := metadata.Service.repo.Task(metadata.TaskID)
	if err != nil {
		return err
	}
	if task.ProviderRequestID != "" || task.PollStage != "" {
		return errors.New("星网文本请求已发出或受理状态待确认；保留原任务，不自动重复提交")
	}
	// Persist uncertainty before the network call: a lost header or process
	// interruption is not proof that the provider did not accept the request.
	return metadata.Service.recordWorkflowProviderRequest(req.Context(), "", "submission_unknown", nil)
}

func greenroomBindTextReceipt(req *http.Request, response *http.Response) error {
	if !greenroomTextRequest(req) {
		return nil
	}
	metadata, ok := req.Context().Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.Service == nil || metadata.TaskID == "" {
		return nil
	}
	reference := strings.TrimSpace(response.Header.Get("X-Request-ID"))
	if reference == "" {
		return nil
	} // no invented ID: task cost remains unknown
	stage := "accepted"
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// A request ID also exists on errors: preserve it for reconciliation,
		// but never describe that audit reference as admitted generation.
		stage = "response_error"
	}
	return metadata.Service.recordWorkflowProviderRequest(req.Context(), reference, stage, nil)
}

// Only the gateway's two verified pre-provider validation errors prove that
// generation was not admitted. HTTP status alone cannot establish this.
func greenroomTextValidationFailure(req *http.Request, response *http.Response, data []byte) error {
	if !greenroomTextRequest(req) {
		return nil
	}
	var problem struct {
		Code         string `json:"code"`
		InternalCode string `json:"internal_code"`
		Submitted    *bool  `json:"submitted"`
	}
	if json.Unmarshal(data, &problem) != nil {
		return nil
	}
	preflight := response.StatusCode == http.StatusBadRequest && ((problem.Code == "validation.invalid_body" && problem.InternalCode == "30010101") || (problem.Code == "validation.missing_model" && problem.InternalCode == "30010102"))
	localRoute := response.StatusCode == http.StatusNotFound && req.URL.String() == greenroomURL()+"/v1/chat/completions" && problem.Code == "greenroom.managed_route_not_found" && problem.Submitted != nil && !*problem.Submitted
	if !preflight && !localRoute {
		return nil
	}
	metadata, ok := req.Context().Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.Service == nil || metadata.TaskID == "" {
		return nil
	}
	return metadata.Service.recordWorkflowProviderRequest(req.Context(), strings.TrimSpace(response.Header.Get("X-Request-ID")), "not_admitted", nil)
}

// The public retry entry must check before RetryTaskWithBilling erases provider
// state. A blank native BillingOrderID is not permission to repeat gateway work.
func (s *Service) greenroomTaskRetryGuard(task *model.Task) error {
	if !greenroomEnabled() || task.Provider != "greenroom" {
		return nil
	}
	if task.PollStage == "not_admitted" {
		return nil
	}
	if task.ProviderRequestID == "" && task.PollStage == "submission_unknown" && s.greenroomLocallyRejectedLegacyRoute(task) {
		return nil
	}
	if task.ProviderRequestID != "" || (task.PollStage != "" && task.PollStage != "create") {
		return BadAuthRequest("星网原请求已受理或状态待确认；请继续查询原任务，不可重新提交")
	}
	diagnostic := taskExecutionDiagnostic(task)
	if diagnostic != nil && !diagnostic.TaskSubmitted && diagnostic.SubmissionOutcome == "not_submitted" {
		return nil
	}
	return BadAuthRequest("无法确认星网原请求未提交；保留原任务，不可重复生成")
}

func greenroomPendingDramaAttempts(job model.DramaJob) []DramaJobAttempt {
	if !greenroomEnabled() {
		return nil
	}
	var attempts []DramaJobAttempt
	if json.Unmarshal([]byte(job.AttemptsJSON), &attempts) != nil {
		return nil
	}
	pending := []DramaJobAttempt{}
	for _, attempt := range attempts {
		if attempt.TaskID == "" || attempt.CostConfirmed {
			continue
		}
		switch model.TaskStatus(attempt.Status) {
		case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
			pending = append(pending, attempt)
		}
	}
	return pending
}

// Bounded, read-only upstream reconciliation. It only updates the existing
// terminal attempt's receipt projection, never its lifecycle, wallet or task.
func (s *Service) greenroomRefreshDramaReceipt(job *model.DramaJob, selected ...string) {
	pending := greenroomPendingDramaAttempts(*job)
	if len(pending) == 0 {
		return
	}
	targetID := pending[int(time.Now().Unix()/5)%len(pending)].TaskID
	if len(selected) > 0 {
		found := false
		for _, attempt := range pending {
			if attempt.TaskID == selected[0] {
				found = true
			}
		}
		if !found {
			return
		}
		targetID = selected[0]
	}
	task, err := s.repo.Task(targetID)
	if err != nil || task.Provider != "greenroom" {
		return
	}
	switch task.Status {
	case model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled:
	default:
		return
	}
	cost, err := greenroomTaskCost(task, 2*time.Second)
	if err != nil {
		return
	}
	var attempts []DramaJobAttempt
	if json.Unmarshal([]byte(job.AttemptsJSON), &attempts) != nil {
		return
	}
	found := false
	for i := range attempts {
		if attempts[i].TaskID == targetID {
			attempts[i].CostMicrocredits = cost
			attempts[i].CostConfirmed = true
			found = true
		}
	}
	if !found {
		return
	} // old/missing history is not manufactured into a receipt
	data, err := json.Marshal(attempts)
	if err != nil {
		return
	}
	candidate := *job
	if targetID == job.TaskID {
		candidate.CostMicrocredits = cost
	}
	candidate.AttemptsJSON = string(data)
	if updated, err := s.repo.SaveManagedDramaReceipt(&candidate, job.AttemptsJSON); err == nil && updated {
		*job = candidate
	}
}

func (s *Service) greenroomRefreshDramaReceipts(jobs []model.DramaJob) {
	if !greenroomEnabled() {
		return
	}
	type candidate struct {
		index  int
		taskID string
	}
	eligible := []candidate{}
	for i := range jobs {
		for _, attempt := range greenroomPendingDramaAttempts(jobs[i]) {
			eligible = append(eligible, candidate{i, attempt.TaskID})
		}
	}
	if len(eligible) == 0 {
		return
	}
	// Flatten attempts before rotating: independent job/attempt rotations could
	// repeatedly select the same pair and starve an older continued attempt.
	target := eligible[int(time.Now().Unix()/5)%len(eligible)]
	s.greenroomRefreshDramaReceipt(&jobs[target.index], target.taskID)
}

// Native API-call logging also updates provider state. Managed submission hooks
// own that state; an audit response/body ID must not erase certainty or replace
// the gateway's actual X-Request-ID with a provider-local completion ID.
func (s *Service) greenroomPreserveProviderState(taskID string) bool {
	if !greenroomEnabled() {
		return false
	}
	task, err := s.repo.Task(taskID)
	return err != nil || task.Provider == "greenroom"
}

// The historical /managed/v1/chat/completions URL is not in managedPath's
// fixed allowlist: DSH rejects it before forward. Recovery needs every stored
// call to prove that exact local rejection (or an earlier concurrency failure),
// not merely a 404, translated error message, or absent provider ID.
func (s *Service) greenroomLocallyRejectedLegacyRoute(task *model.Task) bool {
	if !greenroomEnabled() || task.Provider != "greenroom" || task.Status != model.TaskStatusFailed || task.ProviderRequestID != "" || task.PollStage != "submission_unknown" {
		return false
	}
	base, err := url.Parse(greenroomURL())
	if err != nil || base.Host == "" || !strings.HasSuffix(base.Path, "/managed") {
		return false
	}
	expected := greenroomURL() + "/v1/chat/completions"
	logs, err := s.repo.ManagedTaskCallEvidence(task.ID, task.UserID)
	if err != nil || len(logs) == 0 || len(logs) > 32 {
		return false
	}
	rejected := false
	for _, call := range logs {
		if call.Method != http.MethodPost || call.RequestKind != "create" || call.UpstreamURL != expected || call.Path != base.Path+"/v1/chat/completions" || call.ProviderRequestID != "" {
			return false
		}
		if call.StatusCode == 0 && call.ErrorCode == "channel_concurrency_unavailable" {
			continue
		}
		if call.StatusCode != http.StatusNotFound {
			return false
		}
		var problem struct {
			Error     string `json:"error"`
			Code      string `json:"code"`
			Submitted *bool  `json:"submitted"`
		}
		if json.Unmarshal([]byte(call.ResponseBody), &problem) != nil || problem.Error != "接口不存在" {
			return false
		}
		if problem.Code != "" && (problem.Code != "greenroom.managed_route_not_found" || problem.Submitted == nil || *problem.Submitted) {
			return false
		}
		rejected = true
	}
	return rejected
}

func (s *Service) greenroomTaskOutput(task model.Task) *model.Task {
	output := taskForOutput(task)
	if s.greenroomLocallyRejectedLegacyRoute(&task) {
		// Read projection only: preserve the stored original state and audit trail.
		// The retry entry independently rechecks the same evidence before mutation.
		output.Diagnostic = &model.TaskExecutionDiagnostic{Code: "managed_bridge_route_not_forwarded", Phase: "preparation", TaskSubmitted: false, SubmissionOutcome: "not_submitted", RetryClass: "new_generation_authorization", SafeMessage: "原请求被本地托管桥接路由拒绝，未转发生成；修复后可显式重试原任务", DiagnosticID: task.ID}
	}
	return output
}

func greenroomAuthoritativeTextReference(task *model.Task) bool {
	return greenroomEnabled() && task != nil && task.Provider == "greenroom" && capabilityFromTaskType(task.Type) == "text"
}

// Persist the original terminal attempt before applying its result, as upstream
// does. Gateway receipt latency must not block terminal business processing.
func (r *dramaRun) greenroomSettleTaskAttempt(job *model.DramaJob, task *model.Task, reason string) error {
	if dramaAttemptRecorded(job, task.ID) {
		return nil
	}
	status := string(task.Status)
	var cost int64
	confirmed := false
	if task.PollStage == "not_admitted" {
		status = "rejected"
	} else {
		var err error
		cost, err = greenroomTaskCost(task)
		confirmed = err == nil
	}
	previousAttempts, previousCost := job.AttemptsJSON, job.CostMicrocredits
	job.CostMicrocredits = cost
	recordDramaAttempt(job, task.ID, status, reason, cost, confirmed)
	if err := r.s.repo.RecordDramaJobCost(job, previousAttempts); err != nil {
		job.AttemptsJSON, job.CostMicrocredits = previousAttempts, previousCost
		return &dramaSyncDeferred{err: err}
	}
	r.production.SpentMicrocredits += cost
	return nil
}
