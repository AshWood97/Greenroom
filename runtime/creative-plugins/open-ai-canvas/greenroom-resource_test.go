package app

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

// Deliberately seeds exact rows and plain fixture bytes. It does not call
// storage writers, task workers, auth, DSH, Simulator or content hash helpers.
func TestGreenroomMissingLocalResourceRestoresExactMemberAsset(t *testing.T) {
	for _, scenario := range []string{"restore", "foreign", "no_mapping", "conflict", "raw_url", "failed_task", "foreign_task", "unmanaged_task", "wrong_shape", "denied", "redirect", "missing_asset", "partial", "oversize", "existing", "empty_existing", "dangling_link", "parent_link", "racing_file", "racing_link", "preexisting_stage", "replaced_stage", "missing_parent"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			db, err := gorm.Open(sqlite.Open(filepath.Join(root, "native.sqlite")), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, err := db.DB()
			if err != nil {
				t.Fatal(err)
			}
			defer sqlDB.Close()
			if err := db.AutoMigrate(&model.Resource{}, &model.Task{}); err != nil {
				t.Fatal(err)
			}
			s := &Service{repo: repository.New(db), dataDir: root}
			resource := model.Resource{ID: "original-resource", UserID: "owner", Kind: "image", Provider: "local", Status: model.ResourceStatusReady, ObjectKey: "users/owner/image.png", MimeType: "image/png", Size: 5}
			item := map[string]any{"resourceId": resource.ID, "storageKey": "resource:" + resource.ID, "assetId": "original-asset", "mimeType": resource.MimeType, "bytes": resource.Size}
			result := map[string]any{"mode": "image", "images": []any{item}}
			task := model.Task{ID: "original-task", UserID: "owner", Provider: "greenroom", ProviderRequestID: "original-provider-task", Status: model.TaskStatusSucceeded}
			switch scenario {
			case "no_mapping":
				delete(item, "assetId")
			case "conflict":
				other := map[string]any{}
				for k, v := range item {
					other[k] = v
				}
				other["assetId"] = "other-asset"
				result["images"] = []any{item, other}
			case "raw_url":
				item["assetId"] = "http://127.0.0.1/not-an-asset"
			case "failed_task":
				task.Status = model.TaskStatusFailed
			case "foreign_task":
				task.UserID = "foreign"
			case "unmanaged_task":
				task.Provider = "native"
			case "wrong_shape":
				result = map[string]any{"mode": "text", "metadata": item}
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			task.ResultJSON = string(encoded)
			if err := db.Create(&resource).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.First(&resource, "id = ?", resource.ID).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.First(&task, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(root, "resources", filepath.FromSlash(resource.ObjectKey))
			if err := os.MkdirAll(filepath.Dir(target), 0750); err != nil {
				t.Fatal(err)
			}
			staging := filepath.Join(filepath.Dir(target), "."+filepath.Base(target)+".greenroom-restore")
			changed := []byte("user-edited")
			switch scenario {
			case "preexisting_stage":
				if err := os.WriteFile(staging, changed, 0600); err != nil {
					t.Fatal(err)
				}
			case "missing_parent":
				if err := os.Remove(filepath.Dir(target)); err != nil {
					t.Fatal(err)
				}
			case "existing":
				if err := os.WriteFile(target, changed, 0600); err != nil {
					t.Fatal(err)
				}
			case "empty_existing":
				if err := os.WriteFile(target, nil, 0600); err != nil {
					t.Fatal(err)
				}
			case "dangling_link":
				if err := os.Symlink("absent", target); err != nil {
					t.Fatal(err)
				}
			case "parent_link":
				if err := os.Remove(filepath.Dir(target)); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(root, "other"), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(filepath.Join(root, "other"), filepath.Dir(target)); err != nil {
					t.Fatal(err)
				}
			}
			var reads, otherCalls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.URL.Path != "/media/original-asset" {
					otherCalls.Add(1)
					http.Error(w, "forbidden", 405)
					return
				}
				reads.Add(1)
				switch scenario {
				case "replaced_stage":
					w.Header().Set("Content-Length", "5")
					w.WriteHeader(http.StatusOK)
					w.(http.Flusher).Flush()
					deadline := time.Now().Add(2 * time.Second)
					for {
						if _, err := os.Lstat(staging); err == nil {
							break
						}
						if time.Now().After(deadline) {
							t.Error("staging did not appear")
							return
						}
						time.Sleep(time.Millisecond)
					}
					if err := os.Remove(staging); err != nil {
						t.Error(err)
						return
					}
					if err := os.WriteFile(staging, changed, 0600); err != nil {
						t.Error(err)
						return
					}
				case "redirect":
					http.Redirect(w, r, "/not-an-asset", 302)
					return
				case "denied":
					http.Error(w, "denied", 403)
					return
				case "missing_asset":
					http.Error(w, "missing", 404)
					return
				case "partial":
					io.WriteString(w, "abc")
					return
				case "oversize":
					io.WriteString(w, "abcdef")
					return
				case "racing_file":
					if err := os.WriteFile(target, changed, 0600); err != nil {
						t.Error(err)
					}
				case "racing_link":
					if err := os.Symlink("absent", target); err != nil {
						t.Error(err)
					}
				}
				io.WriteString(w, "abcde")
			}))
			defer server.Close()
			t.Setenv("GREENROOM_MANAGED", "true")
			t.Setenv("GREENROOM_MANAGED_URL", server.URL)
			user := "owner"
			if scenario == "foreign" {
				user = "foreign"
			}
			_, body, readErr := s.OpenResource(user, resource.ID)
			switch scenario {
			case "restore", "existing", "empty_existing":
				if readErr != nil {
					t.Fatal(readErr)
				}
				data, err := io.ReadAll(body)
				body.Close()
				if err != nil {
					t.Fatal(err)
				}
				expected := "abcde"
				if scenario == "existing" {
					expected = string(changed)
				}
				if scenario == "empty_existing" {
					expected = ""
				}
				if string(data) != expected {
					t.Fatalf("content %q != %q", data, expected)
				}
			default:
				if readErr == nil {
					body.Close()
					t.Fatal("unexpected successful restore")
				}
				if scenario != "foreign" && !errors.Is(readErr, os.ErrNotExist) {
					t.Fatalf("original missing-file error changed: %v", readErr)
				}
			}
			wantReads := int32(0)
			switch scenario {
			case "restore", "denied", "redirect", "missing_asset", "partial", "oversize", "racing_file", "racing_link", "replaced_stage":
				wantReads = 1
			}
			if reads.Load() != wantReads || otherCalls.Load() != 0 {
				t.Fatalf("unexpected upstream reads=%d other=%d", reads.Load(), otherCalls.Load())
			}
			switch scenario {
			case "restore", "existing", "empty_existing", "dangling_link", "racing_file", "racing_link":
				// These cases deliberately retain or publish a target entry.
			default:
				if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("failed restore published a target: %v", err)
				}
			}
			if scenario == "racing_file" {
				data, err := os.ReadFile(target)
				if err != nil || string(data) != string(changed) {
					t.Fatal("concurrent file overwritten")
				}
			}
			if scenario == "dangling_link" || scenario == "racing_link" {
				info, err := os.Lstat(target)
				if err != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatal("link overwritten")
				}
			}
			if scenario == "restore" {
				reopened := &Service{repo: repository.New(db), dataDir: root}
				_, body, err := reopened.OpenResource("owner", resource.ID)
				if err != nil {
					t.Fatal(err)
				}
				body.Close()
				if reads.Load() != 1 {
					t.Fatal("existing restored file fetched again")
				}
			}
			if scenario == "preexisting_stage" || scenario == "replaced_stage" {
				data, err := os.ReadFile(staging)
				if err != nil || string(data) != string(changed) {
					t.Fatal("unowned staging replacement changed")
				}
			} else {
				remaining, err := filepath.Glob(filepath.Join(filepath.Dir(target), "*.greenroom-restore"))
				if err != nil || len(remaining) != 0 {
					t.Fatal("staging bytes retained")
				}
			}
			var savedResource model.Resource
			var savedTask model.Task
			if err := db.First(&savedResource, "id = ?", resource.ID).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.First(&savedTask, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(savedResource, resource) || !reflect.DeepEqual(savedTask, task) {
				t.Fatal("restore changed original metadata")
			}
		})
	}
}
