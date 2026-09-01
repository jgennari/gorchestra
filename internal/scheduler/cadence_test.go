package scheduler

import (
	"testing"
	"time"
)

func TestNextSupportsGuidedAndCronCadences(t *testing.T) {
	after := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)

	interval, err := Next(Cadence{Kind: "interval", Every: 90, Unit: "minutes"}, "UTC", after)
	if err != nil || !interval.Equal(after.Add(90*time.Minute)) {
		t.Fatalf("interval next=%s err=%v", interval, err)
	}

	daily, err := Next(Cadence{Kind: "daily", Time: "09:30"}, "America/New_York", after)
	wantDaily := time.Date(2026, 9, 1, 13, 30, 0, 0, time.UTC)
	if err != nil || !daily.Equal(wantDaily) {
		t.Fatalf("daily next=%s want=%s err=%v", daily, wantDaily, err)
	}

	weekly, err := Next(Cadence{Kind: "weekly", Time: "08:00", Weekdays: []string{"mon", "wed"}}, "UTC", after)
	wantWeekly := time.Date(2026, 9, 2, 8, 0, 0, 0, time.UTC)
	if err != nil || !weekly.Equal(wantWeekly) {
		t.Fatalf("weekly next=%s want=%s err=%v", weekly, wantWeekly, err)
	}

	cronNext, err := Next(Cadence{Kind: "cron", Expression: "15 6 * * 1-5"}, "UTC", after)
	wantCron := time.Date(2026, 9, 2, 6, 15, 0, 0, time.UTC)
	if err != nil || !cronNext.Equal(wantCron) {
		t.Fatalf("cron next=%s want=%s err=%v", cronNext, wantCron, err)
	}
}

func TestNextRejectsInvalidCadence(t *testing.T) {
	for _, test := range []struct {
		name     string
		cadence  Cadence
		timezone string
	}{
		{"zero interval", Cadence{Kind: "interval", Unit: "minutes"}, "UTC"},
		{"bad cron", Cadence{Kind: "cron", Expression: "not cron"}, "UTC"},
		{"embedded timezone", Cadence{Kind: "cron", Expression: "CRON_TZ=UTC 0 9 * * *"}, "UTC"},
		{"bad timezone", Cadence{Kind: "daily", Time: "09:00"}, "Mars/Olympus"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Next(test.cadence, test.timezone, time.Now()); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
