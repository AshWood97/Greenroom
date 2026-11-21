package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func greenroomEnabled() bool { return os.Getenv("GREENROOM_MANAGED") == "true" }
func (req *CreateTaskRequest) SetGreenroomTaskID(value string) {
	if greenroomEnabled() {
		req.greenroomTaskID = value
	}
}
func greenroomURL() string { return strings.TrimRight(os.Getenv("GREENROOM_MANAGED_URL"), "/") }

// The original SQLite database, project ownership and worker leases remain the
// business source of truth. A sidecar belongs to exactly one platform member.
func (s *Service) greenroomUser() (*model.User, error) {
	user, err := s.repo.UserByUsername("greenroom-member")
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return user, err
	}
	user = &model.User{ID: newID(), Username: "greenroom-member", DisplayName: "Greenroom 成员", Role: model.UserRoleUser, Status: model.UserStatusActive, PasswordHash: "!managed-account"}
	if err = s.repo.Create(user); err != nil {
		return s.repo.UserByUsername("greenroom-member")
	}
	return user, nil
}

func greenroomError(value map[string]any, status int) error {
	for _, key := range []string{"error", "message", "msg"} {
		switch problem := value[key].(type) {
		case string:
			if problem != "" {
				return fmt.Errorf("%s (HTTP %d)", problem, status)
			}
		case map[string]any:
			if message, ok := problem["message"].(string); ok {
				return fmt.Errorf("%s (code %v, HTTP %d)", message, problem["code"], status)
			}
		}
	}
	return fmt.Errorf("服务商未返回具体失败原因 (HTTP %d)", status)
}

func greenroomRequest(ctx context.Context, path string, body any, submission string) (map[string]any, error) {
	method := http.MethodGet
	var payload io.Reader
	if body != nil {
		method = http.MethodPost
		data, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, greenroomURL()+path, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if submission != "" {
		req.Header.Set("X-T8-Provider-Submission", submission)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var value map[string]any
	if err = json.NewDecoder(response.Body).Decode(&value); err != nil {
		return nil, fmt.Errorf("托管接口响应无法解析 (HTTP %d): %w", response.StatusCode, err)
	}
	if response.StatusCode >= 400 || value["success"] == false {
		return nil, greenroomError(value, response.StatusCode)
	}
	if data, ok := value["data"].(map[string]any); ok {
		return data, nil
	}
	return value, nil
}

func greenroomSettings(ctx context.Context) (map[string]any, error) {
	return greenroomRequest(ctx, "/plugins/open-ai-canvas/settings", nil, "")
}
func greenroomKind(mode string) string {
	if mode == "text" {
		return "llm"
	}
	if mode == "audio" {
		return "tts"
	}
	return mode
}

func greenroomModels(ctx context.Context, settings map[string]any, kind string) ([]map[string]any, error) {
	catalog, err := greenroomRequest(ctx, "/models", nil, "")
	if err != nil {
		return nil, err
	}
	models := []map[string]any{}
	values, _ := catalog[kind].([]any)
	if settings["configured"] == true {
		selected, _ := settings["models"].(map[string]any)
		ids, _ := selected[kind].([]any)
		for _, id := range ids {
			for _, value := range values {
				if item, ok := value.(map[string]any); ok && item["id"] == id {
					models = append(models, item)
				}
			}
		}
	} else {
		for _, value := range values {
			if item, ok := value.(map[string]any); ok {
				models = append(models, item)
			}
		}
	}
	return models, nil
}

func greenroomProtocol(mode string) string {
	switch mode {
	case "text":
		return "chat-completion"
	case "image":
		return "openai-image"
	case "video":
		return "new-api-channel2"
	default:
		return "openai-audio"
	}
}

func (s *Service) greenroomCatalog(intent *ModelRequestIntent) (*ModelCatalogResponse, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	settings, err := greenroomSettings(ctx)
	if err != nil {
		return nil, err
	}
	response := &ModelCatalogResponse{Source: ModelCatalogSourceSystem, Models: []PublicLogicalModel{}, Channels: []PublicChannelCatalog{}}
	channel := PublicChannelCatalog{ID: "greenroom", Name: "Greenroom", DisplayName: "平台托管模型", Models: []PublicChannelModel{}}
	for _, mode := range []string{"text", "image", "video", "audio"} {
		if intent != nil && intent.Capability != "" && intent.Capability != mode {
			continue
		}
		models, err := greenroomModels(ctx, settings, greenroomKind(mode))
		if err != nil {
			return nil, err
		}
		for _, item := range models {
			id, _ := item["id"].(string)
			name, _ := item["name"].(string)
			if mode == "image" {
				if label, _ := item["label"].(string); label != "" {
					name = label
					same, sameChannel := 0, 0
					provider, _ := item["provider_label"].(string)
					for _, other := range models {
						if other["label"] == label {
							same++
							if provider != "" && other["provider_label"] == provider {
								sameChannel++
							}
						}
					}
					if same > 1 {
						if provider == "" || sameChannel != 1 {
							provider = id
						}
						name += " (" + provider + ")"
					}
				}
			}
			if name == "" {
				name = id
			}
			capability := DefaultModelCapabilityConfig(greenroomProtocol(mode))
			if mode == "video" {
				parameters, _ := settings["parameters"].(map[string]any)
				defaults, _ := parameters["video"].(map[string]any)
				capability = &ModelCapabilityConfig{Version: 1, Video: greenroomVideoCapability(item, defaults)}
			}
			encoded, _ := json.Marshal(capability)
			config := map[string]any{}
			_ = json.Unmarshal(encoded, &config)
			channel.Models = append(channel.Models, PublicChannelModel{ID: id, ModelKey: id, DisplayName: name, Capability: mode, Protocol: model.ChannelInterfaceType(greenroomProtocol(mode)), CapabilityConfig: config, PriceTiers: []PublicChannelModelPriceTier{}, PriceLabel: "由星网统一计费，实际费用以结算回执为准", Available: true})
		}
	}
	response.Channels = append(response.Channels, channel)
	return response, nil
}

func (s *Service) greenroomQuote(req ChannelModelQuoteRequest) (*LogicalModelQuote, error) {
	if err := validateQuoteIntent(req.Intent); err != nil {
		return nil, err
	}
	catalog, err := s.greenroomCatalog(&req.Intent)
	if err != nil {
		return nil, err
	}
	for _, channel := range catalog.Channels {
		for _, item := range channel.Models {
			if req.ChannelID == channel.ID && req.ModelKey == item.ModelKey {
				return nil, errors.New("星网按实际请求统一计费；本地积分报价不可用，费用以星网结算回执为准")
			}
		}
	}
	return nil, errors.New("管理员未批准该模型")
}

func (s *Service) createGreenroomTask(userID string, req CreateTaskRequest) (*model.Task, error) {
	if req.greenroomTaskID != "" {
		if _, err := uuid.Parse(req.greenroomTaskID); err != nil {
			return nil, errors.New("任务受理编号无效")
		}
		if task, err := s.repo.TaskForUser(userID, req.greenroomTaskID); err == nil {
			return taskForOutput(*task), nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
	}
	// Only normalize the managed model selection here. Upstream CreateTask's
	// admission and persistence remain authoritative for every new task.
	req.Type = strings.TrimSpace(req.Type)
	input, err := normalizeTaskInput(req.Input)
	if err != nil {
		return nil, err
	}
	if options, ok := input["textOptions"].(map[string]any); ok {
		if err := greenroomValidateThinkingLevel(stringValue(options["thinkingLevel"])); err != nil {
			return nil, err
		}
	}
	mode, _ := input["mode"].(string)
	if mode == "" {
		mode = strings.TrimPrefix(req.Type, "canvas_")
		if strings.HasPrefix(req.Type, "video_") {
			mode = "video"
		}
		input["mode"] = mode
	}
	if mode != "text" && mode != "image" && mode != "video" && mode != "audio" {
		return nil, errors.New("不支持的生成模式")
	}
	if strings.HasPrefix(req.Type, "canvas_") && req.Type != "canvas_"+mode {
		return nil, errors.New("任务类型与生成模式不一致")
	}
	kind := greenroomKind(mode)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	settings, err := greenroomSettings(ctx)
	if err != nil {
		return nil, err
	}
	models, err := greenroomModels(ctx, settings, kind)
	if err != nil {
		return nil, err
	}
	if len(models) == 0 {
		return nil, errors.New("管理员尚未启用该类模型")
	}
	config, _ := input["config"].(map[string]any)
	if config == nil {
		config = map[string]any{}
	}
	selected := firstNonEmpty(stringValue(config["channelModelKey"]), stringValue(config["model"]), req.Model)
	if selected == "" {
		selected = stringValue(models[0]["id"])
	}
	allowed := false
	for _, item := range models {
		if item["id"] == selected {
			allowed = true
		}
	}
	if !allowed {
		return nil, errors.New("管理员未批准该模型")
	}
	for _, field := range []string{"apiKey", "secretKey", "headers", "baseUrl", "runningHubWalletApiKey", "runningHubUploadApiKey", "workflowId", "webappId", "workflowJson", "workflowJSON", "workflowFields", "providerModelKey", "capabilityConfig"} {
		delete(config, field)
	}
	config["model"] = selected
	config["channelModelKey"] = selected
	config["channelId"] = "greenroom"
	config["interfaceType"] = greenroomProtocol(mode)
	input["config"] = config
	parameters, _ := settings["parameters"].(map[string]any)
	input["greenroomParameters"] = parameters[kind]
	config["greenroomParameters"] = parameters[kind]
	if strings.TrimSpace(req.Prompt) == "" {
		req.Prompt = stringValue(input["prompt"])
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return nil, errors.New("prompt is required")
	}
	input["prompt"] = req.Prompt
	req.Input, req.Model, req.Provider = input, selected, "greenroom"
	task, err := s.createTask(userID, req)
	if err != nil {
		if req.greenroomTaskID != "" {
			if existing, readErr := s.repo.TaskForUser(userID, req.greenroomTaskID); readErr == nil {
				return taskForOutput(*existing), nil
			}
		}
		return nil, err
	}
	return task, nil
}

func greenroomConfig(config providerConfig) providerConfig {
	config.BaseURL = greenroomURL()
	config.APIKey = "greenroom-managed"
	config.SecretKey = ""
	config.Headers = nil
	config.ChannelID = ""
	config.APIFormat = "openai"
	config.CapabilityConfig = DefaultModelCapabilityConfig(config.InterfaceType)
	return config
}

func greenroomTextBody(config providerConfig, body map[string]any) map[string]any {
	if !greenroomEnabled() {
		return body
	}
	merged := map[string]any{}
	for key, value := range config.GreenroomParameters {
		merged[key] = value
	}
	for key, value := range body {
		merged[key] = value
	}
	return merged
}

func (s *Service) greenroomArchiveResource(ctx context.Context, userID, resourceID string) (map[string]any, error) {
	resource, content, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return nil, err
	}
	defer content.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, greenroomURL()+"/media/uploads", content)
	if err != nil {
		return nil, err
	}
	req.ContentLength = resource.Size
	req.Header.Set("Content-Type", resource.MimeType)
	req.Header.Set("X-File-Name", "timeline-"+resource.ID+".mp4")
	req.Header.Set("X-Asset-Type", "video")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	var value map[string]any
	if err = json.NewDecoder(response.Body).Decode(&value); err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 || value["assetId"] == nil {
		return nil, greenroomError(value, response.StatusCode)
	}
	return value, nil
}

func (s *Service) runGreenroomMedia(ctx context.Context, userID string, input canvasGenerationInput, rawInput string) (map[string]any, error) {
	id := resumedProviderRequestID(ctx)
	var value map[string]any
	var err error
	if id == "" {
		if err = s.hydrateGenerationMedia(userID, &input, providerMediaHydrationPolicy{}); err != nil {
			return nil, err
		}
		body := map[string]any{}
		var saved map[string]any
		_ = json.Unmarshal([]byte(rawInput), &saved)
		if defaults, ok := saved["greenroomParameters"].(map[string]any); ok {
			for key, value := range defaults {
				body[key] = value
			}
		}
		body["model"] = input.Config.Model
		put := func(key, value string) {
			if value != "" {
				body[key] = value
			}
		}
		references := func(items []providerMedia) []string {
			values := []string{}
			for _, item := range items {
				values = append(values, firstNonEmpty(item.DataURL, item.URL))
			}
			return values
		}
		kind := greenroomKind(input.Mode)
		switch kind {
		case "image":
			body["prompt"] = input.Prompt
			put("size", input.Config.Size)
			put("quality", input.Config.Quality)
			if quality, ok := body["quality"]; ok {
				body["providerParams"] = map[string]any{"quality": quality}
				delete(body, "quality")
			}
			put("resolution", input.Config.ImageResolution)
			if input.Config.Count != "" {
				n, _ := strconv.Atoi(input.Config.Count)
				if n > 0 {
					body["n"] = n
				}
			}
			if len(input.ReferenceImages) > 0 {
				body["reference_images"] = references(input.ReferenceImages)
			}
			if input.Mask != nil {
				if len(input.ReferenceImages) == 0 {
					return nil, errors.New("蒙版编辑必须提供源图片")
				}
				body["mask"] = firstNonEmpty(input.Mask.DataURL, input.Mask.URL)
			}
		case "video":
			body["prompt"] = input.Prompt
			put("aspect_ratio", normalizeGrokImageAspectRatio(input.Config.Size))
			put("resolution", input.Config.VQuality)
			if input.Config.VideoSeconds != "" {
				n, _ := strconv.Atoi(input.Config.VideoSeconds)
				if n > 0 {
					body["duration"] = n
				}
			}
			if input.Config.VideoGenerateAudio != "" {
				body["generate_audio"] = input.Config.VideoGenerateAudio == "true"
			}
			if len(input.ReferenceImages) > 0 {
				body["reference_image_urls"] = references(input.ReferenceImages)
			}
			if len(input.ReferenceVideos) > 0 {
				body["reference_video_urls"] = references(input.ReferenceVideos)
			}
			if len(input.ReferenceAudios) > 0 {
				body["reference_audio_urls"] = references(input.ReferenceAudios)
			}
		case "tts":
			body["text"] = input.Prompt
			put("voice", input.Config.AudioVoice)
			put("response_format", input.Config.AudioFormat)
			if input.Config.AudioSpeed != "" {
				speed, _ := strconv.ParseFloat(input.Config.AudioSpeed, 64)
				body["speed"] = speed
			}
		}
		task, _ := ctx.Value(mediaExecutionTaskKey{}).(model.Task)
		value, err = greenroomRequest(ctx, "/"+kind+"/submit", body, fmt.Sprintf("open-ai-canvas:%s:%d", taskExecutionID(ctx), task.RouteRun))
		if err != nil {
			return nil, err
		}
		id = stringValue(value["taskId"])
		if id == "" {
			return nil, errors.New("平台未返回可恢复的生成任务编号")
		}
		if err = s.recordWorkflowProviderRequest(ctx, id, "processing", nil); err != nil {
			return nil, err
		}
	} else {
		value, err = greenroomRequest(ctx, "/tasks/"+id, nil, "")
	}
	if err != nil {
		_ = s.updateWorkflowProviderState(ctx, id, err.Error(), nil)
		return nil, fmt.Errorf("查询原任务 %s 失败：%v：%w", id, err, providerStatePendingError{TaskID: id, Cause: err})
	}
	status := stringValue(value["status"])
	if status == "failed" || status == "cancelled" {
		return nil, greenroomError(value, 200)
	}
	if status != "succeeded" {
		_ = s.updateWorkflowProviderState(ctx, id, status, nil)
		return nil, providerStatePendingError{TaskID: id}
	}
	result := map[string]any{"mode": input.Mode}
	outputs, _ := value["outputs"].([]any)
	images := []map[string]any{}
	for _, raw := range outputs {
		output, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		assetID := stringValue(output["assetId"])
		if assetID == "" {
			continue
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, greenroomURL()+"/media/"+assetID, nil)
		if err != nil {
			return nil, err
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, fmt.Errorf("私有产物下载失败，原任务 %s：%w", id, providerStatePendingError{TaskID: id, Cause: err})
		}
		data, readErr := io.ReadAll(response.Body)
		response.Body.Close()
		if readErr != nil || response.StatusCode >= 400 {
			return nil, fmt.Errorf("私有产物下载失败 (HTTP %d)，原任务 %s：%w", response.StatusCode, id, providerStatePendingError{TaskID: id, Cause: readErr})
		}
		mime := stringValue(output["mimeType"])
		item := map[string]any{"assetId": assetID, "dataUrl": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(data), "mimeType": mime}
		switch {
		case strings.HasPrefix(mime, "image/"):
			images = append(images, item)
		case strings.HasPrefix(mime, "video/"):
			result["video"] = item
		case strings.HasPrefix(mime, "audio/"):
			result["audio"] = item
		}
	}
	if len(images) > 0 {
		result["images"] = images
	}
	if len(result) == 1 {
		return nil, errors.New("平台未返回可用的媒体产物")
	}
	return result, nil
}

// The managed catalog does not yet declare an authoritative thinking contract.
// Do not silently normalize a requested level using native protocol defaults.
func greenroomValidateThinkingLevel(level string) error {
	if greenroomEnabled() && strings.TrimSpace(level) != "" && strings.TrimSpace(level) != ThinkingIntentAuto {
		return BadAuthRequest("星网尚未提供该模型的思考档位能力；请选择“自动”，或等待管理员完成能力接入")
	}
	return nil
}
