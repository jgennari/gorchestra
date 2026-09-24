// Command showcase-seed creates a synthetic, isolated Threave database for screenshots.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/threave-io/threave/internal/store"
)

type toolStep struct {
	command string
	output  string
	paths   []string
}

type turn struct {
	prompt string
	intro  string
	tools  []toolStep
	reply  string
}

type sessionSpec struct {
	title  string
	agent  string
	parent string
	turns  []turn
}

func main() {
	dbPath := flag.String("db", "", "new SQLite database path")
	workspace := flag.String("workspace", "", "synthetic workspace path")
	flag.Parse()
	if *dbPath == "" || *workspace == "" {
		log.Fatal("--db and --workspace are required")
	}
	if _, err := os.Stat(*dbPath); err == nil {
		log.Fatalf("database already exists: %s (use bun run showcase:reset to recreate it)", *dbPath)
	} else if !os.IsNotExist(err) {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(*dbPath), 0o755); err != nil {
		log.Fatal(err)
	}
	if err := writeWorkspace(*workspace); err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	clock := time.Now().UTC()
	database, err := store.OpenWithClock(ctx, *dbPath, func() time.Time { return clock })
	if err != nil {
		log.Fatal(err)
	}
	defer database.Close()

	ids := map[string]string{}
	specs := showcaseSessions()
	var finalHarborTurn turn
	for index, spec := range specs {
		ages := []time.Duration{8 * 24 * time.Hour, 6 * 24 * time.Hour, 4 * 24 * time.Hour, 2 * 24 * time.Hour, 5 * time.Hour, 4 * time.Hour, 3 * time.Hour}
		base := time.Now().UTC().Add(-ages[index])
		clock = base
		parentID := ids[spec.parent]
		options, err := json.Marshal(sessionOptions(spec.title, spec.agent))
		if err != nil {
			log.Fatal(err)
		}
		session, err := database.CreateSession(ctx, store.CreateSessionParams{
			Title: spec.title, AgentType: spec.agent, ParentSessionID: parentID, WorkspacePath: *workspace, AgentOptions: options,
		})
		if err != nil {
			log.Fatal(err)
		}
		ids[spec.title] = session.ID
		for turnIndex, dialogue := range spec.turns {
			if spec.title == "Harbor UI" && turnIndex == 1 {
				finalHarborTurn = dialogue
				continue
			}
			if turnIndex > 0 {
				clock = base.Add(time.Hour)
			}
			if err := writeTurn(ctx, database, session.ID, spec.agent, *workspace, dialogue, &clock); err != nil {
				log.Fatalf("%s: %v", spec.title, err)
			}
		}
		fmt.Printf("%-23s %s\n", spec.title, session.ID)
	}
	clock = time.Now().UTC().Add(-time.Hour)
	if err := writeTurn(ctx, database, ids["Harbor UI"], "codex", *workspace, finalHarborTurn, &clock); err != nil {
		log.Fatalf("Harbor UI final pass: %v", err)
	}
	fmt.Printf("\nSynthetic database: %s\nSynthetic workspace: %s\n", *dbPath, *workspace)
}

func writeTurn(ctx context.Context, database *store.Store, sessionID, agent, workspace string, dialogue turn, clock *time.Time) error {
	runID, err := store.NewRunID()
	if err != nil {
		return err
	}
	add := func(eventType, role string, status store.EventStatus, payload map[string]any) error {
		step := 5 * time.Second
		switch eventType {
		case "tool.call.started":
			step = 35 * time.Second
		case "tool.call.completed":
			step = 50 * time.Second
		case "agent.message.completed":
			step = 45 * time.Second
		}
		*clock = clock.Add(step)
		payload["run_id"] = runID
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		_, err = database.AppendEvent(ctx, store.AppendEventParams{
			SessionID: sessionID, Type: eventType, Role: role, Status: status, Payload: encoded,
		})
		return err
	}
	for _, entry := range []struct {
		eventType, role string
		status          store.EventStatus
		payload         map[string]any
	}{
		{"user.message.completed", "user", store.EventStatusCompleted, map[string]any{"text": dialogue.prompt}},
		{"session.status.updated", "assistant", store.EventStatusStarted, map[string]any{"status": "running", "run_kind": "message", "agent_type": agent, "workspace_path": workspace}},
		{"agent.run.started", "assistant", store.EventStatusStarted, map[string]any{"provider": agent}},
	} {
		if err := add(entry.eventType, entry.role, entry.status, entry.payload); err != nil {
			return err
		}
	}
	if dialogue.intro != "" {
		if err := add("agent.message.completed", "assistant", store.EventStatusCompleted, map[string]any{"text": dialogue.intro}); err != nil {
			return err
		}
	}
	for index, step := range dialogue.tools {
		itemID := fmt.Sprintf("%s_tool_%d", runID, index+1)
		base := map[string]any{"item_id": itemID, "tool_call_id": itemID, "name": "exec_command", "command": step.command}
		if err := add("tool.call.started", "assistant", store.EventStatusStarted, base); err != nil {
			return err
		}
		finished := map[string]any{"item_id": itemID, "tool_call_id": itemID, "name": "exec_command", "command": step.command, "aggregated_output": step.output, "exit_code": 0}
		if err := add("tool.call.completed", "assistant", store.EventStatusCompleted, finished); err != nil {
			return err
		}
		if len(step.paths) > 0 {
			if err := add("file.change.completed", "assistant", store.EventStatusCompleted, map[string]any{"item_id": itemID + "_files", "paths": step.paths}); err != nil {
				return err
			}
		}
	}
	if err := add("agent.message.completed", "assistant", store.EventStatusCompleted, map[string]any{"text": dialogue.reply}); err != nil {
		return err
	}
	tokens := 850 + len(dialogue.tools)*620 + len(dialogue.reply)*3
	usage := map[string]any{"context_id": runID, "total_tokens": tokens}
	switch agent {
	case "codex":
		snapshot := map[string]any{
			"totalTokens": tokens, "inputTokens": tokens - 220, "cachedInputTokens": tokens / 3,
			"outputTokens": 220, "reasoningOutputTokens": 70,
		}
		if err := add("provider.codex.event", "assistant", store.EventStatusCompleted, map[string]any{
			"provider": agent, "provider_event_type": "thread/tokenUsage/updated",
			"raw":   map[string]any{"tokenUsage": map[string]any{"total": snapshot, "last": snapshot, "modelContextWindow": 258400}},
			"usage": usage,
		}); err != nil {
			return err
		}
	case "opencode":
		if err := add("provider.opencode.event", "assistant", store.EventStatusCompleted, map[string]any{
			"provider": agent, "provider_event_type": "usage_update",
			"raw_update": map[string]any{"used": tokens, "size": 200000}, "usage": usage,
		}); err != nil {
			return err
		}
	}
	terminal := map[string]any{"provider": agent}
	if agent == "claude" {
		terminal["usage"] = usage
	}
	if err := add("agent.run.completed", "assistant", store.EventStatusCompleted, terminal); err != nil {
		return err
	}
	if err := add("session.status.updated", "assistant", store.EventStatusCompleted, map[string]any{"status": "idle"}); err != nil {
		return err
	}
	_, err = database.UpdateSessionStatus(ctx, store.UpdateSessionStatusParams{ID: sessionID, Status: store.SessionStatusIdle})
	return err
}

func sessionOptions(title, agent string) map[string]any {
	switch agent {
	case "codex":
		effort := "medium"
		if title == "Harbor UI" {
			effort = "high"
		}
		return map[string]any{"codex": map[string]any{"model": "gpt-5.6-sol", "reasoning_effort": effort}}
	case "claude":
		return map[string]any{"claude": map[string]any{"model": "sonnet", "effort": "medium"}}
	case "opencode":
		return map[string]any{"opencode": map[string]any{"model": "openai/gpt-5.6-sol"}}
	default:
		return map[string]any{}
	}
}

func writeWorkspace(root string) error {
	if _, err := os.Stat(root); err == nil {
		if _, markerErr := os.Stat(filepath.Join(root, ".threave-showcase")); markerErr != nil {
			return fmt.Errorf("refusing to write into unmarked workspace %s", root)
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	files := map[string]string{
		"README.md":              "# Project workspace\n\nSmall projects and local notes.\n\n- [Harbor UI](harbor-ui/)\n- [Lantern API](lantern-api/)\n- [Trail Map](trail-map/)\n- [Field Notes](field-notes/)\n- [Package Health](package-health/)\n",
		"harbor-ui/package.json": "{\"name\":\"harbor-ui\",\"private\":true,\"scripts\":{\"test\":\"vitest run\",\"build\":\"vite build\"}}\n",
		"harbor-ui/src/App.tsx": `import { Navigation } from './components/Navigation'
import './theme.css'

export function App() {
  const projects: string[] = []
  return <div className="app-shell">
    <Navigation activeSection="Overview" />
    <main>
      <h1>Projects</h1>
      {projects.length === 0 ? <section className="empty-state">
        <h2>No projects yet</h2>
        <p>A project gathers its tasks, notes, and files in one place.</p>
        <button>Create a project</button>
      </section> : projects.map(name => <article key={name}>{name}</article>)}
    </main>
  </div>
}
`,
		"harbor-ui/src/theme.css": `:root { color-scheme: light; --accent: #168f83; }
.app-shell { display: grid; grid-template-columns: 16rem 1fr; min-height: 100vh; }
.empty-state { max-width: 34rem; padding: 2rem; border: 1px solid #d5e3df; }
.empty-state button { background: var(--accent); color: white; }
@media (max-width: 640px) {
  .app-shell { display: block; }
  .empty-state { margin: 1rem; }
}
`,
		"harbor-ui/src/components/Navigation.tsx": `import { useState } from 'react'

export function Navigation({ activeSection }: { activeSection: string }) {
  const [open, setOpen] = useState(false)
  return <header className="navigation">
    <strong>Harbor</strong>
    <span aria-current="page">{activeSection}</span>
    <button aria-expanded={open} aria-controls="main-menu" onClick={() => setOpen(!open)}>Menu</button>
    <nav id="main-menu" aria-label="Main" hidden={!open}>
      <a href="/projects">Projects</a>
      <a href="/activity">Activity</a>
    </nav>
  </header>
}
`,
		"lantern-api/README.md": `# Lantern API

An example Go API for paginated project collections.

GET /projects?cursor=2 returns a project page and a next_cursor when more
results are available. An expired cursor returns 400 with invalid_cursor.

Example response:

    {"projects":[{"name":"North Pier"},{"name":"Market Hall"}],"next_cursor":"2"}
`,
		"lantern-api/go.mod": "module example.test/lantern-api\n\ngo 1.23.5\n",
		"lantern-api/api/projects.go": `package api

import (
  "encoding/json"
  "net/http"
  "strconv"
)

type Project map[string]string
var projects = []Project{{"name": "North Pier"}, {"name": "Market Hall"}, {"name": "Juniper"}}

// ListProjects serves a cursor-paginated project collection.
func ListProjects(w http.ResponseWriter, r *http.Request) {
  cursor := r.URL.Query().Get("cursor")
  offset := 0
  if cursor != "" {
    parsed, err := strconv.Atoi(cursor)
    if err != nil || parsed < 0 || parsed >= len(projects) {
      w.WriteHeader(http.StatusBadRequest)
      _ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_cursor"})
      return
    }
    offset = parsed
  }
  end := offset + 2
  if end > len(projects) { end = len(projects) }
  next := ""
  if end < len(projects) { next = strconv.Itoa(end) }
  _ = json.NewEncoder(w).Encode(map[string]any{"projects": projects[offset:end], "next_cursor": next})
}
`,
		"lantern-api/api/projects_test.go": `package api

import (
  "net/http/httptest"
  "strings"
  "testing"
)

func TestListProjectsStaleCursor(t *testing.T) {
  response := httptest.NewRecorder()
  ListProjects(response, httptest.NewRequest("GET", "/projects?cursor=99", nil))
  if response.Code != 400 || !strings.Contains(response.Body.String(), "invalid_cursor") {
    t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
  }
}
`,
		"trail-map/notes.md": "# Offline map notes\n\nCache region tiles for the next route and show a clear offline state. The last saved route stays visible with its update time.\n",
		"trail-map/src/RouteView.tsx": `export function RouteView({ online, savedAt }: { online: boolean; savedAt: string }) {
  return <main><h1>Last saved route</h1>
    {!online && <p>Offline · Updated {savedAt}. Changes will sync when reconnected.</p>}
    <button disabled={!online}>Refresh route</button>
  </main>
}
`,
		"field-notes/index.md":   "# Field Notes\n\n- [Recipes](recipes.md)\n- [Garden](garden.md)\n\nA small notebook that works offline.\n",
		"field-notes/recipes.md": "# Recipes\n\nQuick weeknight meals and pantry ideas.\n",
		"field-notes/garden.md":  "# Garden\n\nPlanting notes for a small raised bed.\n",
		"package-health/README.md": `# Package Health

Read dependency changes from highest severity to lowest. Each finding shows
the affected package, the upgrade path, and any license change to review.

| Severity | Meaning | Next step |
| --- | --- | --- |
| High | Security or compatibility risk | Upgrade this week |
| Medium | Maintenance risk | Plan an upgrade |
| Low | Informational | Review when convenient |
`,
	}
	for name, content := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return err
		}
	}
	return os.WriteFile(filepath.Join(root, ".threave-showcase"), []byte("Synthetic screenshot workspace. No personal files.\n"), 0o644)
}

func showcaseSessions() []sessionSpec {
	return []sessionSpec{
		{"Field Notes", "codex", "", []turn{{
			prompt: "Give my local notebook a simple index so I can find recipes and garden notes quickly.",
			tools:  []toolStep{{"rg --files field-notes", "field-notes/index.md\nfield-notes/recipes.md\nfield-notes/garden.md", nil}},
			reply:  "Added a concise index with sections for recipes, garden notes, and weekend plans. The links use relative paths so the notebook still works offline.",
		}}},
		{"Package Health", "opencode", "", []turn{{
			prompt: "Can you check whether the package report is readable for a first-time contributor?",
			tools:  []toolStep{{"rg -l 'severity|upgrade|license' package-health", "package-health/README.md", nil}},
			reply:  "The report is sound, but the opening needs a plain-language summary. I added a short legend for severity and an example upgrade path before the detailed table.",
		}}},
		{"Trail Map", "claude", "", []turn{{
			prompt: "Sketch an offline state for the route screen that still feels useful on a phone.",
			intro:  "I’ll keep the route visible and make the unavailable actions explicit.",
			tools:  []toolStep{{"rg --files trail-map", "trail-map/notes.md\ntrail-map/src/RouteView.tsx", nil}},
			reply:  "The offline view now keeps the last saved route on screen, labels its update time, and offers a single retry action. The layout stays one column on narrow screens.",
		}}},
		{"Lantern API", "codex", "", []turn{{
			prompt: "Our project list can get long. Add cursor pagination and document the response shape.",
			intro:  "I’ll trace the handler and the response type, then add a focused test for the next-page cursor.",
			tools: []toolStep{
				{"rg -l 'ListProjects|next_cursor' lantern-api", "lantern-api/api/projects.go\nlantern-api/README.md", nil},
				{"cd lantern-api && go test ./...", "ok  example.test/lantern-api/api  0.08s", []string{"lantern-api/api/projects.go", "lantern-api/api/projects_test.go", "lantern-api/README.md"}},
			},
			reply: "Project listings now accept a cursor and return `next_cursor` when another page exists. The README includes a request and response example, and the pagination tests pass.",
		}, {
			prompt: "What happens when the cursor is stale?",
			tools:  []toolStep{{"cd lantern-api && go test ./api -run TestListProjectsStaleCursor -v", "=== RUN   TestListProjectsStaleCursor\n--- PASS: TestListProjectsStaleCursor (0.00s)\nPASS", nil}},
			reply:  "A stale cursor returns a 400 with a clear `invalid_cursor` error. I added a regression test so clients can safely restart from the first page.",
		}}},
		{"Harbor UI", "codex", "", []turn{{
			prompt: "Polish the dashboard for launch. Split the responsive navigation and empty-state copy into separate tasks, then bring the work together.",
			intro:  "I’ll work on the shared dashboard while the two independent pieces are handled in parallel.",
			tools:  []toolStep{{"rg --files harbor-ui/src", "harbor-ui/src/App.tsx\nharbor-ui/src/theme.css\nharbor-ui/src/components/Navigation.tsx", nil}},
			reply:  "The dashboard structure is ready. Responsive navigation and empty-state copy are separate child sessions; I’ll fold their results into the final pass.",
		}, {
			prompt: "How did the final pass turn out?",
			tools:  []toolStep{{"cd harbor-ui && bun run test && bun run build", "Tests: 24 passed\nBuild completed in 1.3s", []string{"harbor-ui/src/App.tsx", "harbor-ui/src/theme.css"}}},
			reply:  "The navigation, empty state, and dashboard now read as one flow. All 24 component tests pass, and the production build succeeds at mobile and desktop widths.",
		}}},
		{"Responsive navigation", "claude", "Harbor UI", []turn{{
			prompt: "Make Harbor’s navigation work at phone width without hiding the active section.",
			tools:  []toolStep{{"rg -l 'nav|sidebar|active' harbor-ui/src/components", "harbor-ui/src/components/Navigation.tsx", nil}, {"cd harbor-ui && bun run test -- Navigation", "Tests: 6 passed", []string{"harbor-ui/src/components/Navigation.tsx"}}},
			reply:  "The active section remains visible in a compact header, and the menu becomes a full-width sheet on phones. Keyboard and touch navigation both pass the component checks.",
		}}},
		{"Empty-state copy", "opencode", "Harbor UI", []turn{{
			prompt: "Give the new dashboard a helpful empty state for a first visit.",
			tools:  []toolStep{{"rg -l 'empty|No projects' harbor-ui/src", "harbor-ui/src/App.tsx", nil}, {"cd harbor-ui && bun run test -- DashboardEmptyState", "Tests: 3 passed", []string{"harbor-ui/src/App.tsx"}}},
			reply:  "The empty state now explains what a project contains and offers one clear action: Create a project. It avoids implying that the user has done anything wrong.",
		}}},
	}
}
