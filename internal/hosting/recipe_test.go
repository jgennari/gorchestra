package hosting

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseRecipeNormalizesDefaultsAndDigest(t *testing.T) {
	workspace := newRecipeWorkspace(t, "My Project", "web", "api")
	first := parseRecipeForTest(t, workspace, `
version: 1
name: my-app
inherit_env: [Z_TOKEN, A_TOKEN]
services:
  - name: web
    command: [bun, run, dev, --port, "${GORCHESTRA_PORT}"]
    cwd: web
    port: auto
    env:
      Z_VALUE: z
      A_VALUE: a
  - name: api
    command: [go, run, ./cmd/api]
    cwd: api
    port: 18081
    readiness:
      type: http
      path: /health
      timeout: 5s
    proxy:
      host_header: external
      rewrite_origin: true
routes:
  - path: /
    service: web
  - path: /api/
    service: api
    strip_prefix: true
`)

	if first.Recipe.Name != "my-app" || first.Recipe.Version != RecipeVersion {
		t.Fatalf("unexpected recipe identity: %#v", first.Recipe)
	}
	if got := strings.Join(first.Recipe.InheritEnv, ","); got != "A_TOKEN,Z_TOKEN" {
		t.Fatalf("inherit_env not normalized: %s", got)
	}
	if first.Recipe.Services[0].Name != "api" || first.Recipe.Services[1].Name != "web" {
		t.Fatalf("services not sorted by name: %#v", first.Recipe.Services)
	}
	api := first.Recipe.Services[0]
	if port, ok := api.Port.Fixed(); !ok || port != 18081 {
		t.Fatalf("unexpected fixed port: %#v", api.Port)
	}
	if api.Readiness.Type != ReadinessHTTP || api.Readiness.Path != "/health" || api.Readiness.Timeout != 5*time.Second {
		t.Fatalf("unexpected HTTP readiness: %#v", api.Readiness)
	}
	if api.Proxy.HostHeader != HostHeaderExternal || !api.Proxy.RewriteOrigin {
		t.Fatalf("unexpected proxy: %#v", api.Proxy)
	}
	web := first.Recipe.Services[1]
	if web.CWD != "web" || !web.Port.IsAuto() {
		t.Fatalf("unexpected normalized web service: %#v", web)
	}
	if web.Readiness.Type != ReadinessTCP || web.Readiness.Timeout != DefaultReadyTimeout {
		t.Fatalf("expected default TCP readiness, got %#v", web.Readiness)
	}
	if web.Proxy.HostHeader != HostHeaderUpstream || web.Proxy.RewriteOrigin {
		t.Fatalf("unexpected default proxy: %#v", web.Proxy)
	}
	if len(first.Recipe.Routes) != 2 || first.Recipe.Routes[0].Path != "/api" || first.Recipe.Routes[1].Path != "/" {
		t.Fatalf("routes not normalized longest-first: %#v", first.Recipe.Routes)
	}
	if len(first.Digest) != 64 || first.Digest != first.Recipe.Digest() {
		t.Fatalf("unexpected digest %q", first.Digest)
	}

	second := parseRecipeForTest(t, workspace, `
# Formatting and semantically irrelevant order do not affect the digest.
routes:
  - {service: api, strip_prefix: true, path: /api}
  - {service: web, path: /}
services:
  - port: 18081
    cwd: api
    command: [go, run, ./cmd/api]
    name: api
    proxy: {rewrite_origin: true, host_header: external}
    readiness: {timeout: 5s, path: /health, type: http}
  - env: {A_VALUE: a, Z_VALUE: z}
    port: auto
    cwd: web
    command: [bun, run, dev, --port, "${GORCHESTRA_PORT}"]
    name: web
    readiness: {type: tcp, timeout: 30s}
    proxy: {host_header: upstream, rewrite_origin: false}
inherit_env: [A_TOKEN, Z_TOKEN]
name: my-app
version: 1
`)
	if first.Digest != second.Digest {
		t.Fatalf("equivalent recipes produced different digests:\n%s\n%s", first.Digest, second.Digest)
	}
}

func TestLoadRecipeUsesCanonicalWorkspaceAndPreservesSnapshot(t *testing.T) {
	workspace := newRecipeWorkspace(t, "Friendly Workspace")
	configDirectory := filepath.Join(workspace, RecipeDirectory)
	if err := os.MkdirAll(configDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	snapshot := []byte("version: 1\nservices:\n  - name: worker\n    command: [sleep, '1']\n")
	if err := os.WriteFile(filepath.Join(configDirectory, RecipeFilename), snapshot, 0o600); err != nil {
		t.Fatal(err)
	}
	workspaceLink := filepath.Join(t.TempDir(), "workspace-link")
	if err := os.Symlink(workspace, workspaceLink); err != nil {
		t.Fatal(err)
	}

	loaded, err := LoadRecipe(workspaceLink)
	if err != nil {
		t.Fatalf("load recipe: %v", err)
	}
	if loaded.Workspace != workspace {
		t.Fatalf("expected canonical workspace %q, got %q", workspace, loaded.Workspace)
	}
	if loaded.Path != RecipePath(workspace) {
		t.Fatalf("unexpected recipe path %q", loaded.Path)
	}
	if string(loaded.Snapshot) != string(snapshot) {
		t.Fatalf("snapshot changed: %q", loaded.Snapshot)
	}
	if loaded.Recipe.Name != "friendly-workspace" {
		t.Fatalf("unexpected default recipe name %q", loaded.Recipe.Name)
	}
	service := loaded.Recipe.Services[0]
	if service.CWD != "." || service.Port.Mode != PortNone || service.Readiness.Type != ReadinessNone {
		t.Fatalf("unexpected worker defaults: %#v", service)
	}
}

func TestParseRecipeRejectsInvalidRecipes(t *testing.T) {
	workspace := newRecipeWorkspace(t, "workspace", "web")
	tests := []struct {
		name    string
		yaml    string
		message string
	}{
		{"empty", "", "decode"},
		{"version", "version: 2\nservices: []\n", "version must be 1"},
		{"unknown field", "version: 1\nunknown: true\nservices: []\n", "field unknown not found"},
		{"no services", "version: 1\nservices: []\n", "at least one"},
		{"duplicate service", "version: 1\nservices:\n- {name: web, command: [one]}\n- {name: web, command: [two]}\n", "duplicate service"},
		{"bad service name", "version: 1\nservices:\n- {name: Web_App, command: [one]}\n", "lowercase DNS label"},
		{"command scalar", "version: 1\nservices:\n- {name: web, command: echo hi}\n", "cannot unmarshal"},
		{"empty command", "version: 1\nservices:\n- {name: web, command: []}\n", "non-empty argv"},
		{"bad port", "version: 1\nservices:\n- {name: web, command: [one], port: random}\n", "port must be"},
		{"low fixed port", "version: 1\nservices:\n- {name: web, command: [one], port: 0}\n", "between 1 and 65535"},
		{"high fixed port", "version: 1\nservices:\n- {name: web, command: [one], port: 65536}\n", "between 1 and 65535"},
		{"missing cwd", "version: 1\nservices:\n- {name: web, command: [one], cwd: missing}\n", "resolve cwd"},
		{"absolute cwd", "version: 1\nservices:\n- {name: web, command: [one], cwd: /tmp}\n", "relative path"},
		{"bad env key", "version: 1\nservices:\n- name: web\n  command: [one]\n  env: {'BAD-NAME': value}\n", "valid environment"},
		{"reserved env", "version: 1\nservices:\n- name: web\n  command: [one]\n  env: {PORT: '1234'}\n", "reserved variable PORT"},
		{"reserved inheritance", "version: 1\ninherit_env: [GORCHESTRA_PORT]\nservices:\n- {name: web, command: [one]}\n", "reserved variable"},
		{"duplicate inheritance", "version: 1\ninherit_env: [TOKEN, TOKEN]\nservices:\n- {name: web, command: [one]}\n", "duplicate variable"},
		{"bad interpolation", "version: 1\nservices:\n- {name: web, command: [one, '${SECRET_TOKEN}']}\n", "unsupported environment interpolation"},
		{"unterminated interpolation", "version: 1\nservices:\n- {name: web, command: [one, '${GORCHESTRA_PORT']}\n", "unterminated"},
		{"tcp no port", "version: 1\nservices:\n- name: web\n  command: [one]\n  readiness: {type: tcp}\n", "requires a service port"},
		{"http no port", "version: 1\nservices:\n- name: web\n  command: [one]\n  readiness: {type: http}\n", "requires a service port"},
		{"http bad path", "version: 1\nservices:\n- name: web\n  command: [one]\n  port: auto\n  readiness: {type: http, path: 'https://example.test'}\n", "absolute HTTP request path"},
		{"timeout", "version: 1\nservices:\n- name: web\n  command: [one]\n  port: auto\n  readiness: {type: tcp, timeout: nope}\n", "positive duration"},
		{"proxy", "version: 1\nservices:\n- name: web\n  command: [one]\n  proxy: {host_header: arbitrary}\n", "unsupported proxy"},
		{"unknown route service", "version: 1\nservices:\n- {name: web, command: [one], port: auto}\nroutes:\n- {path: /, service: api}\n", "does not exist"},
		{"route no port", "version: 1\nservices:\n- {name: web, command: [one]}\nroutes:\n- {path: /, service: web}\n", "has a route but no port"},
		{"duplicate route", "version: 1\nservices:\n- {name: web, command: [one], port: auto}\nroutes:\n- {path: /api, service: web}\n- {path: /api/, service: web}\n", "duplicate route"},
		{"bad route path", "version: 1\nservices:\n- {name: web, command: [one], port: auto}\nroutes:\n- {path: api, service: web}\n", "begin with /"},
		{"multiple documents", "version: 1\nservices:\n- {name: web, command: [one]}\n---\nversion: 1\n", "more than one YAML document"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseRecipe(workspace, RecipePath(workspace), []byte(test.yaml))
			if !errors.Is(err, ErrInvalidRecipe) {
				t.Fatalf("expected ErrInvalidRecipe, got %v", err)
			}
			if !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected error containing %q, got %v", test.message, err)
			}
		})
	}
}

func TestParseRecipeRejectsCWDThatEscapesThroughSymlink(t *testing.T) {
	workspace := newRecipeWorkspace(t, "workspace")
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(workspace, "outside")); err != nil {
		t.Fatal(err)
	}
	_, err := ParseRecipe(workspace, RecipePath(workspace), []byte(`
version: 1
services:
  - name: web
    command: [one]
    cwd: outside
`))
	if !errors.Is(err, ErrInvalidRecipe) || !strings.Contains(err.Error(), "resolves outside workspace") {
		t.Fatalf("expected symlink escape error, got %v", err)
	}
}

func TestParseRecipeCanonicalizesCWDThroughInternalSymlink(t *testing.T) {
	workspace := newRecipeWorkspace(t, "workspace", "packages/web")
	if err := os.Symlink(filepath.Join("packages", "web"), filepath.Join(workspace, "web-link")); err != nil {
		t.Fatal(err)
	}
	loaded := parseRecipeForTest(t, workspace, `
version: 1
services:
  - name: web
    command: [one]
    cwd: web-link
`)
	if got := loaded.Recipe.Services[0].CWD; got != "packages/web" {
		t.Fatalf("expected canonical cwd packages/web, got %q", got)
	}
}

func TestLoadRecipeRejectsConfigSymlinkThatEscapesWorkspace(t *testing.T) {
	workspace := newRecipeWorkspace(t, "workspace")
	configDirectory := filepath.Join(workspace, RecipeDirectory)
	if err := os.MkdirAll(configDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "host.yaml")
	if err := os.WriteFile(outside, []byte("version: 1\nservices: []\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(configDirectory, RecipeFilename)); err != nil {
		t.Fatal(err)
	}
	_, err := LoadRecipe(workspace)
	if !errors.Is(err, ErrInvalidRecipe) || !strings.Contains(err.Error(), "resolves outside workspace") {
		t.Fatalf("expected config symlink escape error, got %v", err)
	}
}

func TestParseRecipeRejectsOversizedSnapshot(t *testing.T) {
	workspace := newRecipeWorkspace(t, "workspace")
	_, err := ParseRecipe(workspace, RecipePath(workspace), make([]byte, MaxRecipeSize+1))
	if !errors.Is(err, ErrInvalidRecipe) || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("expected size error, got %v", err)
	}
}

func TestRecipeMatchRouteUsesLongestBoundaryMatch(t *testing.T) {
	recipe := Recipe{Routes: []Route{
		{Path: "/", Service: "web"},
		{Path: "/api", Service: "api"},
		{Path: "/api/admin", Service: "admin"},
	}}
	tests := map[string]string{
		"/":                 "web",
		"/other":            "web",
		"/api":              "api",
		"/api/users":        "api",
		"/api/admin":        "admin",
		"/api/admin/people": "admin",
		"/apix":             "web",
	}
	for requestPath, want := range tests {
		route, ok := recipe.MatchRoute(requestPath)
		if !ok || route.Service != want {
			t.Errorf("MatchRoute(%q) = %#v, %v; want service %q", requestPath, route, ok, want)
		}
	}
	if route, ok := recipe.MatchRoute("not-absolute"); ok || route != nil {
		t.Fatalf("expected no route for relative path, got %#v", route)
	}
}

func TestInterpolateRuntimeEnvironment(t *testing.T) {
	value, err := InterpolateRuntimeEnvironment(
		"http://${GORCHESTRA_HOST}:${GORCHESTRA_PORT}/$SHELL",
		map[string]string{"GORCHESTRA_HOST": "127.0.0.1", "GORCHESTRA_PORT": "5173"},
	)
	if err != nil {
		t.Fatalf("interpolate: %v", err)
	}
	if value != "http://127.0.0.1:5173/$SHELL" {
		t.Fatalf("unexpected interpolation result %q", value)
	}
	_, err = InterpolateRuntimeEnvironment("${GORCHESTRA_SESSION_ID}", map[string]string{})
	if err == nil || !strings.Contains(err.Error(), "is missing") {
		t.Fatalf("expected missing value error, got %v", err)
	}
}

func parseRecipeForTest(t *testing.T, workspace string, source string) LoadedRecipe {
	t.Helper()
	loaded, err := ParseRecipe(workspace, RecipePath(workspace), []byte(source))
	if err != nil {
		t.Fatalf("parse recipe: %v", err)
	}
	return loaded
}

func newRecipeWorkspace(t *testing.T, name string, directories ...string) string {
	t.Helper()
	workspace := filepath.Join(t.TempDir(), name)
	if err := os.MkdirAll(workspace, 0o755); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		t.Fatal(err)
	}
	for _, directory := range directories {
		if err := os.MkdirAll(filepath.Join(canonical, directory), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return canonical
}
