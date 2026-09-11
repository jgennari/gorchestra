package claude

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
)

func writeTestSkill(t *testing.T, root, name, content string) string {
	t.Helper()
	path := filepath.Join(root, name, "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestClaudeSkillsDiscoveryAndRefresh(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	workspace := filepath.Join(home, "repo", "nested")
	if err := os.MkdirAll(workspace, 0755); err != nil {
		t.Fatal(err)
	}
	userRoot := filepath.Join(home, ".claude", "skills")
	repoRoot := filepath.Join(home, "repo", ".claude", "skills")
	userPath := writeTestSkill(t, userRoot, "review", "---\nname: review\ndescription: Personal review\n---\nReview code")
	writeTestSkill(t, repoRoot, "review", "---\ndescription: Shadowed\n---\nReview")
	release := writeTestSkill(t, repoRoot, "release", "---\ndescription: |\n  Release safely\ndisable-model-invocation: true\n---\nRelease")
	writeTestSkill(t, userRoot, "hidden", "---\nuser-invocable: false\n---\nBackground knowledge")
	writeTestSkill(t, repoRoot, "broken", "---\nname: broken")
	writeTestSkill(t, repoRoot, "nearest", "---\ndescription: Ancestor\n---\nOld")
	nearest := writeTestSkill(t, filepath.Join(workspace, ".claude", "skills"), "nearest", "# Nested instructions")
	// A bridge and another alias for the same file must not produce extra entries.
	if err := os.Symlink(filepath.Dir(userPath), filepath.Join(repoRoot, "alias")); err != nil {
		t.Fatal(err)
	}
	external := writeTestSkill(t, filepath.Join(home, ".agents", "skills"), "bridge", "---\ndescription: Bridged skill\n---\nReview")
	if err := os.Symlink(filepath.Dir(external), filepath.Join(userRoot, "bridge")); err != nil {
		t.Fatal(err)
	}
	a := New()
	catalog, err := a.Skills(context.Background(), agents.SkillQuery{Workdir: workspace})
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Skills) != 5 || len(catalog.Errors) != 1 {
		t.Fatalf("unexpected catalog: %#v", catalog)
	}
	found := map[string]agents.Skill{}
	for _, skill := range catalog.Skills {
		found[skill.Name] = skill
	}
	if found["review"].Path != userPath || found["review"].Scope != "user" {
		t.Fatalf("personal precedence: %#v", found)
	}
	if found["release"].Path != release || !found["release"].Enabled {
		t.Fatalf("explicit-only skill missing: %#v", found)
	}
	if found["hidden"].Enabled || found["nearest"].Path != nearest {
		t.Fatalf("visibility or ancestor resolution: %#v", found)
	}
	if !filepath.IsAbs(found["bridge"].Path) {
		t.Fatal("expected absolute path")
	}
	if err := os.Remove(release); err != nil {
		t.Fatal(err)
	}
	refreshed, err := a.Skills(context.Background(), agents.SkillQuery{Workdir: workspace, ForceReload: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(refreshed.Skills) != 4 || refreshed.Revision == catalog.Revision {
		t.Fatalf("stale catalog: %#v", refreshed)
	}
}

func TestClaudeSkillsConfigDirectoryAndCancellation(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "config"))
	path := writeTestSkill(t, filepath.Join(root, "config", "skills"), "custom", "---\nname: custom\ndescription: Test\n---\nInstructions")
	a := New()
	catalog, err := a.Skills(context.Background(), agents.SkillQuery{Workdir: root})
	if err != nil || len(catalog.Skills) != 1 || catalog.Skills[0].Path != path {
		t.Fatalf("config directory: %#v, %v", catalog, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := a.Skills(ctx, agents.SkillQuery{Workdir: root}); err != context.Canceled {
		t.Fatalf("cancellation: %v", err)
	}
}

func TestClaudeSkillMalformedMetadata(t *testing.T) {
	for _, content := range []string{"---\nname: unfinished", "---\nname: [invalid]\n---\nBody", "---\nuser-invocable: perhaps\n---\nBody"} {
		if _, err := parseSkill([]byte(content), "test"); err == nil {
			t.Fatalf("accepted invalid metadata: %q", content)
		}
	}
	skill, err := parseSkill([]byte("---\r\ndescription: CRLF skill\r\n---\r\nBody"), "windows-skill")
	if err != nil || skill.Name != "windows-skill" || !strings.Contains(skill.Description, "CRLF") {
		t.Fatalf("CRLF: %#v %v", skill, err)
	}
}

func TestUsageIdentityStaysWithMainModel(t *testing.T) {
	n := newNormalizer()
	events := []string{
		`{"type":"system","subtype":"init","model":"claude-sonnet-4-6"}`,
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"main","model":"claude-sonnet-4-6","usage":{"input_tokens":3,"cache_creation_input_tokens":21331}}}}`,
		`{"type":"stream_event","parent_tool_use_id":"tool_1","event":{"type":"message_start","message":{"id":"helper","model":"haiku","usage":{"input_tokens":500}}}}`,
		`{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":18}}}`,
		`{"type":"result","usage":{"input_tokens":3,"output_tokens":18}}`,
	}
	for index, raw := range events {
		input, err := parseStreamEvent([]byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		normalized := n.normalize(input)
		payload := normalized[0].Event.Payload.(map[string]any)
		if index == 2 && payload["parent_tool_use_id"] != "tool_1" {
			t.Fatal("lost subagent identity")
		}
		if index == 3 && (payload["message_id"] != "main" || payload["model"] != "claude-sonnet-4-6") {
			t.Fatalf("wrong delta identity: %#v", payload)
		}
		if index == 4 && payload["model"] != "claude-sonnet-4-6" {
			t.Fatalf("wrong result model: %#v", payload)
		}
	}
}
