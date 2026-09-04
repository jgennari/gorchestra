package httpapi

import (
	"net/http"
	"time"
)

type eventMaintenanceStatusResponse struct {
	Running             bool    `json:"running"`
	LastStartedAt       *string `json:"last_started_at"`
	LastCompletedAt     *string `json:"last_completed_at"`
	LastError           string  `json:"last_error,omitempty"`
	DeletedDeltaEvents  int64   `json:"deleted_delta_events"`
	DeletedDebugEvents  int64   `json:"deleted_debug_events"`
	ExtractedBlobEvents int64   `json:"extracted_blob_events"`
	ReclaimedBytes      int64   `json:"reclaimed_bytes"`
	RetainedDebugAfter  *string `json:"retained_debug_after"`
}

func (api API) eventMaintenanceStatusHandler(w http.ResponseWriter, r *http.Request) {
	status, err := api.maintenance.Status(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load event maintenance status")
		return
	}
	writeJSON(w, http.StatusOK, eventMaintenanceStatusResponse{
		Running:             status.Running,
		LastStartedAt:       maintenanceTimeResponse(status.LastStartedAt),
		LastCompletedAt:     maintenanceTimeResponse(status.LastCompletedAt),
		LastError:           status.LastError,
		DeletedDeltaEvents:  status.DeletedDeltaEvents,
		DeletedDebugEvents:  status.DeletedDebugEvents,
		ExtractedBlobEvents: status.ExtractedBlobEvents,
		ReclaimedBytes:      status.ReclaimedBytes,
		RetainedDebugAfter:  maintenanceTimeResponse(status.RetainedDebugAfter),
	})
}

func maintenanceTimeResponse(value *time.Time) *string {
	if value == nil {
		return nil
	}
	formatted := value.UTC().Format(time.RFC3339Nano)
	return &formatted
}
