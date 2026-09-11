package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/jgennari/gorchestra/internal/agents"
	"github.com/jgennari/gorchestra/internal/agents/claude"
	"github.com/jgennari/gorchestra/internal/store"
)

// Exercise real Claude discovery and HTTP validation, with only model execution
// replaced so this test never invokes the installed Claude CLI.
type claudeSkillTestAgent struct {
	*claude.Agent
	inputs chan agents.AgentInput
}

func (a *claudeSkillTestAgent) Run(_ context.Context, input agents.AgentInput, _ agents.EmitFunc) error {
	a.inputs <- input
	return nil
}

func TestClaudeSkillPickerAPIAndSubmission(t *testing.T) {
	ctx := context.Background()
	workspace := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(workspace, "personal-claude"))
	write := func(name, frontmatter string) string {
		path := filepath.Join(workspace, ".claude", "skills", name, "SKILL.md")
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("---\n"+frontmatter+"\n---\nReview instructions"), 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	path := write("review", "description: Review code")
	write("hidden", "user-invocable: false")
	agent := &claudeSkillTestAgent{Agent: claude.New(claude.WithVersionChecker(func(context.Context, string) (string, error) { return "test", nil })), inputs: make(chan agents.AgentInput, 1)}
	db, _, _, handler := newIntegrationAPIWithWorkdir(t, ctx, workspace, agent)
	session, err := db.CreateSession(ctx, store.CreateSessionParams{Title: "Claude skills", AgentType: "claude", WorkspacePath: workspace})
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/sessions/" + session.ID
	response := get(handler, base+"/skills?refresh=true")
	if response.Code != http.StatusOK {
		t.Fatalf("catalog: %d %s", response.Code, response.Body.String())
	}
	var catalog agents.SkillCatalog
	decodeJSON(t, response, &catalog)
	if len(catalog.Skills) != 1 || catalog.Skills[0].Name != "review" {
		t.Fatalf("catalog: %#v", catalog)
	}
	selected := agents.SkillReference{Name: "review", Path: catalog.Skills[0].Path}
	body, _ := json.Marshal(map[string]any{"content": "Review this", "skills": []agents.SkillReference{selected}})
	submitted := postJSON(handler, base+"/messages", string(body))
	if submitted.Code != http.StatusAccepted {
		t.Fatalf("submission: %d %s", submitted.Code, submitted.Body.String())
	}
	select {
	case input := <-agent.inputs:
		if input.Message != "Review this" || !reflect.DeepEqual(input.Skills, []agents.SkillReference{selected}) {
			t.Fatalf("input: %#v", input)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("skill reference never reached adapter")
	}
	waitFor(t, func() bool {
		current, err := db.GetSession(ctx, session.ID)
		return err == nil && current.Status == store.SessionStatusIdle
	})
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	rejected := postJSON(handler, base+"/messages", string(body))
	if rejected.Code != http.StatusBadRequest {
		t.Fatalf("removed skill accepted: %d %s", rejected.Code, rejected.Body.String())
	}
}
