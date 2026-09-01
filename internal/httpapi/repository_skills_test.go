package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents/fake"
	"github.com/jgennari/gorchestra/internal/reposkills"
)

func TestRepositorySkillCRUDAPI(t *testing.T) {
	ctx := context.Background()
	workspace := t.TempDir()
	database, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, workspace, fake.New())
	session := createIntegrationSession(t, ctx, database)
	base := "/api/sessions/" + session.ID + "/repository-skills"

	listed := httptest.NewRecorder()
	handler.ServeHTTP(listed, httptest.NewRequest(http.MethodGet, base, nil))
	if listed.Code != http.StatusOK || strings.TrimSpace(listed.Body.String()) != "{\"skills\":[]}" {
		t.Fatalf("unexpected empty list: status=%d body=%s", listed.Code, listed.Body.String())
	}

	created := postJSON(handler, base, `{"name":"review-code","description":"Review code changes","instructions":"# Review\n\nInspect tests."}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create: status=%d body=%s", created.Code, created.Body.String())
	}
	var skill reposkills.Skill
	decodeJSON(t, created, &skill)
	if !skill.Editable || skill.ClaudeBridge.Status != "linked" || skill.Revision == "" {
		t.Fatalf("unexpected created skill: %#v", skill)
	}

	detail := httptest.NewRecorder()
	handler.ServeHTTP(detail, httptest.NewRequest(http.MethodGet, base+"/review-code", nil))
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), "Inspect tests") {
		t.Fatalf("get: status=%d body=%s", detail.Code, detail.Body.String())
	}

	stale := patchJSON(handler, base+"/review-code", `{"name":"review-code","description":"Changed","instructions":"Changed","revision":"stale"}`)
	if stale.Code != http.StatusConflict {
		t.Fatalf("expected revision conflict, status=%d body=%s", stale.Code, stale.Body.String())
	}

	updated := patchJSON(handler, base+"/review-code", `{"name":"review-pr","description":"Review pull requests","instructions":"Updated","revision":"`+skill.Revision+`"}`)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"name":"review-pr"`) {
		t.Fatalf("update: status=%d body=%s", updated.Code, updated.Body.String())
	}

	deleted := httptest.NewRecorder()
	handler.ServeHTTP(deleted, httptest.NewRequest(http.MethodDelete, base+"/review-pr", nil))
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete: status=%d body=%s", deleted.Code, deleted.Body.String())
	}
}

func TestRepositorySkillAPIRejectsTraversal(t *testing.T) {
	ctx := context.Background()
	workspace := t.TempDir()
	database, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, workspace, fake.New())
	session := createIntegrationSession(t, ctx, database)
	created := postJSON(handler, "/api/sessions/"+session.ID+"/repository-skills", `{"name":"../escape","description":"No","instructions":"No"}`)
	if created.Code != http.StatusBadRequest {
		t.Fatalf("expected bad request, status=%d body=%s", created.Code, created.Body.String())
	}
}

func TestUserSkillCRUDAPIUsesServiceUserHome(t *testing.T) {
	ctx := context.Background()
	userHome := t.TempDir()
	t.Setenv("HOME", userHome)
	_, _, _, handler := newIntegrationAPI(t, ctx, fake.New())

	created := postJSON(handler, "/api/user-skills", `{"name":"personal-review","description":"Review my projects","instructions":"# Review\n\nInspect carefully."}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create user skill: status=%d body=%s", created.Code, created.Body.String())
	}
	var skill reposkills.Skill
	decodeJSON(t, created, &skill)
	if skill.ClaudeBridge.Status != "linked" || skill.Revision == "" {
		t.Fatalf("unexpected user skill: %#v", skill)
	}
	if _, err := os.Stat(filepath.Join(userHome, ".agents", "skills", "personal-review", "SKILL.md")); err != nil {
		t.Fatalf("user skill was not created beneath HOME: %v", err)
	}

	listed := httptest.NewRecorder()
	handler.ServeHTTP(listed, httptest.NewRequest(http.MethodGet, "/api/user-skills", nil))
	if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), userHome) || !strings.Contains(listed.Body.String(), "personal-review") {
		t.Fatalf("list user skills: status=%d body=%s", listed.Code, listed.Body.String())
	}

	deleted := httptest.NewRecorder()
	handler.ServeHTTP(deleted, httptest.NewRequest(http.MethodDelete, "/api/user-skills/personal-review", nil))
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete user skill: status=%d body=%s", deleted.Code, deleted.Body.String())
	}
}
