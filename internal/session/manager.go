package session

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/jgennari/gorchestra/internal/agents"
)

var (
	ErrInvalidSessionID    = errors.New("session: invalid session id")
	ErrRunAlreadyActive    = errors.New("session: run already active")
	ErrRunNotActive        = errors.New("session: run not active")
	ErrRunAlreadyCanceled  = errors.New("session: run already canceled")
	ErrUserInputNotActive  = errors.New("session: user input request not active")
	ErrPermissionNotActive = errors.New("session: permission request not active")
)

type Manager struct {
	mu   sync.Mutex
	runs map[string]*run
}

type run struct {
	cancel             context.CancelFunc
	cancelled          bool
	inputRequests      map[string]*userInputRequest
	permissionRequests map[string]*permissionRequest
}

type userInputRequest struct {
	request  agents.UserInputRequest
	response chan agents.UserInputResponse
}

type userInputWaiter struct {
	manager   *Manager
	sessionID string
	requestID string
	pending   *userInputRequest
}

type permissionRequest struct {
	request  agents.PermissionRequest
	response chan agents.PermissionResponse
}

type permissionWaiter struct {
	manager   *Manager
	sessionID string
	requestID string
	pending   *permissionRequest
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

func (m *Manager) OpenUserInput(ctx context.Context, request agents.UserInputRequest) (agents.UserInputWaiter, error) {
	sessionID := strings.TrimSpace(request.SessionID)
	requestID := strings.TrimSpace(request.RequestID)
	if sessionID == "" {
		return nil, ErrInvalidSessionID
	}
	if requestID == "" {
		return nil, ErrUserInputNotActive
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	request.SessionID = sessionID
	request.RequestID = requestID
	pending := &userInputRequest{
		request:  request,
		response: make(chan agents.UserInputResponse, 1),
	}

	m.mu.Lock()
	activeRun, exists := m.runs[sessionID]
	if !exists {
		m.mu.Unlock()
		return nil, fmt.Errorf("%w: %s", ErrRunNotActive, sessionID)
	}
	if activeRun.inputRequests == nil {
		activeRun.inputRequests = make(map[string]*userInputRequest)
	}
	if _, exists := activeRun.inputRequests[requestID]; exists {
		m.mu.Unlock()
		return nil, fmt.Errorf("session: user input request already active: %s", requestID)
	}
	activeRun.inputRequests[requestID] = pending
	m.mu.Unlock()

	return &userInputWaiter{
		manager:   m,
		sessionID: sessionID,
		requestID: requestID,
		pending:   pending,
	}, nil
}

func (m *Manager) PendingUserInput(sessionID string, requestID string) (agents.UserInputRequest, error) {
	sessionID = strings.TrimSpace(sessionID)
	requestID = strings.TrimSpace(requestID)
	if sessionID == "" {
		return agents.UserInputRequest{}, ErrInvalidSessionID
	}
	if requestID == "" {
		return agents.UserInputRequest{}, ErrUserInputNotActive
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	activeRun, exists := m.runs[sessionID]
	if !exists {
		return agents.UserInputRequest{}, fmt.Errorf("%w: %s", ErrRunNotActive, sessionID)
	}
	pending := activeRun.inputRequests[requestID]
	if pending == nil {
		return agents.UserInputRequest{}, fmt.Errorf("%w: %s", ErrUserInputNotActive, requestID)
	}
	return pending.request, nil
}

func (m *Manager) AnswerUserInput(sessionID string, requestID string, response agents.UserInputResponse) error {
	sessionID = strings.TrimSpace(sessionID)
	requestID = strings.TrimSpace(requestID)
	if sessionID == "" {
		return ErrInvalidSessionID
	}
	if requestID == "" {
		return ErrUserInputNotActive
	}

	m.mu.Lock()
	activeRun, exists := m.runs[sessionID]
	if !exists {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRunNotActive, sessionID)
	}
	pending := activeRun.inputRequests[requestID]
	if pending == nil {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrUserInputNotActive, requestID)
	}
	delete(activeRun.inputRequests, requestID)
	m.mu.Unlock()

	pending.response <- response
	return nil
}

func (w *userInputWaiter) Wait(ctx context.Context) (agents.UserInputResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case response := <-w.pending.response:
		return response, nil
	case <-ctx.Done():
		return agents.UserInputResponse{}, ctx.Err()
	}
}

func (w *userInputWaiter) Close() {
	w.manager.mu.Lock()
	defer w.manager.mu.Unlock()

	activeRun := w.manager.runs[w.sessionID]
	if activeRun == nil || activeRun.inputRequests[w.requestID] != w.pending {
		return
	}
	delete(activeRun.inputRequests, w.requestID)
}

func (m *Manager) OpenPermission(ctx context.Context, request agents.PermissionRequest) (agents.PermissionWaiter, error) {
	sessionID := strings.TrimSpace(request.SessionID)
	requestID := strings.TrimSpace(request.RequestID)
	if sessionID == "" {
		return nil, ErrInvalidSessionID
	}
	if requestID == "" {
		return nil, ErrPermissionNotActive
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	request.SessionID = sessionID
	request.RequestID = requestID
	pending := &permissionRequest{request: request, response: make(chan agents.PermissionResponse, 1)}

	m.mu.Lock()
	activeRun, exists := m.runs[sessionID]
	if !exists {
		m.mu.Unlock()
		return nil, fmt.Errorf("%w: %s", ErrRunNotActive, sessionID)
	}
	if activeRun.permissionRequests == nil {
		activeRun.permissionRequests = make(map[string]*permissionRequest)
	}
	if _, exists := activeRun.permissionRequests[requestID]; exists {
		m.mu.Unlock()
		return nil, fmt.Errorf("session: permission request already active: %s", requestID)
	}
	activeRun.permissionRequests[requestID] = pending
	m.mu.Unlock()

	return &permissionWaiter{manager: m, sessionID: sessionID, requestID: requestID, pending: pending}, nil
}

func (m *Manager) PendingPermission(sessionID string, requestID string) (agents.PermissionRequest, error) {
	sessionID = strings.TrimSpace(sessionID)
	requestID = strings.TrimSpace(requestID)
	if sessionID == "" {
		return agents.PermissionRequest{}, ErrInvalidSessionID
	}
	if requestID == "" {
		return agents.PermissionRequest{}, ErrPermissionNotActive
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	activeRun := m.runs[sessionID]
	if activeRun == nil {
		return agents.PermissionRequest{}, fmt.Errorf("%w: %s", ErrRunNotActive, sessionID)
	}
	pending := activeRun.permissionRequests[requestID]
	if pending == nil {
		return agents.PermissionRequest{}, fmt.Errorf("%w: %s", ErrPermissionNotActive, requestID)
	}
	return pending.request, nil
}

func (m *Manager) ResolvePermission(sessionID string, requestID string, response agents.PermissionResponse) error {
	sessionID = strings.TrimSpace(sessionID)
	requestID = strings.TrimSpace(requestID)
	if sessionID == "" {
		return ErrInvalidSessionID
	}
	if requestID == "" {
		return ErrPermissionNotActive
	}
	m.mu.Lock()
	activeRun := m.runs[sessionID]
	if activeRun == nil {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrRunNotActive, sessionID)
	}
	pending := activeRun.permissionRequests[requestID]
	if pending == nil {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrPermissionNotActive, requestID)
	}
	delete(activeRun.permissionRequests, requestID)
	m.mu.Unlock()
	pending.response <- response
	return nil
}

func (w *permissionWaiter) Wait(ctx context.Context) (agents.PermissionResponse, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case response := <-w.pending.response:
		return response, nil
	case <-ctx.Done():
		return agents.PermissionResponse{}, ctx.Err()
	}
}

func (w *permissionWaiter) Close() {
	w.manager.mu.Lock()
	defer w.manager.mu.Unlock()
	activeRun := w.manager.runs[w.sessionID]
	if activeRun == nil || activeRun.permissionRequests[w.requestID] != w.pending {
		return
	}
	delete(activeRun.permissionRequests, w.requestID)
}
