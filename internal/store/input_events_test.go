package store

import (
	"context"
	"fmt"
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

func TestWithdrawnQuestionDisappearsFromReplayAndPendingCount(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t, ctx)
	session := createTestSession(t, ctx, s)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.requested", `{"request_id":"first","questions":[{"id":"q","multi_select":true}]}`)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.requested", `{"request_id":"second"}`)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.answered", `{"request_id":"first","answers":{"q":{"answers":["A","B"]}}}`)
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.cancelled", `{"request_id":"first"}`)
	current, err := s.GetSession(ctx, session.ID)
	if err != nil || current.PendingInputCount != 1 {
		t.Fatalf("racing withdrawal changed another question's count: %#v %v", current, err)
	}
	appendTestEventWithType(t, ctx, s, session.ID, "agent.input.cancelled", `{"request_id":"second"}`)
	current, err = s.GetSession(ctx, session.ID)
	if err != nil || current.PendingInputCount != 0 {
		t.Fatalf("withdrawn question still pending: %#v %v", current, err)
	}
	for watermark, count := range map[int64]int{2: 2, 4: 1, 5: 0} {
		events, err := s.ListPendingInputEvents(ctx, session.ID, watermark)
		if err != nil || len(events) != count {
			t.Fatalf("watermark %d: %#v %v", watermark, events, err)
		}
	}
}

func TestControlResolutionRacesDoNotConsumeAnotherRequestsCount(t *testing.T) {
	for _, kind := range []string{"input", "permission"} {
		for _, cancelFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/cancelFirst=%t", kind, cancelFirst), func(t *testing.T) {
				ctx := context.Background()
				s := newTestStore(t, ctx)
				session := createTestSession(t, ctx, s)
				prefix := "agent." + kind + "."
				resolved := prefix + "answered"
				if kind == "permission" {
					resolved = prefix + "resolved"
				}
				first, second := resolved, prefix+"cancelled"
				if cancelFirst {
					first, second = second, first
				}
				appendTestEventWithType(t, ctx, s, session.ID, prefix+"requested", `{"request_id":"first"}`)
				appendTestEventWithType(t, ctx, s, session.ID, prefix+"requested", `{"request_id":"second"}`)
				appendTestEventWithType(t, ctx, s, session.ID, first, `{"request_id":"first"}`)
				appendTestEventWithType(t, ctx, s, session.ID, second, `{"request_id":"first"}`)
				current, err := s.GetSession(ctx, session.ID)
				if err != nil {
					t.Fatal(err)
				}
				count := current.PendingInputCount
				if kind == "permission" {
					count = current.PendingPermissionCount
				}
				if count != 1 {
					t.Fatalf("duplicate resolution consumed another request: %d", count)
				}
			})
		}
	}
}
