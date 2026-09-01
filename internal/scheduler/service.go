package scheduler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	eventservice "github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/store"
)

type EventAppender interface {
	Append(context.Context, eventservice.AppendParams) (store.Event, error)
}

type Input struct {
	Name     string  `json:"name"`
	Prompt   string  `json:"prompt"`
	Cadence  Cadence `json:"cadence"`
	Timezone string  `json:"timezone"`
	Enabled  bool    `json:"enabled"`
}

type Service struct {
	store  *store.Store
	events EventAppender
	now    func() time.Time
	wake   chan struct{}

	mu       sync.RWMutex
	dispatch func(string)
}

func New(database *store.Store, events EventAppender) *Service {
	return &Service{store: database, events: events, now: func() time.Time { return time.Now().UTC() }, wake: make(chan struct{}, 1)}
}

func (s *Service) SetDispatch(dispatch func(string)) {
	s.mu.Lock()
	s.dispatch = dispatch
	s.mu.Unlock()
}

func (s *Service) Start(ctx context.Context) error {
	if err := s.store.FailInterruptedScheduleOccurrences(ctx); err != nil {
		return fmt.Errorf("recover schedule occurrences: %w", err)
	}
	now := s.now()
	due, err := s.store.ListDueSchedules(ctx, now)
	if err != nil {
		return err
	}
	for _, schedule := range due {
		cadence, err := decodeCadence(schedule.Cadence)
		if err != nil {
			log.Printf("disable invalid schedule: schedule_id=%s error=%v", schedule.ID, err)
			_ = s.store.SetScheduleNextRun(ctx, schedule.SessionID, schedule.ID, nil)
			continue
		}
		next, err := Next(cadence, schedule.Timezone, now)
		if err != nil {
			log.Printf("disable invalid schedule: schedule_id=%s error=%v", schedule.ID, err)
			_ = s.store.SetScheduleNextRun(ctx, schedule.SessionID, schedule.ID, nil)
			continue
		}
		if err := s.store.SetScheduleNextRun(ctx, schedule.SessionID, schedule.ID, &next); err != nil {
			return err
		}
	}
	go s.loop(ctx)
	pending, err := s.store.ListPendingQueueSessionIDs(ctx)
	if err != nil {
		return err
	}
	for _, sessionID := range pending {
		s.dispatchSession(sessionID)
	}
	return nil
}

func (s *Service) List(ctx context.Context, sessionID string) ([]store.SessionSchedule, error) {
	return s.store.ListSchedules(ctx, sessionID)
}

func (s *Service) Get(ctx context.Context, sessionID, id string) (store.SessionSchedule, error) {
	return s.store.GetSchedule(ctx, sessionID, id)
}

func (s *Service) Create(ctx context.Context, sessionID string, input Input) (store.SessionSchedule, error) {
	normalized, cadenceJSON, next, err := s.prepare(input)
	if err != nil {
		return store.SessionSchedule{}, err
	}
	item, err := s.store.CreateSchedule(ctx, store.CreateScheduleParams{SessionID: sessionID, Name: normalized.Name, Prompt: normalized.Prompt, Cadence: cadenceJSON, Timezone: normalized.Timezone, Enabled: normalized.Enabled, NextRunAt: next})
	if err != nil {
		return store.SessionSchedule{}, err
	}
	s.emit(ctx, item.SessionID, "schedule.created", item.ID, "")
	s.signal()
	return item, nil
}

func (s *Service) Update(ctx context.Context, sessionID, id string, input Input) (store.SessionSchedule, error) {
	normalized, cadenceJSON, next, err := s.prepare(input)
	if err != nil {
		return store.SessionSchedule{}, err
	}
	previous, err := s.store.GetSchedule(ctx, sessionID, id)
	if err != nil {
		return store.SessionSchedule{}, err
	}
	item, err := s.store.UpdateSchedule(ctx, store.UpdateScheduleParams{SessionID: sessionID, ID: id, Name: normalized.Name, Prompt: normalized.Prompt, Cadence: cadenceJSON, Timezone: normalized.Timezone, Enabled: normalized.Enabled, NextRunAt: next})
	if err != nil {
		return store.SessionSchedule{}, err
	}
	eventType := "schedule.updated"
	if previous.Enabled && !item.Enabled {
		eventType = "schedule.paused"
	}
	if !previous.Enabled && item.Enabled {
		eventType = "schedule.resumed"
	}
	s.emit(ctx, sessionID, eventType, id, "")
	s.signal()
	return item, nil
}

func (s *Service) Delete(ctx context.Context, sessionID, id string) error {
	if err := s.store.DeleteSchedule(ctx, sessionID, id); err != nil {
		return err
	}
	s.emit(ctx, sessionID, "schedule.deleted", id, "")
	s.signal()
	return nil
}

func (s *Service) PauseForArchive(ctx context.Context, sessionID string) error {
	if err := s.store.PauseSchedulesForArchive(ctx, sessionID); err != nil {
		return err
	}
	s.emit(ctx, sessionID, "schedule.archived", "", "")
	s.signal()
	return nil
}

func (s *Service) RunNow(ctx context.Context, sessionID, id string) (store.ScheduleOccurrence, error) {
	item, err := s.store.GetSchedule(ctx, sessionID, id)
	if err != nil {
		return store.ScheduleOccurrence{}, err
	}
	session, err := s.store.GetSession(ctx, sessionID)
	if err != nil {
		return store.ScheduleOccurrence{}, err
	}
	if session.ArchivedAt != nil {
		return store.ScheduleOccurrence{}, fmt.Errorf("%w: session is archived", store.ErrInvalidArgument)
	}
	now := s.now()
	occurrence, err := s.store.MaterializeScheduleOccurrence(ctx, store.MaterializeScheduleOccurrenceParams{ScheduleID: id, SessionID: sessionID, Prompt: item.Prompt, Trigger: "manual", ScheduledFor: now})
	if err != nil {
		return store.ScheduleOccurrence{}, err
	}
	s.emit(ctx, sessionID, "schedule.occurrence.queued", id, occurrence.ID)
	s.dispatchSession(sessionID)
	return occurrence, nil
}

func (s *Service) Occurrences(ctx context.Context, sessionID, id string, limit int) ([]store.ScheduleOccurrence, error) {
	if _, err := s.store.GetSchedule(ctx, sessionID, id); err != nil {
		return nil, err
	}
	return s.store.ListScheduleOccurrences(ctx, sessionID, id, limit)
}

func (s *Service) Occurrence(ctx context.Context, occurrenceID string) (store.ScheduleOccurrence, error) {
	return s.store.GetScheduleOccurrence(ctx, occurrenceID)
}

func (s *Service) CancelOccurrence(ctx context.Context, sessionID, scheduleID, occurrenceID string) (store.ScheduleOccurrence, error) {
	item, err := s.store.CancelScheduleOccurrence(ctx, sessionID, scheduleID, occurrenceID)
	if err == nil {
		s.emit(ctx, sessionID, "schedule.occurrence.cancelled", scheduleID, occurrenceID)
	}
	return item, err
}

func (s *Service) MarkRunning(ctx context.Context, sessionID, scheduleID, occurrenceID, runID string) {
	if occurrenceID == "" {
		return
	}
	if err := s.store.MarkScheduleOccurrenceRunning(ctx, occurrenceID, runID); err != nil {
		log.Printf("mark schedule occurrence running failed: %v", err)
		return
	}
	s.emit(ctx, sessionID, "schedule.occurrence.running", scheduleID, occurrenceID)
}

func (s *Service) MarkFinished(ctx context.Context, sessionID, scheduleID, occurrenceID, status string) {
	if occurrenceID == "" {
		return
	}
	if err := s.store.MarkScheduleOccurrenceFinished(ctx, occurrenceID, status, ""); err != nil {
		log.Printf("mark schedule occurrence finished failed: %v", err)
		return
	}
	s.emit(ctx, sessionID, "schedule.occurrence."+status, scheduleID, occurrenceID)
}

func (s *Service) prepare(input Input) (Input, json.RawMessage, *time.Time, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Prompt = strings.TrimSpace(input.Prompt)
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Prompt == "" {
		return Input{}, nil, nil, fmt.Errorf("%w: prompt is required", store.ErrInvalidArgument)
	}
	if input.Name == "" {
		input.Name = derivedName(input.Prompt)
	}
	if err := ValidateCadence(input.Cadence, input.Timezone); err != nil {
		return Input{}, nil, nil, fmt.Errorf("%w: %v", store.ErrInvalidArgument, err)
	}
	encoded, err := json.Marshal(input.Cadence)
	if err != nil {
		return Input{}, nil, nil, err
	}
	var next *time.Time
	if input.Enabled {
		value, err := Next(input.Cadence, input.Timezone, s.now())
		if err != nil {
			return Input{}, nil, nil, err
		}
		next = &value
	}
	return input, encoded, next, nil
}

func (s *Service) loop(ctx context.Context) {
	for {
		next, err := s.store.NextScheduleTime(ctx)
		if err != nil {
			log.Printf("schedule timer lookup failed: %v", err)
			next = nil
		}
		var timer *time.Timer
		var timerC <-chan time.Time
		if next != nil {
			delay := time.Until(*next)
			if delay < 0 {
				delay = 0
			}
			timer = time.NewTimer(delay)
			timerC = timer.C
		}
		select {
		case <-ctx.Done():
			if timer != nil {
				timer.Stop()
			}
			return
		case <-s.wake:
			if timer != nil {
				timer.Stop()
			}
		case <-timerC:
			s.processDue(ctx)
		}
	}
}

func (s *Service) processDue(ctx context.Context) {
	now := s.now()
	due, err := s.store.ListDueSchedules(ctx, now)
	if err != nil {
		log.Printf("list due schedules failed: %v", err)
		return
	}
	for _, item := range due {
		session, err := s.store.GetSession(ctx, item.SessionID)
		if err != nil || session.ArchivedAt != nil {
			continue
		}
		cadence, err := decodeCadence(item.Cadence)
		if err != nil || item.NextRunAt == nil {
			continue
		}
		next, err := Next(cadence, item.Timezone, *item.NextRunAt)
		if err != nil {
			log.Printf("calculate next schedule failed: schedule_id=%s error=%v", item.ID, err)
			continue
		}
		if !next.After(now) {
			next, err = Next(cadence, item.Timezone, now)
			if err != nil {
				continue
			}
		}
		occurrence, err := s.store.MaterializeScheduleOccurrence(ctx, store.MaterializeScheduleOccurrenceParams{ScheduleID: item.ID, SessionID: item.SessionID, Prompt: item.Prompt, Trigger: "scheduled", ScheduledFor: *item.NextRunAt, NextRunAt: &next, Advance: true})
		if err != nil {
			if !errors.Is(err, store.ErrNotFound) {
				log.Printf("materialize scheduled occurrence failed: schedule_id=%s error=%v", item.ID, err)
			}
			continue
		}
		s.emit(ctx, item.SessionID, "schedule.occurrence.queued", item.ID, occurrence.ID)
		s.dispatchSession(item.SessionID)
	}
}

func (s *Service) emit(ctx context.Context, sessionID, eventType, scheduleID, occurrenceID string) {
	if s.events == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{"schedule_id": scheduleID, "occurrence_id": occurrenceID})
	if _, err := s.events.Append(ctx, eventservice.AppendParams{SessionID: sessionID, Type: eventType, Role: "system", Status: store.EventStatusCompleted, Payload: payload}); err != nil {
		log.Printf("append schedule event failed: session_id=%s event=%s error=%v", sessionID, eventType, err)
	}
}

func (s *Service) dispatchSession(sessionID string) {
	s.mu.RLock()
	dispatch := s.dispatch
	s.mu.RUnlock()
	if dispatch != nil {
		dispatch(sessionID)
	}
}

func (s *Service) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func decodeCadence(raw json.RawMessage) (Cadence, error) {
	var cadence Cadence
	if err := json.Unmarshal(raw, &cadence); err != nil {
		return Cadence{}, err
	}
	return cadence, nil
}

func derivedName(prompt string) string {
	line := strings.TrimSpace(strings.SplitN(prompt, "\n", 2)[0])
	runes := []rune(line)
	if len(runes) > 80 {
		line = string(runes[:80])
	}
	return line
}
