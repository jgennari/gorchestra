package session

import (
	"context"
	"errors"
	"strings"

	"github.com/jgennari/gorchestra/internal/agents"
)

var ErrSteeringUnavailable = errors.New("session: this run cannot receive input now")

type steeringHandler struct {
	runID   string
	deliver func(context.Context, agents.SteeringInput) error
	busy    bool
}

func (m *Manager) RegisterSteering(ctx context.Context, sessionID, runID string, deliver func(context.Context, agents.SteeringInput) error) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(runID) == "" || deliver == nil {
		return nil, ErrSteeringUnavailable
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	active := m.runs[sessionID]
	if active == nil || active.cancelled {
		return nil, ErrRunNotActive
	}
	if active.steering != nil {
		return nil, ErrSteeringUnavailable
	}
	handler := &steeringHandler{runID: runID, deliver: deliver}
	active.steering = handler
	return func() {
		m.mu.Lock()
		defer m.mu.Unlock()
		if active.steering == handler {
			active.steering = nil
		}
	}, nil
}

// The expected run prevents stale clients/retries from steering a successor run.
// The caller reserves a durable submission ID before entering this method.
func (m *Manager) SteerWithPersistence(ctx context.Context, sessionID, expectedRunID string, input agents.SteeringInput, persist func() error) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.mu.Lock()
	active := m.runs[sessionID]
	if active == nil || active.cancelled {
		m.mu.Unlock()
		return ErrRunNotActive
	}
	handler := active.steering
	if handler == nil || handler.runID != expectedRunID || handler.busy {
		m.mu.Unlock()
		return ErrSteeringUnavailable
	}
	handler.busy = true
	m.mu.Unlock()
	defer func() { m.mu.Lock(); handler.busy = false; m.mu.Unlock() }()
	if persist != nil {
		if err := persist(); err != nil {
			return err
		}
	}
	m.mu.Lock()
	valid := m.runs[sessionID] == active && !active.cancelled && active.steering == handler
	m.mu.Unlock()
	if !valid {
		return ErrRunNotActive
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return handler.deliver(ctx, input)
}
