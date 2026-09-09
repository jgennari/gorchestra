package store

import (
	"context"
	"testing"
)

func TestPendingInputEventsSnapshotUsesWatermarkAndIgnoresTranscriptBudget(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t, ctx)
	session := createTestSession(t, ctx, s)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.requested", `{"request_id":"question","delivery":"async"}`)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.message.completed", `{"text":"Still working"}`)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.submitted", `{"request_id":"question"}`)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.answered", `{"request_id":"question"}`)
	for watermark, count := range map[int64]int{2: 1, 3: 2, 4: 0} {
		got, err := s.ListPendingInputEvents(ctx, session.ID, watermark)
		if err != nil || len(got) != count {
			t.Fatalf("watermark %d: %#v %v", watermark, got, err)
		}
	}
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.requested", `{"request_id":"next"}`)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.run.cancelled", `{}`)
	got, err := s.ListPendingInputEvents(ctx, session.ID, 6)
	if err != nil || len(got) != 0 {
		t.Fatalf("terminal questions: %#v %v", got, err)
	}
}
