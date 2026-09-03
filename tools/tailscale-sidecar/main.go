package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

type config struct {
	stateDir   string
	hostname   string
	tag        string
	prodName   string
	devName    string
	prodTarget string
	devTarget  string
	apiTarget  string
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	cfg, err := parseConfig()
	if err != nil {
		log.Fatal(err)
	}
	if err := run(cfg); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func parseConfig() (config, error) {
	defaultStateDir, err := defaultStateDir()
	if err != nil {
		return config{}, err
	}

	cfg := config{}
	flag.StringVar(&cfg.stateDir, "state-dir", defaultStateDir, "directory for the sidecar Tailscale identity")
	flag.StringVar(&cfg.hostname, "hostname", "gorchestra-services-host", "tailnet device hostname")
	flag.StringVar(&cfg.tag, "tag", "tag:gorchestra-services", "tag-based Tailscale identity")
	flag.StringVar(&cfg.prodName, "prod-service", "svc:gorchestra", "built frontend Tailscale Service")
	flag.StringVar(&cfg.devName, "dev-service", "svc:gorchestra-dev", "Vite frontend Tailscale Service")
	flag.StringVar(&cfg.prodTarget, "prod-target", "http://127.0.0.1:18080", "built frontend and API upstream")
	flag.StringVar(&cfg.devTarget, "dev-target", "http://127.0.0.1:15173", "Vite upstream")
	flag.StringVar(&cfg.apiTarget, "api-target", "http://127.0.0.1:18080", "dev /api upstream")
	flag.Parse()

	for name, value := range map[string]string{
		"state-dir":    cfg.stateDir,
		"hostname":     cfg.hostname,
		"tag":          cfg.tag,
		"prod-service": cfg.prodName,
		"dev-service":  cfg.devName,
	} {
		if strings.TrimSpace(value) == "" {
			return config{}, fmt.Errorf("-%s cannot be empty", name)
		}
	}
	if !strings.HasPrefix(cfg.tag, "tag:") {
		return config{}, fmt.Errorf("-tag must begin with tag:")
	}
	if !strings.HasPrefix(cfg.prodName, "svc:") || !strings.HasPrefix(cfg.devName, "svc:") {
		return config{}, fmt.Errorf("service names must begin with svc:")
	}
	for name, value := range map[string]string{
		"prod-target": cfg.prodTarget,
		"dev-target":  cfg.devTarget,
		"api-target":  cfg.apiTarget,
	} {
		parsed, parseErr := url.Parse(value)
		if parseErr != nil || parsed.Scheme == "" || parsed.Host == "" {
			return config{}, fmt.Errorf("invalid -%s %q", name, value)
		}
	}

	return cfg, nil
}

func defaultStateDir() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve user config directory: %w", err)
	}
	return filepath.Join(configDir, "Gorchestra", "tailscale-sidecar"), nil
}

func run(cfg config) error {
	if err := os.MkdirAll(cfg.stateDir, 0o700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	if err := os.Chmod(cfg.stateDir, 0o700); err != nil {
		return fmt.Errorf("secure state directory: %w", err)
	}

	prodHandler, err := newProxy(cfg.prodTarget, "")
	if err != nil {
		return err
	}
	devHandler, err := newDevHandler(cfg.devTarget, cfg.apiTarget)
	if err != nil {
		return err
	}

	server := &tsnet.Server{
		Dir:           cfg.stateDir,
		Hostname:      cfg.hostname,
		AdvertiseTags: []string{cfg.tag},
		UserLogf:      log.Printf,
	}
	defer server.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	type service struct {
		name    string
		handler http.Handler
	}
	services := []service{
		{name: cfg.prodName, handler: prodHandler},
		{name: cfg.devName, handler: devHandler},
	}

	httpServers := make([]*http.Server, 0, len(services))
	errCh := make(chan error, len(services))
	for _, svc := range services {
		listener, listenErr := server.ListenService(svc.name, tsnet.ServiceModeHTTP{Port: 443, HTTPS: true})
		if listenErr != nil {
			return fmt.Errorf("listen for %s: %w", svc.name, listenErr)
		}

		httpServer := &http.Server{
			Handler:           svc.handler,
			ReadHeaderTimeout: 15 * time.Second,
			IdleTimeout:       2 * time.Minute,
		}
		httpServers = append(httpServers, httpServer)
		log.Printf("%s is listening at https://%s", svc.name, listener.FQDN)
		go func(name string) {
			if serveErr := httpServer.Serve(listener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				errCh <- fmt.Errorf("serve %s: %w", name, serveErr)
			}
		}(svc.name)
	}

	select {
	case <-ctx.Done():
	case err := <-errCh:
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var shutdownErr error
	for _, httpServer := range httpServers {
		shutdownErr = errors.Join(shutdownErr, httpServer.Shutdown(shutdownCtx))
	}
	return shutdownErr
}

func newDevHandler(devTarget, apiTarget string) (http.Handler, error) {
	devURL, err := url.Parse(devTarget)
	if err != nil {
		return nil, fmt.Errorf("parse target %q: %w", devTarget, err)
	}
	devProxy, err := newProxy(devTarget, devURL.Host)
	if err != nil {
		return nil, err
	}
	apiProxy, err := newProxy(apiTarget, "")
	if err != nil {
		return nil, err
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") {
			apiProxy.ServeHTTP(w, r)
			return
		}
		devProxy.ServeHTTP(w, r)
	}), nil
}

func newProxy(targetValue, hostOverride string) (*httputil.ReverseProxy, error) {
	target, err := url.Parse(targetValue)
	if err != nil {
		return nil, fmt.Errorf("parse target %q: %w", targetValue, err)
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(request *httputil.ProxyRequest) {
			externalHost := request.In.Host
			request.SetURL(target)
			request.SetXForwarded()
			request.Out.Header.Set("X-Forwarded-Host", externalHost)
			request.Out.Header.Set("X-Forwarded-Proto", "https")
			if hostOverride == "" {
				request.Out.Host = externalHost
			} else {
				request.Out.Host = hostOverride
			}
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, proxyErr error) {
			log.Printf("proxy %s %s: %v", r.Method, r.URL.Path, proxyErr)
			http.Error(w, "Gorchestra upstream unavailable", http.StatusBadGateway)
		},
	}
	return proxy, nil
}
