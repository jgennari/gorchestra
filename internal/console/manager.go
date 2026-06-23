package console

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"

	"github.com/creack/pty"
)

const (
	DefaultIdleTimeout = 60 * time.Minute
	DefaultScrollback  = 1 << 20
	defaultCols        = 120
	defaultRows        = 32
)

var ErrNotFound = errors.New("console not found")

type Manager struct {
	mu          sync.Mutex
	consoles    map[string]*sessionConsole
	idleTimeout time.Duration
	scrollback  int
}

type Status struct {
	SessionID     string  `json:"session_id"`
	WorkspacePath string  `json:"workspace_path"`
	Running       bool    `json:"running"`
	AttachedCount int     `json:"attached_count"`
	StartedAt     string  `json:"started_at,omitempty"`
	IdleSince     *string `json:"idle_since,omitempty"`
	ExitedAt      *string `json:"exited_at,omitempty"`
	ExitCode      *int    `json:"exit_code,omitempty"`
}

type Attachment struct {
	console  *sessionConsole
	output   chan []byte
	close    sync.Once
	Snapshot []byte
}

type sessionConsole struct {
	manager       *Manager
	sessionID     string
	workspacePath string
	cmd           *exec.Cmd
	pty           *os.File
	startedAt     time.Time
	exitedAt      *time.Time
	exitCode      *int
	scrollback    boundedBuffer
	clients       map[chan []byte]struct{}
	idleSince     *time.Time
	idleTimer     *time.Timer
	mu            sync.Mutex
}

func NewManager() *Manager {
	return &Manager{
		consoles:    make(map[string]*sessionConsole),
		idleTimeout: DefaultIdleTimeout,
		scrollback:  DefaultScrollback,
	}
}

func (m *Manager) Status(sessionID string) (Status, bool) {
	m.mu.Lock()
	c, ok := m.consoles[sessionID]
	m.mu.Unlock()
	if !ok {
		return Status{SessionID: sessionID}, false
	}
	return c.status(), true
}

func (m *Manager) Start(_ context.Context, sessionID string, workspacePath string) (Status, error) {
	c, err := m.getOrStart(sessionID, workspacePath)
	if err != nil {
		return Status{}, err
	}
	return c.status(), nil
}

func (m *Manager) Attach(_ context.Context, sessionID string, workspacePath string) (*Attachment, Status, error) {
	c, err := m.getOrStart(sessionID, workspacePath)
	if err != nil {
		return nil, Status{}, err
	}
	attachment := c.attach()
	return attachment, c.status(), nil
}

func (m *Manager) Kill(sessionID string) error {
	m.mu.Lock()
	c, ok := m.consoles[sessionID]
	if ok {
		delete(m.consoles, sessionID)
	}
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	c.kill()
	return nil
}

func (m *Manager) getOrStart(sessionID string, workspacePath string) (*sessionConsole, error) {
	m.mu.Lock()
	if c, ok := m.consoles[sessionID]; ok && c.running() {
		m.mu.Unlock()
		return c, nil
	}
	delete(m.consoles, sessionID)
	m.mu.Unlock()

	c, err := m.start(sessionID, workspacePath)
	if err != nil {
		return nil, err
	}

	m.mu.Lock()
	if existing, ok := m.consoles[sessionID]; ok && existing.running() {
		m.mu.Unlock()
		c.kill()
		return existing, nil
	}
	m.consoles[sessionID] = c
	m.mu.Unlock()
	go c.readLoop()
	return c, nil
}

func (m *Manager) start(sessionID string, workspacePath string) (*sessionConsole, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		if runtime.GOOS == "windows" {
			shell = "cmd"
		} else {
			shell = "/bin/sh"
		}
	}
	cmd := exec.Command(shell)
	cmd.Dir = workspacePath
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: defaultCols, Rows: defaultRows})
	if err != nil {
		return nil, err
	}
	return &sessionConsole{
		manager:       m,
		sessionID:     sessionID,
		workspacePath: workspacePath,
		cmd:           cmd,
		pty:           ptmx,
		startedAt:     time.Now().UTC(),
		scrollback:    boundedBuffer{limit: m.scrollback},
		clients:       make(map[chan []byte]struct{}),
	}, nil
}

func (c *sessionConsole) attach() *Attachment {
	ch := make(chan []byte, 128)
	c.mu.Lock()
	if c.idleTimer != nil {
		c.idleTimer.Stop()
		c.idleTimer = nil
	}
	c.idleSince = nil
	c.clients[ch] = struct{}{}
	snapshot := c.scrollback.bytes()
	c.mu.Unlock()
	return &Attachment{console: c, output: ch, Snapshot: snapshot}
}

func (a *Attachment) Output() <-chan []byte {
	return a.output
}

func (a *Attachment) Write(data string) error {
	_, err := io.WriteString(a.console.pty, data)
	return err
}

func (a *Attachment) Resize(cols uint16, rows uint16) error {
	if cols == 0 || rows == 0 {
		return nil
	}
	return pty.Setsize(a.console.pty, &pty.Winsize{Cols: cols, Rows: rows})
}

func (a *Attachment) Close() {
	a.close.Do(func() {
		a.console.detach(a.output)
	})
}

func (c *sessionConsole) detach(ch chan []byte) {
	c.mu.Lock()
	delete(c.clients, ch)
	close(ch)
	if len(c.clients) == 0 && c.runningLocked() {
		now := time.Now().UTC()
		c.idleSince = &now
		c.idleTimer = time.AfterFunc(c.manager.idleTimeout, func() {
			_ = c.manager.Kill(c.sessionID)
		})
	}
	c.mu.Unlock()
}

func (c *sessionConsole) readLoop() {
	buf := make([]byte, 4096)
	for {
		n, err := c.pty.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			c.broadcast(chunk)
		}
		if err != nil {
			break
		}
	}
	code := 0
	if err := c.cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			code = -1
		}
	}
	c.markExited(code)
}

func (c *sessionConsole) broadcast(chunk []byte) {
	c.mu.Lock()
	c.scrollback.write(chunk)
	for client := range c.clients {
		select {
		case client <- chunk:
		default:
		}
	}
	c.mu.Unlock()
}

func (c *sessionConsole) status() Status {
	c.mu.Lock()
	defer c.mu.Unlock()
	status := Status{
		SessionID:     c.sessionID,
		WorkspacePath: c.workspacePath,
		Running:       c.runningLocked(),
		AttachedCount: len(c.clients),
		StartedAt:     c.startedAt.Format(time.RFC3339Nano),
		ExitCode:      c.exitCode,
	}
	if c.idleSince != nil {
		idleSince := c.idleSince.Format(time.RFC3339Nano)
		status.IdleSince = &idleSince
	}
	if c.exitedAt != nil {
		exitedAt := c.exitedAt.Format(time.RFC3339Nano)
		status.ExitedAt = &exitedAt
	}
	return status
}

func (c *sessionConsole) running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.runningLocked()
}

func (c *sessionConsole) runningLocked() bool {
	return c.exitedAt == nil
}

func (c *sessionConsole) kill() {
	c.mu.Lock()
	if c.idleTimer != nil {
		c.idleTimer.Stop()
		c.idleTimer = nil
	}
	clients := make([]chan []byte, 0, len(c.clients))
	for client := range c.clients {
		clients = append(clients, client)
		delete(c.clients, client)
	}
	c.mu.Unlock()
	for _, client := range clients {
		close(client)
	}
	_ = c.pty.Close()
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
}

func (c *sessionConsole) markExited(code int) {
	now := time.Now().UTC()
	c.mu.Lock()
	if c.exitedAt == nil {
		c.exitedAt = &now
		c.exitCode = &code
	}
	if c.idleTimer != nil {
		c.idleTimer.Stop()
		c.idleTimer = nil
	}
	clients := make([]chan []byte, 0, len(c.clients))
	for client := range c.clients {
		clients = append(clients, client)
		delete(c.clients, client)
	}
	c.mu.Unlock()
	for _, client := range clients {
		close(client)
	}
}

type boundedBuffer struct {
	limit int
	buf   bytes.Buffer
}

func (b *boundedBuffer) write(data []byte) {
	if b.limit <= 0 {
		return
	}
	if len(data) >= b.limit {
		b.buf.Reset()
		b.buf.Write(data[len(data)-b.limit:])
		return
	}
	b.buf.Write(data)
	if b.buf.Len() <= b.limit {
		return
	}
	current := b.buf.Bytes()
	keep := append([]byte(nil), current[len(current)-b.limit:]...)
	b.buf.Reset()
	b.buf.Write(keep)
}

func (b *boundedBuffer) bytes() []byte {
	return append([]byte(nil), b.buf.Bytes()...)
}
