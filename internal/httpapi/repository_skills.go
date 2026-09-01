package httpapi

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/reposkills"
)

func (api API) listRepositorySkillsHandler(w http.ResponseWriter, r *http.Request) {
	_, workspace, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	catalog, err := api.repositorySkills.List(workspace)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, catalog)
}

func (api API) getRepositorySkillHandler(w http.ResponseWriter, r *http.Request) {
	_, workspace, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	item, err := api.repositorySkills.Get(workspace, chi.URLParam(r, "name"))
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (api API) createRepositorySkillHandler(w http.ResponseWriter, r *http.Request) {
	_, workspace, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	var input reposkills.Input
	if !decodeJSONBody(w, r, &input) {
		return
	}
	item, err := api.repositorySkills.Create(workspace, input)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (api API) updateRepositorySkillHandler(w http.ResponseWriter, r *http.Request) {
	_, workspace, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	var input reposkills.Input
	if !decodeJSONBody(w, r, &input) {
		return
	}
	item, err := api.repositorySkills.Update(workspace, chi.URLParam(r, "name"), input)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (api API) deleteRepositorySkillHandler(w http.ResponseWriter, r *http.Request) {
	_, workspace, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	if err := api.repositorySkills.Delete(workspace, chi.URLParam(r, "name")); err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api API) repairRepositorySkillClaudeBridgeHandler(w http.ResponseWriter, r *http.Request) {
	_, workspace, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	var input struct {
		ReplaceConflict bool `json:"replace_conflict"`
	}
	if r.ContentLength != 0 && !decodeJSONBody(w, r, &input) {
		return
	}
	result, err := api.repositorySkills.RepairBridge(workspace, chi.URLParam(r, "name"), input.ReplaceConflict)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (api API) repairRepositorySkillClaudeBridgesHandler(w http.ResponseWriter, r *http.Request) {
	_, workspace, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	result, err := api.repositorySkills.RepairAll(workspace)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func writeRepositorySkillError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, reposkills.ErrNotFound):
		writeError(w, http.StatusNotFound, err.Error())
	case errors.Is(err, reposkills.ErrConflict):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, reposkills.ErrReadOnly):
		writeError(w, http.StatusForbidden, err.Error())
	default:
		// Validation and path errors are deliberately returned without wrapping.
		if errors.Is(err, reposkills.ErrNotFound) {
			writeError(w, http.StatusNotFound, err.Error())
			return
		}
		writeError(w, http.StatusBadRequest, err.Error())
	}
}
