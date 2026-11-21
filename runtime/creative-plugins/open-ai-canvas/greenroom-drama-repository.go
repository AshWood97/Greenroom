package repository

import "yingce/backend/internal/model"

// Refresh only the receipt projection of the same completed attempt. A query
// racing a user edit/retry must never overwrite lifecycle or a newer task ID.
func (r *Repository) SaveManagedDramaReceipt(job *model.DramaJob, previousAttempts string) (bool, error) {
	result := r.db.Model(&model.DramaJob{}).Where("id = ? AND project_id = ? AND task_id = ? AND status = ? AND attempts_json = ?", job.ID, job.ProjectID, job.TaskID, job.Status, previousAttempts).Updates(map[string]any{"cost_microcredits": job.CostMicrocredits, "attempts_json": job.AttemptsJSON})
	return result.RowsAffected == 1, result.Error
}

// A bounded audit read for the historical, locally rejected bridge URL. No
// response/request body beyond the needed rejection evidence is loaded.
func (r *Repository) ManagedTaskCallEvidence(taskID, userID string) ([]model.ApiCallLog, error) {
	var logs []model.ApiCallLog
	err := r.db.Select("method", "path", "upstream_url", "status_code", "error_code", "provider_request_id", "request_kind", "response_body").Where("task_id = ? AND user_id = ?", taskID, userID).Order("created_at ASC").Limit(33).Find(&logs).Error
	return logs, err
}
