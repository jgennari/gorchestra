package maintenance

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jgennari/gorchestra/internal/store"
)

const (
	DefaultInitialDelay = 30 * time.Second
	DefaultInterval     = 24 * time.Hour
	DefaultBatchSize    = 1000
)

type Store interface {
	HasRunningSession(context.Context) (bool, error)
	EventMaintenanceStatus(context.Context) (store.EventMaintenanceStatus, error)
	StartEventMaintenance(context.Context, *time.Time) error
	RunEventMaintenanceBatch(context.Context, *time.Time, int) (store.EventMaintenanceBatch, error)
	CompleteEventMaintenance(context.Context, store.EventMaintenanceBatch) error
	FailEventMaintenance(context.Context, error) error
}

type Service struct {
	store          Store
	debugRetention time.Duration
	initialDelay   time.Duration
	interval       time.Duration
	batchSize      int
	now            func() time.Time

	mu      sync.Mutex
	running bool
}

type Option func(*Service)

func WithInitialDelay(delay time.Duration) Option {
	return func(service *Service) { service.initialDelay = delay }
}

func WithInterval(interval time.Duration) Option {
	return func(service *Service) { service.interval = interval }
}

func WithBatchSize(size int) Option {
	return func(service *Service) { service.batchSize = size }
}

func New(eventStore Store, debugRetention time.Duration, options ...Option) *Service {
	service := &Service{
		store:          eventStore,
		debugRetention: debugRetention,
		initialDelay:   DefaultInitialDelay,
		interval:       DefaultInterval,
		batchSize:      DefaultBatchSize,
		now:            func() time.Time { return time.Now().UTC() },
	}
	for _, option := range options {
		option(service)
	}
	return service
}

func (s *Service) Start(ctx context.Context) {
	go func() {
		timer := time.NewTimer(s.initialDelay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			s.runAndLog(ctx)
		}

		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.runAndLog(ctx)
			}
		}
	}()
}

func (s *Service) Status(ctx context.Context) (store.EventMaintenanceStatus, error) {
	return s.store.EventMaintenanceStatus(ctx)
}

func (s *Service) Run(ctx context.Context) error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return nil
	}
	s.running = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
	}()

	running, err := s.store.HasRunningSession(ctx)
	if err != nil {
		return err
	}
	if running {
		return nil
	}

	var cutoff *time.Time
	if s.debugRetention > 0 {
		value := s.now().Add(-s.debugRetention)
		cutoff = &value
	}
	if err := s.store.StartEventMaintenance(ctx, cutoff); err != nil {
		return err
	}
	total := store.EventMaintenanceBatch{}
	for {
		running, err = s.store.HasRunningSession(ctx)
		if err != nil {
			return s.fail(ctx, err)
		}
		if running {
			return s.store.CompleteEventMaintenance(ctx, total)
		}
		batch, err := s.store.RunEventMaintenanceBatch(ctx, cutoff, s.batchSize)
		if err != nil {
			return s.fail(ctx, err)
		}
		total.DeletedDeltaEvents += batch.DeletedDeltaEvents
		total.DeletedDebugEvents += batch.DeletedDebugEvents
		total.ExtractedBlobEvents += batch.ExtractedBlobEvents
		total.ReclaimedBytes += batch.ReclaimedBytes
		if !batch.More {
			break
		}
	}
	return s.store.CompleteEventMaintenance(ctx, total)
}

func (s *Service) fail(ctx context.Context, err error) error {
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if recordErr := s.store.FailEventMaintenance(recordCtx, err); recordErr != nil {
		return fmt.Errorf("%w; record failure: %v", err, recordErr)
	}
	return err
}

func (s *Service) runAndLog(ctx context.Context) {
	if err := s.Run(ctx); err != nil && ctx.Err() == nil {
		log.Printf("event maintenance failed: %v", err)
	}
}
