package hosting

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	RecipeDirectory     = ".gorchestra"
	RecipeFilename      = "host.yaml"
	RecipeVersion       = 1
	DefaultReadyTimeout = 30 * time.Second
	MaxRecipeSize       = 1 << 20
)

// RuntimeEnvironmentNames are populated by Gorchestra for every hosted
// service. Recipes may reference them using ${NAME}, but may not override or
// inherit them.
var RuntimeEnvironmentNames = []string{
	"GORCHESTRA_HOST",
	"GORCHESTRA_PORT",
	"GORCHESTRA_SERVICE_NAME",
	"GORCHESTRA_SESSION_ID",
	"GORCHESTRA_WORKSPACE",
	"HOST",
	"PORT",
}

// BaselineEnvironmentNames is the small, non-secret process environment that
// the supervisor should inherit without an explicit recipe opt-in.
var BaselineEnvironmentNames = []string{
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TMP",
	"TEMP",
}

// LoadedRecipe contains both a normalized recipe and the source material used
// to produce it. Snapshot is the recipe file itself; it never contains values
// resolved from the parent process environment.
type LoadedRecipe struct {
	Recipe    Recipe
	Workspace string
	Path      string
	Snapshot  []byte
	Digest    string
}

// Recipe describes the normalized, validated services hosted for a workspace.
// Values omitted from host.yaml are populated with their documented defaults.
type Recipe struct {
	Version    int       `json:"version"`
	Name       string    `json:"name"`
	InheritEnv []string  `json:"inherit_env,omitempty"`
	Services   []Service `json:"services"`
	Routes     []Route   `json:"routes,omitempty"`
}

type Service struct {
	Name      string            `json:"name"`
	Command   []string          `json:"command"`
	CWD       string            `json:"cwd"`
	Port      Port              `json:"port"`
	Env       map[string]string `json:"env,omitempty"`
	Readiness Readiness         `json:"readiness"`
	Proxy     Proxy             `json:"proxy"`
}

type PortMode string

const (
	PortNone  PortMode = "none"
	PortAuto  PortMode = "auto"
	PortFixed PortMode = "fixed"
)

type Port struct {
	Mode   PortMode `json:"mode"`
	Number int      `json:"number,omitempty"`
}

func (p Port) IsSet() bool {
	return p.Mode == PortAuto || p.Mode == PortFixed
}

func (p Port) IsAuto() bool {
	return p.Mode == PortAuto
}

func (p Port) Fixed() (int, bool) {
	return p.Number, p.Mode == PortFixed
}

type ReadinessType string

const (
	ReadinessNone ReadinessType = "none"
	ReadinessTCP  ReadinessType = "tcp"
	ReadinessHTTP ReadinessType = "http"
)

type Readiness struct {
	Type    ReadinessType `json:"type"`
	Path    string        `json:"path,omitempty"`
	Timeout time.Duration `json:"timeout"`
}

type HostHeader string

const (
	HostHeaderUpstream HostHeader = "upstream"
	HostHeaderExternal HostHeader = "external"
)

type Proxy struct {
	HostHeader    HostHeader `json:"host_header"`
	RewriteOrigin bool       `json:"rewrite_origin"`
}

type Route struct {
	Path        string `json:"path"`
	Service     string `json:"service"`
	StripPrefix bool   `json:"strip_prefix"`
}

func RecipePath(workspace string) string {
	return filepath.Join(workspace, RecipeDirectory, RecipeFilename)
}

func (r *Recipe) Service(name string) (*Service, bool) {
	for i := range r.Services {
		if r.Services[i].Name == name {
			return &r.Services[i], true
		}
	}
	return nil, false
}

// MatchRoute selects the longest boundary-matching route. Thus /api matches
// /api and /api/users, but not /apix. The result is independent of YAML order.
func (r *Recipe) MatchRoute(requestPath string) (*Route, bool) {
	best := -1
	for i := range r.Routes {
		routePath := r.Routes[i].Path
		if !routePathMatches(routePath, requestPath) {
			continue
		}
		if best < 0 || len(routePath) > len(r.Routes[best].Path) {
			best = i
		}
	}
	if best < 0 {
		return nil, false
	}
	return &r.Routes[best], true
}

func routePathMatches(routePath string, requestPath string) bool {
	if routePath == "/" {
		return strings.HasPrefix(requestPath, "/")
	}
	return requestPath == routePath || strings.HasPrefix(requestPath, routePath+"/")
}

// NormalizeOrder removes ordering differences that do not affect runtime
// behavior, making the digest stable across equivalent YAML recipes.
func (r *Recipe) NormalizeOrder() {
	sort.Strings(r.InheritEnv)
	sort.Slice(r.Services, func(i, j int) bool {
		return r.Services[i].Name < r.Services[j].Name
	})
	sort.Slice(r.Routes, func(i, j int) bool {
		if len(r.Routes[i].Path) != len(r.Routes[j].Path) {
			return len(r.Routes[i].Path) > len(r.Routes[j].Path)
		}
		if r.Routes[i].Path != r.Routes[j].Path {
			return r.Routes[i].Path < r.Routes[j].Path
		}
		return r.Routes[i].Service < r.Routes[j].Service
	})
}

// Digest returns a deterministic hash of the normalized recipe. It intentionally
// excludes the workspace path, source formatting, and inherited environment.
func (r *Recipe) Digest() string {
	data, err := json.Marshal(r)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
