package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"yingce/backend/internal/database"
	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
	"yingce/backend/internal/repository"
)

type greenroomCatalogTransport func(*http.Request) (*http.Response, error)

func (f greenroomCatalogTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func TestGreenroomVideoCatalogMatchesDramaProfile(t *testing.T) {
	for _, tc := range []struct {
		name, capabilities, defaults string
		images                       int
		operations                   []string
		durations                    []int
		duration                     int
		ratio, resolution            string
	}{
		{"unknown", `{"verification_status":"unknown"}`, `{}`, 0, []string{"text_to_video"}, []int{5}, 5, "16:9", ""},
		{"missing capabilities", `null`, `null`, 0, []string{"text_to_video"}, []int{5}, 5, "16:9", ""},
		{"unverified references", `{"firstFrame":true,"maxReferenceImages":9}`, `{}`, 0, []string{"text_to_video"}, []int{5}, 5, "16:9", ""},
		{"unknown references", `{"verification_status":"unknown","supportsFirstFrame":true,"maxReferenceImages":9}`, `{}`, 0, []string{"text_to_video"}, []int{5}, 5, "16:9", ""},
		{"verified without references", `{"verification_status":"verified"}`, `{}`, 0, []string{"text_to_video"}, []int{5}, 5, "16:9", ""},
		{"verified first frame", `{"verification_status":"verified","firstFrame":true}`, `{}`, 1, []string{"text_to_video", "image_to_video"}, []int{5}, 5, "16:9", ""},
		{"verified alias and references", `{"verification_status":"verified","supportsFirstFrame":true,"maxReferenceImages":"3"}`, `{"duration":"8","aspect_ratio":"9:16","resolution":"1080p"}`, 3, []string{"text_to_video", "image_to_video", "reference_to_video"}, []int{8}, 8, "9:16", "1080p"},
		{"verified references only", `{"verification_status":"verified","maxReferenceImages":2}`, `{}`, 2, []string{"text_to_video", "reference_to_video"}, []int{5}, 5, "16:9", ""},
		{"invalid reference count", `{"verification_status":"verified","firstFrame":"true","maxReferenceImages":1.5}`, `{"duration":-1}`, 0, []string{"text_to_video"}, []int{5}, 5, "16:9", ""},
		{"nonpositive count retains first frame", `{"verification_status":"verified","firstFrame":true,"maxReferenceImages":-2}`, `{"duration":"invalid"}`, 1, []string{"text_to_video", "image_to_video"}, []int{5}, 5, "16:9", ""},
		{"duration values", `{"verification_status":"verified","durations":[0,-1,1.5,"bad",5,"10"]}`, `{"duration":10}`, 0, []string{"text_to_video"}, []int{5, 10}, 10, "16:9", ""},
		{"invalid duration values", `{"verification_status":"unknown","durations":[0,-1,"bad"]}`, `{"duration":7}`, 0, []string{"text_to_video"}, []int{7}, 7, "16:9", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			requests := 0
			client := http.DefaultClient
			http.DefaultClient = &http.Client{Transport: greenroomCatalogTransport(func(req *http.Request) (*http.Response, error) {
				requests++
				if req.Method != http.MethodGet {
					return nil, errors.New("catalog test forbids submissions")
				}
				var body string
				switch req.URL.Path {
				case "/plugins/open-ai-canvas/settings":
					body = `{"configured":false,"parameters":{"video":` + tc.defaults + `}}`
				case "/models":
					// A familiar provider/model name must never imply capabilities.
					body = `{"video":[{"id":"H3-max","capabilities":` + tc.capabilities + `},{"id":"other-video","capabilities":` + tc.capabilities + `}]}`
				default:
					return nil, errors.New("unexpected catalog path: " + req.URL.Path)
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			t.Cleanup(func() { http.DefaultClient = client })
			t.Setenv("GREENROOM_MANAGED", "true")
			t.Setenv("GREENROOM_MANAGED_URL", "https://managed-catalog.invalid")
			s := &Service{}
			catalog, err := s.greenroomCatalog(&ModelRequestIntent{Capability: "video"})
			if err != nil {
				t.Fatal(err)
			}
			if requests != 2 || len(catalog.Channels) != 1 || len(catalog.Channels[0].Models) != 2 {
				t.Fatalf("catalog must reuse its existing settings/models reads: requests=%d catalog=%+v", requests, catalog)
			}
			for _, item := range catalog.Channels[0].Models {
				data, err := json.Marshal(item.CapabilityConfig)
				if err != nil {
					t.Fatal(err)
				}
				var config ModelCapabilityConfig
				if err := json.Unmarshal(data, &config); err != nil {
					t.Fatal(err)
				}
				video := config.Video
				if config.Version != 1 || video == nil || video.References != (VideoReferenceConfig{MaxImages: tc.images}) || !reflect.DeepEqual(video.Operations, tc.operations) {
					t.Fatalf("catalog invented reference support: %s", data)
				}
				if video.Duration.Selection != "enum" || video.Duration.Default != tc.duration || !reflect.DeepEqual(video.Duration.Values, tc.durations) || video.Duration.Min != 0 || video.Duration.Max != 0 {
					t.Fatalf("catalog lost managed request durations: %s", data)
				}
				if video.DefaultRatio != tc.ratio || video.DefaultResolution != tc.resolution || video.Resolutions == nil || (tc.resolution == "" && len(video.Resolutions) != 0) || (tc.resolution != "" && !reflect.DeepEqual(video.Resolutions, []string{tc.resolution})) {
					t.Fatalf("catalog must expose UI-safe managed screen parameters: %s", data)
				}
				profile, err := s.greenroomDramaVideoProfile(DramaModelChoice{ChannelID: "greenroom", ModelKey: item.ModelKey})
				if err != nil || !reflect.DeepEqual(video, profile.video) || profile.MaxImages != tc.images || !reflect.DeepEqual(profile.Operations, tc.operations) || !reflect.DeepEqual(profile.Durations.Values, tc.durations) {
					t.Fatalf("catalog/drama mismatch: catalog=%s drama=%+v err=%v", data, profile, err)
				}
			}
		})
	}
}

func TestGreenroomNonVideoCatalogKeepsNativeDefaults(t *testing.T) {
	greenroomTestGateway(t, nil)
	for _, mode := range []string{"text", "image", "audio"} {
		catalog, err := (&Service{}).greenroomCatalog(&ModelRequestIntent{Capability: mode})
		if err != nil {
			t.Fatal(err)
		}
		want, _ := json.Marshal(DefaultModelCapabilityConfig(greenroomProtocol(mode)))
		got, _ := json.Marshal(catalog.Channels[0].Models[0].CapabilityConfig)
		var expected map[string]any
		_ = json.Unmarshal(want, &expected)
		if !reflect.DeepEqual(catalog.Channels[0].Models[0].CapabilityConfig, expected) {
			t.Fatalf("%s defaults changed: %s", mode, got)
		}
	}
}

func greenroomTestGateway(t *testing.T, receipt *map[string]any) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet {
			t.Errorf("unexpected submission: %s %s", r.Method, r.URL.Path)
			http.Error(w, "no submissions", 500)
			return
		}
		switch r.URL.Path {
		case "/plugins/open-ai-canvas/settings":
			_, _ = w.Write([]byte(`{"configured":false,"parameters":{"video":{"duration":5}}}`))
		case "/models":
			_, _ = w.Write([]byte(`{"llm":[{"id":"text"}],"image":[{"id":"image","capabilities":{"verification_status":"unknown"}}],"video":[{"id":"video","capabilities":{"verification_status":"unknown"}}],"tts":[{"id":"audio"}]}`))
		case "/usage/receipts":
			if r.URL.Query().Get("reference_id") != "host.example.com/ABC123-000001" {
				t.Errorf("opaque reference lost: %q", r.URL.RawQuery)
				http.Error(w, "bad reference", 400)
				return
			}
			if receipt == nil {
				http.NotFound(w, r)
				return
			}
			_ = json.NewEncoder(w).Encode(*receipt)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv("GREENROOM_MANAGED", "true")
	t.Setenv("GREENROOM_MANAGED_URL", server.URL)
	return server
}

func TestGreenroomDramaGatewayModelsAndUnknownQuote(t *testing.T) {
	greenroomTestGateway(t, nil)
	s := &Service{}
	choice := DramaModelChoice{ChannelID: "greenroom", ModelKey: "video"}
	if issue := s.dramaChoiceIssue(nil, choice, "video"); issue != "" {
		t.Fatal(issue)
	}
	p, err := s.dramaVideoProfile(choice)
	if err != nil || !p.supports("text_to_video") || p.supports("image_to_video") || p.supports("reference_to_video") || p.MaxImages != 0 {
		t.Fatalf("unexpected request profile: %+v %v", p, err)
	}
	if p.maxSeconds() != 5 {
		t.Fatal("must use configured request duration")
	}
	if issue := s.dramaChoiceIssue(nil, DramaModelChoice{ChannelID: "greenroom", ModelKey: "unapproved"}, "video"); issue == "" {
		t.Fatal("unapproved model allowed")
	}
	if _, ok := s.quoteDramaChoice("member", DramaModelChoice{ChannelID: "greenroom", ModelKey: "text"}, ModelRequestIntent{Capability: "text"}); ok {
		t.Fatal("unknown quote must not be zero")
	}
}

func TestGreenroomDramaApprovedModelDiscovery(t *testing.T) {
	s, _ := newDramaTestService(t)
	greenroomTestGateway(t, nil)
	models, err := s.resolveDramaModels("usr-drama", DramaSettings{VideoContinuity: DramaContinuityParallel}.normalized())
	if err != nil || len(missingDramaCapabilities(models)) != 0 {
		t.Fatalf("approved models not discoverable: %+v %v", models, err)
	}
	settings := DramaSettings{Models: models, VideoContinuity: DramaContinuityParallel}.normalized()
	settings.AspectRatio = "16:9"
	if err := s.validateDramaVideoSettings(settings); err != nil {
		t.Fatal(err)
	}
}

func TestGreenroomDramaReceiptValues(t *testing.T) {
	receipt := map[string]any{}
	greenroomTestGateway(t, &receipt)
	task := &model.Task{Provider: "greenroom", ProviderRequestID: "host.example.com/ABC123-000001"}
	for _, tc := range []struct {
		name  string
		value map[string]any
		want  int64
		valid bool
	}{
		{"pending", map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": false, "netCents": nil}, 0, false},
		{"foreign", map[string]any{"referenceId": "another", "settled": true, "currency": "CNY", "netCents": 1}, 0, false},
		{"currency", map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "USD", "netCents": 1}, 0, false},
		{"fractional", map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "CNY", "netCents": 3.338}, 33380, true},
		{"minimum precision", map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "CNY", "netCents": 0.001}, 10, true},
		{"sub-cent", map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "CNY", "netCents": 0.54}, 5400, true},
		{"refund", map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "CNY", "netCents": 0}, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			receipt = tc.value
			got, err := greenroomTaskCost(task)
			if (err == nil) != tc.valid || (tc.valid && got != tc.want) {
				t.Fatalf("cost=%d err=%v", got, err)
			}
		})
	}
	if _, err := greenroomTaskCost(&model.Task{Provider: "greenroom"}); err == nil {
		t.Fatal("missing request reference must remain unknown")
	}
}

func TestGreenroomSavedDramaResumesAndPendingReceiptNeverResubmits(t *testing.T) {
	s, fake := newDramaTestService(t)
	receipt := map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": false, "netCents": nil}
	greenroomTestGateway(t, &receipt)
	settings := DramaSettings{VideoContinuity: DramaContinuityParallel, Models: DramaModels{Text: DramaModelChoice{ChannelID: "greenroom", ModelKey: "text"}, Image: DramaModelChoice{ChannelID: "greenroom", ModelKey: "image"}, Video: DramaModelChoice{ChannelID: "greenroom", ModelKey: "video"}}}
	production := &model.DramaProduction{ProjectID: "managed-project", UserID: "usr-drama", Status: model.DramaStatusPaused, SettingsJSON: encodeDramaSettings(settings), BudgetMicrocredits: 1}
	if err := fake.db.Create(production).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.resumeDrama(production); err != nil {
		t.Fatal(err)
	}
	if production.Status != model.DramaStatusRunning {
		t.Fatal("saved project did not resume")
	}
	if exhausted, err := s.dramaBudgetExhausted(production); err != nil || exhausted {
		t.Fatal("native credit budget must not govern gateway", err)
	}
	task := &model.Task{ID: "managed-task", UserID: "usr-drama", Provider: "greenroom", ProviderRequestID: "host.example.com/ABC123-000001", Type: "canvas_text", Status: model.TaskStatusFailed, Error: "gateway rejected request"}
	job := &model.DramaJob{ID: "managed-job", ProjectID: production.ProjectID, Kind: "test", TaskID: task.ID, Status: model.DramaJobRunning}
	if err := fake.db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(job).Error; err != nil {
		t.Fatal(err)
	}
	r := &dramaRun{s: s, project: &model.Project{ID: production.ProjectID, UserID: "usr-drama"}, production: production}
	if err := r.syncRunningJob(job); err != nil {
		t.Fatal(err)
	}
	if job.Status != model.DramaJobFailed || greenroomDramaCostConfirmed(*job) || len(fake.requests) != 0 {
		t.Fatal("pending receipt blocked terminal failure, invented a cost or resubmitted")
	}
	receipt = map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "CNY", "netCents": 3.338}
	s.greenroomRefreshDramaReceipt(job)
	if job.Status != model.DramaJobFailed || job.CostMicrocredits != 33380 || !dramaJobView(*job).CostConfirmed || len(fake.requests) != 0 {
		t.Fatalf("incorrect settled projection %+v", job)
	}
}

func TestGreenroomFailedAndCancelledCastFinishesBeforeReceipt(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled} {
		for _, receiptMode := range []string{"pending", "confirmed earlier", "settled"} {
			t.Run(string(status)+"/"+receiptMode, func(t *testing.T) {
				s, fake := newDramaTestService(t)
				receipt := map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": false, "netCents": nil}
				greenroomTestGateway(t, &receipt)
				task := model.Task{ID: "terminal-cast-task", UserID: "usr-drama", Provider: "greenroom", ProviderRequestID: "host.example.com/ABC123-000001", PollStage: "accepted", Status: status, Error: "upstream.media_failed"}
				cast := model.DramaCast{ID: "terminal-cast", ProjectID: "terminal-project", Revision: 3, ImageStatus: model.DramaMediaRunning, ImageResourceID: "previous-image"}
				job := model.DramaJob{ID: "terminal-cast-job", ProjectID: cast.ProjectID, CastID: cast.ID, TaskID: task.ID, Kind: model.DramaJobCastImage, PayloadJSON: `{"revision":3}`, Status: model.DramaJobRunning}
				wantCost, wantConfirmed := int64(0), false
				if receiptMode == "confirmed earlier" {
					wantCost, wantConfirmed = 12300, true
					job.CostMicrocredits = wantCost
					recordDramaAttempt(&job, task.ID, string(status), task.Error, wantCost, true)
				} else if receiptMode == "settled" {
					wantCost, wantConfirmed = 5400, true
					receipt = map[string]any{"referenceId": task.ProviderRequestID, "settled": true, "currency": "CNY", "netCents": 0.54}
				}
				for _, value := range []any{&task, &cast, &job} {
					if err := fake.db.Create(value).Error; err != nil {
						t.Fatal(err)
					}
				}
				original, err := s.repo.Task(task.ID)
				if err != nil {
					t.Fatal(err)
				}
				r := &dramaRun{s: s, project: &model.Project{ID: cast.ProjectID, UserID: task.UserID}, production: &model.DramaProduction{ProjectID: cast.ProjectID}}
				if err := r.syncRunningJob(&job); err != nil {
					t.Fatal(err)
				}
				if job.Status != model.DramaJobFailed || job.Error != task.Error || job.FinishedAt == nil || job.TaskID != task.ID || job.CostMicrocredits != wantCost || greenroomDramaCostConfirmed(job) != wantConfirmed {
					t.Fatalf("terminal task held by receipt or mispriced: %+v", job)
				}
				casts, err := s.repo.DramaCasts(cast.ProjectID)
				if err != nil || len(casts) != 1 || casts[0].ImageStatus != model.DramaMediaFailed || casts[0].ImageResourceID != "previous-image" {
					t.Fatalf("cast did not leave running while retaining prior asset: %+v %v", casts, err)
				}
				finishedAt := *job.FinishedAt
				if receiptMode == "pending" {
					receipt = map[string]any{"referenceId": task.ProviderRequestID, "settled": true, "currency": "CNY", "netCents": 0.54}
					s.greenroomRefreshDramaReceipt(&job)
					wantCost, wantConfirmed = 5400, true
				}
				var attempts []DramaJobAttempt
				if err := json.Unmarshal([]byte(job.AttemptsJSON), &attempts); err != nil {
					t.Fatal(err)
				}
				if len(attempts) != 1 || attempts[0].TaskID != task.ID || attempts[0].Status != string(status) || attempts[0].Error != task.Error || attempts[0].CostConfirmed != wantConfirmed || attempts[0].CostMicrocredits != wantCost || job.CostMicrocredits != wantCost || job.Status != model.DramaJobFailed || !job.FinishedAt.Equal(finishedAt) {
					t.Fatalf("late receipt changed lifecycle or lost terminal attempt: %+v %+v", job, attempts)
				}
				saved, err := s.repo.Task(task.ID)
				if err != nil || !reflect.DeepEqual(saved, original) || len(fake.requests) != 0 {
					t.Fatalf("terminal sync/reconciliation mutated or resubmitted original task: %+v %v", saved, err)
				}
			})
		}
	}
}

func TestGreenroomTaskReadErrorDoesNotFailDramaJob(t *testing.T) {
	s, fake := newDramaTestService(t)
	greenroomTestGateway(t, nil)
	task := model.Task{ID: "unreadable-task", UserID: "usr-drama", Provider: "greenroom", Status: model.TaskStatusFailed}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Callback().Query().Before("gorm:query").Register("greenroom-task-read-error", func(tx *gorm.DB) {
		if tx.Statement.Table == "tasks" {
			tx.AddError(errors.New("fixture database unavailable"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fake.db.Callback().Query().Remove("greenroom-task-read-error") })
	job := model.DramaJob{ID: "unreadable-job", TaskID: task.ID, Status: model.DramaJobRunning}
	original := job
	r := &dramaRun{s: s}
	var deferred *dramaSyncDeferred
	if err := r.syncRunningJob(&job); !errors.As(err, &deferred) || !reflect.DeepEqual(job, original) || len(fake.requests) != 0 {
		t.Fatalf("database read failure became business failure: %+v %v", job, err)
	}
}

func TestGreenroomTextBindsReferenceAndNeverReplays(t *testing.T) {
	s, fake := newDramaTestService(t)
	server := greenroomTestGateway(t, nil)
	task := model.Task{ID: "managed-text", UserID: "usr-drama", Provider: "greenroom", Type: "canvas_text", Status: model.TaskStatusRunning}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := withProviderAnalytics(context.Background(), s, task)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/chat/completions", strings.NewReader(`{}`))
	if err := greenroomCheckTextReplay(req); err != nil {
		t.Fatal(err)
	}
	response := &http.Response{StatusCode: 200, Header: http.Header{"X-Request-Id": []string{"host.example.com/ABC123-000001"}}}
	if err := greenroomBindTextReceipt(req, response); err != nil {
		t.Fatal(err)
	}
	if err := greenroomCheckTextReplay(req); err == nil {
		t.Fatal("accepted text could be resubmitted")
	}
	saved, err := s.repo.Task(task.ID)
	if err != nil || saved.ProviderRequestID != "host.example.com/ABC123-000001" || saved.PollStage != "accepted" {
		t.Fatalf("reference not persisted: %+v %v", saved, err)
	}
}

func TestGreenroomTextErrorReferenceIsNotAdmission(t *testing.T) {
	s, fake := newDramaTestService(t)
	server := greenroomTestGateway(t, nil)
	task := model.Task{ID: "managed-text-error", UserID: "usr-drama", Provider: "greenroom", Type: "canvas_text", Status: model.TaskStatusRunning}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(withProviderAnalytics(context.Background(), s, task), http.MethodPost, server.URL+"/chat/completions", strings.NewReader(`{}`))
	response := &http.Response{StatusCode: 503, Header: http.Header{"X-Request-Id": []string{"host.example.com/ABC123-000001"}}}
	if err := greenroomBindTextReceipt(req, response); err != nil {
		t.Fatal(err)
	}
	saved, err := s.repo.Task(task.ID)
	if err != nil || saved.PollStage != "response_error" || saved.ProviderRequestID != "host.example.com/ABC123-000001" {
		t.Fatalf("error is not admission: %+v %v", saved, err)
	}
	if err := greenroomCheckTextReplay(req); err == nil {
		t.Fatal("uncertain server failure may not resubmit")
	}
}

func TestGreenroomLocalTaskDoesNotInventGatewayReceipt(t *testing.T) {
	t.Setenv("GREENROOM_MANAGED", "true")
	job := model.DramaJob{TaskID: "render"}
	recordDramaAttempt(&job, job.TaskID, "succeeded", "", 0)
	if greenroomDramaCostConfirmed(job) {
		t.Fatal("local zero is not a confirmed gateway receipt")
	}
}

func TestGreenroomTextMissingHeaderCannotReplay(t *testing.T) {
	s, fake := newDramaTestService(t)
	server := greenroomTestGateway(t, nil)
	task := model.Task{ID: "text-lost-header", UserID: "usr-drama", Provider: "greenroom", Type: "canvas_text", Status: model.TaskStatusRunning}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(withProviderAnalytics(context.Background(), s, task), http.MethodPost, server.URL+"/chat/completions", strings.NewReader(`{}`))
	if err := greenroomCheckTextReplay(req); err != nil {
		t.Fatal(err)
	}
	if err := greenroomBindTextReceipt(req, &http.Response{StatusCode: 200, Header: http.Header{}}); err != nil {
		t.Fatal(err)
	}
	if err := greenroomCheckTextReplay(req); err == nil {
		t.Fatal("lost header permits duplicate submission")
	}
}

func TestGreenroomDefiniteValidationFailureDoesNotWaitForInventedZeroReceipt(t *testing.T) {
	s, fake := newDramaTestService(t)
	server := greenroomTestGateway(t, nil)
	task := model.Task{ID: "invalid-body", UserID: "usr-drama", Provider: "greenroom", Type: "canvas_text", Status: model.TaskStatusFailed, Error: "body invalid"}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(withProviderAnalytics(context.Background(), s, task), http.MethodPost, server.URL+"/chat/completions", strings.NewReader(`{}`))
	response := &http.Response{StatusCode: 400, Header: http.Header{"X-Request-Id": []string{"audit-validation"}}}
	if err := greenroomBindTextReceipt(req, response); err != nil {
		t.Fatal(err)
	}
	// A provider error sharing the HTTP status must stay uncertain.
	if err := greenroomTextValidationFailure(req, response, []byte(`{"code":"provider.failed","internal_code":"30010101"}`)); err != nil {
		t.Fatal(err)
	}
	saved, _ := s.repo.Task(task.ID)
	if saved.PollStage != "response_error" {
		t.Fatal("provider error misclassified")
	}
	if err := greenroomTextValidationFailure(req, response, []byte(`{"code":"validation.invalid_body","internal_code":"30010101"}`)); err != nil {
		t.Fatal(err)
	}
	job := model.DramaJob{ID: "invalid-body-job", ProjectID: "invalid-body-project", TaskID: task.ID, Kind: "test", Status: model.DramaJobRunning}
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	r := &dramaRun{s: s, project: &model.Project{ID: job.ProjectID, UserID: task.UserID}, production: &model.DramaProduction{ProjectID: job.ProjectID}}
	if err := r.syncRunningJob(&job); err != nil {
		t.Fatal(err)
	}
	if job.Status != model.DramaJobFailed || greenroomDramaCostConfirmed(job) || len(fake.requests) != 0 {
		t.Fatalf("invalid rejection projection: %+v", job)
	}
	if err := greenroomCheckTextReplay(req); err == nil {
		t.Fatal("automatic replay of rejected input allowed")
	}
}

func TestGreenroomTextUsesNativeHostConcurrencyWithoutInventedChannel(t *testing.T) {
	s, fake := newDramaTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, "greenroom-text-http-test")
	t.Setenv("GREENROOM_MANAGED", "true")
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	calls := 0
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("X-Request-ID", "host.example.com/ABC123-000001")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"fixture"}}]}`))
	}))
	defer gateway.Close()
	t.Setenv("GREENROOM_MANAGED_URL", gateway.URL)
	task := model.Task{ID: "managed-real-http", UserID: "usr-drama", Provider: "greenroom", Type: "canvas_text", Status: model.TaskStatusRunning, InputJSON: `{"mode":"text","config":{"channelId":"greenroom","model":"text"}}`}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	ctx := withProviderAnalytics(context.Background(), s, task)
	metadata := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if metadata.ChannelID != "" {
		t.Fatal("virtual catalog ID treated as native SystemChannel")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, gateway.URL+"/chat/completions", strings.NewReader(`{"model":"text"}`))
	if _, _, err := doBinary(req); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("request count=%d", calls)
	}
	if _, _, err := doBinary(req); err == nil {
		t.Fatal("accepted request was replayed")
	}
	if calls != 1 {
		t.Fatal("replay reached gateway")
	}
}

func TestGreenroomNativeRetryPreservesAcceptedAndUnknownTasks(t *testing.T) {
	s, fake := newDramaTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, "greenroom-native-retry")
	greenroomTestGateway(t, nil) // every unexpected POST fails this test
	cases := []struct {
		name, reference, stage, diagnostic string
		allow                              bool
	}{
		{"accepted", "host.example.com/ABC123-000001", "accepted", "", false},
		{"error", "host.example.com/ABC123-000001", "response_error", "", false},
		{"unknown", "", "submission_unknown", `{"taskSubmitted":false,"submissionOutcome":"not_submitted"}`, false},
		{"legacy-id", "host.example.com/ABC123-000001", "", "", false},
		{"unproved", "", "", "", false},
		{"unsent", "", "", `{"taskSubmitted":false,"submissionOutcome":"not_submitted"}`, true},
		{"legacy-create-unsent", "", "create", `{"taskSubmitted":false,"submissionOutcome":"not_submitted"}`, true},
		{"legacy-create-unproved", "", "create", "", false},
		{"validation", "host.example.com/ABC123-000001", "not_admitted", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			task := model.Task{ID: "retry-" + tc.name, UserID: "usr-drama", Provider: "greenroom", Type: "canvas_text", Status: model.TaskStatusFailed, ProviderRequestID: tc.reference, PollStage: tc.stage, ExecutionDiagnosticJSON: tc.diagnostic, InputJSON: `{"mode":"text","prompt":"fixture","config":{"channelId":"greenroom","model":"text"}}`}
			if err := fake.db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			_, err := s.RetryTask(task.UserID, task.ID)
			if (err == nil) != tc.allow {
				t.Fatalf("allowed=%v err=%v", tc.allow, err)
			}
			saved, readErr := s.repo.Task(task.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if !tc.allow && (saved.ProviderRequestID != tc.reference || saved.PollStage != tc.stage || saved.Status != model.TaskStatusFailed) {
				t.Fatalf("rejected retry changed original task: %+v", saved)
			}
			if tc.allow && (saved.ID != task.ID || saved.Status != model.TaskStatusQueued) {
				t.Fatalf("allowed retry lost original task: %+v", saved)
			}
		})
	}
}

func TestGreenroomSuccessfulOutputAdvancesWhileReceiptPendingThenReconciles(t *testing.T) {
	s, fake := newDramaTestService(t)
	receipt := map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": false, "netCents": nil}
	greenroomTestGateway(t, &receipt)
	project := model.Project{ID: "receipt-success-project", UserID: "usr-drama", Name: "receipt success"}
	production := model.DramaProduction{ProjectID: project.ID, UserID: project.UserID, Status: model.DramaStatusRunning, Stage: model.DramaStageBible, SettingsJSON: "{}"}
	if err := fake.db.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(&production).Error; err != nil {
		t.Fatal(err)
	}
	result, _ := json.Marshal(map[string]any{"text": `{"logline":"寻找怀表往事","characters":[{"name":"林舟"}],"scenes":[],"props":[]}`})
	task := model.Task{ID: "receipt-success-task", UserID: project.UserID, ProjectID: project.ID, Provider: "greenroom", ProviderRequestID: "host.example.com/ABC123-000001", Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: string(result)}
	job := model.DramaJob{ID: "receipt-success-job", ProjectID: project.ID, TaskID: task.ID, Kind: model.DramaJobBible, Status: model.DramaJobRunning}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	r := &dramaRun{s: s, project: &project, production: &production}
	if err := r.syncRunningJob(&job); err != nil {
		t.Fatal(err)
	}
	casts, err := s.repo.DramaCasts(project.ID)
	if err != nil || len(casts) != 1 || production.Stage != model.DramaStageProduce || job.Status != model.DramaJobSucceeded || greenroomDramaCostConfirmed(job) {
		t.Fatalf("output blocked/mispriced: %+v casts=%v err=%v", job, casts, err)
	}
	if _, err := s.DramaJobs(project.UserID, project.ID, 20); err != nil {
		t.Fatal(err)
	}
	receipt = map[string]any{"referenceId": task.ProviderRequestID, "settled": true, "currency": "CNY", "netCents": 0.54}
	detail, err := s.DramaJobDetail(project.UserID, project.ID, job.ID)
	if err != nil || !detail.Job.CostConfirmed || detail.Job.CostMicrocredits != 5400 || detail.Job.TaskID != task.ID || len(fake.requests) != 0 {
		t.Fatalf("bad read-only reconciliation: %+v %v", detail, err)
	}
	if len(detail.Attempts) != 1 || !detail.Attempts[0].CostConfirmed {
		t.Fatal("attempt receipt not updated")
	}
	// A stale read cannot overwrite another lifecycle transition or task ID.
	old, err := s.repo.DramaJob(project.ID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaJob{}).Where("id = ?", job.ID).Update("task_id", "new-task").Error; err != nil {
		t.Fatal(err)
	}
	old.CostMicrocredits = 999
	if updated, err := s.repo.SaveManagedDramaReceipt(old, old.AttemptsJSON); err != nil || updated {
		t.Fatalf("stale receipt overwrote newer task: %v %v", updated, err)
	}
}

func TestGreenroomOldTerminalAttemptReceivesLateReceiptWithoutChangingCurrentCost(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled} {
		t.Run(string(status), func(t *testing.T) {
			s, fake := newDramaTestService(t)
			receipt := map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "CNY", "netCents": 0.54}
			greenroomTestGateway(t, &receipt)
			old := model.Task{ID: "old-continued-task", UserID: "usr-drama", Provider: "greenroom", ProviderRequestID: "host.example.com/ABC123-000001", Status: status}
			if err := fake.db.Create(&old).Error; err != nil {
				t.Fatal(err)
			}
			attempts, _ := json.Marshal([]DramaJobAttempt{{TaskID: old.ID, Status: string(status)}, {TaskID: "current-task", Status: "succeeded", CostConfirmed: true, CostMicrocredits: 12300}})
			job := model.DramaJob{ID: "continued-job", ProjectID: "continued-project", TaskID: "current-task", Status: model.DramaJobSucceeded, CostMicrocredits: 12300, AttemptsJSON: string(attempts)}
			if err := fake.db.Create(&job).Error; err != nil {
				t.Fatal(err)
			}
			s.greenroomRefreshDramaReceipt(&job)
			var got []DramaJobAttempt
			if err := json.Unmarshal([]byte(job.AttemptsJSON), &got); err != nil {
				t.Fatal(err)
			}
			if !got[0].CostConfirmed || got[0].CostMicrocredits != 5400 || got[0].Status != string(status) || job.TaskID != "current-task" || job.CostMicrocredits != 12300 || !greenroomDramaCostConfirmed(job) || len(fake.requests) != 0 {
				t.Fatalf("late old receipt changed current attempt: %+v %+v", job, got)
			}
			if len(greenroomPendingDramaAttempts(job)) != 0 {
				t.Fatal("confirmed old attempt kept pending")
			}
		})
	}
}

func TestGreenroomAuditCannotOverwriteAuthoritativeProviderState(t *testing.T) {
	s, fake := newDramaTestService(t)
	t.Setenv("GREENROOM_MANAGED", "true")
	for _, stage := range []string{"accepted", "submission_unknown", "response_error", "not_admitted"} {
		task := model.Task{ID: "audit-" + stage, UserID: "usr-drama", Provider: "greenroom", ProviderRequestID: "host.example.com/ABC123-000001", PollStage: stage, Status: model.TaskStatusFailed}
		if stage == "submission_unknown" {
			task.ProviderRequestID = ""
		}
		if err := fake.db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		if err := s.LogAPICall(model.ApiCallLog{TaskID: task.ID, UserID: task.UserID, RequestKind: "create", ProviderRequestID: "provider-body-local-id", Status: model.ApiCallStatusSucceeded}); err != nil {
			t.Fatal(err)
		}
		saved, err := s.repo.Task(task.ID)
		if err != nil || saved.ProviderRequestID != task.ProviderRequestID || saved.PollStage != stage {
			t.Fatalf("audit rewrote gateway certainty: %+v %v", saved, err)
		}
	}
}

func TestGreenroomTextProtocolKeepsExactManagedBridgePath(t *testing.T) {
	s, fake := newDramaTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, "greenroom-protocol-path")
	t.Setenv("GREENROOM_MANAGED", "true")
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "true")
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path != "/managed/chat/completions" {
			http.Error(w, "wrong bridge path", 404)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "host.example.com/ABC123-000001")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"fixture"}}]}`))
	}))
	defer server.Close()
	t.Setenv("GREENROOM_MANAGED_URL", server.URL+"/managed")
	task := model.Task{ID: "protocol-text", UserID: "usr-drama", Provider: "greenroom", Type: "canvas_text", Status: model.TaskStatusRunning, InputJSON: `{"mode":"text","config":{"channelId":"greenroom","model":"text"}}`}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	_, err := requestTextProvider(withProviderAnalytics(context.Background(), s, task), greenroomConfig(providerConfig{Model: "text"}), "/chat/completions", map[string]any{"model": "text", "messages": []any{map[string]any{"role": "user", "content": "fixture"}}}, "chat-completion", false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 || paths[0] != "/managed/chat/completions" {
		t.Fatalf("bad path: %v", paths)
	}
	saved, _ := s.repo.Task(task.ID)
	if saved.ProviderRequestID != "host.example.com/ABC123-000001" || saved.PollStage != "accepted" {
		t.Fatalf("provider state changed: %+v", saved)
	}
	if apiURL("https://external.invalid", "/chat/completions") != "https://external.invalid/v1/chat/completions" {
		t.Fatal("nonmanaged URL changed")
	}
}

func TestGreenroomLegacyBridgeRejectionNeedsCompleteLocalAuditProof(t *testing.T) {
	s, fake := newDramaTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, "greenroom-bridge-recovery")
	t.Setenv("GREENROOM_MANAGED", "true")
	t.Setenv("GREENROOM_MANAGED_URL", "http://127.0.0.1:18767/managed")
	for _, tc := range []struct {
		name, url, body string
		code            int
		extra           bool
		allowed         bool
	}{
		{"local", "http://127.0.0.1:18767/managed/v1/chat/completions", `{"error":"接口不存在"}`, 404, false, true},
		{"valid-route", "http://127.0.0.1:18767/managed/chat/completions", `{"error":"接口不存在"}`, 404, false, false},
		{"foreign-origin", "http://127.0.0.1:9999/managed/v1/chat/completions", `{"error":"接口不存在"}`, 404, false, false},
		{"unknown-server", "http://127.0.0.1:18767/managed/v1/chat/completions", `{"error":"接口不存在"}`, 500, false, false},
		{"mixed", "http://127.0.0.1:18767/managed/v1/chat/completions", `{"error":"接口不存在"}`, 404, true, false},
		{"missing", "http://127.0.0.1:18767/managed/v1/chat/completions", `{"error":"接口不存在"}`, 404, false, false},
		{"overlimit", "http://127.0.0.1:18767/managed/v1/chat/completions", `{"error":"接口不存在"}`, 404, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			task := model.Task{ID: "legacy-route-" + tc.name, UserID: "usr-drama", Provider: "greenroom", Status: model.TaskStatusFailed, Type: "canvas_text", PollStage: "submission_unknown", InputJSON: `{"mode":"text","config":{"channelId":"greenroom","model":"text"}}`}
			if err := fake.db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			log := model.ApiCallLog{ID: "proof-" + tc.name, TaskID: task.ID, UserID: task.UserID, Method: "POST", RequestKind: "create", Path: "/managed/v1/chat/completions", UpstreamURL: tc.url, StatusCode: tc.code, ResponseBody: tc.body}
			if tc.name != "missing" {
				if err := fake.db.Create(&log).Error; err != nil {
					t.Fatal(err)
				}
			}
			if tc.name == "overlimit" {
				for i := 0; i < 32; i++ {
					copy := log
					copy.ID = newID()
					if err := fake.db.Create(&copy).Error; err != nil {
						t.Fatal(err)
					}
				}
			}
			if tc.extra {
				other := log
				other.ID += "-unknown"
				other.StatusCode = 0
				other.ErrorCode = ""
				if err := fake.db.Create(&other).Error; err != nil {
					t.Fatal(err)
				}
			}
			projected, readErr := s.Task(task.UserID, task.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if tc.allowed && (projected.Diagnostic == nil || projected.Diagnostic.Code != "managed_bridge_route_not_forwarded" || projected.PollStage != "submission_unknown") {
				t.Fatal("read proof missing or mutated original")
			}
			_, err := s.RetryTask(task.UserID, task.ID)
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v err=%v", tc.allowed, err)
			}
			saved, _ := s.repo.Task(task.ID)
			if !tc.allowed && saved.PollStage != "submission_unknown" {
				t.Fatal("unproved retry cleared original state")
			}
		})
	}
}

func TestGreenroomLocalBridgeCodeCannotReclassifyUpstream404(t *testing.T) {
	s, fake := newDramaTestService(t)
	t.Setenv("GREENROOM_MANAGED", "true")
	t.Setenv("GREENROOM_MANAGED_URL", "http://127.0.0.1:18767/managed")
	task := model.Task{ID: "bridge-code", UserID: "usr-drama", Provider: "greenroom", Status: model.TaskStatusRunning, PollStage: "submission_unknown"}
	if err := fake.db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	response := &http.Response{StatusCode: 404, Header: http.Header{}}
	body := []byte(`{"error":"接口不存在","code":"greenroom.managed_route_not_found","submitted":false}`)
	req, _ := http.NewRequestWithContext(withProviderAnalytics(context.Background(), s, task), http.MethodPost, greenroomURL()+"/chat/completions", nil)
	if err := greenroomTextValidationFailure(req, response, body); err != nil {
		t.Fatal(err)
	}
	saved, _ := s.repo.Task(task.ID)
	if saved.PollStage != "submission_unknown" {
		t.Fatal("upstream valid-route 404 treated as unsent")
	}
	req.URL.Path = "/managed/v1/chat/completions"
	if err := greenroomTextValidationFailure(req, response, body); err != nil {
		t.Fatal(err)
	}
	saved, _ = s.repo.Task(task.ID)
	if saved.PollStage != "not_admitted" {
		t.Fatal("local no-forward proof not recognized")
	}
}

func TestGreenroomPublicTextReferenceDoesNotUseBodyCompletionID(t *testing.T) {
	s, fake := newDramaTestService(t)
	t.Setenv("GREENROOM_MANAGED", "true")
	cases := []struct{ id, provider, kind, reference, want string }{
		{"no-header", "greenroom", "canvas_text", "", ""},
		{"real-header", "greenroom", "canvas_text", "host.example.com/ABC123-000001", "host.example.com/ABC123-000001"},
		{"media-id", "greenroom", "canvas_video", "real-media-task", "real-media-task"},
		{"native-text", "native", "canvas_text", "", "chatcmpl-body"},
	}
	for _, tc := range cases {
		task := model.Task{ID: "public-" + tc.id, UserID: "usr-drama", Provider: tc.provider, Type: tc.kind, Status: model.TaskStatusSucceeded, ProviderRequestID: tc.reference}
		if err := fake.db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		log := model.ApiCallLog{ID: "body-" + tc.id, UserID: task.UserID, TaskID: task.ID, ProviderRequestID: "chatcmpl-body", RequestKind: "create", Status: model.ApiCallStatusSucceeded}
		if err := fake.db.Create(&log).Error; err != nil {
			t.Fatal(err)
		}
		out, err := s.Task(task.UserID, task.ID)
		if err != nil || out.ProviderRequestID != tc.want {
			t.Fatalf("%s ref=%q want=%q err=%v", tc.id, out.ProviderRequestID, tc.want, err)
		}
	}
	list, err := s.TasksWithOptions("usr-drama", TaskListOptions{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		found := false
		for _, task := range list {
			if task.ID == "public-"+tc.id {
				found = true
				if task.ProviderRequestID != tc.want {
					t.Fatalf("list %s invented reference %q", tc.id, task.ProviderRequestID)
				}
			}
		}
		if !found {
			t.Fatal("task missing")
		}
	}
	if bodyID, err := s.repo.LatestProviderRequestIDForTask("public-no-header"); err != nil || bodyID != "chatcmpl-body" {
		t.Fatal("body completion ID was removed from audit")
	}
}

func TestGreenroomAttemptSettlementPersistsBeforeApplyAndDeduplicates(t *testing.T) {
	s, fake := newDramaTestService(t)
	receipt := map[string]any{"referenceId": "host.example.com/ABC123-000001", "settled": true, "currency": "CNY", "netCents": 0.54}
	greenroomTestGateway(t, &receipt)
	task := model.Task{ID: "settlement-task", Provider: "greenroom", ProviderRequestID: "host.example.com/ABC123-000001", Status: model.TaskStatusSucceeded}
	job := model.DramaJob{ID: "settlement-job", ProjectID: "settlement-project", TaskID: task.ID, Status: model.DramaJobRunning}
	recordDramaAttempt(&job, "earlier-task", "succeeded", "", 12300, true)
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: s, production: &model.DramaProduction{ProjectID: job.ProjectID}}
	if err := run.settleTaskAttempt(&job, &task, ""); err != nil {
		t.Fatal(err)
	}
	saved, err := s.repo.DramaJob(job.ProjectID, job.ID)
	if err != nil {
		t.Fatal(err)
	}
	var attempts []DramaJobAttempt
	if err := json.Unmarshal([]byte(saved.AttemptsJSON), &attempts); err != nil {
		t.Fatal(err)
	}
	if saved.Status != model.DramaJobRunning || len(attempts) != 2 || attempts[0].CostMicrocredits != 12300 || attempts[1].CostMicrocredits != 5400 || !attempts[1].CostConfirmed {
		t.Fatalf("incorrect pre-apply history: %+v %+v", saved, attempts)
	}
	receipt = map[string]any{"settled": false}
	restarted := &dramaRun{s: s, production: &model.DramaProduction{ProjectID: job.ProjectID}}
	if err := restarted.settleTaskAttempt(saved, &task, ""); err != nil {
		t.Fatal(err)
	}
	if saved.AttemptsJSON != job.AttemptsJSON || restarted.production.SpentMicrocredits != 0 || len(fake.requests) != 0 {
		t.Fatal("recovery changed or recharged original attempt")
	}
}

func TestGreenroomAttemptSettlementConflictDefersWithoutApplying(t *testing.T) {
	s, fake := newDramaTestService(t)
	receipt := map[string]any{"settled": false}
	greenroomTestGateway(t, &receipt)
	task := model.Task{ID: "conflict-task", Provider: "greenroom", Status: model.TaskStatusFailed}
	job := model.DramaJob{ID: "conflict-job", ProjectID: "conflict-project", TaskID: task.ID, Status: model.DramaJobRunning, CostMicrocredits: 123}
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaJob{}).Where("id = ?", job.ID).Update("task_id", "replacement-task").Error; err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: s, production: &model.DramaProduction{ProjectID: job.ProjectID}}
	err := run.settleTaskAttempt(&job, &task, "failed")
	var deferred *dramaSyncDeferred
	if !errors.As(err, &deferred) || job.AttemptsJSON != "" || job.CostMicrocredits != 123 || job.Status != model.DramaJobRunning || len(fake.requests) != 0 {
		t.Fatalf("conflict applied or corrupted attempt: %+v %v", job, err)
	}
}

func TestGreenroomDraftBudgetRejectedWithoutReplacingOriginal(t *testing.T) {
	s, fake := newDramaTestService(t)
	receipt := map[string]any{"settled": false}
	greenroomTestGateway(t, &receipt)
	req := CreateDramaRequest{Name: "Original managed draft", Settings: DramaSettings{MediaMode: DramaMediaManual}, Chapters: []DramaChapterInput{{Title: "Original chapter", Text: "Original source"}}, Draft: &DramaDraftForm{SourceText: "Original source"}}
	created, err := s.CreateDrama("usr-drama", req)
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.DramaDraft("usr-drama", created.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	req.Name = "Unwanted replacement"
	req.Chapters[0].Text = "Changed source"
	req.BudgetMicrocredits = 100
	req.Start = true
	if _, err = s.SaveDramaDraft("usr-drama", created.Project.ID, req); err == nil || !strings.Contains(err.Error(), "星网统一计费") {
		t.Fatalf("managed draft budget accepted: %v", err)
	}
	after, err := s.DramaDraft("usr-drama", created.Project.ID)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("rejected replacement changed original draft: %+v %v", after, err)
	}
	if _, err = s.CreateDrama("usr-drama", req); err == nil || !strings.Contains(err.Error(), "星网统一计费") {
		t.Fatalf("managed creation budget accepted: %v", err)
	}
	if len(fake.requests) != 0 {
		t.Fatal("budget rejection submitted generation")
	}
}

func TestGreenroomThinkingRejectsUnsupportedBeforeAdmission(t *testing.T) {
	s, fake := newDramaTestService(t)
	t.Setenv("GREENROOM_MANAGED", "true")
	t.Setenv("GREENROOM_MANAGED_URL", "http://unreachable.invalid")
	for _, level := range []string{"off", "minimal", "low", "medium", "high", "max", "deep"} {
		_, err := s.CreateTask("usr-drama", CreateTaskRequest{Type: "canvas_text", Prompt: "test", Input: map[string]any{"mode": "text", "textOptions": map[string]any{"thinkingLevel": level}, "config": map[string]any{"capabilityConfig": map[string]any{"thinking": level}}}})
		if err == nil || !strings.Contains(err.Error(), "请选择“自动”") {
			t.Fatalf("%s not rejected before network: %v", level, err)
		}
		if err := (DramaTextThinking{Bible: level}).validate(); err == nil {
			t.Fatalf("drama %s accepted", level)
		}
	}
	var count int64
	if err := fake.db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 0 || len(fake.requests) != 0 {
		t.Fatalf("rejection persisted/submitted tasks: %d %v", count, err)
	}
}

func TestGreenroomThinkingAutoPreservesAdministratorParameters(t *testing.T) {
	t.Setenv("GREENROOM_MANAGED", "true")
	for _, level := range []string{"", "auto"} {
		if err := greenroomValidateThinkingLevel(level); err != nil {
			t.Fatal(err)
		}
		if err := (DramaTextThinking{Bible: level}).validate(); err != nil {
			t.Fatal(err)
		}
		config := greenroomConfig(providerConfig{InterfaceType: "chat-completion", GreenroomParameters: map[string]any{"temperature": 0.2, "max_tokens": 2048, "top_p": 0.9}})
		input := canvasGenerationInput{Config: config, TextOptions: canvasTextOptions{ThinkingLevel: level}}
		body := map[string]any{"model": "managed-model"}
		applyTextThinking(body, input, "chat-completion")
		if _, exists := body["reasoning_effort"]; exists {
			t.Fatalf("auto invented native effort: %+v", body)
		}
		merged := greenroomTextBody(config, body)
		if _, exists := merged["reasoning_effort"]; exists {
			t.Fatalf("managed defaults invented effort: %+v", merged)
		}
		if merged["temperature"] != 0.2 || merged["max_tokens"] != 2048 || merged["top_p"] != 0.9 {
			t.Fatalf("administrator parameters altered: %+v", merged)
		}
	}
}

// Uses real native task/media persistence in separate test processes. Only the
// member broker and expiring object URLs are loopback transport fixtures.
func TestGreenroomAssetOriginalTaskRecoveryAcrossProcesses(t *testing.T) {
	if stage := os.Getenv("GREENROOM_ASSET_TEST_STAGE"); stage != "" {
		greenroomAssetProcess(t, stage)
		return
	}
	root := t.TempDir()
	payload := mediaTestPNG(t)
	if err := os.WriteFile(filepath.Join(root, "expected.png"), payload, 0600); err != nil {
		t.Fatal(err)
	}
	var taskReads, mediaReads, expiredReads, ignoredURLReads, submits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			submits.Add(1)
			http.Error(w, "no submissions", 405)
			return
		}
		switch r.URL.Path {
		case "/tasks/original-provider-task":
			taskReads.Add(1)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"status": "succeeded", "outputs": []any{map[string]any{"assetId": "owner-asset", "mimeType": "image/png", "url": "http://" + r.Host + "/signed/never-use"}}})
		case "/media/owner-asset":
			if mediaReads.Add(1) == 1 {
				http.Redirect(w, r, "/signed/expired", 302)
			} else {
				http.Redirect(w, r, "/signed/fresh", 302)
			}
		case "/signed/never-use":
			ignoredURLReads.Add(1)
			http.Error(w, "temporary output URL must not be used", 403)
		case "/signed/expired":
			expiredReads.Add(1)
			http.Error(w, "expired", 403)
		case "/signed/fresh":
			w.Header().Set("Content-Type", "image/png")
			w.Write(payload)
		default:
			http.Error(w, "unowned or unknown asset", 404)
		}
	}))
	defer server.Close()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, stage := range []string{"expired", "recover", "readback"} {
		cmd := exec.Command(binary, "-test.run=^TestGreenroomAssetOriginalTaskRecoveryAcrossProcesses$", "-test.v")
		cmd.Env = append(os.Environ(), "GREENROOM_ASSET_TEST_STAGE="+stage, "GREENROOM_ASSET_TEST_ROOT="+root, "GREENROOM_MANAGED=true", "GREENROOM_MANAGED_URL="+server.URL)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s: %v\n%s", stage, err, out)
		}
	}
	if taskReads.Load() != 2 || mediaReads.Load() != 2 || expiredReads.Load() != 1 || ignoredURLReads.Load() != 0 || submits.Load() != 0 {
		t.Fatalf("unexpected recovery calls: task=%d media=%d expired=%d ignored=%d submit=%d", taskReads.Load(), mediaReads.Load(), expiredReads.Load(), ignoredURLReads.Load(), submits.Load())
	}
}

func greenroomAssetProcess(t *testing.T, stage string) {
	root := os.Getenv("GREENROOM_ASSET_TEST_ROOT")
	db, err := gorm.Open(sqlite.Open(filepath.Join(root, "native.sqlite")), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	if stage == "expired" {
		if err := db.AutoMigrate(database.Models()...); err != nil {
			t.Fatal(err)
		}
	}
	s := &Service{repo: repository.New(db), dataDir: root}
	task := model.Task{ID: "original-native-task", UserID: "owner", Provider: "greenroom", ProviderRequestID: "original-provider-task", Type: "canvas_image", Status: model.TaskStatusRunning}
	if stage == "expired" {
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
	} else {
		if err := db.First(&task, "id = ?", task.ID).Error; err != nil {
			t.Fatal(err)
		}
	}
	if task.ProviderRequestID != "original-provider-task" || task.UserID != "owner" {
		t.Fatal("original task identity lost")
	}
	if _, err := s.Task("foreign", task.ID); err == nil {
		t.Fatal("foreign member read original task")
	}
	if stage == "readback" {
		if task.Status != model.TaskStatusSucceeded {
			t.Fatal("result not persisted")
		}
		var result map[string]any
		if err := json.Unmarshal([]byte(task.ResultJSON), &result); err != nil {
			t.Fatal(err)
		}
		item := result["images"].([]any)[0].(map[string]any)
		if item["assetId"] != "owner-asset" {
			t.Fatal("persistent member Asset reference lost")
		}
		id := stringValue(item["resourceId"])
		_, body, err := s.OpenResource("owner", id)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(body)
		body.Close()
		if err != nil {
			t.Fatal(err)
		}
		expected, err := os.ReadFile(filepath.Join(root, "expected.png"))
		if err != nil || !bytes.Equal(data, expected) {
			t.Fatal("persisted resource bytes changed")
		}
		if _, body, err := s.OpenResource("foreign", id); err == nil {
			body.Close()
			t.Fatal("foreign member read persisted resource")
		}
		var count int64
		if err := db.Model(&model.Resource{}).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("resources duplicated: %d %v", count, err)
		}
		return
	}
	result, err := s.runGreenroomMedia(withProviderAnalytics(context.Background(), s, task), "owner", canvasGenerationInput{Mode: "image"}, "{}")
	if stage == "expired" {
		var pending providerStatePendingError
		if !errors.As(err, &pending) || pending.TaskID != task.ProviderRequestID {
			t.Fatalf("expiry lost original task: %v", err)
		}
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	result, err = s.persistGeneratedMediaResult("owner", result)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	task.Status = model.TaskStatusSucceeded
	task.ResultJSON = string(data)
	if err := db.Save(&task).Error; err != nil {
		t.Fatal(err)
	}
}
