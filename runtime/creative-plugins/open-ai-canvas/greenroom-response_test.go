package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func TestGreenroomNativeErrorMessageContract(t *testing.T) {
	for _, tc := range []struct {
		name    string
		status  int
		message string
		write   func(*gin.Context)
	}{
		{"native business", 400, "设定已锁定，请先解锁", func(c *gin.Context) { failService(c, service.BadAuthRequest("设定已锁定，请先解锁")) }},
		{"public failure", 404, "资源不存在", func(c *gin.Context) { fail(c, 404, errors.New("资源不存在")) }},
		{"internal failure", 500, internalErrorMessage, func(c *gin.Context) { failInternal(c, 500, errors.New("private database credential detail")) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/test", nil)
			tc.write(ctx)
			if recorder.Code != tc.status {
				t.Fatalf("status=%d", recorder.Code)
			}
			var body map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["msg"] != tc.message || body["message"] != tc.message {
				t.Fatalf("safe native reason lost: %s", recorder.Body.String())
			}
			if body["code"] == float64(0) || body["data"] != nil {
				t.Fatalf("failure envelope changed: %s", recorder.Body.String())
			}
		})
	}
}
