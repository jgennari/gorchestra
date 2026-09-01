package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/reposkills"
)

type userSkillCatalogResponse struct {
	HomePath string             `json:"home_path"`
	Skills   []reposkills.Skill `json:"skills"`
}

func (api API) listUserSkillsHandler(w http.ResponseWriter, _ *http.Request) {
	catalog, err := api.repositorySkills.List(api.userHome)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, userSkillCatalogResponse{HomePath: api.userHome, Skills: catalog.Skills})
}

func (api API) getUserSkillHandler(w http.ResponseWriter, r *http.Request) {
	item, err := api.repositorySkills.Get(api.userHome, chi.URLParam(r, "name"))
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (api API) createUserSkillHandler(w http.ResponseWriter, r *http.Request) {
	var input reposkills.Input
	if !decodeJSONBody(w, r, &input) {
		return
	}
	item, err := api.repositorySkills.Create(api.userHome, input)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (api API) updateUserSkillHandler(w http.ResponseWriter, r *http.Request) {
	var input reposkills.Input
	if !decodeJSONBody(w, r, &input) {
		return
	}
	item, err := api.repositorySkills.Update(api.userHome, chi.URLParam(r, "name"), input)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (api API) deleteUserSkillHandler(w http.ResponseWriter, r *http.Request) {
	if err := api.repositorySkills.Delete(api.userHome, chi.URLParam(r, "name")); err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api API) repairUserSkillClaudeBridgeHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ReplaceConflict bool `json:"replace_conflict"`
	}
	if r.ContentLength != 0 && !decodeJSONBody(w, r, &input) {
		return
	}
	result, err := api.repositorySkills.RepairBridge(api.userHome, chi.URLParam(r, "name"), input.ReplaceConflict)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (api API) repairUserSkillClaudeBridgesHandler(w http.ResponseWriter, _ *http.Request) {
	result, err := api.repositorySkills.RepairAll(api.userHome)
	if err != nil {
		writeRepositorySkillError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
