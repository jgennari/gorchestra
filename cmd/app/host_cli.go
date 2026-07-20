package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultHostCommandTimeout = 60 * time.Second

type hostCLI struct {
	client *http.Client
	stdout io.Writer
	stderr io.Writer
	getenv func(string) string
}

type hostStatusResponse struct {
	SessionID string                `json:"session_id"`
	Config    hostConfigResponse    `json:"config"`
	Runtime   hostRuntimeResponse   `json:"runtime"`
	Services  []hostServiceResponse `json:"services"`
	LogCursor int64                 `json:"log_cursor"`
}

type hostConfigResponse struct {
	Path         string   `json:"path"`
	Present      bool     `json:"present"`
	Valid        bool     `json:"valid"`
	Stale        bool     `json:"stale"`
	Digest       string   `json:"digest,omitempty"`
	LoadedDigest string   `json:"loaded_digest,omitempty"`
	Name         string   `json:"name,omitempty"`
	Errors       []string `json:"errors"`
}

type hostRuntimeResponse struct {
	Status    string `json:"status"`
	URL       string `json:"url,omitempty"`
	StartedAt string `json:"started_at,omitempty"`
	StoppedAt string `json:"stopped_at,omitempty"`
	Error     string `json:"error,omitempty"`
}

type hostServiceResponse struct {
	Name       string   `json:"name"`
	Status     string   `json:"status"`
	Port       int      `json:"port,omitempty"`
	RoutePaths []string `json:"route_paths"`
	StartedAt  string   `json:"started_at,omitempty"`
	ExitCode   *int     `json:"exit_code,omitempty"`
	Error      string   `json:"error,omitempty"`
}

type hostLogChunk struct {
	Seq       int64  `json:"seq"`
	Service   string `json:"service"`
	Stream    string `json:"stream"`
	Data      string `json:"data"`
	CreatedAt string `json:"created_at"`
}

type hostLogsResponse struct {
	Chunks    []hostLogChunk `json:"chunks"`
	FirstSeq  int64          `json:"first_seq"`
	LastSeq   int64          `json:"last_seq"`
	Truncated bool           `json:"truncated"`
}

type hostCommandOptions struct {
	server  string
	session string
	timeout time.Duration
	wait    bool
	service string
	follow  bool
	after   int64
	limit   int
}

func runHostCLI(ctx context.Context, args []string) error {
	cli := hostCLI{
		client: &http.Client{},
		stdout: os.Stdout,
		stderr: os.Stderr,
		getenv: os.Getenv,
	}
	return cli.run(ctx, args)
}

func (cli hostCLI) run(ctx context.Context, args []string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		cli.usage()
		return nil
	}
	command := args[0]
	options, err := cli.parseOptions(command, args[1:])
	if err != nil {
		return err
	}
	if options.session == "" {
		return errors.New("host command requires --session or GORCHESTRA_SESSION_ID")
	}

	ctx, cancel := context.WithTimeout(ctx, options.timeout)
	defer cancel()

	switch command {
	case "status":
		status, err := cli.status(ctx, options)
		if err != nil {
			return err
		}
		return writePrettyJSON(cli.stdout, status)
	case "validate", "check":
		status, err := cli.action(ctx, options, command)
		if err != nil {
			return err
		}
		return writePrettyJSON(cli.stdout, status)
	case "start", "stop", "restart":
		status, err := cli.action(ctx, options, command)
		if err != nil {
			return err
		}
		if options.wait && !hostCommandTerminal(command, status.Runtime.Status) {
			status, err = cli.waitForStatus(ctx, options, command)
			if err != nil {
				return err
			}
		}
		if err := writePrettyJSON(cli.stdout, status); err != nil {
			return err
		}
		if status.Runtime.Status == "failed" {
			return fmt.Errorf("preview failed: %s", status.Runtime.Error)
		}
		return nil
	case "url":
		status, err := cli.status(ctx, options)
		if err != nil {
			return err
		}
		if status.Runtime.URL == "" {
			return errors.New("preview URL is unavailable")
		}
		_, err = fmt.Fprintln(cli.stdout, status.Runtime.URL)
		return err
	case "logs":
		return cli.logs(ctx, options)
	default:
		cli.usage()
		return fmt.Errorf("unknown host command %q", command)
	}
}

func (cli hostCLI) parseOptions(command string, args []string) (hostCommandOptions, error) {
	options := hostCommandOptions{
		server:  strings.TrimRight(cli.getenv("GORCHESTRA_API_URL"), "/"),
		session: strings.TrimSpace(cli.getenv("GORCHESTRA_SESSION_ID")),
		timeout: defaultHostCommandTimeout,
		wait:    true,
		limit:   1000,
	}
	if options.server == "" {
		options.server = "http://127.0.0.1:8080"
	}
	flags := flag.NewFlagSet("gorchestra host "+command, flag.ContinueOnError)
	flags.SetOutput(cli.stderr)
	flags.StringVar(&options.server, "server", options.server, "Gorchestra API base URL")
	flags.StringVar(&options.session, "session", options.session, "Gorchestra session ID")
	flags.DurationVar(&options.timeout, "timeout", options.timeout, "command timeout")
	flags.BoolVar(&options.wait, "wait", options.wait, "wait for the requested state")
	if command == "logs" {
		flags.StringVar(&options.service, "service", "", "filter by service")
		flags.BoolVar(&options.follow, "follow", false, "follow new log output")
		flags.Int64Var(&options.after, "after-seq", 0, "return logs after this sequence")
		flags.IntVar(&options.limit, "limit", options.limit, "maximum retained chunks")
	}
	if err := flags.Parse(args); err != nil {
		return hostCommandOptions{}, err
	}
	if flags.NArg() != 0 {
		return hostCommandOptions{}, fmt.Errorf("unexpected arguments: %s", strings.Join(flags.Args(), " "))
	}
	parsed, err := url.Parse(options.server)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return hostCommandOptions{}, fmt.Errorf("invalid --server URL %q", options.server)
	}
	if options.timeout <= 0 {
		return hostCommandOptions{}, errors.New("--timeout must be positive")
	}
	return options, nil
}

func (cli hostCLI) status(ctx context.Context, options hostCommandOptions) (hostStatusResponse, error) {
	var response hostStatusResponse
	err := cli.requestJSON(ctx, http.MethodGet, cli.hostURL(options, ""), nil, &response)
	return response, err
}

func (cli hostCLI) action(ctx context.Context, options hostCommandOptions, action string) (hostStatusResponse, error) {
	var response hostStatusResponse
	err := cli.requestJSON(ctx, http.MethodPost, cli.hostURL(options, action), map[string]any{}, &response)
	return response, err
}

func (cli hostCLI) waitForStatus(ctx context.Context, options hostCommandOptions, command string) (hostStatusResponse, error) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return hostStatusResponse{}, fmt.Errorf("wait for preview %s: %w", command, ctx.Err())
		case <-ticker.C:
			status, err := cli.status(ctx, options)
			if err != nil {
				return hostStatusResponse{}, err
			}
			if hostCommandTerminal(command, status.Runtime.Status) {
				return status, nil
			}
		}
	}
}

func hostCommandTerminal(command string, status string) bool {
	switch command {
	case "stop":
		return status == "stopped" || status == "failed"
	default:
		return status == "running" || status == "failed"
	}
}

func (cli hostCLI) logs(ctx context.Context, options hostCommandOptions) error {
	query := url.Values{}
	query.Set("after_seq", strconv.FormatInt(options.after, 10))
	query.Set("limit", strconv.Itoa(options.limit))
	if options.service != "" {
		query.Set("service", options.service)
	}
	logsURL := cli.hostURL(options, "logs") + "?" + query.Encode()
	var snapshot hostLogsResponse
	if err := cli.requestJSON(ctx, http.MethodGet, logsURL, nil, &snapshot); err != nil {
		return err
	}
	for _, chunk := range snapshot.Chunks {
		if err := writeHostLogChunk(cli.stdout, chunk); err != nil {
			return err
		}
	}
	if !options.follow {
		return nil
	}

	query.Set("after_seq", strconv.FormatInt(snapshot.LastSeq, 10))
	streamURL := cli.hostURL(options, "logs/stream") + "?" + query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, streamURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "text/event-stream")
	response, err := cli.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
		return apiResponseError(response.StatusCode, body)
	}

	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		var chunk hostLogChunk
		if err := json.Unmarshal(bytes.TrimSpace([]byte(strings.TrimPrefix(line, "data:"))), &chunk); err != nil || chunk.Seq == 0 {
			continue
		}
		if err := writeHostLogChunk(cli.stdout, chunk); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func (cli hostCLI) hostURL(options hostCommandOptions, suffix string) string {
	base := strings.TrimRight(options.server, "/") + "/api/sessions/" + url.PathEscape(options.session) + "/host"
	if suffix == "" {
		return base
	}
	return base + "/" + suffix
}

func (cli hostCLI) requestJSON(ctx context.Context, method string, rawURL string, body any, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, rawURL, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := cli.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return apiResponseError(response.StatusCode, data)
	}
	if len(bytes.TrimSpace(data)) == 0 || output == nil {
		return nil
	}
	if err := json.Unmarshal(data, output); err != nil {
		return fmt.Errorf("decode Gorchestra response: %w", err)
	}
	return nil
}

func apiResponseError(status int, body []byte) error {
	var payload struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &payload) == nil && payload.Error != "" {
		return fmt.Errorf("Gorchestra API returned %d: %s", status, payload.Error)
	}
	message := strings.TrimSpace(string(body))
	if message == "" {
		message = http.StatusText(status)
	}
	return fmt.Errorf("Gorchestra API returned %d: %s", status, message)
}

func writePrettyJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetIndent("", "  ")
	return encoder.Encode(value)
}

func writeHostLogChunk(writer io.Writer, chunk hostLogChunk) error {
	prefix := "[" + chunk.Service + "/" + chunk.Stream + "] "
	data := chunk.Data
	if data == "" {
		return nil
	}
	for _, line := range strings.SplitAfter(data, "\n") {
		if line == "" {
			continue
		}
		if _, err := io.WriteString(writer, prefix+line); err != nil {
			return err
		}
		if !strings.HasSuffix(line, "\n") {
			if _, err := io.WriteString(writer, "\n"); err != nil {
				return err
			}
		}
	}
	return nil
}

func (cli hostCLI) usage() {
	fmt.Fprintln(cli.stdout, `Usage: gorchestra host <command> [options]

Commands:
  validate   Validate .gorchestra/host.yaml
  status     Show recipe and runtime status
  start      Start this session's preview stack
  stop       Stop this session's preview stack
  restart    Reload the recipe and restart the stack
  check      Probe the configured preview routes
  logs       Print retained logs; use --follow to stream
  url        Print the stable preview URL

Common options:
  --server URL       Gorchestra API URL (default GORCHESTRA_API_URL)
  --session ID       Session ID (default GORCHESTRA_SESSION_ID)
  --timeout DURATION Command timeout
  --wait=false       Do not wait for start/stop/restart completion`)
}
