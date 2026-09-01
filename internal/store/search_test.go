package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestSearchIndexesSessionHistoryAndToolInputOutput(t *testing.T) {
	ctx := context.Background()
	database := newTestStore(t, ctx)
	session, err := database.CreateSession(ctx, CreateSessionParams{
		Title:         "Deploy observatory",
		AgentType:     "codex",
		WorkspacePath: "/repo",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	message := appendSearchEvent(t, ctx, database, session.ID, "agent.message.completed", `{"text":"The nebula migration is ready."}`)
	appendSearchEvent(t, ctx, database, session.ID, "tool.call.started", `{"tool_call_id":"call-1","name":"exec_command","input":{"command":"deploy canary"}}`)
	completed := appendSearchEvent(t, ctx, database, session.ID, "tool.call.completed", `{"tool_call_id":"call-1","name":"exec_command","output":"canary healthy"}`)

	results, err := database.Search(ctx, "nebu", 10)
	if err != nil {
		t.Fatalf("search message prefix: %v", err)
	}
	if len(results) != 1 || results[0].Kind != "agent_message" || results[0].EventSeq != message.Seq {
		t.Fatalf("unexpected message results: %#v", results)
	}

	results, err = database.Search(ctx, "deploy healthy", 10)
	if err != nil {
		t.Fatalf("search tool input and output: %v", err)
	}
	if len(results) != 1 || results[0].Kind != "tool_call" || results[0].EventSeq != completed.Seq {
		t.Fatalf("unexpected tool results: %#v", results)
	}

	if _, err := database.ArchiveSession(ctx, ArchiveSessionParams{ID: session.ID}); err != nil {
		t.Fatalf("archive session: %v", err)
	}
	results, err = database.Search(ctx, "observ", 10)
	if err != nil {
		t.Fatalf("search archived session: %v", err)
	}
	if len(results) != 1 || results[0].Kind != "session" || results[0].ArchivedAt == nil {
		t.Fatalf("expected archived session result, got %#v", results)
	}
}

func TestSearchFTSQueryRejectsPunctuationOnlyInput(t *testing.T) {
	if got := searchFTSQuery(" ... / "); got != "" {
		t.Fatalf("expected empty query, got %q", got)
	}
	if got := searchFTSQuery("Release notes"); got != `"release"* AND "notes"*` {
		t.Fatalf("unexpected prefix query: %q", got)
	}
}

func TestSearchableToolPayloadSkipsEncodedBlobs(t *testing.T) {
	payload := searchableToolPayload(map[string]any{
		"input":  map[string]any{"query": "needle", "image_base64": strings.Repeat("a", 1000)},
		"output": "data:image/png;base64,hidden",
	})
	if payload != "needle" {
		t.Fatalf("unexpected searchable payload: %q", payload)
	}
}

func appendSearchEvent(t *testing.T, ctx context.Context, database *Store, sessionID, eventType, payload string) Event {
	t.Helper()
	event, err := database.AppendEvent(ctx, AppendEventParams{
		SessionID: sessionID,
		Type:      eventType,
		Role:      "assistant",
		Status:    EventStatusCompleted,
		Payload:   json.RawMessage(payload),
	})
	if err != nil {
		t.Fatalf("append %s: %v", eventType, err)
	}
	return event
}
