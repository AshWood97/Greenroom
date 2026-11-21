package repository

import "yingce/backend/internal/model"

// Resource has no original-task foreign key. Prefilter only this owner's
// successful managed outputs; the caller must match the JSON object exactly.
func (r *Repository) ManagedResourceResults(userID, resourceID string) ([]string, error) {
	var results []string
	err := r.db.Model(&model.Task{}).Where("user_id = ? AND provider = ? AND status = ? AND provider_request_id <> '' AND result_json LIKE ?", userID, "greenroom", model.TaskStatusSucceeded, "%"+resourceID+"%").Pluck("result_json", &results).Error
	return results, err
}
