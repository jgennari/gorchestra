package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestSubmissionReservationSurvivesReopen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "submissions.db")
	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	session, err := db.CreateSession(ctx, CreateSessionParams{AgentType: "fake", Title: "Fixture"})
	if err != nil {
		t.Fatal(err)
	}
	_, claimed, err := db.ClaimMessageSubmission(ctx, session.ID, "pending-1", "fingerprint")
	if err != nil || !claimed {
		t.Fatalf("claim: %v %v", claimed, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	record, claimed, err := db.ClaimMessageSubmission(ctx, session.ID, "pending-1", "fingerprint")
	if err != nil || claimed || record.State != "unknown" {
		t.Fatalf("unsafe reclaim: %#v %v %v", record, claimed, err)
	}
	if err := db.CompleteMessageSubmission(ctx, session.ID, "pending-1", 400, []byte(`{"error":"rejected"}`)); err != nil {
		t.Fatal(err)
	}
	record, err = db.GetMessageSubmission(ctx, session.ID, "pending-1")
	if err != nil || record.State != "rejected" {
		t.Fatalf("rejected receipt: %#v %v", record, err)
	}
}
