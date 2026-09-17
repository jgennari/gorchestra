package httpapi

import (
	"net/http"

	"github.com/jgennari/gorchestra/internal/agents"
)

type agentCatalog interface {
	List() []agents.Agent
}

type agentCatalogEntry struct {
	Type       string `json:"type"`
	Available  bool   `json:"available"`
	Error      string `json:"error,omitempty"`
	HasOptions bool   `json:"has_options"`
}

func (api API) capabilitiesHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"schema_version": 1,
		"capabilities": []string{
			"agents.list", "agents.options", "runs.create", "runs.show", "runs.report",
			"runs.events", "runs.stream", "runs.wait", "runs.cancel",
			"sessions.send", "sessions.queue", "sessions.steer", "requests.control",
		},
	})
}

func (api API) agentsHandler(w http.ResponseWriter, _ *http.Request) {
	catalog, ok := api.agents.(agentCatalog)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "agent catalog is unavailable")
		return
	}
	entries := make([]agentCatalogEntry, 0)
	for _, agent := range catalog.List() {
		entry := agentCatalogEntry{Type: agent.Type()}
		_, entry.HasOptions = agent.(agents.OptionsProvider)
		if availability, ok := agent.(agents.Availability); ok {
			if err := availability.Available(); err != nil {
				entry.Error = err.Error()
			} else {
				entry.Available = true
			}
		} else {
			entry.Available = true
		}
		entries = append(entries, entry)
	}
	writeJSON(w, http.StatusOK, map[string]any{"schema_version": 1, "agents": entries})
}
