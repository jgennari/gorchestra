package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type observedRequest struct {
	Path              string `json:"path"`
	Host              string `json:"host"`
	ForwardedHost     string `json:"forwarded_host"`
	ForwardedProtocol string `json:"forwarded_protocol"`
}

func TestDevHandlerRoutesFrontendAndAPI(t *testing.T) {
	frontend := requestRecorder(t)
	defer frontend.Close()
	api := requestRecorder(t)
	defer api.Close()

	handler, err := newDevHandler(frontend.URL, api.URL)
	if err != nil {
		t.Fatal(err)
	}

	for _, test := range []struct {
		path     string
		expected string
	}{
		{path: "/", expected: "frontend"},
		{path: "/@vite/client", expected: "frontend"},
		{path: "/api", expected: "api"},
		{path: "/api/health", expected: "api"},
		{path: "/apian", expected: "frontend"},
	} {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "https://gorchestra-dev.example"+test.path, nil)
			request.Host = "gorchestra-dev.example"
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d", response.Code)
			}

			var observed observedRequest
			if err := json.NewDecoder(response.Body).Decode(&observed); err != nil {
				t.Fatal(err)
			}
			if observed.Path != test.path {
				t.Fatalf("path = %q", observed.Path)
			}
			if test.expected == "frontend" && observed.Host != strings.TrimPrefix(frontend.URL, "http://") {
				t.Fatalf("frontend Host = %q", observed.Host)
			}
			if test.expected == "api" && observed.Host != "gorchestra-dev.example" {
				t.Fatalf("API Host = %q", observed.Host)
			}
			if observed.ForwardedHost != "gorchestra-dev.example" {
				t.Fatalf("X-Forwarded-Host = %q", observed.ForwardedHost)
			}
			if observed.ForwardedProtocol != "https" {
				t.Fatalf("X-Forwarded-Proto = %q", observed.ForwardedProtocol)
			}
		})
	}
}

func TestProductionProxyPreservesExternalHost(t *testing.T) {
	upstream := requestRecorder(t)
	defer upstream.Close()

	handler, err := newProxy(upstream.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "https://gorchestra.example/api/health", nil)
	request.Host = "gorchestra.example"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	var observed observedRequest
	if err := json.NewDecoder(response.Body).Decode(&observed); err != nil {
		t.Fatal(err)
	}
	if observed.Host != "gorchestra.example" {
		t.Fatalf("Host = %q", observed.Host)
	}
}

func requestRecorder(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewEncoder(w).Encode(observedRequest{
			Path:              r.URL.Path,
			Host:              r.Host,
			ForwardedHost:     r.Header.Get("X-Forwarded-Host"),
			ForwardedProtocol: r.Header.Get("X-Forwarded-Proto"),
		}); err != nil {
			t.Errorf("encode request: %v", err)
		}
	}))
}
