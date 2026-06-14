package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
)

func (api API) agentOptionsHandler(w http.ResponseWriter, r *http.Request) {
	agentType := strings.TrimSpace(chi.URLParam(r, "agentType"))
	if agentType == "" {
		writeError(w, http.StatusBadRequest, "agent_type is required")
		return
	}

	agent, ok := api.agents.Get(agentType)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported agent_type")
		return
	}
	if !api.agentAvailable(w, agent) {
		return
	}

	optionsProvider, ok := agent.(agents.OptionsProvider)
	if !ok {
		writeError(w, http.StatusNotFound, "agent options unavailable")
		return
	}

	options, err := optionsProvider.Options(r.Context())
	if err != nil {
		if errors.Is(err, agents.ErrUnavailable) {
			writeError(w, http.StatusServiceUnavailable, "agent unavailable")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent options")
		return
	}

	writeJSON(w, http.StatusOK, options)
}
