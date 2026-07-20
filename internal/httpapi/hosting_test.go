package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/agents/fake"
	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/hosting"
	runcontrol "github.com/jgennari/gorchestra/internal/session"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestHostedPreviewAPIValidatesStartsAndReturnsStatus(t *testing.T) {
	ctx := context.Background()
	workspace := writeHostRecipeWorkspace(t)
	manager := newFakeHostingManager()
	dbStore, handler := newHostedPreviewAPI(t, ctx, workspace, nil, manager)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{
		Title:         "Hosted",
		AgentType:     fake.Type,
		WorkspacePath: workspace,
	})
	if err != nil {
		t.Fatal(err)
	}

	statusRec := get(handler, "/api/sessions/"+session.ID+"/host")
	if statusRec.Code != http.StatusOK {
		t.Fatalf("status returned %d: %s", statusRec.Code, statusRec.Body.String())
	}
	var status hosting.Snapshot
	decodeJSON(t, statusRec, &status)
	if !status.Config.Present || !status.Config.Valid || status.Config.Name != "host-test" {
		t.Fatalf("unexpected config status %#v", status.Config)
	}
	if status.Runtime.Status != hosting.StatusStopped || len(status.Services) != 1 || status.Services[0].RoutePaths[0] != "/" {
		t.Fatalf("unexpected initial status %#v", status)
	}

	validateRec := postJSON(handler, "/api/sessions/"+session.ID+"/host/validate", `{}`)
	if validateRec.Code != http.StatusOK {
		t.Fatalf("validate returned %d: %s", validateRec.Code, validateRec.Body.String())
	}
	startRec := postJSON(handler, "/api/sessions/"+session.ID+"/host/start", `{}`)
	if startRec.Code != http.StatusAccepted {
		t.Fatalf("start returned %d: %s", startRec.Code, startRec.Body.String())
	}
	manager.mu.Lock()
	startRequest := manager.startRequest
	manager.mu.Unlock()
	if startRequest.SessionID != session.ID || !strings.HasSuffix(startRequest.Slug, "-gorchestra") || startRequest.Loaded.Digest == "" {
		t.Fatalf("unexpected start request %#v", startRequest)
	}

	stopRec := postJSON(handler, "/api/sessions/"+session.ID+"/host/stop", `{}`)
	if stopRec.Code != http.StatusAccepted {
		t.Fatalf("stop returned %d: %s", stopRec.Code, stopRec.Body.String())
	}
}

func TestHostedPreviewAPIReportsMissingAndInvalidRecipesWithout404(t *testing.T) {
	ctx := context.Background()
	workspace := t.TempDir()
	manager := newFakeHostingManager()
	dbStore, handler := newHostedPreviewAPI(t, ctx, workspace, nil, manager)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{Title: "Missing", AgentType: fake.Type, WorkspacePath: workspace})
	if err != nil {
		t.Fatal(err)
	}
	rec := get(handler, "/api/sessions/"+session.ID+"/host")
	if rec.Code != http.StatusOK {
		t.Fatalf("missing recipe status returned %d: %s", rec.Code, rec.Body.String())
	}
	var status hosting.Snapshot
	decodeJSON(t, rec, &status)
	if status.Config.Present || status.Config.Valid || len(status.Config.Errors) != 0 {
		t.Fatalf("unexpected missing recipe status %#v", status.Config)
	}

	if err := os.MkdirAll(filepath.Dir(hosting.RecipePath(workspace)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hosting.RecipePath(workspace), []byte("version: nope\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec = get(handler, "/api/sessions/"+session.ID+"/host")
	decodeJSON(t, rec, &status)
	if !status.Config.Present || status.Config.Valid || len(status.Config.Errors) != 1 {
		t.Fatalf("unexpected invalid recipe status %#v", status.Config)
	}
	startRec := postJSON(handler, "/api/sessions/"+session.ID+"/host/start", `{}`)
	if startRec.Code != http.StatusBadRequest {
		t.Fatalf("invalid recipe start returned %d: %s", startRec.Code, startRec.Body.String())
	}
}

func TestHostedPreviewLogsSnapshotAndSSEReplay(t *testing.T) {
	ctx := context.Background()
	workspace := writeHostRecipeWorkspace(t)
	manager := newFakeHostingManager()
	manager.logs = hosting.LogSnapshot{
		Chunks:   []hosting.LogChunk{{Seq: 2, Service: "web", Stream: hosting.LogStdout, Data: "ready\n"}},
		FirstSeq: 2,
		LastSeq:  2,
	}
	dbStore, handler := newHostedPreviewAPI(t, ctx, workspace, nil, manager)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{Title: "Logs", AgentType: fake.Type, WorkspacePath: workspace})
	if err != nil {
		t.Fatal(err)
	}
	manager.snapshot = hosting.Snapshot{SessionID: session.ID, Runtime: hosting.RuntimeInfo{Status: hosting.StatusRunning}}

	rec := get(handler, "/api/sessions/"+session.ID+"/host/logs?after_seq=1&limit=10&service=web")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "ready") {
		t.Fatalf("logs returned %d: %s", rec.Code, rec.Body.String())
	}
	streamRec := get(handler, "/api/sessions/"+session.ID+"/host/logs/stream?after_seq=1")
	if streamRec.Code != http.StatusOK {
		t.Fatalf("stream returned %d: %s", streamRec.Code, streamRec.Body.String())
	}
	body := streamRec.Body.String()
	if !strings.Contains(body, "event: log") || !strings.Contains(body, `"seq":2`) || !strings.Contains(body, "ready") {
		t.Fatalf("unexpected SSE replay %q", body)
	}
}

func TestHostedPreviewDispatchesKnownHostsAndIngressHealth(t *testing.T) {
	ctx := context.Background()
	workspace := writeHostRecipeWorkspace(t)
	manager := newFakeHostingManager()
	manager.knownHost = "preview.example.test"
	_, handler := newHostedPreviewAPI(t, ctx, workspace, nil, manager)

	request := httptest.NewRequest(http.MethodGet, "http://preview.example.test/anything", nil)
	request.Host = manager.knownHost
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusTeapot || recorder.Body.String() != "preview proxy" {
		t.Fatalf("known host was not dispatched: %d %q", recorder.Code, recorder.Body.String())
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, hosting.IngressHealthPath, nil))
	if health.Code != http.StatusTeapot {
		t.Fatalf("ingress health was not dispatched: %d", health.Code)
	}
}

func TestHostedPreviewStopsBeforeWorkspaceChangeAndArchive(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	oldWorkspace := filepath.Join(root, "old")
	newWorkspace := filepath.Join(root, "new")
	for _, workspace := range []string{oldWorkspace, newWorkspace} {
		if err := os.Mkdir(workspace, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	manager := newFakeHostingManager()
	dbStore, handler := newHostedPreviewAPI(t, ctx, oldWorkspace, []string{root}, manager)
	session, err := dbStore.CreateSession(ctx, store.CreateSessionParams{Title: "Lifecycle", AgentType: fake.Type, WorkspacePath: oldWorkspace})
	if err != nil {
		t.Fatal(err)
	}
	manager.snapshot = hosting.Snapshot{SessionID: session.ID, Runtime: hosting.RuntimeInfo{Status: hosting.StatusRunning}}

	workspaceRec := patchJSON(handler, "/api/sessions/"+session.ID, `{"workspace_path":`+quoteJSON(newWorkspace)+`}`)
	if workspaceRec.Code != http.StatusOK {
		t.Fatalf("workspace update returned %d: %s", workspaceRec.Code, workspaceRec.Body.String())
	}
	manager.mu.Lock()
	stopCalls := manager.stopCalls
	waitCalls := manager.waitCalls
	manager.snapshot.Runtime.Status = hosting.StatusRunning
	manager.mu.Unlock()
	if stopCalls != 1 || waitCalls != 1 {
		t.Fatalf("expected stop/wait before workspace change, got stop=%d wait=%d", stopCalls, waitCalls)
	}

	archiveRec := postJSON(handler, "/api/sessions/"+session.ID+"/archive", `{}`)
	if archiveRec.Code != http.StatusOK {
		t.Fatalf("archive returned %d: %s", archiveRec.Code, archiveRec.Body.String())
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.stopCalls != 2 || manager.waitCalls != 2 {
		t.Fatalf("expected stop/wait before archive, got stop=%d wait=%d", manager.stopCalls, manager.waitCalls)
	}
}

func newHostedPreviewAPI(t *testing.T, ctx context.Context, workdir string, workspaceRoots []string, manager *fakeHostingManager) (*store.Store, http.Handler) {
	t.Helper()
	dbStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "sessions.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = dbStore.Close() })
	events, err := eventservice.NewService(dbStore)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := agents.NewRegistry(fake.New())
	if err != nil {
		t.Fatal(err)
	}
	return dbStore, NewRouter(Dependencies{
		Store:          dbStore,
		Events:         events,
		Agents:         registry,
		Runs:           runcontrol.NewManager(),
		Workdir:        workdir,
		WorkspaceRoots: workspaceRoots,
		Hosting:        manager,
		HostStore:      dbStore,
	})
}

func writeHostRecipeWorkspace(t *testing.T) string {
	t.Helper()
	workspace := t.TempDir()
	if err := os.MkdirAll(filepath.Dir(hosting.RecipePath(workspace)), 0o755); err != nil {
		t.Fatal(err)
	}
	recipe := `version: 1
name: host-test
services:
  - name: web
    command: ["server"]
    cwd: .
    port: auto
routes:
  - path: /
    service: web
`
	if err := os.WriteFile(hosting.RecipePath(workspace), []byte(recipe), 0o600); err != nil {
		t.Fatal(err)
	}
	return workspace
}

type fakeHostingManager struct {
	mu           sync.Mutex
	snapshot     hosting.Snapshot
	startRequest hosting.StartRequest
	logs         hosting.LogSnapshot
	knownHost    string
	stopCalls    int
	waitCalls    int
}

func newFakeHostingManager() *fakeHostingManager {
	return &fakeHostingManager{logs: hosting.LogSnapshot{Chunks: []hosting.LogChunk{}}}
}

func (m *fakeHostingManager) Start(_ context.Context, request hosting.StartRequest) (hosting.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.startRequest = request
	m.snapshot = fakeHostSnapshot(request, hosting.StatusStarting)
	return m.snapshot, nil
}

func (m *fakeHostingManager) Stop(_ context.Context, sessionID string) (hosting.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.snapshot.SessionID == "" {
		return hosting.Snapshot{}, hosting.ErrNotFound
	}
	m.stopCalls++
	m.snapshot.SessionID = sessionID
	m.snapshot.Runtime.Status = hosting.StatusStopping
	return m.snapshot, nil
}

func (m *fakeHostingManager) Restart(_ context.Context, request hosting.StartRequest) (hosting.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.startRequest = request
	m.snapshot = fakeHostSnapshot(request, hosting.StatusStopping)
	return m.snapshot, nil
}

func (m *fakeHostingManager) Status(sessionID string) (hosting.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.snapshot.SessionID == "" || (m.snapshot.SessionID != sessionID && m.startRequest.SessionID != sessionID) {
		return hosting.Snapshot{}, hosting.ErrNotFound
	}
	return m.snapshot, nil
}

func (m *fakeHostingManager) Wait(_ context.Context, sessionID string) (hosting.Snapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.waitCalls++
	m.snapshot.SessionID = sessionID
	m.snapshot.Runtime.Status = hosting.StatusStopped
	return m.snapshot, nil
}

func (m *fakeHostingManager) Check(context.Context, string) ([]hosting.ServiceCheck, error) {
	return []hosting.ServiceCheck{{Name: "web", Ready: true}}, nil
}

func (m *fakeHostingManager) Logs(string, uint64, int, string) (hosting.LogSnapshot, error) {
	return m.logs, nil
}

func (m *fakeHostingManager) SubscribeLogs(string, uint64, string) (hosting.LogSnapshot, <-chan hosting.LogChunk, func(), error) {
	chunks := make(chan hosting.LogChunk)
	close(chunks)
	return m.logs, chunks, func() {}, nil
}

func (m *fakeHostingManager) LookupHost(host string) (string, bool) {
	if host == m.knownHost && host != "" {
		return "session", true
	}
	return "", false
}

func (m *fakeHostingManager) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusTeapot)
	_, _ = io.WriteString(w, "preview proxy")
}

func fakeHostSnapshot(request hosting.StartRequest, status hosting.RuntimeStatus) hosting.Snapshot {
	return hosting.Snapshot{
		SessionID: request.SessionID,
		Config: hosting.ConfigStatus{
			Path:         request.Loaded.Path,
			Present:      true,
			Valid:        true,
			Digest:       request.Loaded.Digest,
			LoadedDigest: request.Loaded.Digest,
			Name:         request.Loaded.Recipe.Name,
			Errors:       []string{},
		},
		Runtime:  hosting.RuntimeInfo{Status: status},
		Services: []hosting.ServiceInfo{},
	}
}

var _ HostingManager = (*fakeHostingManager)(nil)
