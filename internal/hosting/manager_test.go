package hosting

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestManagerStartsProxiesLogsAndStops(t *testing.T) {
	requireHostingRuntime(t)
	loaded := helperLoadedRecipe(t, "serve", Readiness{Type: ReadinessHTTP, Path: "/ready", Timeout: 5 * time.Second})

	var callbackMu sync.Mutex
	persisted := make(map[RuntimeStatus]bool)
	manager, err := NewManager(ManagerOptions{
		PreviewURLTemplate: "http://{slug}.example.test",
		ReadinessPoll:      10 * time.Millisecond,
		StopTimeout:        2 * time.Second,
		Persist: func(_ context.Context, state PersistedState) error {
			callbackMu.Lock()
			persisted[state.Snapshot.Runtime.Status] = true
			callbackMu.Unlock()
			return nil
		},
		Emit: func(_ context.Context, event RuntimeEvent) error {
			callbackMu.Lock()
			defer callbackMu.Unlock()
			if !persisted[event.Snapshot.Runtime.Status] {
				t.Fatalf("event %s emitted before status %s was persisted", event.Type, event.Snapshot.Runtime.Status)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatalf("new manager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = manager.Shutdown(ctx)
	})

	starting, err := manager.Start(context.Background(), StartRequest{SessionID: "sess_12345678", Loaded: loaded})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if starting.Runtime.Status != StatusStarting {
		t.Fatalf("expected starting status, got %s", starting.Runtime.Status)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	running, err := manager.Wait(ctx, "sess_12345678")
	if err != nil {
		t.Fatalf("wait for running: %v", err)
	}
	if running.Runtime.Status != StatusRunning || len(running.Services) != 1 || running.Services[0].Port == 0 {
		t.Fatalf("unexpected running snapshot %#v", running)
	}

	parsedURL, err := url.Parse(running.Runtime.URL)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, running.Runtime.URL+"/api/hello?value=1", nil)
	request.Host = parsedURL.Host
	request.Header.Set("Origin", "http://browser.example")
	recorder := httptest.NewRecorder()
	manager.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("proxy returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Path   string `json:"path"`
		Query  string `json:"query"`
		Host   string `json:"host"`
		Origin string `json:"origin"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode proxy response: %v", err)
	}
	if response.Path != "/hello" || response.Query != "value=1" {
		t.Fatalf("unexpected proxied target: %#v", response)
	}
	if response.Host != parsedURL.Host || !strings.HasPrefix(response.Origin, "http://127.0.0.1:") {
		t.Fatalf("unexpected proxy headers: %#v", response)
	}

	logs, err := manager.Logs("sess_12345678", 0, 100, "web")
	if err != nil {
		t.Fatalf("logs: %v", err)
	}
	combined := ""
	for _, chunk := range logs.Chunks {
		combined += chunk.Data
	}
	if !strings.Contains(combined, "helper stdout") || !strings.Contains(combined, "helper stderr") {
		t.Fatalf("expected stdout and stderr in logs, got %q", combined)
	}

	stopping, err := manager.Stop(context.Background(), "sess_12345678")
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if stopping.Runtime.Status != StatusStopping {
		t.Fatalf("expected stopping status, got %s", stopping.Runtime.Status)
	}
	stopped, err := manager.Wait(ctx, "sess_12345678")
	if err != nil {
		t.Fatalf("wait for stopped: %v", err)
	}
	if stopped.Runtime.Status != StatusStopped {
		t.Fatalf("expected stopped status, got %s", stopped.Runtime.Status)
	}
	request = httptest.NewRequest(http.MethodGet, running.Runtime.URL+"/api/hello", nil)
	request.Host = parsedURL.Host
	recorder = httptest.NewRecorder()
	manager.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected stopped route to return 503, got %d", recorder.Code)
	}
}

func TestManagerCrashFailsRuntimeWithoutRetry(t *testing.T) {
	requireHostingRuntime(t)
	loaded := helperLoadedRecipe(t, "crash", Readiness{Type: ReadinessNone, Timeout: time.Second})
	manager, err := NewManager(ManagerOptions{
		PreviewURLTemplate: "http://{slug}.example.test",
		ReadinessPoll:      10 * time.Millisecond,
		StopTimeout:        time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Start(context.Background(), StartRequest{SessionID: "sess_crash", Loaded: loaded}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		snapshot, statusErr := manager.Status("sess_crash")
		if statusErr != nil {
			t.Fatal(statusErr)
		}
		if snapshot.Runtime.Status == StatusFailed {
			if snapshot.Runtime.Error == "" || snapshot.Services[0].Status != ServiceFailed {
				t.Fatalf("expected visible crash failure, got %#v", snapshot)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("runtime did not fail after helper crashed")
}

func TestManagerRestoreKeepsStableStoppedRouteAndRequiresRestartForDrift(t *testing.T) {
	requireHostingRuntime(t)
	loaded := helperLoadedRecipe(t, "serve", Readiness{Type: ReadinessHTTP, Path: "/ready", Timeout: 5 * time.Second})
	manager, err := NewManager(ManagerOptions{PreviewURLTemplate: "http://{slug}.example.test", ReadinessPoll: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	slug := "custom-stable-gorchestra"
	if err := manager.Restore(PersistedState{
		Snapshot: Snapshot{
			SessionID: "sess_restore",
			Config: ConfigStatus{
				Path:         loaded.Path,
				Present:      true,
				Valid:        true,
				Digest:       loaded.Digest,
				LoadedDigest: loaded.Digest,
				Name:         loaded.Recipe.Name,
				Errors:       []string{},
			},
			Runtime:  RuntimeInfo{Status: StatusRunning},
			Services: serviceSnapshots(loaded.Recipe, ServiceRunning),
		},
		Slug:           slug,
		Workspace:      loaded.Workspace,
		Recipe:         loaded.Recipe,
		RecipeSnapshot: loaded.Snapshot,
	}); err != nil {
		t.Fatalf("restore: %v", err)
	}
	restored, err := manager.Status("sess_restore")
	if err != nil {
		t.Fatal(err)
	}
	if restored.Runtime.Status != StatusStopped || restored.Runtime.URL != "http://"+slug+".example.test" {
		t.Fatalf("unexpected restored snapshot %#v", restored)
	}

	if _, err := manager.Start(context.Background(), StartRequest{SessionID: "sess_restore", Loaded: loaded}); err != nil {
		t.Fatalf("start restored route: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	running, err := manager.Wait(ctx, "sess_restore")
	if err != nil || running.Runtime.Status != StatusRunning {
		t.Fatalf("wait restored start: status=%s err=%v", running.Runtime.Status, err)
	}
	if running.Runtime.URL != "http://"+slug+".example.test" {
		t.Fatalf("stable URL changed to %q", running.Runtime.URL)
	}
	changed := loaded
	changed.Digest = "different"
	if _, err := manager.Start(context.Background(), StartRequest{SessionID: "sess_restore", Loaded: changed}); !errorsIs(err, ErrRecipeChanged) {
		t.Fatalf("expected recipe drift error, got %v", err)
	}
	if _, err := manager.Restart(context.Background(), StartRequest{SessionID: "sess_restore", Loaded: changed}); err != nil {
		t.Fatalf("restart changed recipe: %v", err)
	}
	running, err = manager.Wait(ctx, "sess_restore")
	if err != nil || running.Runtime.Status != StatusRunning {
		t.Fatalf("wait restart: status=%s err=%v", running.Runtime.Status, err)
	}
	_, _ = manager.Stop(context.Background(), "sess_restore")
	_, _ = manager.Wait(ctx, "sess_restore")
}

func TestManagerIngressHealthIsDistinctFromSPAFallback(t *testing.T) {
	requireHostingRuntime(t)
	manager, err := NewManager(ManagerOptions{PreviewURLTemplate: "http://{slug}.example.test"})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	manager.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, IngressHealthPath, nil))
	if recorder.Code != http.StatusOK || recorder.Header().Get("X-Gorchestra-Preview-Ingress") != "ok" || !strings.Contains(recorder.Body.String(), "gorchestra-hosting") {
		t.Fatalf("unexpected ingress health response: code=%d headers=%v body=%q", recorder.Code, recorder.Header(), recorder.Body.String())
	}
}

func TestHostingHelperProcess(t *testing.T) {
	if os.Getenv("GO_WANT_HOSTING_HELPER") != "1" {
		return
	}
	mode := os.Getenv("HOSTING_HELPER_MODE")
	if mode == "crash" {
		fmt.Fprintln(os.Stdout, "helper stdout before crash")
		time.Sleep(150 * time.Millisecond)
		os.Exit(17)
	}
	port := os.Getenv("PORT")
	listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Fprintln(os.Stdout, "helper stdout")
	fmt.Fprintln(os.Stderr, "helper stderr")
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"path":   r.URL.Path,
			"query":  r.URL.RawQuery,
			"host":   r.Host,
			"origin": r.Header.Get("Origin"),
		})
	})
	if err := http.Serve(listener, handler); err != nil {
		os.Exit(3)
	}
}

func helperLoadedRecipe(t *testing.T, mode string, readiness Readiness) LoadedRecipe {
	t.Helper()
	workspace := t.TempDir()
	workspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	recipe := Recipe{
		Version: RecipeVersion,
		Name:    "test-preview",
		Services: []Service{{
			Name:    "web",
			Command: []string{os.Args[0], "-test.run=TestHostingHelperProcess"},
			CWD:     ".",
			Port:    Port{Mode: PortAuto},
			Env: map[string]string{
				"GO_WANT_HOSTING_HELPER": "1",
				"HOSTING_HELPER_MODE":    mode,
			},
			Readiness: readiness,
			Proxy: Proxy{
				HostHeader:    HostHeaderExternal,
				RewriteOrigin: true,
			},
		}},
		Routes: []Route{{Path: "/api", Service: "web", StripPrefix: true}},
	}
	return LoadedRecipe{
		Recipe:    recipe,
		Workspace: workspace,
		Path:      RecipePath(workspace),
		Snapshot:  []byte("test recipe"),
		Digest:    recipe.Digest(),
	}
}

func requireHostingRuntime(t *testing.T) {
	t.Helper()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("hosted preview process supervision is supported on macOS and Linux")
	}
}

func errorsIs(err error, target error) bool {
	return err != nil && strings.Contains(err.Error(), target.Error())
}
