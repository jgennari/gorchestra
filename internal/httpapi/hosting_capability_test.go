package httpapi

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAgentRuntimeEnvironmentIncludesHostCLIContext(t *testing.T) {
	api := API{agentAPIURL: "http://127.0.0.1:18080/", executable: "/tmp/gorchestra"}
	environment := api.agentRuntimeEnvironment("sess_1")
	if environment["GORCHESTRA_SESSION_ID"] != "sess_1" {
		t.Fatalf("unexpected session environment %#v", environment)
	}
	if environment["GORCHESTRA_API_URL"] != "http://127.0.0.1:18080" {
		t.Fatalf("unexpected API URL environment %#v", environment)
	}
	if environment["GORCHESTRA_BIN"] != "/tmp/gorchestra" {
		t.Fatalf("unexpected binary environment %#v", environment)
	}
}

func TestAgentHostingContextRequiresRecipe(t *testing.T) {
	workspace := t.TempDir()
	api := API{}
	if context := api.agentHostingContext(workspace); context != "" {
		t.Fatalf("expected no context without recipe, got %q", context)
	}
	configDirectory := filepath.Join(workspace, ".gorchestra")
	if err := os.MkdirAll(configDirectory, 0o755); err != nil {
		t.Fatalf("create config directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configDirectory, "host.yaml"), []byte("version: 1\n"), 0o644); err != nil {
		t.Fatalf("write recipe: %v", err)
	}
	context := api.agentHostingContext(workspace)
	if !strings.Contains(context, `"$GORCHESTRA_BIN" host`) || !strings.Contains(context, ".gorchestra/host.yaml") {
		t.Fatalf("unexpected hosting context %q", context)
	}
}
