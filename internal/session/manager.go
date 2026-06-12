package session

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
)

var (
	ErrInvalidSessionID   = errors.New("session: invalid session id")
	ErrRunAlreadyActive   = errors.New("session: run already active")
	ErrRunNotActive       = errors.New("session: run not active")
	ErrRunAlreadyCanceled = errors.New("session: run already canceled")
)

type Manager struct {
	mu   sync.Mutex
	runs map[string]*run
}

type run struct {
	cancel    context.CancelFunc
	cancelled bool
}

func NewManager() *Manager {
	return &Manager{
		runs: make(map[string]*run),
	}
}

func (m *Manager) Register(parent context.Context, sessionID string) (context.Context, func(), error) {
	if strings.TrimSpace(sessionID) == "" {
		return nil, nil, ErrInvalidSessionID
	}
	if parent == nil {
		parent = context.Background()
	}

	ctx, cancel := context.WithCancel(parent)
	activeRun := &run{cancel: cancel}

	m.mu.Lock()
	if _, exists := m.runs[sessionID]; exists {
		m.mu.Unlock()
		cancel()
		return nil, nil, fmt.Errorf("%w: %s", ErrRunAlreadyActive, sessionID)
	}
	m.runs[sessionID] = activeRun
	m.mu.Unlock()

	var once sync.Once
	cleanup := func() {
		once.Do(func() {
			m.mu.Lock()
			if m.runs[sessionID] == activeRun {
				delete(m.runs, sessionID)
			}
			m.mu.Unlock()

			cancel()
		})
	}

	return ctx, cleanup, nil
}

func (m *Manager) Cancel(sessionID string) error {
	if strings.TrimSpace(sessionID) == "" {
		return ErrInvalidSessionID
	}

	m.mu.Lock()
	activeRun, exists := m.runs[sessionID]
	if !exists {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRunNotActive, sessionID)
	}
	if activeRun.cancelled {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRunAlreadyCanceled, sessionID)
	}
	activeRun.cancelled = true
	cancel := activeRun.cancel
	m.mu.Unlock()

	cancel()
	return nil
}

func (m *Manager) Active(sessionID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	_, exists := m.runs[sessionID]
	return exists
}
