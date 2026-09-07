package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/jgennari/gorchestra/internal/agents/fake"
	"github.com/jgennari/gorchestra/internal/store"
)

func TestConcurrentSubmissionIdentityStartsOnlyOneRun(t *testing.T) {
	ctx := context.Background()
	agent := newBlockingAgent()
	db, _, _, handler := newIntegrationAPI(t, ctx, agent)
	session := createIntegrationSession(t, ctx, db)
	defer func() {
		agent.release()
		waitFor(t, func() bool {
			s, err := db.GetSession(ctx, session.ID)
			return err == nil && s.Status == store.SessionStatusIdle
		})
	}()
	path := "/api/sessions/" + session.ID + "/messages"
	body := `{"content":"Only once","client_submission_id":"stable-1"}`
	var group sync.WaitGroup
	results := make(chan int, 12)
	for i := 0; i < 12; i++ {
		group.Add(1)
		go func() { defer group.Done(); results <- postJSON(handler, path, body).Code }()
	}
	group.Wait()
	close(results)
	for status := range results {
		if status != 202 && status != 409 {
			t.Fatalf("unexpected status %d", status)
		}
	}
	if rec := postJSON(handler, path, body); rec.Code != 202 {
		t.Fatalf("retry: %d %s", rec.Code, rec.Body.String())
	}
	messages := 0
	for _, event := range listIntegrationEvents(t, ctx, db, session.ID) {
		if event.Type == "user.message.completed" {
			messages++
		}
	}
	if messages != 1 {
		t.Fatalf("expected exactly one durable message, got %d", messages)
	}
	queued, _ := db.ListQueuedMessages(ctx, session.ID)
	if len(queued) != 0 {
		t.Fatalf("duplicate retry became queued work: %#v", queued)
	}
	if rec := postJSON(handler, path, `{"content":"Different","client_submission_id":"stable-1"}`); rec.Code != 409 {
		t.Fatalf("identity reuse: %d", rec.Code)
	}
}

func TestQueuedSubmissionReceiptDeduplicatesAndCanBeChecked(t *testing.T) {
	ctx := context.Background()
	db, _, _, handler := newIntegrationAPI(t, ctx, fake.New())
	session := createIntegrationSession(t, ctx, db)
	path := "/api/sessions/" + session.ID
	body := `{"content":"Queue only once","queue":true,"client_submission_id":"queued-1"}`
	for i := 0; i < 2; i++ {
		if rec := postJSON(handler, path+"/messages", body); rec.Code != 202 {
			t.Fatalf("queue: %d %s", rec.Code, rec.Body.String())
		}
	}
	messages, err := db.ListQueuedMessages(ctx, session.ID)
	if err != nil || len(messages) != 1 || messages[0].SourceID != "queued-1" {
		t.Fatalf("queue identity: %#v %v", messages, err)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path+"/submissions/queued-1", nil))
	var receipt store.MessageSubmission
	decodeJSON(t, rec, &receipt)
	if receipt.State != "accepted" {
		t.Fatalf("receipt: %#v", receipt)
	}
	// A durable queue row remains acceptance evidence even if the final receipt
	// could not be written before a process/network failure.
	if err := db.CompleteMessageSubmission(ctx, session.ID, "queued-1", 503, []byte(`{"error":"lost response"}`)); err != nil {
		t.Fatal(err)
	}
	receipt, err = db.GetMessageSubmission(ctx, session.ID, "queued-1")
	if err != nil || receipt.State != "accepted" {
		t.Fatalf("canonical queue recovery: %#v %v", receipt, err)
	}
}

func TestFileSaveRejectsChangedBaseWithoutOverwriting(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "draft.txt")
	if err := os.WriteFile(path, []byte("server changed"), 0600); err != nil {
		t.Fatal(err)
	}
	base := "original"
	if _, err := writeWorkspaceFile(root, path, "local draft", &base); err != errWorkspaceFileChanged {
		t.Fatalf("expected conflict, got %v", err)
	}
	current, _ := os.ReadFile(path)
	if string(current) != "server changed" {
		t.Fatalf("server file overwritten: %s", current)
	}
	base = "server changed"
	if _, err := writeWorkspaceFile(root, path, "reviewed draft", &base); err != nil {
		t.Fatal(err)
	}
}
