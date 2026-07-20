package hosting

import (
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
)

type serviceLaunch struct {
	service Service
	port    int
	dir     string
	command []string
	env     []string
}

func buildServiceLaunch(loaded LoadedRecipe, service Service, sessionID string, port int, lookup func(string) (string, bool)) (serviceLaunch, error) {
	runtimeEnv := map[string]string{
		"GORCHESTRA_HOST":         "127.0.0.1",
		"GORCHESTRA_PORT":         portString(port),
		"GORCHESTRA_SERVICE_NAME": service.Name,
		"GORCHESTRA_SESSION_ID":   sessionID,
		"GORCHESTRA_WORKSPACE":    loaded.Workspace,
		"HOST":                    "127.0.0.1",
		"PORT":                    portString(port),
	}

	environment := make(map[string]string)
	for _, name := range BaselineEnvironmentNames {
		if value, ok := lookup(name); ok {
			environment[name] = value
		}
	}
	for _, name := range loaded.Recipe.InheritEnv {
		if value, ok := lookup(name); ok {
			environment[name] = value
		}
	}
	for name, value := range service.Env {
		expanded, err := InterpolateRuntimeEnvironment(value, runtimeEnv)
		if err != nil {
			return serviceLaunch{}, fmt.Errorf("interpolate service %s environment %s: %w", service.Name, name, err)
		}
		environment[name] = expanded
	}
	for name, value := range runtimeEnv {
		environment[name] = value
	}

	command := make([]string, len(service.Command))
	for index, argument := range service.Command {
		expanded, err := InterpolateRuntimeEnvironment(argument, runtimeEnv)
		if err != nil {
			return serviceLaunch{}, fmt.Errorf("interpolate service %s command argument %d: %w", service.Name, index, err)
		}
		command[index] = expanded
	}

	dir := filepath.Join(loaded.Workspace, filepath.FromSlash(service.CWD))
	realDir, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return serviceLaunch{}, fmt.Errorf("resolve service %s cwd: %w", service.Name, err)
	}
	if !pathWithin(loaded.Workspace, realDir) {
		return serviceLaunch{}, fmt.Errorf("service %s cwd resolves outside workspace", service.Name)
	}

	keys := make([]string, 0, len(environment))
	for name := range environment {
		keys = append(keys, name)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, name := range keys {
		env = append(env, name+"="+environment[name])
	}

	return serviceLaunch{
		service: service,
		port:    port,
		dir:     realDir,
		command: command,
		env:     env,
	}, nil
}

func portString(port int) string {
	if port == 0 {
		return ""
	}
	return strconv.Itoa(port)
}
