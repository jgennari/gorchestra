package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type healthResponse struct {
	Status string `json:"status"`
}

func NewRouter() http.Handler {
	r := chi.NewRouter()
	r.Get("/api/health", healthHandler)
	return r
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	body, err := json.Marshal(healthResponse{Status: "ok"})
	if err != nil {
		http.Error(w, "failed to encode health response", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
