package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/agents/fake"
	eventservice "github.com/jgennari/gorchestra/internal/events"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestCreateSessionCreatesIdleFakeAgentSession(t *testing.T) {
	ctx := context.Background()
	workspace := canonicalPath(t, t.TempDir())
	dbStore, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, workspace, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"fake","title":"Inspect repository"}`)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var response createSessionResponse
	decodeJSON(t, rec, &response)
	if response.SessionID == "" {
		t.Fatal("expected session_id")
	}

	session, err := dbStore.GetSession(ctx, response.SessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.AgentType != "fake" {
		t.Fatalf("expected fake agent type, got %q", session.AgentType)
	}
	if session.Title != "Inspect repository" {
		t.Fatalf("expected title Inspect repository, got %q", session.Title)
	}
	if session.Status != store.SessionStatusIdle {
		t.Fatalf("expected idle status, got %q", session.Status)
	}
	if session.WorkspacePath != workspace {
		t.Fatalf("expected workspace path %q, got %q", workspace, session.WorkspacePath)
	}
}

func TestCreateSessionAcceptsWorkspaceInsideAllowedRoot(t *testing.T) {
	ctx := context.Background()
	root := canonicalPath(t, t.TempDir())
	project := filepath.Join(root, "project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatalf("create project directory: %v", err)
	}
	dbStore, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, root, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"fake","workspace_path":`+quoteJSON(project)+`}`)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusCreated, rec.Code, rec.Body.String())
	}
	var response createSessionResponse
	decodeJSON(t, rec, &response)
	session, err := dbStore.GetSession(ctx, response.SessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.WorkspacePath != project {
		t.Fatalf("expected workspace path %q, got %q", project, session.WorkspacePath)
	}
}

func TestCreateSessionRejectsWorkspaceOutsideAllowedRoots(t *testing.T) {
	ctx := context.Background()
	root := canonicalPath(t, t.TempDir())
	outside := canonicalPath(t, t.TempDir())
	_, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, root, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"fake","workspace_path":`+quoteJSON(outside)+`}`)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusForbidden, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "workspace is outside allowed roots")
}

func TestWorkspaceRootsAndBrowseExposeAllowedServerDirectories(t *testing.T) {
	ctx := context.Background()
	root := canonicalPath(t, t.TempDir())
	project := filepath.Join(root, "project")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatalf("create project directory: %v", err)
	}
	_, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, root, fake.New())

	rootsRec := get(handler, "/api/workspaces/roots")
	if rootsRec.Code != http.StatusOK {
		t.Fatalf("expected roots status %d, got %d with body %s", http.StatusOK, rootsRec.Code, rootsRec.Body.String())
	}
	var rootsResponse workspaceRootsResponse
	decodeJSON(t, rootsRec, &rootsResponse)
	if len(rootsResponse.Roots) != 1 || rootsResponse.Roots[0].Path != root || !rootsResponse.Roots[0].Default {
		t.Fatalf("expected default root %q, got %#v", root, rootsResponse.Roots)
	}

	browseRec := get(handler, "/api/workspaces/browse?root_id="+rootsResponse.Roots[0].ID)
	if browseRec.Code != http.StatusOK {
		t.Fatalf("expected browse status %d, got %d with body %s", http.StatusOK, browseRec.Code, browseRec.Body.String())
	}
	var browseResponse workspaceBrowseResponse
	decodeJSON(t, browseRec, &browseResponse)
	if len(browseResponse.Entries) != 1 || browseResponse.Entries[0].Name != "project" || browseResponse.Entries[0].Type != "directory" {
		t.Fatalf("expected project directory, got %#v", browseResponse.Entries)
	}
}

func TestSessionFileAPIsListSearchAndReadWorkspaceFiles(t *testing.T) {
	ctx := context.Background()
	workspace := canonicalPath(t, t.TempDir())
	if err := os.Mkdir(filepath.Join(workspace, "src"), 0o755); err != nil {
		t.Fatalf("create src directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}
	dbStore, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, workspace, fake.New())
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:         "Files",
		AgentType:     "fake",
		WorkspacePath: workspace,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	listRec := get(handler, "/api/sessions/"+session.ID+"/files")
	if listRec.Code != http.StatusOK {
		t.Fatalf("expected list status %d, got %d with body %s", http.StatusOK, listRec.Code, listRec.Body.String())
	}
	var listResponse workspaceBrowseResponse
	decodeJSON(t, listRec, &listResponse)
	if len(listResponse.Entries) != 1 || listResponse.Entries[0].Name != "src" {
		t.Fatalf("expected src entry, got %#v", listResponse.Entries)
	}

	searchRec := get(handler, "/api/sessions/"+session.ID+"/files/search?q=main")
	if searchRec.Code != http.StatusOK {
		t.Fatalf("expected search status %d, got %d with body %s", http.StatusOK, searchRec.Code, searchRec.Body.String())
	}
	var searchResponse workspaceSearchResponse
	decodeJSON(t, searchRec, &searchResponse)
	if len(searchResponse.Results) != 1 || searchResponse.Results[0].Path != "src/main.go" {
		t.Fatalf("expected src/main.go search result, got %#v", searchResponse.Results)
	}

	contentRec := get(handler, "/api/sessions/"+session.ID+"/files/content?path="+url.QueryEscape("src/main.go"))
	if contentRec.Code != http.StatusOK {
		t.Fatalf("expected content status %d, got %d with body %s", http.StatusOK, contentRec.Code, contentRec.Body.String())
	}
	var contentResponse workspaceFileContentResponse
	decodeJSON(t, contentRec, &contentResponse)
	if contentResponse.Content != "package main\n" || contentResponse.Encoding != "utf-8" {
		t.Fatalf("expected text file content, got %#v", contentResponse)
	}

	updateRec := putJSON(handler, "/api/sessions/"+session.ID+"/files/content?path="+url.QueryEscape("src/main.go"), `{"content":"package main\n\nfunc main() {}\n"}`)
	if updateRec.Code != http.StatusOK {
		t.Fatalf("expected update status %d, got %d with body %s", http.StatusOK, updateRec.Code, updateRec.Body.String())
	}
	var updatedContent workspaceFileContentResponse
	decodeJSON(t, updateRec, &updatedContent)
	if updatedContent.Content != "package main\n\nfunc main() {}\n" {
		t.Fatalf("expected updated content, got %#v", updatedContent.Content)
	}
	persisted, err := os.ReadFile(filepath.Join(workspace, "src", "main.go"))
	if err != nil {
		t.Fatalf("read persisted source file: %v", err)
	}
	if string(persisted) != updatedContent.Content {
		t.Fatalf("expected persisted content %q, got %q", updatedContent.Content, string(persisted))
	}

	if err := os.WriteFile(filepath.Join(workspace, "src", "image.bin"), []byte{0x00, 0x01}, 0o644); err != nil {
		t.Fatalf("write binary file: %v", err)
	}
	binaryUpdateRec := putJSON(handler, "/api/sessions/"+session.ID+"/files/content?path="+url.QueryEscape("src/image.bin"), `{"content":"text"}`)
	if binaryUpdateRec.Code != http.StatusBadRequest {
		t.Fatalf("expected binary update status %d, got %d with body %s", http.StatusBadRequest, binaryUpdateRec.Code, binaryUpdateRec.Body.String())
	}
	assertErrorResponse(t, binaryUpdateRec, "file must be UTF-8 text")
}

func TestCreateSessionRejectsUnsupportedAgent(t *testing.T) {
	ctx := context.Background()
	_, _, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"codex"}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "unsupported agent_type")
}

func TestCreateSessionAcceptsAvailableCodexAgent(t *testing.T) {
	ctx := context.Background()
	codexAgent := availabilityAgent{agentType: "codex"}
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, codexAgent)

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"codex","title":"Real run"}`)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var response createSessionResponse
	decodeJSON(t, rec, &response)
	session, err := dbStore.GetSession(ctx, response.SessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if session.AgentType != "codex" {
		t.Fatalf("expected codex agent type, got %q", session.AgentType)
	}
}

func TestCreateSessionStoresCodexRunDangerouslyOption(t *testing.T) {
	ctx := context.Background()
	codexAgent := availabilityAgent{agentType: "codex"}
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, codexAgent)

	rec := postJSON(handler, "/api/sessions", `{
		"agent_type":"codex",
		"title":"Danger run",
		"agent_options":{"codex":{"run_dangerously":true}}
	}`)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusCreated, rec.Code, rec.Body.String())
	}

	var response createSessionResponse
	decodeJSON(t, rec, &response)
	session, err := dbStore.GetSession(ctx, response.SessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	var options map[string]map[string]any
	if err := json.Unmarshal(session.AgentOptions, &options); err != nil {
		t.Fatalf("decode agent options: %v", err)
	}
	if options["codex"]["run_dangerously"] != true {
		t.Fatalf("expected run_dangerously option, got %#v", options)
	}

	var sessionResponse sessionResponse
	getRec := get(handler, "/api/sessions/"+response.SessionID)
	decodeJSON(t, getRec, &sessionResponse)
	responseOptions, ok := sessionResponse.AgentOptions.(map[string]any)
	if !ok {
		t.Fatalf("expected response agent options map, got %#v", sessionResponse.AgentOptions)
	}
	codexOptions, ok := responseOptions["codex"].(map[string]any)
	if !ok || codexOptions["run_dangerously"] != true {
		t.Fatalf("expected response run_dangerously option, got %#v", responseOptions)
	}
}

func TestCreateSessionReturnsUnavailableForRegisteredUnavailableAgent(t *testing.T) {
	ctx := context.Background()
	codexAgent := availabilityAgent{agentType: "codex", availableErr: agents.ErrUnavailable}
	_, _, _, handler := newIntegrationAPI(t, ctx, codexAgent)

	rec := postJSON(handler, "/api/sessions", `{"agent_type":"codex"}`)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "agent unavailable")
}

func TestAgentOptionsReturnsProviderOptions(t *testing.T) {
	ctx := context.Background()
	codexAgent := optionsAgent{
		agentType: "codex",
		options: agents.Options{
			DefaultModel: "gpt-5.5",
			Models: []agents.ModelOption{
				{
					Model:                  "gpt-5.5",
					DisplayName:            "GPT-5.5",
					DefaultReasoningEffort: "medium",
					IsDefault:              true,
				},
			},
			CollaborationModes: []agents.CollaborationModeOption{{Name: "Plan", Mode: "plan"}},
		},
	}
	_, _, _, handler := newIntegrationAPI(t, ctx, codexAgent)

	req := httptest.NewRequest(http.MethodGet, "/api/agents/codex/options", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response agents.Options
	decodeJSON(t, rec, &response)
	if response.DefaultModel != "gpt-5.5" {
		t.Fatalf("expected default model gpt-5.5, got %q", response.DefaultModel)
	}
	if len(response.Models) != 1 || response.Models[0].DisplayName != "GPT-5.5" {
		t.Fatalf("expected model options, got %#v", response.Models)
	}
	if len(response.CollaborationModes) != 1 || response.CollaborationModes[0].Mode != "plan" {
		t.Fatalf("expected plan collaboration mode, got %#v", response.CollaborationModes)
	}
}

func TestCreateSessionRejectsMissingAgentType(t *testing.T) {
	ctx := context.Background()
	_, _, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions", `{"title":"No agent"}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "agent_type is required")
}

func TestMessageSubmissionPersistsUserMessageAndMarksSessionRunning(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session := createIntegrationSession(t, ctx, dbStore)
	t.Cleanup(func() {
		agent.release()
		waitFor(t, func() bool {
			session, err := dbStore.GetSession(ctx, session.ID)
			return err == nil && session.Status == store.SessionStatusIdle
		})
	})

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Inspect this repo"}`)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var response submitMessageResponse
	decodeJSON(t, rec, &response)
	if response.SessionID != session.ID {
		t.Fatalf("expected session_id %q, got %q", session.ID, response.SessionID)
	}
	if response.Status != string(store.SessionStatusRunning) {
		t.Fatalf("expected response status running, got %q", response.Status)
	}

	updatedSession, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updatedSession.Status != store.SessionStatusRunning {
		t.Fatalf("expected session status running, got %q", updatedSession.Status)
	}

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{"user.message.completed", "session.status.updated"})
	if events[0].Role != "user" {
		t.Fatalf("expected user role, got %q", events[0].Role)
	}
	if events[0].Status != store.EventStatusCompleted {
		t.Fatalf("expected completed user event, got %q", events[0].Status)
	}
	assertPayloadText(t, events[0], "Inspect this repo")
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)
}

func TestMessageSubmissionAcceptsImageAttachments(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session := createIntegrationSession(t, ctx, dbStore)
	t.Cleanup(func() {
		agent.release()
		waitFor(t, func() bool {
			session, err := dbStore.GetSession(ctx, session.ID)
			return err == nil && session.Status == store.SessionStatusIdle
		})
	})

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{
		"content":"Describe this image",
		"attachments":[
			{
				"name":"diagram.png",
				"media_type":"image/png",
				"data_url":"data:image/png;base64,aGVsbG8=",
				"size_bytes":5
			}
		]
	}`)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var input agents.AgentInput
	select {
	case input = <-agent.started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for agent input")
	}
	if len(input.Attachments) != 1 {
		t.Fatalf("expected one attachment, got %#v", input.Attachments)
	}
	if input.Attachments[0].Name != "diagram.png" || input.Attachments[0].DataURL != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("unexpected attachment %#v", input.Attachments[0])
	}

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{"user.message.completed", "session.status.updated"})
	payload := decodeEventPayload(t, events[0])
	attachments, ok := payload["attachments"].([]any)
	if !ok || len(attachments) != 1 {
		t.Fatalf("expected attachment payload, got %#v", payload["attachments"])
	}
	attachment, ok := attachments[0].(map[string]any)
	if !ok {
		t.Fatalf("expected attachment object, got %#v", attachments[0])
	}
	if attachment["name"] != "diagram.png" || attachment["media_type"] != "image/png" {
		t.Fatalf("unexpected attachment payload %#v", attachment)
	}
}

func TestMessageSubmissionRejectsNonImageAttachments(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{
		"content":"Read this",
		"attachments":[
			{
				"name":"notes.txt",
				"media_type":"text/plain",
				"data_url":"data:text/plain;base64,aGVsbG8=",
				"size_bytes":5
			}
		]
	}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "attachment 1 must be an image")
}

func TestUpdateSessionTitleTrimsAndReturnsSession(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := patchJSON(handler, "/api/sessions/"+session.ID, `{"title":"  New title  "}`)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response sessionResponse
	decodeJSON(t, rec, &response)
	if response.Title != "New title" {
		t.Fatalf("expected trimmed title, got %q", response.Title)
	}

	updated, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updated.Title != "New title" {
		t.Fatalf("expected persisted title, got %q", updated.Title)
	}
}

func TestUpdateSessionTitleReturnsNotFound(t *testing.T) {
	ctx := context.Background()
	_, _, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := patchJSON(handler, "/api/sessions/sess_missing", `{"title":"Missing"}`)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session not found")
}

func TestUpdateSessionTitleRejectsMalformedJSON(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := patchJSON(handler, "/api/sessions/"+session.ID, `{"title"`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "invalid JSON body")
}

func TestArchiveSessionSetsArchivedAtAndHidesFromList(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/archive", ``)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusOK, rec.Code, rec.Body.String())
	}

	var response sessionResponse
	decodeJSON(t, rec, &response)
	if response.ID != session.ID {
		t.Fatalf("expected archived session id %q, got %q", session.ID, response.ID)
	}
	if response.ArchivedAt == nil {
		t.Fatal("expected archived_at in response")
	}

	updated, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updated.ArchivedAt == nil {
		t.Fatal("expected persisted archived_at")
	}

	sessions, err := dbStore.ListSessions(ctx, store.ListSessionsParams{})
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) != 0 {
		t.Fatalf("expected archived session to be hidden from list, got %#v", sessions)
	}
}

func TestArchiveRunningSessionReturnsConflict(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)
	if _, err := dbStore.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	}); err != nil {
		t.Fatalf("mark running: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/archive", ``)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "running session cannot be archived")

	updated, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updated.ArchivedAt != nil {
		t.Fatalf("expected running session not to be archived, got %s", updated.ArchivedAt)
	}
}

func TestMessageSubmissionReturnsUnavailableForRegisteredUnavailableAgent(t *testing.T) {
	ctx := context.Background()
	codexAgent := availabilityAgent{agentType: "codex", availableErr: agents.ErrUnavailable}
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, codexAgent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Codex run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Inspect this repo"}`)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusServiceUnavailable, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "agent unavailable")

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	if len(events) != 0 {
		t.Fatalf("expected no events to be appended, got %#v", events)
	}
}

func TestMessageSubmissionPassesConfiguredWorkdirToAgent(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	workdir := canonicalPath(t, t.TempDir())
	dbStore, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, workdir, agent)
	session := createIntegrationSession(t, ctx, dbStore)
	t.Cleanup(agent.release)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Inspect this repo"}`)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	select {
	case input := <-agent.started:
		if input.Workdir != workdir {
			t.Fatalf("expected workdir %q, got %q", workdir, input.Workdir)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("context ended before agent started")
	}
}

func TestMessageSubmissionPassesSessionWorkspaceToAgent(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	defaultWorkdir := canonicalPath(t, t.TempDir())
	sessionWorkdir := filepath.Join(defaultWorkdir, "project")
	if err := os.Mkdir(sessionWorkdir, 0o755); err != nil {
		t.Fatalf("create session workspace: %v", err)
	}
	dbStore, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, defaultWorkdir, agent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:         "Workspace run",
		AgentType:     "fake",
		WorkspacePath: sessionWorkdir,
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(agent.release)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Inspect this repo"}`)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	select {
	case input := <-agent.started:
		if input.Workdir != sessionWorkdir {
			t.Fatalf("expected workdir %q, got %q", sessionWorkdir, input.Workdir)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("context ended before agent started")
	}
}

func TestMessageSubmissionPassesCodexOptionsToAgentMetadata(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	agent.agentType = "codex"
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Codex run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(agent.release)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{
		"content":"Inspect this repo",
		"agent_options":{
			"codex":{
				"model":"gpt-5.5",
				"reasoning_effort":"xhigh",
				"fast_mode":true,
				"planning_mode":true,
				"service_tier":"priority"
			}
		}
	}`)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	select {
	case input := <-agent.started:
		if input.Metadata["agent_type"] != "codex" {
			t.Fatalf("expected codex agent metadata, got %#v", input.Metadata)
		}
		options, ok := input.Metadata["codex_options"].(map[string]any)
		if !ok {
			t.Fatalf("expected codex options metadata, got %#v", input.Metadata["codex_options"])
		}
		assertMetadataValue(t, options, "model", "gpt-5.5")
		assertMetadataValue(t, options, "reasoning_effort", "xhigh")
		assertMetadataValue(t, options, "service_tier", "priority")
		assertMetadataValue(t, options, "fast_mode", true)
		assertMetadataValue(t, options, "planning_mode", true)
	case <-time.After(2 * time.Second):
		t.Fatal("context ended before agent started")
	}
}

func TestMessageSubmissionPassesSessionCodexOptionsToAgentMetadata(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	agent.agentType = "codex"
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:        "Codex run",
		AgentType:    "codex",
		AgentOptions: json.RawMessage(`{"codex":{"run_dangerously":true}}`),
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(agent.release)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Inspect this repo"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	select {
	case input := <-agent.started:
		options, ok := input.Metadata["codex_options"].(map[string]any)
		if !ok {
			t.Fatalf("expected codex options metadata, got %#v", input.Metadata["codex_options"])
		}
		assertMetadataValue(t, options, "run_dangerously", true)
	case <-time.After(2 * time.Second):
		t.Fatal("context ended before agent started")
	}
}

func TestMessageSubmissionPassesProviderSessionIDToCodexAgent(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	agent.agentType = "codex"
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Codex run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := dbStore.SetSessionProviderSessionID(ctx, store.SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_existing",
	}); err != nil {
		t.Fatalf("set provider session id: %v", err)
	}
	t.Cleanup(agent.release)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Continue"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	select {
	case input := <-agent.started:
		if input.ProviderSessionID != "thread_existing" {
			t.Fatalf("expected provider session id thread_existing, got %q", input.ProviderSessionID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("context ended before agent started")
	}
}

func TestCodexRunStartedPersistsProviderSessionID(t *testing.T) {
	ctx := context.Background()
	agent := codexThreadAgent{threadID: "thread_created"}
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Codex run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Start"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusIdle
	})

	updated, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updated.ProviderSessionID != "thread_created" {
		t.Fatalf("expected provider session id thread_created, got %q", updated.ProviderSessionID)
	}
}

func TestClearCodexSessionReplacesProviderSessionID(t *testing.T) {
	ctx := context.Background()
	agent := codexThreadAgent{threadID: "thread_new"}
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Codex run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := dbStore.SetSessionProviderSessionID(ctx, store.SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_old",
	}); err != nil {
		t.Fatalf("set provider session id: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/clear", ``)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusIdle
	})

	updated, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updated.ProviderSessionID != "thread_new" {
		t.Fatalf("expected provider session id thread_new, got %q", updated.ProviderSessionID)
	}

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{
		"user.action.completed",
		"session.status.updated",
		"agent.run.started",
		"agent.run.completed",
		"session.status.updated",
	})
	assertPayloadAction(t, events[0], "clear")
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)
	assertPayloadStatus(t, events[4], store.SessionStatusIdle)
}

func TestCompactCodexSessionStartsActionRun(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	agent.agentType = "codex"
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Codex run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if _, err := dbStore.SetSessionProviderSessionID(ctx, store.SetSessionProviderSessionIDParams{
		ID:                session.ID,
		ProviderSessionID: "thread_existing",
	}); err != nil {
		t.Fatalf("set provider session id: %v", err)
	}
	t.Cleanup(agent.release)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/compact", ``)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	select {
	case input := <-agent.started:
		if input.Action != agents.AgentActionCompact {
			t.Fatalf("expected compact action, got %q", input.Action)
		}
		if input.ProviderSessionID != "thread_existing" {
			t.Fatalf("expected provider session id thread_existing, got %q", input.ProviderSessionID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("context ended before agent started")
	}

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{"user.action.completed", "session.status.updated"})
	assertPayloadAction(t, events[0], "compact")
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)

	agent.release()
	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusIdle
	})
}

func TestCompactCodexSessionWithoutProviderSessionIDReturnsConflict(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, codexThreadAgent{threadID: "thread_new"})
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Codex run",
		AgentType: "codex",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/compact", ``)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session has no codex thread to compact")

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	if len(events) != 0 {
		t.Fatalf("expected no events to be appended, got %#v", events)
	}
}

func TestSessionActionRejectsNonCodexSession(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/clear", ``)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session action requires a codex session")
}

func TestMessageSubmissionRejectsCodexOptionsForNonCodexSession(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{
		"content":"Inspect this repo",
		"agent_options":{"codex":{"model":"gpt-5.5"}}
	}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "codex options require a codex session")

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	if len(events) != 0 {
		t.Fatalf("expected no events to be appended, got %#v", events)
	}
}

func TestSuccessfulFakeAgentRunCompletesSessionAndIsVisibleThroughHistory(t *testing.T) {
	ctx := context.Background()
	dbStore, _, runManager, handler := newIntegrationAPI(t, ctx, fake.New())

	createRec := postJSON(handler, "/api/sessions", `{"agent_type":"fake","title":"Fake run"}`)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("expected create status %d, got %d with body %s", http.StatusCreated, createRec.Code, createRec.Body.String())
	}

	var createResponse createSessionResponse
	decodeJSON(t, createRec, &createResponse)

	messageRec := postJSON(handler, "/api/sessions/"+createResponse.SessionID+"/messages", `{"content":"Inspect this repo"}`)
	if messageRec.Code != http.StatusAccepted {
		t.Fatalf("expected message status %d, got %d with body %s", http.StatusAccepted, messageRec.Code, messageRec.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, createResponse.SessionID)
		return err == nil && session.Status == store.SessionStatusIdle
	})
	waitFor(t, func() bool {
		return !runManager.Active(createResponse.SessionID)
	})

	events := listIntegrationEvents(t, ctx, dbStore, createResponse.SessionID)
	assertEventTypes(t, events, []string{
		"user.message.completed",
		"session.status.updated",
		"agent.run.started",
		"agent.message.delta",
		"agent.message.completed",
		"agent.run.completed",
		"session.status.updated",
	})
	assertTerminalRunEventCount(t, events, 1)
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)
	assertPayloadText(t, events[3], "Received task: Inspect this repo")
	assertPayloadStatus(t, events[6], store.SessionStatusIdle)

	historyReq := httptest.NewRequest(http.MethodGet, "/api/sessions/"+createResponse.SessionID+"/events?after_seq=0", nil)
	historyRec := httptest.NewRecorder()
	handler.ServeHTTP(historyRec, historyReq)

	if historyRec.Code != http.StatusOK {
		t.Fatalf("expected history status %d, got %d with body %s", http.StatusOK, historyRec.Code, historyRec.Body.String())
	}

	var historyResponse eventHistoryResponse
	decodeJSON(t, historyRec, &historyResponse)
	if len(historyResponse.Events) != len(events) {
		t.Fatalf("expected %d history events, got %d", len(events), len(historyResponse.Events))
	}
	if historyResponse.Events[6].Type != "session.status.updated" {
		t.Fatalf("expected final history event session.status.updated, got %q", historyResponse.Events[6].Type)
	}
}

func TestFakeAgentErrorEmitsFailedEventAndMarksSessionFailed(t *testing.T) {
	ctx := context.Background()
	dbStore, _, runManager, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithError(errors.New("planned failure"))))
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Fail this task"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusFailed
	})
	waitFor(t, func() bool {
		return !runManager.Active(session.ID)
	})

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{
		"user.message.completed",
		"session.status.updated",
		"agent.run.started",
		"agent.run.failed",
		"session.status.updated",
	})
	assertTerminalRunEventCount(t, events, 1)
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)
	if events[3].Status != store.EventStatusFailed {
		t.Fatalf("expected failed status, got %q", events[3].Status)
	}
	assertPayloadError(t, events[3], "planned failure")
	assertPayloadStatus(t, events[4], store.SessionStatusFailed)
}

func TestCancelRunningFakeAgentMarksSessionCancelledAndCleansUpRun(t *testing.T) {
	ctx := context.Background()
	stepBarrier := make(chan struct{})
	dbStore, _, runManager, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithStepBarrier(stepBarrier)))
	session := createIntegrationSession(t, ctx, dbStore)

	messageRec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Cancel this task"}`)
	if messageRec.Code != http.StatusAccepted {
		t.Fatalf("expected message status %d, got %d with body %s", http.StatusAccepted, messageRec.Code, messageRec.Body.String())
	}

	waitFor(t, func() bool {
		return runManager.Active(session.ID) && hasEventType(t, ctx, dbStore, session.ID, "agent.run.started")
	})

	cancelRec := postJSON(handler, "/api/sessions/"+session.ID+"/cancel", ``)
	if cancelRec.Code != http.StatusAccepted {
		t.Fatalf("expected cancel status %d, got %d with body %s", http.StatusAccepted, cancelRec.Code, cancelRec.Body.String())
	}

	var cancelResponse cancelSessionResponse
	decodeJSON(t, cancelRec, &cancelResponse)
	if cancelResponse.SessionID != session.ID {
		t.Fatalf("expected session_id %q, got %q", session.ID, cancelResponse.SessionID)
	}
	if cancelResponse.Status != "cancelling" {
		t.Fatalf("expected cancelling status, got %q", cancelResponse.Status)
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusIdle
	})
	waitFor(t, func() bool {
		return !runManager.Active(session.ID)
	})

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{
		"user.message.completed",
		"session.status.updated",
		"agent.run.started",
		"agent.run.cancelled",
		"session.status.updated",
	})
	assertTerminalRunEventCount(t, events, 1)
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)
	assertPayloadStatus(t, events[4], store.SessionStatusIdle)
	if hasEvent(events, "agent.run.completed") {
		t.Fatal("expected cancelled run not to emit agent.run.completed")
	}
}

func TestAnswerUserInputRequestPersistsAnswerAndCompletesRun(t *testing.T) {
	ctx := context.Background()
	agent := userInputAgent{}
	dbStore, _, runManager, handler := newIntegrationAPI(t, ctx, agent)
	session := createIntegrationSession(t, ctx, dbStore)

	messageRec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Ask me"}`)
	if messageRec.Code != http.StatusAccepted {
		t.Fatalf("expected message status %d, got %d with body %s", http.StatusAccepted, messageRec.Code, messageRec.Body.String())
	}
	waitFor(t, func() bool {
		return hasEventType(t, ctx, dbStore, session.ID, "agent.input.requested")
	})

	answerRec := postJSON(handler, "/api/sessions/"+session.ID+"/requests/call_test/answer", `{
		"answers": {
			"question_test": {
				"answers": ["Beta"]
			}
		}
	}`)
	if answerRec.Code != http.StatusAccepted {
		t.Fatalf("expected answer status %d, got %d with body %s", http.StatusAccepted, answerRec.Code, answerRec.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusIdle
	})
	waitFor(t, func() bool {
		return !runManager.Active(session.ID)
	})

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{
		"user.message.completed",
		"session.status.updated",
		"agent.run.started",
		"agent.input.requested",
		"agent.input.answered",
		"agent.message.completed",
		"agent.run.completed",
		"session.status.updated",
	})
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)
	assertPayloadStatus(t, events[7], store.SessionStatusIdle)
	answerPayload := decodeEventPayload(t, events[4])
	if answerPayload["request_id"] != "call_test" {
		t.Fatalf("expected answered request id call_test, got %#v", answerPayload["request_id"])
	}
	assertPayloadText(t, events[5], "Answer: Beta")
}

func TestAnswerUserInputRejectsInvalidOption(t *testing.T) {
	ctx := context.Background()
	agent := userInputAgent{}
	dbStore, _, runManager, handler := newIntegrationAPI(t, ctx, agent)
	session := createIntegrationSession(t, ctx, dbStore)
	t.Cleanup(func() {
		if runManager.Active(session.ID) {
			_ = runManager.Cancel(session.ID)
			waitFor(t, func() bool {
				session, err := dbStore.GetSession(ctx, session.ID)
				return err == nil && session.Status == store.SessionStatusIdle
			})
		}
	})

	messageRec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Ask me"}`)
	if messageRec.Code != http.StatusAccepted {
		t.Fatalf("expected message status %d, got %d with body %s", http.StatusAccepted, messageRec.Code, messageRec.Body.String())
	}
	waitFor(t, func() bool {
		return hasEventType(t, ctx, dbStore, session.ID, "agent.input.requested")
	})

	answerRec := postJSON(handler, "/api/sessions/"+session.ID+"/requests/call_test/answer", `{
		"answers": {
			"question_test": {
				"answers": ["Delta"]
			}
		}
	}`)
	if answerRec.Code != http.StatusBadRequest {
		t.Fatalf("expected answer status %d, got %d with body %s", http.StatusBadRequest, answerRec.Code, answerRec.Body.String())
	}
	assertErrorResponse(t, answerRec, `answer "question_test" is not a valid option`)
}

func TestCancelUnknownSessionReturnsNotFound(t *testing.T) {
	ctx := context.Background()
	_, _, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions/sess_missing/cancel", ``)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session not found")
}

func TestCancelIdleSessionReturnsConflict(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/cancel", ``)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session is not running")

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	if len(events) != 0 {
		t.Fatalf("expected no events, got %#v", events)
	}
}

func TestCancelIdleAfterCompletedRunReturnsConflict(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/cancel", ``)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session is not running")
}

func TestDuplicateCancelReturnsConflictAfterTerminalState(t *testing.T) {
	ctx := context.Background()
	stepBarrier := make(chan struct{})
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New(fake.WithStepBarrier(stepBarrier)))
	session := createIntegrationSession(t, ctx, dbStore)

	messageRec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Cancel twice"}`)
	if messageRec.Code != http.StatusAccepted {
		t.Fatalf("expected message status %d, got %d with body %s", http.StatusAccepted, messageRec.Code, messageRec.Body.String())
	}

	waitFor(t, func() bool {
		return hasEventType(t, ctx, dbStore, session.ID, "agent.run.started")
	})

	firstCancel := postJSON(handler, "/api/sessions/"+session.ID+"/cancel", ``)
	if firstCancel.Code != http.StatusAccepted {
		t.Fatalf("expected first cancel status %d, got %d with body %s", http.StatusAccepted, firstCancel.Code, firstCancel.Body.String())
	}

	waitFor(t, func() bool {
		session, err := dbStore.GetSession(ctx, session.ID)
		return err == nil && session.Status == store.SessionStatusIdle
	})

	secondCancel := postJSON(handler, "/api/sessions/"+session.ID+"/cancel", ``)
	if secondCancel.Code != http.StatusConflict {
		t.Fatalf("expected second cancel status %d, got %d with body %s", http.StatusConflict, secondCancel.Code, secondCancel.Body.String())
	}
	assertErrorResponse(t, secondCancel, "session is not running")
}

func TestCancelRunningSessionWithoutActiveRunFailsSession(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)
	if _, err := dbStore.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	}); err != nil {
		t.Fatalf("mark running: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/cancel", ``)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}
	var response submitMessageResponse
	decodeJSON(t, rec, &response)
	if response.SessionID != session.ID {
		t.Fatalf("expected session_id %q, got %q", session.ID, response.SessionID)
	}
	if response.Status != string(store.SessionStatusFailed) {
		t.Fatalf("expected failed status, got %q", response.Status)
	}

	updatedSession, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updatedSession.Status != store.SessionStatusFailed {
		t.Fatalf("expected failed status, got %q", updatedSession.Status)
	}

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{"agent.run.failed", "session.status.updated"})
	assertPayloadStatus(t, events[1], store.SessionStatusFailed)
	assertTerminalRunEventCount(t, events, 1)
}

func TestCancelRejectsMalformedJSONBody(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/cancel", `{"unterminated"`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "invalid JSON body")
}

func TestMessageSubmissionToRunningSessionReturnsConflict(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	if _, err := dbStore.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusRunning,
	}); err != nil {
		t.Fatalf("mark running: %v", err)
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Second message"}`)

	if rec.Code != http.StatusConflict {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusConflict, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session is already running")

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	if len(events) != 0 {
		t.Fatalf("expected no events to be appended, got %#v", events)
	}
}

func TestMessageSubmissionToFailedSessionStartsNewRun(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session := createIntegrationSession(t, ctx, dbStore)
	t.Cleanup(func() {
		agent.release()
		waitFor(t, func() bool {
			session, err := dbStore.GetSession(ctx, session.ID)
			return err == nil && session.Status == store.SessionStatusIdle
		})
	})

	failedSession, err := dbStore.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{
		ID:     session.ID,
		Status: store.SessionStatusFailed,
	})
	if err != nil {
		t.Fatalf("mark failed: %v", err)
	}
	if failedSession.CompletedAt == nil {
		t.Fatal("expected failure timestamp before submitting another message")
	}

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"Another message"}`)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusAccepted, rec.Code, rec.Body.String())
	}

	var response submitMessageResponse
	decodeJSON(t, rec, &response)
	if response.Status != string(store.SessionStatusRunning) {
		t.Fatalf("expected response status running, got %q", response.Status)
	}

	updatedSession, err := dbStore.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if updatedSession.Status != store.SessionStatusRunning {
		t.Fatalf("expected session status running, got %q", updatedSession.Status)
	}
	if updatedSession.CompletedAt != nil {
		t.Fatalf("expected completed_at to be cleared for new run, got %s", updatedSession.CompletedAt)
	}

	events := listIntegrationEvents(t, ctx, dbStore, session.ID)
	assertEventTypes(t, events, []string{"user.message.completed", "session.status.updated"})
	assertPayloadText(t, events[0], "Another message")
	assertPayloadStatus(t, events[1], store.SessionStatusRunning)
}

func TestMessageSubmissionToMissingSessionReturnsNotFound(t *testing.T) {
	ctx := context.Background()
	_, _, _, handler := newIntegrationAPI(t, ctx, fake.New())

	rec := postJSON(handler, "/api/sessions/sess_missing/messages", `{"content":"Hello"}`)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusNotFound, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "session not found")
}

func TestMessageSubmissionRejectsEmptyContent(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	rec := postJSON(handler, "/api/sessions/"+session.ID+"/messages", `{"content":"   "}`)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	assertErrorResponse(t, rec, "content or attachments are required")
}

func TestWriteAPIsRejectMalformedJSON(t *testing.T) {
	ctx := context.Background()
	dbStore, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, dbStore)

	for _, test := range []struct {
		name string
		path string
	}{
		{name: "create session", path: "/api/sessions"},
		{name: "submit message", path: "/api/sessions/" + session.ID + "/messages"},
	} {
		t.Run(test.name, func(t *testing.T) {
			rec := postJSON(handler, test.path, `{"unterminated"`)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("expected status %d, got %d with body %s", http.StatusBadRequest, rec.Code, rec.Body.String())
			}
			assertErrorResponse(t, rec, "invalid JSON body")
		})
	}
}

func newIntegrationAPI(t *testing.T, ctx context.Context, agent agents.Agent) (*store.Store, *eventservice.Service, *runcontrol.Manager, http.Handler) {
	t.Helper()
	return newIntegrationAPIWithWorkdir(t, ctx, "", agent)
}

func newIntegrationAPIWithWorkdir(t *testing.T, ctx context.Context, workdir string, agent agents.Agent) (*store.Store, *eventservice.Service, *runcontrol.Manager, http.Handler) {
	t.Helper()
	return newIntegrationAPIWithWorkspaceRoots(t, ctx, workdir, nil, agent)
}

func newIntegrationAPIWithWorkspaceRoots(t *testing.T, ctx context.Context, workdir string, workspaceRoots []string, agent agents.Agent) (*store.Store, *eventservice.Service, *runcontrol.Manager, http.Handler) {
	t.Helper()

	dbStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() {
		if err := dbStore.Close(); err != nil {
			t.Fatalf("close store: %v", err)
		}
	})

	events, err := eventservice.NewService(dbStore)
	if err != nil {
		t.Fatalf("new event service: %v", err)
	}

	registry, err := agents.NewRegistry(agent)
	if err != nil {
		t.Fatalf("new agent registry: %v", err)
	}

	runManager := runcontrol.NewManager()
	handler := NewRouter(Dependencies{
		Store:          dbStore,
		Events:         events,
		Agents:         registry,
		Runs:           runManager,
		Workdir:        workdir,
		WorkspaceRoots: workspaceRoots,
	})

	return dbStore, events, runManager, handler
}

func createIntegrationSession(t *testing.T, ctx context.Context, dbStore *store.Store) store.Session {
	t.Helper()

	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:     "Test session",
		AgentType: "fake",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	return session
}

func postJSON(handler http.Handler, path string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func patchJSON(handler http.Handler, path string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPatch, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func putJSON(handler http.Handler, path string, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPut, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func get(handler http.Handler, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func quoteJSON(value string) string {
	body, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(body)
}

func canonicalPath(t *testing.T, value string) string {
	t.Helper()
	evaluated, err := filepath.EvalSymlinks(value)
	if err != nil {
		t.Fatalf("evaluate path %q: %v", value, err)
	}
	return evaluated
}

func listIntegrationEvents(t *testing.T, ctx context.Context, dbStore *store.Store, sessionID string) []store.Event {
	t.Helper()

	events, err := dbStore.ListEvents(ctx, sessionID, 0, 100)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}

	return events
}

func assertEventTypes(t *testing.T, events []store.Event, want []string) {
	t.Helper()

	if len(events) != len(want) {
		t.Fatalf("expected %d events, got %d: %#v", len(want), len(events), events)
	}
	for i, event := range events {
		if event.Type != want[i] {
			t.Fatalf("expected event %d type %q, got %q", i, want[i], event.Type)
		}
	}
}

func hasEventType(t *testing.T, ctx context.Context, dbStore *store.Store, sessionID string, eventType string) bool {
	t.Helper()

	events := listIntegrationEvents(t, ctx, dbStore, sessionID)
	return hasEvent(events, eventType)
}

func hasEvent(events []store.Event, eventType string) bool {
	for _, event := range events {
		if event.Type == eventType {
			return true
		}
	}
	return false
}

func assertTerminalRunEventCount(t *testing.T, events []store.Event, want int) {
	t.Helper()

	count := 0
	for _, event := range events {
		if isTerminalRunEvent(event.Type) {
			count++
		}
	}
	if count != want {
		t.Fatalf("expected %d terminal run events, got %d in %#v", want, count, events)
	}
}

func assertPayloadText(t *testing.T, event store.Event, want string) {
	t.Helper()

	payload := decodeEventPayload(t, event)
	if payload["text"] != want {
		t.Fatalf("expected payload text %q, got %#v", want, payload["text"])
	}
}

func assertPayloadStatus(t *testing.T, event store.Event, want store.SessionStatus) {
	t.Helper()

	payload := decodeEventPayload(t, event)
	if payload["status"] != string(want) {
		t.Fatalf("expected payload status %q, got %#v", want, payload["status"])
	}
}

func assertPayloadAction(t *testing.T, event store.Event, want string) {
	t.Helper()

	payload := decodeEventPayload(t, event)
	if payload["action"] != want {
		t.Fatalf("expected payload action %q, got %#v", want, payload["action"])
	}
}

func assertMetadataValue(t *testing.T, metadata map[string]any, key string, want any) {
	t.Helper()

	if got := metadata[key]; got != want {
		t.Fatalf("expected metadata %s %#v, got %#v", key, want, got)
	}
}

func assertPayloadError(t *testing.T, event store.Event, want string) {
	t.Helper()

	payload := decodeEventPayload(t, event)
	if payload["error"] != want {
		t.Fatalf("expected payload error %q, got %#v", want, payload["error"])
	}
}

func decodeEventPayload(t *testing.T, event store.Event) map[string]any {
	t.Helper()

	var payload map[string]any
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("decode event payload: %v", err)
	}

	return payload
}

type blockingAgent struct {
	agentType string
	started   chan agents.AgentInput
	releasec  chan struct{}
	once      sync.Once
}

func newBlockingAgent() *blockingAgent {
	return &blockingAgent{
		agentType: "fake",
		started:   make(chan agents.AgentInput, 1),
		releasec:  make(chan struct{}),
	}
}

func (a *blockingAgent) Type() string {
	return a.agentType
}

func (a *blockingAgent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	a.started <- input
	select {
	case <-a.releasec:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *blockingAgent) release() {
	a.once.Do(func() {
		close(a.releasec)
	})
}

type userInputAgent struct{}

func (a userInputAgent) Type() string {
	return "fake"
}

func (a userInputAgent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	if err := emit(ctx, agents.AgentEvent{
		Type:   "agent.run.started",
		Role:   "assistant",
		Status: string(store.EventStatusStarted),
		Payload: map[string]any{
			"agent_type": "fake",
		},
	}); err != nil {
		return err
	}

	request := agents.UserInputRequest{
		SessionID:         input.SessionID,
		RequestID:         "call_test",
		Provider:          "fake",
		ProviderEventType: "item/tool/requestUserInput",
		ProviderRequestID: "99",
		ThreadID:          "thread_test",
		TurnID:            "turn_test",
		ItemID:            "call_test",
		Questions: []agents.UserInputQuestion{
			{
				ID:       "question_test",
				Header:   "Pick",
				Question: "Pick one",
				IsOther:  false,
				Options: []agents.UserInputOption{
					{Label: "Alpha", Description: "First"},
					{Label: "Beta", Description: "Second"},
					{Label: "Gamma", Description: "Third"},
				},
			},
		},
	}
	waiter, err := input.UserInput.OpenUserInput(ctx, request)
	if err != nil {
		return err
	}
	defer waiter.Close()

	if err := emit(ctx, agents.AgentEvent{
		Type:   "agent.input.requested",
		Role:   "assistant",
		Status: string(store.EventStatusStarted),
		Payload: map[string]any{
			"provider":            request.Provider,
			"provider_event_type": request.ProviderEventType,
			"provider_request_id": request.ProviderRequestID,
			"request_id":          request.RequestID,
			"thread_id":           request.ThreadID,
			"turn_id":             request.TurnID,
			"item_id":             request.ItemID,
			"questions":           request.Questions,
		},
	}); err != nil {
		return err
	}

	response, err := waiter.Wait(ctx)
	if err != nil {
		return err
	}
	answer := response.Answers["question_test"].Answers[0]
	return emit(ctx, agents.AgentEvent{
		Type:   "agent.message.completed",
		Role:   "assistant",
		Status: string(store.EventStatusCompleted),
		Payload: map[string]any{
			"text": "Answer: " + answer,
		},
	})
}

type codexThreadAgent struct {
	threadID string
}

func (a codexThreadAgent) Type() string {
	return "codex"
}

func (a codexThreadAgent) Run(ctx context.Context, input agents.AgentInput, emit agents.EmitFunc) error {
	return emit(ctx, agents.AgentEvent{
		Type:   "agent.run.started",
		Role:   "assistant",
		Status: string(store.EventStatusStarted),
		Payload: map[string]any{
			"provider":            "codex",
			"provider_event_type": "thread/start",
			"thread_id":           a.threadID,
		},
	})
}

type availabilityAgent struct {
	agentType    string
	availableErr error
}

func (a availabilityAgent) Type() string {
	return a.agentType
}

func (a availabilityAgent) Available() error {
	return a.availableErr
}

func (a availabilityAgent) Run(context.Context, agents.AgentInput, agents.EmitFunc) error {
	return nil
}

type optionsAgent struct {
	agentType    string
	availableErr error
	options      agents.Options
	optionsErr   error
}

func (a optionsAgent) Type() string {
	return a.agentType
}

func (a optionsAgent) Available() error {
	return a.availableErr
}

func (a optionsAgent) Options(context.Context) (agents.Options, error) {
	return a.options, a.optionsErr
}

func (a optionsAgent) Run(context.Context, agents.AgentInput, agents.EmitFunc) error {
	return nil
}
