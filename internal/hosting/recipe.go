package hosting

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

var (
	ErrInvalidRecipe  = errors.New("invalid host recipe")
	environmentNameRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	componentNameRE   = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
)

type rawRecipe struct {
	Version    int          `yaml:"version"`
	Name       string       `yaml:"name"`
	InheritEnv []string     `yaml:"inherit_env"`
	Services   []rawService `yaml:"services"`
	Routes     []rawRoute   `yaml:"routes"`
}

type rawService struct {
	Name      string            `yaml:"name"`
	Command   []string          `yaml:"command"`
	CWD       string            `yaml:"cwd"`
	Port      rawPort           `yaml:"port"`
	Env       map[string]string `yaml:"env"`
	Readiness *rawReadiness     `yaml:"readiness"`
	Proxy     *rawProxy         `yaml:"proxy"`
}

type rawPort struct {
	set    bool
	mode   PortMode
	number int
}

func (p *rawPort) UnmarshalYAML(node *yaml.Node) error {
	p.set = true
	if node.Kind == yaml.ScalarNode && (node.Tag == "!!null" || node.Value == "") {
		p.mode = PortNone
		return nil
	}
	if node.Kind != yaml.ScalarNode {
		return fmt.Errorf("port must be auto, none, or an integer")
	}
	if node.Tag == "!!int" {
		number, err := strconv.Atoi(node.Value)
		if err != nil {
			return fmt.Errorf("port must be a valid integer: %w", err)
		}
		p.mode = PortFixed
		p.number = number
		return nil
	}
	switch strings.TrimSpace(node.Value) {
	case "auto":
		p.mode = PortAuto
	case "none":
		p.mode = PortNone
	default:
		return fmt.Errorf("port must be auto, none, or an integer")
	}
	return nil
}

type rawReadiness struct {
	Type    string `yaml:"type"`
	Path    string `yaml:"path"`
	Timeout string `yaml:"timeout"`
}

type rawProxy struct {
	HostHeader    string `yaml:"host_header"`
	RewriteOrigin bool   `yaml:"rewrite_origin"`
}

type rawRoute struct {
	Path        string `yaml:"path"`
	Service     string `yaml:"service"`
	StripPrefix bool   `yaml:"strip_prefix"`
}

// LoadRecipe loads and validates <workspace>/.gorchestra/host.yaml.
func LoadRecipe(workspace string) (LoadedRecipe, error) {
	canonicalWorkspace, err := canonicalWorkspacePath(workspace)
	if err != nil {
		return LoadedRecipe{}, err
	}
	configPath := RecipePath(canonicalWorkspace)
	realConfigPath, err := filepath.EvalSymlinks(configPath)
	if err != nil {
		return LoadedRecipe{}, fmt.Errorf("load host recipe %s: %w", configPath, err)
	}
	if !pathWithin(canonicalWorkspace, realConfigPath) {
		return LoadedRecipe{}, invalidf("recipe path %q resolves outside workspace", configPath)
	}

	// Open the already-resolved path so a symlink swap cannot redirect the read
	// outside the workspace between validation and open.
	file, err := os.Open(realConfigPath)
	if err != nil {
		return LoadedRecipe{}, fmt.Errorf("load host recipe %s: %w", configPath, err)
	}
	defer file.Close()
	snapshot, err := io.ReadAll(io.LimitReader(file, MaxRecipeSize+1))
	if err != nil {
		return LoadedRecipe{}, fmt.Errorf("read host recipe %s: %w", configPath, err)
	}
	if len(snapshot) > MaxRecipeSize {
		return LoadedRecipe{}, invalidf("recipe exceeds %d bytes", MaxRecipeSize)
	}

	return parseRecipe(canonicalWorkspace, configPath, snapshot)
}

// ParseRecipe validates a snapshot using the same rules as LoadRecipe. It is
// useful to validate an already-read snapshot without changing the filesystem.
func ParseRecipe(workspace string, configPath string, snapshot []byte) (LoadedRecipe, error) {
	canonicalWorkspace, err := canonicalWorkspacePath(workspace)
	if err != nil {
		return LoadedRecipe{}, err
	}
	if len(snapshot) > MaxRecipeSize {
		return LoadedRecipe{}, invalidf("recipe exceeds %d bytes", MaxRecipeSize)
	}
	if strings.TrimSpace(configPath) == "" {
		configPath = RecipePath(canonicalWorkspace)
	}
	absConfigPath, err := filepath.Abs(configPath)
	if err != nil {
		return LoadedRecipe{}, invalidf("resolve recipe path: %v", err)
	}
	resolvedConfigPath := absConfigPath
	if realConfigPath, evalErr := filepath.EvalSymlinks(absConfigPath); evalErr == nil {
		resolvedConfigPath = realConfigPath
	}
	if !pathWithin(canonicalWorkspace, resolvedConfigPath) {
		return LoadedRecipe{}, invalidf("recipe path %q is outside workspace", configPath)
	}
	return parseRecipe(canonicalWorkspace, filepath.Clean(resolvedConfigPath), snapshot)
}

func parseRecipe(workspace string, configPath string, snapshot []byte) (LoadedRecipe, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(snapshot))
	decoder.KnownFields(true)
	var raw rawRecipe
	if err := decoder.Decode(&raw); err != nil {
		return LoadedRecipe{}, invalidf("decode %s: %v", configPath, err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return LoadedRecipe{}, invalidf("%s contains more than one YAML document", configPath)
		}
		return LoadedRecipe{}, invalidf("decode trailing YAML in %s: %v", configPath, err)
	}

	recipe, err := normalizeRecipe(workspace, raw)
	if err != nil {
		return LoadedRecipe{}, err
	}
	recipe.NormalizeOrder()
	return LoadedRecipe{
		Recipe:    recipe,
		Workspace: workspace,
		Path:      configPath,
		Snapshot:  append([]byte(nil), snapshot...),
		Digest:    recipe.Digest(),
	}, nil
}

func normalizeRecipe(workspace string, raw rawRecipe) (Recipe, error) {
	if raw.Version != RecipeVersion {
		return Recipe{}, invalidf("version must be %d", RecipeVersion)
	}
	name := strings.TrimSpace(raw.Name)
	if name == "" {
		name = slugify(filepath.Base(workspace))
	}
	if !componentNameRE.MatchString(name) {
		return Recipe{}, invalidf("name %q must be a lowercase DNS label of at most 63 characters", name)
	}
	if len(raw.Services) == 0 {
		return Recipe{}, invalidf("services must contain at least one service")
	}

	inheritEnv, err := normalizeInheritedEnvironment(raw.InheritEnv)
	if err != nil {
		return Recipe{}, err
	}

	services := make([]Service, 0, len(raw.Services))
	serviceNames := make(map[string]struct{}, len(raw.Services))
	for index, rawService := range raw.Services {
		service, err := normalizeService(workspace, rawService)
		if err != nil {
			return Recipe{}, invalidf("services[%d]: %v", index, err)
		}
		if _, duplicate := serviceNames[service.Name]; duplicate {
			return Recipe{}, invalidf("duplicate service name %q", service.Name)
		}
		serviceNames[service.Name] = struct{}{}
		services = append(services, service)
	}

	routes := make([]Route, 0, len(raw.Routes))
	routePaths := make(map[string]struct{}, len(raw.Routes))
	routedServices := make(map[string]struct{}, len(raw.Routes))
	for index, rawRoute := range raw.Routes {
		route, err := normalizeRoute(rawRoute)
		if err != nil {
			return Recipe{}, invalidf("routes[%d]: %v", index, err)
		}
		if _, exists := serviceNames[route.Service]; !exists {
			return Recipe{}, invalidf("routes[%d]: service %q does not exist", index, route.Service)
		}
		if _, duplicate := routePaths[route.Path]; duplicate {
			return Recipe{}, invalidf("duplicate route path %q", route.Path)
		}
		routePaths[route.Path] = struct{}{}
		routedServices[route.Service] = struct{}{}
		routes = append(routes, route)
	}
	for i := range services {
		if _, routed := routedServices[services[i].Name]; routed && !services[i].Port.IsSet() {
			return Recipe{}, invalidf("service %q has a route but no port", services[i].Name)
		}
	}

	return Recipe{
		Version:    RecipeVersion,
		Name:       name,
		InheritEnv: inheritEnv,
		Services:   services,
		Routes:     routes,
	}, nil
}

func normalizeService(workspace string, raw rawService) (Service, error) {
	name := strings.TrimSpace(raw.Name)
	if !componentNameRE.MatchString(name) {
		return Service{}, fmt.Errorf("name %q must be a lowercase DNS label of at most 63 characters", name)
	}
	if len(raw.Command) == 0 || strings.TrimSpace(raw.Command[0]) == "" {
		return Service{}, fmt.Errorf("command must be a non-empty argv array")
	}
	command := append([]string(nil), raw.Command...)
	for index, argument := range command {
		if strings.IndexByte(argument, 0) >= 0 {
			return Service{}, fmt.Errorf("command[%d] contains a NUL byte", index)
		}
		if err := validateInterpolations(argument); err != nil {
			return Service{}, fmt.Errorf("command[%d]: %w", index, err)
		}
	}

	cwd, err := validateServiceCWD(workspace, raw.CWD)
	if err != nil {
		return Service{}, err
	}
	port := Port{Mode: PortNone}
	if raw.Port.set {
		port = Port{Mode: raw.Port.mode, Number: raw.Port.number}
	}
	if port.Mode == PortFixed && (port.Number < 1 || port.Number > 65535) {
		return Service{}, fmt.Errorf("fixed port must be between 1 and 65535")
	}

	env, err := normalizeEnvironment(raw.Env)
	if err != nil {
		return Service{}, err
	}
	readiness, err := normalizeReadiness(raw.Readiness, port.IsSet())
	if err != nil {
		return Service{}, err
	}
	proxy, err := normalizeProxy(raw.Proxy)
	if err != nil {
		return Service{}, err
	}

	return Service{
		Name:      name,
		Command:   command,
		CWD:       cwd,
		Port:      port,
		Env:       env,
		Readiness: readiness,
		Proxy:     proxy,
	}, nil
}

func normalizeInheritedEnvironment(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for index, value := range values {
		name := strings.TrimSpace(value)
		if !environmentNameRE.MatchString(name) {
			return nil, invalidf("inherit_env[%d] %q is not a valid environment variable name", index, value)
		}
		if isRuntimeEnvironmentName(name) {
			return nil, invalidf("inherit_env[%d] may not override reserved variable %s", index, name)
		}
		if _, duplicate := seen[name]; duplicate {
			return nil, invalidf("inherit_env contains duplicate variable %s", name)
		}
		seen[name] = struct{}{}
		result = append(result, name)
	}
	sort.Strings(result)
	return result, nil
}

func normalizeEnvironment(values map[string]string) (map[string]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	result := make(map[string]string, len(values))
	for name, value := range values {
		if !environmentNameRE.MatchString(name) {
			return nil, fmt.Errorf("env key %q is not a valid environment variable name", name)
		}
		if isRuntimeEnvironmentName(name) {
			return nil, fmt.Errorf("env may not override reserved variable %s", name)
		}
		if strings.IndexByte(value, 0) >= 0 {
			return nil, fmt.Errorf("env %s contains a NUL byte", name)
		}
		if err := validateInterpolations(value); err != nil {
			return nil, fmt.Errorf("env %s: %w", name, err)
		}
		result[name] = value
	}
	return result, nil
}

func normalizeReadiness(raw *rawReadiness, hasPort bool) (Readiness, error) {
	result := Readiness{Type: ReadinessNone, Timeout: DefaultReadyTimeout}
	if hasPort {
		result.Type = ReadinessTCP
	}
	if raw == nil {
		return result, nil
	}
	typeName := strings.TrimSpace(raw.Type)
	if typeName == "" {
		typeName = string(result.Type)
	}
	result.Type = ReadinessType(typeName)
	switch result.Type {
	case ReadinessNone:
		if strings.TrimSpace(raw.Path) != "" {
			return Readiness{}, fmt.Errorf("readiness.path requires readiness type http")
		}
	case ReadinessTCP:
		if !hasPort {
			return Readiness{}, fmt.Errorf("readiness type tcp requires a service port")
		}
		if strings.TrimSpace(raw.Path) != "" {
			return Readiness{}, fmt.Errorf("readiness.path requires readiness type http")
		}
	case ReadinessHTTP:
		if !hasPort {
			return Readiness{}, fmt.Errorf("readiness type http requires a service port")
		}
		result.Path = strings.TrimSpace(raw.Path)
		if result.Path == "" {
			result.Path = "/"
		}
		parsed, err := url.ParseRequestURI(result.Path)
		if err != nil || parsed.IsAbs() || !strings.HasPrefix(result.Path, "/") || parsed.Fragment != "" {
			return Readiness{}, fmt.Errorf("readiness.path must be an absolute HTTP request path")
		}
	default:
		return Readiness{}, fmt.Errorf("unsupported readiness type %q", raw.Type)
	}
	if strings.TrimSpace(raw.Timeout) != "" {
		timeout, err := time.ParseDuration(strings.TrimSpace(raw.Timeout))
		if err != nil || timeout <= 0 {
			return Readiness{}, fmt.Errorf("readiness.timeout must be a positive duration")
		}
		result.Timeout = timeout
	}
	return result, nil
}

func normalizeProxy(raw *rawProxy) (Proxy, error) {
	result := Proxy{HostHeader: HostHeaderUpstream}
	if raw == nil {
		return result, nil
	}
	if strings.TrimSpace(raw.HostHeader) != "" {
		result.HostHeader = HostHeader(strings.TrimSpace(raw.HostHeader))
	}
	switch result.HostHeader {
	case HostHeaderUpstream, HostHeaderExternal:
	default:
		return Proxy{}, fmt.Errorf("unsupported proxy.host_header %q", raw.HostHeader)
	}
	result.RewriteOrigin = raw.RewriteOrigin
	return result, nil
}

func normalizeRoute(raw rawRoute) (Route, error) {
	routePath := strings.TrimSpace(raw.Path)
	if routePath == "" || !strings.HasPrefix(routePath, "/") {
		return Route{}, fmt.Errorf("path must begin with /")
	}
	if strings.ContainsAny(routePath, "?#") || strings.Contains(routePath, "\\") {
		return Route{}, fmt.Errorf("path must not contain a query, fragment, or backslash")
	}
	cleaned := path.Clean(routePath)
	if cleaned != "/" {
		cleaned = strings.TrimSuffix(cleaned, "/")
	}
	service := strings.TrimSpace(raw.Service)
	if service == "" {
		return Route{}, fmt.Errorf("service is required")
	}
	return Route{Path: cleaned, Service: service, StripPrefix: raw.StripPrefix}, nil
}

func validateServiceCWD(workspace string, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "."
	}
	if filepath.IsAbs(value) || !filepath.IsLocal(value) {
		return "", fmt.Errorf("cwd %q must be a relative path inside the workspace", value)
	}
	cleaned := filepath.Clean(value)
	joined := filepath.Join(workspace, cleaned)
	realPath, err := filepath.EvalSymlinks(joined)
	if err != nil {
		return "", fmt.Errorf("resolve cwd %q: %w", value, err)
	}
	info, err := os.Stat(realPath)
	if err != nil {
		return "", fmt.Errorf("stat cwd %q: %w", value, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("cwd %q is not a directory", value)
	}
	if !pathWithin(workspace, realPath) {
		return "", fmt.Errorf("cwd %q resolves outside workspace", value)
	}
	canonicalRelative, err := filepath.Rel(workspace, realPath)
	if err != nil {
		return "", fmt.Errorf("normalize cwd %q: %w", value, err)
	}
	return filepath.ToSlash(filepath.Clean(canonicalRelative)), nil
}

func canonicalWorkspacePath(workspace string) (string, error) {
	workspace = strings.TrimSpace(workspace)
	if workspace == "" {
		return "", invalidf("workspace is required")
	}
	absPath, err := filepath.Abs(workspace)
	if err != nil {
		return "", invalidf("resolve workspace: %v", err)
	}
	realPath, err := filepath.EvalSymlinks(absPath)
	if err != nil {
		return "", invalidf("resolve workspace %q: %v", workspace, err)
	}
	info, err := os.Stat(realPath)
	if err != nil {
		return "", invalidf("stat workspace %q: %v", workspace, err)
	}
	if !info.IsDir() {
		return "", invalidf("workspace %q is not a directory", workspace)
	}
	return filepath.Clean(realPath), nil
}

func pathWithin(parent string, child string) bool {
	relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func isRuntimeEnvironmentName(name string) bool {
	for _, reserved := range RuntimeEnvironmentNames {
		if name == reserved {
			return true
		}
	}
	return false
}

func validateInterpolations(value string) error {
	for offset := 0; ; {
		start := strings.Index(value[offset:], "${")
		if start < 0 {
			return nil
		}
		start += offset
		endRelative := strings.IndexByte(value[start+2:], '}')
		if endRelative < 0 {
			return fmt.Errorf("unterminated environment interpolation")
		}
		end := start + 2 + endRelative
		name := value[start+2 : end]
		if !isRuntimeEnvironmentName(name) {
			return fmt.Errorf("unsupported environment interpolation ${%s}", name)
		}
		offset = end + 1
	}
}

// InterpolateRuntimeEnvironment expands the reserved ${NAME} forms validated
// by ParseRecipe. Missing values are errors instead of silently becoming empty.
func InterpolateRuntimeEnvironment(value string, environment map[string]string) (string, error) {
	if err := validateInterpolations(value); err != nil {
		return "", err
	}
	var interpolationErr error
	expanded := os.Expand(value, func(name string) string {
		if !isRuntimeEnvironmentName(name) {
			// os.Expand also sees $NAME. Preserve those forms for explicit shells.
			return "$" + name
		}
		resolved, ok := environment[name]
		if !ok {
			interpolationErr = fmt.Errorf("runtime environment value %s is missing", name)
		}
		return resolved
	})
	if interpolationErr != nil {
		return "", interpolationErr
	}
	return expanded, nil
}

func slugify(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var builder strings.Builder
	lastDash := false
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
			builder.WriteRune(character)
			lastDash = false
			continue
		}
		if builder.Len() > 0 && !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	result := strings.Trim(builder.String(), "-")
	if len(result) > 63 {
		result = strings.TrimRight(result[:63], "-")
	}
	if result == "" {
		return "preview"
	}
	return result
}

func invalidf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidRecipe, fmt.Sprintf(format, args...))
}
