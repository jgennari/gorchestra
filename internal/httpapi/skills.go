package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/store"
)

const maxSubmitSkills = 16

func (api API) sessionSkillsHandler(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionId")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return
	}

	agent, ok := api.agents.Get(session.AgentType)
	if !ok {
		writeError(w, http.StatusBadRequest, "unsupported agent_type")
		return
	}
	if !api.agentAvailable(w, agent) {
		return
	}
	provider, ok := agent.(agents.SkillProvider)
	if !ok {
		writeError(w, http.StatusNotFound, "agent skills unavailable")
		return
	}

	catalog, err := provider.Skills(r.Context(), agents.SkillQuery{
		Workdir:     sessionWorkspacePath(session, api.workdir),
		ForceReload: r.URL.Query().Get("refresh") == "true",
	})
	if err != nil {
		if errors.Is(err, agents.ErrUnavailable) {
			writeError(w, http.StatusServiceUnavailable, "agent unavailable")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to load agent skills")
		return
	}

	enabled := catalog.Skills[:0]
	for _, skill := range catalog.Skills {
		if skill.Enabled {
			enabled = append(enabled, skill)
		}
	}
	catalog.Skills = enabled
	writeJSON(w, http.StatusOK, catalog)
}

func (api API) validateSkillReferences(
	ctx context.Context,
	session store.Session,
	requested []submitSkillReference,
) ([]agents.SkillReference, error) {
	if len(requested) == 0 {
		return nil, nil
	}
	if len(requested) > maxSubmitSkills {
		return nil, fmt.Errorf("select up to %d skills", maxSubmitSkills)
	}

	agent, ok := api.agents.Get(session.AgentType)
	if !ok {
		return nil, errors.New("unsupported agent_type")
	}
	provider, ok := agent.(agents.SkillProvider)
	if !ok {
		return nil, errors.New("agent does not support skills")
	}
	catalog, err := provider.Skills(ctx, agents.SkillQuery{Workdir: sessionWorkspacePath(session, api.workdir)})
	if err != nil {
		return nil, fmt.Errorf("load agent skills: %w", err)
	}

	available := make(map[string]struct{}, len(catalog.Skills))
	for _, skill := range catalog.Skills {
		if !skill.Enabled {
			continue
		}
		available[skillReferenceKey(skill.Name, skill.Path)] = struct{}{}
	}

	validated := make([]agents.SkillReference, 0, len(requested))
	seen := make(map[string]struct{}, len(requested))
	for _, reference := range requested {
		name := strings.TrimSpace(reference.Name)
		path := strings.TrimSpace(reference.Path)
		if name == "" || path == "" {
			return nil, errors.New("skill name and path are required")
		}
		key := skillReferenceKey(name, path)
		if _, ok := available[key]; !ok {
			return nil, fmt.Errorf("skill %q is not available to this session", name)
		}
		if _, duplicate := seen[key]; duplicate {
			return nil, fmt.Errorf("skill %q was selected more than once", name)
		}
		seen[key] = struct{}{}
		validated = append(validated, agents.SkillReference{Name: name, Path: path})
	}
	return validated, nil
}

func skillReferenceKey(name string, path string) string {
	return strings.TrimSpace(name) + "\x00" + strings.TrimSpace(path)
}
