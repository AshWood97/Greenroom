package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"yingce/backend/internal/model"
)

// Only restore an absent local file from a completed managed result belonging
// to this owner. This never creates a resource/task or replays generation.
func (s *Service) greenroomRestoreMissingResource(userID string, resource *model.Resource) bool {
	if !greenroomEnabled() || resource.Provider != "local" || resource.Status != model.ResourceStatusReady || resource.UserID != userID || resource.Size <= 0 {
		return false
	}
	current, err := s.repo.ResourceForUser(userID, resource.ID)
	if err != nil || current.ObjectKey != resource.ObjectKey || current.Provider != "local" || current.Status != model.ResourceStatusReady || current.Size != resource.Size || current.Kind != resource.Kind || current.MimeType != resource.MimeType {
		return false
	}
	key := filepath.FromSlash(resource.ObjectKey)
	if !filepath.IsLocal(key) || filepath.Clean(key) != key {
		return false
	}
	rootPath := filepath.Join(s.dataDir, "resources")
	info, err := os.Lstat(rootPath)
	if err != nil || !info.IsDir() {
		return false
	}
	dir, err := os.OpenRoot(rootPath)
	if err != nil {
		return false
	}
	defer func() { dir.Close() }()
	opened, err := dir.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		return false
	}
	parts := strings.Split(key, string(filepath.Separator))
	for _, part := range parts[:len(parts)-1] {
		info, err := dir.Lstat(part)
		if err != nil || !info.IsDir() {
			return false
		}
		next, err := dir.OpenRoot(part)
		if err != nil {
			return false
		}
		opened, err := next.Stat(".")
		if err != nil || !os.SameFile(info, opened) {
			next.Close()
			return false
		}
		dir.Close()
		dir = next
	}
	name := parts[len(parts)-1]
	temp := "." + name + ".greenroom-restore"
	if _, err := dir.Lstat(name); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	if _, err := dir.Lstat(temp); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	results, err := s.repo.ManagedResourceResults(userID, resource.ID)
	if err != nil {
		return false
	}
	assetID := ""
	for _, raw := range results {
		var result map[string]any
		if json.Unmarshal([]byte(raw), &result) != nil {
			return false
		}
		if result["mode"] != resource.Kind {
			continue
		}
		var items []any
		switch result["mode"] {
		case "image":
			items, _ = result["images"].([]any)
		case "video":
			items = []any{result["video"]}
		case "audio":
			items, _ = result["audios"].([]any)
			items = append(items, result["audio"])
		default:
			continue
		}
		for _, value := range items {
			item, ok := value.(map[string]any)
			if !ok || item["resourceId"] != resource.ID {
				continue
			}
			id, ok := item["assetId"].(string)
			if !ok || !greenroomResourceAssetID(id) || item["storageKey"] != "resource:"+resource.ID || item["mimeType"] != resource.MimeType || item["bytes"] != float64(resource.Size) || (assetID != "" && assetID != id) {
				return false
			}
			assetID = id
		}
	}
	if assetID == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, greenroomURL()+"/media/"+assetID, nil)
	if err != nil {
		return false
	}
	client := *http.DefaultClient
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(req)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	// Fixed exclusive staging name coordinates concurrent reads without modifying
	// an existing target. Missing parent directories or an existing staging file
	// are not repaired/cleared. No content digest or native storage writer is used.
	file, err := dir.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return false
	}
	staged, err := file.Stat()
	if err != nil {
		file.Close()
		return false
	}
	defer func() {
		current, err := dir.Lstat(temp)
		if err == nil && current.Mode().IsRegular() && os.SameFile(staged, current) {
			dir.Remove(temp)
		}
	}()
	count, copyErr := io.Copy(file, io.LimitReader(response.Body, resource.Size+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || count != resource.Size {
		return false
	}
	current, err = s.repo.ResourceForUser(userID, resource.ID)
	if err != nil || current.ObjectKey != resource.ObjectKey || current.Provider != "local" || current.Status != model.ResourceStatusReady || current.Size != resource.Size || current.Kind != resource.Kind || current.MimeType != resource.MimeType {
		return false
	}
	stageNow, err := dir.Lstat(temp)
	if err != nil || !stageNow.Mode().IsRegular() || !os.SameFile(staged, stageNow) {
		return false
	}
	// Hard-link publication is atomic and refuses any concurrent file or symlink.
	return dir.Link(temp, name) == nil
}

func greenroomResourceAssetID(id string) bool {
	if id == "" {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}
