package hosting

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const maxLogChunks = 10_000

type Manager struct {
	mu sync.RWMutex

	previewURLTemplate string
	persistFn          PersistFunc
	emitFn             EmitFunc
	logLimit           int
	stopTimeout        time.Duration
	readinessPoll      time.Duration
	httpClient         *http.Client
	parentEnvironment  func(string) (string, bool)
	now                func() time.Time

	runtimes     map[string]*managedRuntime
	hosts        map[string]string
	shuttingDown bool
}

type managedRuntime struct {
	sessionID string
	slug      string
	host      string
	loaded    LoadedRecipe
	snapshot  Snapshot
	logs      *logBuffer

	generation      uint64
	processes       map[string]*managedProcess
	runContext      context.Context
	cancelRun       context.CancelFunc
	expectedStop    bool
	failureStarted  bool
	restarting      bool
	transitionDone  chan struct{}
	transitionClose sync.Once
}

type managedProcess struct {
	name       string
	cmd        *exec.Cmd
	port       int
	generation uint64
	done       chan struct{}
}

func NewManager(options ManagerOptions) (*Manager, error) {
	template := strings.TrimSpace(options.PreviewURLTemplate)
	if template == "" {
		template = DefaultPreviewTemplate
	}
	if err := ValidatePreviewURLTemplate(template); err != nil {
		return nil, err
	}
	if !processRuntimeSupported() {
		return nil, ErrUnsupported
	}
	if options.LogLimit <= 0 {
		options.LogLimit = DefaultLogLimit
	}
	if options.StopTimeout <= 0 {
		options.StopTimeout = DefaultStopTimeout
	}
	if options.ReadinessPoll <= 0 {
		options.ReadinessPoll = DefaultReadinessPoll
	}
	if options.HTTPClient == nil {
		options.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}
	if options.ParentEnvironment == nil {
		options.ParentEnvironment = os.LookupEnv
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Manager{
		previewURLTemplate: template,
		persistFn:          options.Persist,
		emitFn:             options.Emit,
		logLimit:           options.LogLimit,
		stopTimeout:        options.StopTimeout,
		readinessPoll:      options.ReadinessPoll,
		httpClient:         options.HTTPClient,
		parentEnvironment:  options.ParentEnvironment,
		now:                options.Now,
		runtimes:           make(map[string]*managedRuntime),
		hosts:              make(map[string]string),
	}, nil
}

// Restore reinstates a durable route and stopped snapshot without starting any
// child process. A preview must always be explicitly started after Gorchestra
// itself restarts.
func (m *Manager) Restore(state PersistedState) error {
	if strings.TrimSpace(state.Snapshot.SessionID) == "" {
		return fmt.Errorf("restore hosted preview: session ID is required")
	}
	if strings.TrimSpace(state.Slug) == "" {
		return fmt.Errorf("restore hosted preview: route slug is required")
	}
	previewURL, host, err := m.previewAddress(state.Slug)
	if err != nil {
		return err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.shuttingDown {
		return ErrShuttingDown
	}
	if owner, exists := m.hosts[host]; exists && owner != state.Snapshot.SessionID {
		return fmt.Errorf("%w: %s", ErrHostConflict, host)
	}
	if _, exists := m.runtimes[state.Snapshot.SessionID]; exists {
		return fmt.Errorf("restore hosted preview: session %s already exists", state.Snapshot.SessionID)
	}

	snapshot := cloneSnapshot(state.Snapshot)
	snapshot.Runtime.Status = StatusStopped
	snapshot.Runtime.URL = previewURL
	snapshot.LogCursor = 0
	if snapshot.Config.Errors == nil {
		snapshot.Config.Errors = []string{}
	}
	for index := range snapshot.Services {
		snapshot.Services[index].Status = ServiceStopped
	}
	runtime := &managedRuntime{
		sessionID: state.Snapshot.SessionID,
		slug:      state.Slug,
		host:      host,
		loaded: LoadedRecipe{
			Recipe:    state.Recipe,
			Workspace: state.Workspace,
			Path:      snapshot.Config.Path,
			Snapshot:  append([]byte(nil), state.RecipeSnapshot...),
			Digest:    snapshot.Config.LoadedDigest,
		},
		snapshot:  snapshot,
		logs:      newLogBuffer(m.logLimit, m.now),
		processes: make(map[string]*managedProcess),
	}
	if runtime.loaded.Digest == "" {
		runtime.loaded.Digest = state.Recipe.Digest()
	}
	m.runtimes[runtime.sessionID] = runtime
	m.hosts[host] = runtime.sessionID
	return nil
}

func (m *Manager) Start(ctx context.Context, request StartRequest) (Snapshot, error) {
	m.mu.RLock()
	existing := m.runtimes[strings.TrimSpace(request.SessionID)]
	existingSlug := ""
	if existing != nil {
		existingSlug = existing.slug
	}
	m.mu.RUnlock()
	request, previewURL, host, err := m.normalizeStartRequest(request, existingSlug)
	if err != nil {
		return Snapshot{}, err
	}

	m.mu.Lock()
	if m.shuttingDown {
		m.mu.Unlock()
		return Snapshot{}, ErrShuttingDown
	}
	if owner, exists := m.hosts[host]; exists && owner != request.SessionID {
		m.mu.Unlock()
		return Snapshot{}, fmt.Errorf("%w: %s", ErrHostConflict, host)
	}
	if existing, exists := m.runtimes[request.SessionID]; exists {
		if existing.loaded.Digest != request.Loaded.Digest {
			m.mu.Unlock()
			return Snapshot{}, ErrRecipeChanged
		}
		switch existing.snapshot.Runtime.Status {
		case StatusStarting, StatusRunning:
			snapshot := cloneSnapshot(existing.snapshot)
			m.mu.Unlock()
			return snapshot, nil
		case StatusStopping:
			m.mu.Unlock()
			return Snapshot{}, ErrBusy
		}
		request.Slug = existing.slug
		previewURL = existing.snapshot.Runtime.URL
		host = existing.host
	}

	runtime := m.runtimes[request.SessionID]
	if runtime == nil {
		runtime = &managedRuntime{
			sessionID: request.SessionID,
			slug:      request.Slug,
			host:      host,
			logs:      newLogBuffer(m.logLimit, m.now),
			processes: make(map[string]*managedProcess),
		}
		m.runtimes[request.SessionID] = runtime
		m.hosts[host] = request.SessionID
	}
	m.prepareStartLocked(runtime, request.Loaded, previewURL, false)
	state := m.persistedStateLocked(runtime)
	snapshot := cloneSnapshot(runtime.snapshot)
	generation := runtime.generation
	m.mu.Unlock()

	if err := m.publish(ctx, state, "host.runtime.starting", ""); err != nil {
		m.failRuntime(runtime, generation, "", fmt.Errorf("persist starting preview: %w", err))
		return Snapshot{}, err
	}
	go m.launchRuntime(runtime, generation)
	return snapshot, nil
}

func (m *Manager) Stop(ctx context.Context, sessionID string) (Snapshot, error) {
	sessionID = strings.TrimSpace(sessionID)
	m.mu.Lock()
	runtime, exists := m.runtimes[sessionID]
	if !exists {
		m.mu.Unlock()
		return Snapshot{}, ErrNotFound
	}
	switch runtime.snapshot.Runtime.Status {
	case StatusStopped:
		snapshot := cloneSnapshot(runtime.snapshot)
		m.mu.Unlock()
		return snapshot, nil
	case StatusStopping:
		snapshot := cloneSnapshot(runtime.snapshot)
		m.mu.Unlock()
		return snapshot, nil
	}
	runtime.generation++
	generation := runtime.generation
	runtime.expectedStop = true
	runtime.restarting = false
	if runtime.cancelRun != nil {
		runtime.cancelRun()
	}
	runtime.snapshot.Runtime.Status = StatusStopping
	runtime.snapshot.Runtime.Error = ""
	runtime.transitionDone = make(chan struct{})
	runtime.transitionClose = sync.Once{}
	state := m.persistedStateLocked(runtime)
	snapshot := cloneSnapshot(runtime.snapshot)
	m.mu.Unlock()

	publishErr := m.publish(ctx, state, "host.runtime.stopping", "")
	go m.stopRuntime(runtime, generation, StatusStopped, "")
	if publishErr != nil {
		return snapshot, publishErr
	}
	return snapshot, nil
}

func (m *Manager) Restart(ctx context.Context, request StartRequest) (Snapshot, error) {
	request.SessionID = strings.TrimSpace(request.SessionID)
	m.mu.RLock()
	existing := m.runtimes[request.SessionID]
	existingSlug := ""
	if existing != nil {
		existingSlug = existing.slug
	}
	m.mu.RUnlock()
	request, previewURL, host, err := m.normalizeStartRequest(request, existingSlug)
	if err != nil {
		return Snapshot{}, err
	}

	m.mu.Lock()
	if m.shuttingDown {
		m.mu.Unlock()
		return Snapshot{}, ErrShuttingDown
	}
	runtime := m.runtimes[request.SessionID]
	if runtime == nil {
		m.mu.Unlock()
		return m.Start(ctx, request)
	}
	if runtime.snapshot.Runtime.Status == StatusStarting || runtime.snapshot.Runtime.Status == StatusStopping {
		m.mu.Unlock()
		return Snapshot{}, ErrBusy
	}
	if owner, exists := m.hosts[host]; exists && owner != request.SessionID {
		m.mu.Unlock()
		return Snapshot{}, fmt.Errorf("%w: %s", ErrHostConflict, host)
	}
	runtime.generation++
	generation := runtime.generation
	runtime.expectedStop = true
	runtime.failureStarted = false
	runtime.restarting = true
	if runtime.cancelRun != nil {
		runtime.cancelRun()
	}
	runtime.snapshot.Runtime.Status = StatusStopping
	runtime.snapshot.Runtime.Error = ""
	runtime.transitionDone = make(chan struct{})
	runtime.transitionClose = sync.Once{}
	state := m.persistedStateLocked(runtime)
	snapshot := cloneSnapshot(runtime.snapshot)
	m.mu.Unlock()

	if err := m.publish(ctx, state, "host.runtime.stopping", ""); err != nil {
		go m.stopRuntime(runtime, generation, StatusFailed, err.Error())
		return snapshot, err
	}
	go m.restartRuntime(runtime, generation, request.Loaded, previewURL)
	return snapshot, nil
}

func (m *Manager) Status(sessionID string) (Snapshot, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	runtime, exists := m.runtimes[strings.TrimSpace(sessionID)]
	if !exists {
		return Snapshot{}, ErrNotFound
	}
	snapshot := cloneSnapshot(runtime.snapshot)
	snapshot.LogCursor = runtime.logs.cursor()
	return snapshot, nil
}

func (m *Manager) Wait(ctx context.Context, sessionID string) (Snapshot, error) {
	for {
		m.mu.RLock()
		runtime, exists := m.runtimes[strings.TrimSpace(sessionID)]
		if !exists {
			m.mu.RUnlock()
			return Snapshot{}, ErrNotFound
		}
		snapshot := cloneSnapshot(runtime.snapshot)
		done := runtime.transitionDone
		transitional := snapshot.Runtime.Status == StatusStarting || snapshot.Runtime.Status == StatusStopping
		m.mu.RUnlock()
		if !transitional || done == nil {
			return snapshot, nil
		}
		select {
		case <-ctx.Done():
			return Snapshot{}, ctx.Err()
		case <-done:
		}
	}
}

func (m *Manager) Check(ctx context.Context, sessionID string) ([]ServiceCheck, error) {
	m.mu.RLock()
	runtime, exists := m.runtimes[strings.TrimSpace(sessionID)]
	if !exists {
		m.mu.RUnlock()
		return nil, ErrNotFound
	}
	if runtime.snapshot.Runtime.Status != StatusRunning {
		m.mu.RUnlock()
		return nil, ErrBusy
	}
	loaded := runtime.loaded
	ports := make(map[string]int, len(runtime.snapshot.Services))
	for _, service := range runtime.snapshot.Services {
		ports[service.Name] = service.Port
	}
	m.mu.RUnlock()

	checks := make([]ServiceCheck, 0, len(loaded.Recipe.Services))
	failures := make([]string, 0)
	for _, service := range loaded.Recipe.Services {
		started := m.now()
		err := m.checkServiceReady(ctx, service, ports[service.Name])
		check := ServiceCheck{
			Name:      service.Name,
			Ready:     err == nil,
			Latency:   m.now().Sub(started),
			CheckedAt: m.now().UTC(),
		}
		if err != nil {
			check.Error = err.Error()
			failures = append(failures, service.Name+": "+err.Error())
		}
		checks = append(checks, check)
	}
	if len(failures) > 0 {
		return checks, fmt.Errorf("%w: %s", ErrNotReady, strings.Join(failures, "; "))
	}
	return checks, nil
}

// Logs returns retained chunks after a cursor. When limit truncates a result,
// the newest chunks win so callers can reconnect from LastSeq.
func (m *Manager) Logs(sessionID string, after uint64, limit int, service string) (LogSnapshot, error) {
	m.mu.RLock()
	runtime, exists := m.runtimes[strings.TrimSpace(sessionID)]
	m.mu.RUnlock()
	if !exists {
		return LogSnapshot{}, ErrNotFound
	}
	snapshot := runtime.logs.snapshot(after, strings.TrimSpace(service))
	if limit <= 0 || limit > maxLogChunks {
		limit = maxLogChunks
	}
	if len(snapshot.Chunks) > limit {
		snapshot.Chunks = append([]LogChunk(nil), snapshot.Chunks[len(snapshot.Chunks)-limit:]...)
		snapshot.FirstSeq = snapshot.Chunks[0].Seq
		snapshot.Truncated = true
	}
	return snapshot, nil
}

func (m *Manager) SubscribeLogs(sessionID string, after uint64, service string) (LogSnapshot, <-chan LogChunk, func(), error) {
	m.mu.RLock()
	runtime, exists := m.runtimes[strings.TrimSpace(sessionID)]
	m.mu.RUnlock()
	if !exists {
		return LogSnapshot{}, nil, nil, ErrNotFound
	}
	snapshot, chunks, unsubscribe := runtime.logs.subscribe(after, strings.TrimSpace(service))
	return snapshot, chunks, unsubscribe, nil
}

func (m *Manager) LookupHost(rawHost string) (string, bool) {
	host := normalizeRequestHost(rawHost)
	m.mu.RLock()
	sessionID, ok := m.hosts[host]
	m.mu.RUnlock()
	return sessionID, ok
}

func (m *Manager) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if request.URL.Path == IngressHealthPath {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Gorchestra-Preview-Ingress", "ok")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"status":"ok","service":"gorchestra-hosting"}`)
		return
	}

	sessionID, ok := m.LookupHost(request.Host)
	if !ok {
		writeProxyError(w, http.StatusNotFound, "hosted preview not found")
		return
	}
	m.mu.RLock()
	runtime := m.runtimes[sessionID]
	if runtime == nil {
		m.mu.RUnlock()
		writeProxyError(w, http.StatusNotFound, "hosted preview not found")
		return
	}
	if runtime.snapshot.Runtime.Status != StatusRunning {
		status := runtime.snapshot.Runtime.Status
		m.mu.RUnlock()
		writeProxyError(w, http.StatusServiceUnavailable, "hosted preview is "+string(status))
		return
	}
	route, matched := runtime.loaded.Recipe.MatchRoute(request.URL.Path)
	if !matched {
		m.mu.RUnlock()
		writeProxyError(w, http.StatusNotFound, "preview route not found")
		return
	}
	service, exists := runtime.loaded.Recipe.Service(route.Service)
	if !exists {
		m.mu.RUnlock()
		writeProxyError(w, http.StatusBadGateway, "preview service is unavailable")
		return
	}
	process := runtime.processes[service.Name]
	if process == nil || process.port == 0 {
		m.mu.RUnlock()
		writeProxyError(w, http.StatusBadGateway, "preview service is unavailable")
		return
	}
	port := process.port
	proxyConfig := service.Proxy
	routeCopy := *route
	m.mu.RUnlock()

	target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port))}
	externalHost := request.Host
	proxy := &httputil.ReverseProxy{
		Rewrite: func(proxyRequest *httputil.ProxyRequest) {
			proxyRequest.SetURL(target)
			proxyRequest.SetXForwarded()
			if proxyConfig.HostHeader == HostHeaderExternal {
				proxyRequest.Out.Host = externalHost
			} else {
				proxyRequest.Out.Host = target.Host
			}
			if routeCopy.StripPrefix {
				proxyRequest.Out.URL.Path = stripRoutePrefix(routeCopy.Path, proxyRequest.In.URL.Path)
				proxyRequest.Out.URL.RawPath = ""
			}
			if proxyConfig.RewriteOrigin && proxyRequest.Out.Header.Get("Origin") != "" {
				proxyRequest.Out.Header.Set("Origin", target.Scheme+"://"+target.Host)
			}
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			writeProxyError(w, http.StatusBadGateway, "preview upstream failed: "+err.Error())
		},
		FlushInterval: -1,
	}
	proxy.ServeHTTP(w, request)
}

func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	if m.shuttingDown {
		m.mu.Unlock()
		return nil
	}
	m.shuttingDown = true
	type stopTarget struct {
		runtime    *managedRuntime
		generation uint64
	}
	targets := make([]stopTarget, 0)
	for _, runtime := range m.runtimes {
		switch runtime.snapshot.Runtime.Status {
		case StatusStarting, StatusRunning, StatusStopping, StatusFailed:
			runtime.generation++
			runtime.expectedStop = true
			runtime.restarting = false
			if runtime.cancelRun != nil {
				runtime.cancelRun()
			}
			runtime.snapshot.Runtime.Status = StatusStopping
			runtime.transitionDone = make(chan struct{})
			runtime.transitionClose = sync.Once{}
			targets = append(targets, stopTarget{runtime: runtime, generation: runtime.generation})
		}
	}
	m.mu.Unlock()

	for _, target := range targets {
		m.stopRuntime(target.runtime, target.generation, StatusStopped, "server shutting down")
	}
	for _, target := range targets {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-target.runtime.transitionDone:
		}
	}
	return nil
}

func (m *Manager) normalizeStartRequest(request StartRequest, fallbackSlug string) (StartRequest, string, string, error) {
	request.SessionID = strings.TrimSpace(request.SessionID)
	if request.SessionID == "" {
		return StartRequest{}, "", "", fmt.Errorf("start hosted preview: session ID is required")
	}
	if request.Loaded.Digest == "" {
		request.Loaded.Digest = request.Loaded.Recipe.Digest()
	}
	if request.Loaded.Digest == "" || strings.TrimSpace(request.Loaded.Workspace) == "" || len(request.Loaded.Recipe.Services) == 0 {
		return StartRequest{}, "", "", fmt.Errorf("start hosted preview: a validated recipe is required")
	}
	request.Slug = strings.TrimSpace(request.Slug)
	if request.Slug == "" {
		request.Slug = strings.TrimSpace(fallbackSlug)
	}
	if request.Slug == "" {
		request.Slug = RouteSlug(request.Loaded.Recipe.Name, request.SessionID)
	}
	previewURL, host, err := m.previewAddress(request.Slug)
	if err != nil {
		return StartRequest{}, "", "", err
	}
	return request, previewURL, host, nil
}

func (m *Manager) previewAddress(slug string) (string, string, error) {
	previewURL, err := ExpandPreviewURL(m.previewURLTemplate, slug)
	if err != nil {
		return "", "", err
	}
	parsed, err := url.Parse(previewURL)
	if err != nil {
		return "", "", err
	}
	return previewURL, strings.ToLower(parsed.Hostname()), nil
}

func (m *Manager) prepareStartLocked(runtime *managedRuntime, loaded LoadedRecipe, previewURL string, preserveTransition bool) {
	runtime.loaded = cloneLoadedRecipe(loaded)
	runtime.generation++
	runtime.expectedStop = false
	runtime.failureStarted = false
	runtime.restarting = false
	runtime.processes = make(map[string]*managedProcess)
	runtime.runContext, runtime.cancelRun = context.WithCancel(context.Background())
	if !preserveTransition || runtime.transitionDone == nil {
		runtime.transitionDone = make(chan struct{})
		runtime.transitionClose = sync.Once{}
	}
	runtime.snapshot = Snapshot{
		SessionID: runtime.sessionID,
		Config: ConfigStatus{
			Path:         loaded.Path,
			Present:      true,
			Valid:        true,
			Digest:       loaded.Digest,
			LoadedDigest: loaded.Digest,
			Name:         loaded.Recipe.Name,
			Errors:       []string{},
		},
		Runtime: RuntimeInfo{
			Status: StatusStarting,
			URL:    previewURL,
		},
		Services:  serviceSnapshots(loaded.Recipe, ServiceStarting),
		LogCursor: runtime.logs.cursor(),
	}
}

func (m *Manager) launchRuntime(runtime *managedRuntime, generation uint64) {
	ports := make(map[int]string)
	for _, service := range runtime.loaded.Recipe.Services {
		select {
		case <-runtime.runContext.Done():
			return
		default:
		}
		port, err := allocateServicePort(service.Port)
		if err != nil {
			m.failRuntime(runtime, generation, service.Name, fmt.Errorf("allocate port for %s: %w", service.Name, err))
			return
		}
		if port != 0 {
			if owner, duplicate := ports[port]; duplicate {
				m.failRuntime(runtime, generation, service.Name, fmt.Errorf("services %s and %s use port %d", owner, service.Name, port))
				return
			}
			ports[port] = service.Name
		}
		launch, err := buildServiceLaunch(runtime.loaded, service, runtime.sessionID, port, m.parentEnvironment)
		if err != nil {
			m.failRuntime(runtime, generation, service.Name, err)
			return
		}
		command := exec.Command(launch.command[0], launch.command[1:]...)
		command.Dir = launch.dir
		command.Env = launch.env
		command.Stdout = serviceLogWriter{buffer: runtime.logs, service: service.Name, stream: LogStdout}
		command.Stderr = serviceLogWriter{buffer: runtime.logs, service: service.Name, stream: LogStderr}
		configureProcess(command)
		if err := command.Start(); err != nil {
			m.failRuntime(runtime, generation, service.Name, fmt.Errorf("start service %s: %w", service.Name, err))
			return
		}
		process := &managedProcess{
			name:       service.Name,
			cmd:        command,
			port:       port,
			generation: generation,
			done:       make(chan struct{}),
		}
		m.mu.Lock()
		if runtime.generation != generation || runtime.expectedStop {
			m.mu.Unlock()
			_ = signalProcessGroup(command, syscall.SIGTERM)
			go command.Wait()
			return
		}
		runtime.processes[service.Name] = process
		if info := serviceInfo(runtime.snapshot.Services, service.Name); info != nil {
			now := m.now().UTC()
			info.Port = port
			info.PID = command.Process.Pid
			info.StartedAt = &now
		}
		state := m.persistedStateLocked(runtime)
		m.mu.Unlock()
		go m.waitProcess(runtime, process)
		if err := m.persist(context.Background(), state); err != nil {
			m.failRuntime(runtime, generation, service.Name, fmt.Errorf("persist service %s start: %w", service.Name, err))
			return
		}
	}

	for _, service := range runtime.loaded.Recipe.Services {
		m.mu.RLock()
		process := runtime.processes[service.Name]
		m.mu.RUnlock()
		if process == nil {
			m.failRuntime(runtime, generation, service.Name, fmt.Errorf("service %s did not start", service.Name))
			return
		}
		if err := m.waitForReadiness(runtime.runContext, service, process.port); err != nil {
			m.failRuntime(runtime, generation, service.Name, fmt.Errorf("service %s readiness failed: %w", service.Name, err))
			return
		}
	}

	m.mu.Lock()
	if runtime.generation != generation || runtime.expectedStop || runtime.snapshot.Runtime.Status != StatusStarting {
		m.mu.Unlock()
		return
	}
	now := m.now().UTC()
	runtime.snapshot.Runtime.Status = StatusRunning
	runtime.snapshot.Runtime.StartedAt = &now
	runtime.snapshot.Runtime.StoppedAt = nil
	runtime.snapshot.Runtime.Error = ""
	for index := range runtime.snapshot.Services {
		runtime.snapshot.Services[index].Status = ServiceRunning
	}
	runtime.snapshot.LogCursor = runtime.logs.cursor()
	state := m.persistedStateLocked(runtime)
	m.closeTransitionLocked(runtime)
	m.mu.Unlock()

	if err := m.publish(context.Background(), state, "host.runtime.running", ""); err != nil {
		m.failRuntime(runtime, generation, "", fmt.Errorf("persist running preview: %w", err))
	}
}

func (m *Manager) waitProcess(runtime *managedRuntime, process *managedProcess) {
	err := process.cmd.Wait()
	close(process.done)
	exitCode := -1
	if process.cmd.ProcessState != nil {
		exitCode = process.cmd.ProcessState.ExitCode()
	}

	m.mu.Lock()
	info := serviceInfo(runtime.snapshot.Services, process.name)
	if info != nil {
		now := m.now().UTC()
		info.PID = 0
		info.StoppedAt = &now
		info.ExitCode = &exitCode
	}
	unexpected := runtime.generation == process.generation && !runtime.expectedStop &&
		(runtime.snapshot.Runtime.Status == StatusStarting || runtime.snapshot.Runtime.Status == StatusRunning)
	m.mu.Unlock()
	if !unexpected {
		return
	}
	if err == nil {
		err = fmt.Errorf("service %s exited", process.name)
	} else {
		err = fmt.Errorf("service %s exited: %w", process.name, err)
	}
	m.failRuntime(runtime, process.generation, process.name, err)
}

func (m *Manager) failRuntime(runtime *managedRuntime, generation uint64, serviceName string, failure error) {
	if failure == nil {
		failure = errors.New("hosted preview failed")
	}
	m.mu.Lock()
	if runtime.generation != generation || runtime.failureStarted {
		m.mu.Unlock()
		return
	}
	runtime.failureStarted = true
	runtime.expectedStop = true
	runtime.restarting = false
	if runtime.cancelRun != nil {
		runtime.cancelRun()
	}
	runtime.snapshot.Runtime.Status = StatusFailed
	runtime.snapshot.Runtime.Error = failure.Error()
	if info := serviceInfo(runtime.snapshot.Services, serviceName); info != nil {
		info.Status = ServiceFailed
		info.Error = failure.Error()
	}
	state := m.persistedStateLocked(runtime)
	m.mu.Unlock()

	_ = m.publish(context.Background(), state, "host.runtime.failed", failure.Error())
	m.terminateProcesses(runtime)

	m.mu.Lock()
	if runtime.generation == generation {
		now := m.now().UTC()
		runtime.snapshot.Runtime.StoppedAt = &now
		for index := range runtime.snapshot.Services {
			if runtime.snapshot.Services[index].Status != ServiceFailed {
				runtime.snapshot.Services[index].Status = ServiceStopped
			}
		}
		runtime.snapshot.LogCursor = runtime.logs.cursor()
		state = m.persistedStateLocked(runtime)
		m.closeTransitionLocked(runtime)
	}
	m.mu.Unlock()
	_ = m.persist(context.Background(), state)
}

func (m *Manager) stopRuntime(runtime *managedRuntime, generation uint64, finalStatus RuntimeStatus, message string) {
	m.terminateProcesses(runtime)
	m.mu.Lock()
	if runtime.generation != generation {
		m.mu.Unlock()
		return
	}
	now := m.now().UTC()
	runtime.snapshot.Runtime.Status = finalStatus
	runtime.snapshot.Runtime.StoppedAt = &now
	runtime.snapshot.Runtime.Error = message
	for index := range runtime.snapshot.Services {
		runtime.snapshot.Services[index].Status = ServiceStopped
		runtime.snapshot.Services[index].PID = 0
	}
	runtime.snapshot.LogCursor = runtime.logs.cursor()
	runtime.processes = make(map[string]*managedProcess)
	state := m.persistedStateLocked(runtime)
	m.closeTransitionLocked(runtime)
	m.mu.Unlock()
	eventType := "host.runtime.stopped"
	if finalStatus == StatusFailed {
		eventType = "host.runtime.failed"
	}
	_ = m.publish(context.Background(), state, eventType, message)
}

func (m *Manager) restartRuntime(runtime *managedRuntime, generation uint64, loaded LoadedRecipe, previewURL string) {
	m.terminateProcesses(runtime)
	m.mu.Lock()
	if runtime.generation != generation || !runtime.restarting {
		m.mu.Unlock()
		return
	}
	m.prepareStartLocked(runtime, loaded, previewURL, true)
	newGeneration := runtime.generation
	state := m.persistedStateLocked(runtime)
	m.mu.Unlock()
	if err := m.publish(context.Background(), state, "host.runtime.starting", ""); err != nil {
		m.failRuntime(runtime, newGeneration, "", err)
		return
	}
	m.launchRuntime(runtime, newGeneration)
}

func (m *Manager) terminateProcesses(runtime *managedRuntime) {
	m.mu.RLock()
	processes := make([]*managedProcess, 0, len(runtime.processes))
	for _, process := range runtime.processes {
		processes = append(processes, process)
	}
	m.mu.RUnlock()
	for _, process := range processes {
		_ = signalProcessGroup(process.cmd, syscall.SIGTERM)
	}
	deadline := time.NewTimer(m.stopTimeout)
	defer deadline.Stop()
	for _, process := range processes {
		select {
		case <-process.done:
		case <-deadline.C:
			for _, remaining := range processes {
				select {
				case <-remaining.done:
				default:
					_ = signalProcessGroup(remaining.cmd, syscall.SIGKILL)
				}
			}
			return
		}
	}
}

func (m *Manager) waitForReadiness(ctx context.Context, service Service, port int) error {
	if service.Readiness.Type == ReadinessNone {
		return nil
	}
	timeout := service.Readiness.Timeout
	if timeout <= 0 {
		timeout = DefaultReadyTimeout
	}
	readyContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(m.readinessPoll)
	defer ticker.Stop()
	var lastErr error
	for {
		lastErr = m.checkServiceReady(readyContext, service, port)
		if lastErr == nil {
			return nil
		}
		select {
		case <-readyContext.Done():
			if errors.Is(readyContext.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("timeout after %s: %w", timeout, lastErr)
			}
			return readyContext.Err()
		case <-ticker.C:
		}
	}
}

func (m *Manager) checkServiceReady(ctx context.Context, service Service, port int) error {
	switch service.Readiness.Type {
	case ReadinessNone:
		return nil
	case ReadinessTCP:
		dialer := net.Dialer{Timeout: minDuration(m.readinessPoll, time.Second)}
		connection, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port)))
		if err != nil {
			return err
		}
		return connection.Close()
	case ReadinessHTTP:
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port))+service.Readiness.Path, nil)
		if err != nil {
			return err
		}
		response, err := m.httpClient.Do(request)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		_ = response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 400 {
			return fmt.Errorf("HTTP %d", response.StatusCode)
		}
		return nil
	default:
		return fmt.Errorf("unsupported readiness type %q", service.Readiness.Type)
	}
}

func (m *Manager) publish(ctx context.Context, state PersistedState, eventType string, eventError string) error {
	if err := m.persist(ctx, state); err != nil {
		return err
	}
	if m.emitFn == nil {
		return nil
	}
	event := RuntimeEvent{
		SessionID: state.Snapshot.SessionID,
		Type:      eventType,
		Error:     eventError,
		CreatedAt: m.now().UTC(),
		Snapshot:  cloneSnapshot(state.Snapshot),
	}
	return m.emitFn(ctx, event)
}

func (m *Manager) persist(ctx context.Context, state PersistedState) error {
	if m.persistFn == nil {
		return nil
	}
	return m.persistFn(ctx, state)
}

func (m *Manager) persistedStateLocked(runtime *managedRuntime) PersistedState {
	snapshot := cloneSnapshot(runtime.snapshot)
	snapshot.LogCursor = runtime.logs.cursor()
	return PersistedState{
		Snapshot:       snapshot,
		Slug:           runtime.slug,
		Workspace:      runtime.loaded.Workspace,
		Recipe:         runtime.loaded.Recipe,
		RecipeSnapshot: append([]byte(nil), runtime.loaded.Snapshot...),
	}
}

func (m *Manager) closeTransitionLocked(runtime *managedRuntime) {
	if runtime.transitionDone == nil {
		return
	}
	runtime.transitionClose.Do(func() { close(runtime.transitionDone) })
}

func serviceSnapshots(recipe Recipe, status ServiceStatus) []ServiceInfo {
	services := make([]ServiceInfo, 0, len(recipe.Services))
	for _, service := range recipe.Services {
		services = append(services, ServiceInfo{
			Name:       service.Name,
			Status:     status,
			RoutePaths: routePathsForService(recipe, service.Name),
		})
	}
	return services
}

func routePathsForService(recipe Recipe, serviceName string) []string {
	paths := make([]string, 0)
	for _, route := range recipe.Routes {
		if route.Service == serviceName {
			paths = append(paths, route.Path)
		}
	}
	sort.Strings(paths)
	return paths
}

func serviceInfo(services []ServiceInfo, name string) *ServiceInfo {
	for index := range services {
		if services[index].Name == name {
			return &services[index]
		}
	}
	return nil
}

func allocateServicePort(port Port) (int, error) {
	switch port.Mode {
	case PortNone:
		return 0, nil
	case PortFixed:
		return port.Number, nil
	case PortAuto:
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return 0, err
		}
		number := listener.Addr().(*net.TCPAddr).Port
		if err := listener.Close(); err != nil {
			return 0, err
		}
		return number, nil
	default:
		return 0, fmt.Errorf("unsupported port mode %q", port.Mode)
	}
}

func cloneLoadedRecipe(loaded LoadedRecipe) LoadedRecipe {
	clone := loaded
	clone.Snapshot = append([]byte(nil), loaded.Snapshot...)
	return clone
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	clone := snapshot
	clone.Config.Errors = append([]string(nil), snapshot.Config.Errors...)
	clone.Services = append([]ServiceInfo(nil), snapshot.Services...)
	for index := range clone.Services {
		clone.Services[index].RoutePaths = append([]string(nil), snapshot.Services[index].RoutePaths...)
	}
	return clone
}

func normalizeRequestHost(rawHost string) string {
	rawHost = strings.TrimSpace(strings.ToLower(rawHost))
	if host, _, err := net.SplitHostPort(rawHost); err == nil {
		return strings.Trim(host, "[]")
	}
	return strings.Trim(rawHost, "[]")
}

func stripRoutePrefix(prefix string, requestPath string) string {
	if prefix == "/" {
		return requestPath
	}
	result := strings.TrimPrefix(requestPath, prefix)
	if result == "" {
		return "/"
	}
	if !strings.HasPrefix(result, "/") {
		result = "/" + result
	}
	return result
}

func writeProxyError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func minDuration(left time.Duration, right time.Duration) time.Duration {
	if left < right {
		return left
	}
	return right
}
