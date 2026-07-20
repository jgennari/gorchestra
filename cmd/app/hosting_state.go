package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"

	"github.com/jgennari/gorchestra/internal/events"
	"github.com/jgennari/gorchestra/internal/hosting"
	"github.com/jgennari/gorchestra/internal/store"
)

const interruptedHostRuntimeReason = "server restarted while preview was active"

func initializeHostingManager(
	ctx context.Context,
	dbStore *store.Store,
	eventService *events.Service,
	previewURLTemplate string,
) (*hosting.Manager, error) {
	manager, err := hosting.NewManager(hosting.ManagerOptions{
		PreviewURLTemplate: previewURLTemplate,
		Persist: func(ctx context.Context, state hosting.PersistedState) error {
			return saveHostState(ctx, dbStore, state)
		},
		Emit: func(ctx context.Context, event hosting.RuntimeEvent) error {
			return appendHostRuntimeEvent(ctx, eventService, event)
		},
	})
	if errors.Is(err, hosting.ErrUnsupported) {
		log.Printf("hosted previews unavailable: %v", err)
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("create hosted preview manager: %w", err)
	}

	recovered, err := dbStore.RecoverActiveHostRuntimes(ctx, interruptedHostRuntimeReason)
	if err != nil {
		return nil, fmt.Errorf("recover hosted previews: %w", err)
	}
	for _, runtime := range recovered {
		state, stateErr := restoredHostState(runtime, previewURLTemplate)
		if stateErr != nil {
			log.Printf("hosted preview recovery event skipped: session_id=%s error=%v", runtime.SessionID, stateErr)
			continue
		}
		if err := appendHostRuntimeEvent(ctx, eventService, hosting.RuntimeEvent{
			SessionID: runtime.SessionID,
			Type:      "host.runtime.stopped",
			Error:     interruptedHostRuntimeReason,
			Snapshot:  state.Snapshot,
		}); err != nil {
			return nil, fmt.Errorf("append hosted preview recovery event for %s: %w", runtime.SessionID, err)
		}
	}

	runtimes, err := dbStore.ListHostRuntimes(ctx)
	if err != nil {
		return nil, fmt.Errorf("list hosted previews: %w", err)
	}
	for _, runtime := range runtimes {
		state, stateErr := restoredHostState(runtime, previewURLTemplate)
		if stateErr != nil {
			log.Printf("hosted preview route restore skipped: session_id=%s error=%v", runtime.SessionID, stateErr)
			continue
		}
		if err := manager.Restore(state); err != nil {
			return nil, fmt.Errorf("restore hosted preview %s: %w", runtime.SessionID, err)
		}
	}
	return manager, nil
}

func restoredHostState(runtime store.HostRuntime, previewURLTemplate string) (hosting.PersistedState, error) {
	loaded, err := hosting.ParseRecipe(runtime.WorkspacePath, runtime.ConfigPath, runtime.RecipeSnapshot)
	if err != nil {
		return hosting.PersistedState{}, fmt.Errorf("parse persisted recipe for session %s: %w", runtime.SessionID, err)
	}
	previewURL, err := hosting.ExpandPreviewURL(previewURLTemplate, runtime.RouteSlug)
	if err != nil {
		return hosting.PersistedState{}, fmt.Errorf("restore preview URL for session %s: %w", runtime.SessionID, err)
	}

	servicesByName := make(map[string]store.HostServiceSnapshot, len(runtime.Services))
	for _, service := range runtime.Services {
		servicesByName[service.Name] = service
	}
	services := make([]hosting.ServiceInfo, 0, len(loaded.Recipe.Services))
	for _, recipeService := range loaded.Recipe.Services {
		persisted := servicesByName[recipeService.Name]
		services = append(services, hosting.ServiceInfo{
			Name:       recipeService.Name,
			Status:     hosting.ServiceStopped,
			Port:       persisted.Port,
			RoutePaths: hostRoutePaths(loaded.Recipe, recipeService.Name),
			StartedAt:  persisted.StartedAt,
			StoppedAt:  persisted.StoppedAt,
			ExitCode:   persisted.ExitCode,
			Error:      persisted.Error,
		})
	}

	digest := loaded.Digest
	if strings.TrimSpace(runtime.RecipeHash) != "" {
		digest = runtime.RecipeHash
	}
	return hosting.PersistedState{
		Snapshot: hosting.Snapshot{
			SessionID: runtime.SessionID,
			Config: hosting.ConfigStatus{
				Path:         runtime.ConfigPath,
				Present:      true,
				Valid:        true,
				Digest:       digest,
				LoadedDigest: digest,
				Name:         runtime.RecipeName,
				Errors:       []string{},
			},
			Runtime: hosting.RuntimeInfo{
				Status:    hosting.StatusStopped,
				URL:       previewURL,
				StartedAt: runtime.StartedAt,
				StoppedAt: runtime.StoppedAt,
				Error:     runtime.LastError,
			},
			Services: services,
		},
		Slug:           runtime.RouteSlug,
		Workspace:      runtime.WorkspacePath,
		Recipe:         loaded.Recipe,
		RecipeSnapshot: append([]byte(nil), runtime.RecipeSnapshot...),
	}, nil
}

func hostRoutePaths(recipe hosting.Recipe, serviceName string) []string {
	paths := make([]string, 0)
	for _, route := range recipe.Routes {
		if route.Service == serviceName {
			paths = append(paths, route.Path)
		}
	}
	return paths
}

func saveHostState(ctx context.Context, dbStore *store.Store, state hosting.PersistedState) error {
	_, err := dbStore.SaveHostRuntime(ctx, hostStateSaveParams(state))
	return err
}

func hostStateSaveParams(state hosting.PersistedState) store.SaveHostRuntimeParams {
	digest := strings.TrimSpace(state.Snapshot.Config.LoadedDigest)
	if digest == "" {
		digest = strings.TrimSpace(state.Snapshot.Config.Digest)
	}
	if digest == "" {
		digest = state.Recipe.Digest()
	}
	configPath := strings.TrimSpace(state.Snapshot.Config.Path)
	if configPath == "" {
		configPath = hosting.RecipePath(state.Workspace)
	}
	recipeName := strings.TrimSpace(state.Snapshot.Config.Name)
	if recipeName == "" {
		recipeName = state.Recipe.Name
	}

	services := make([]store.HostServiceSnapshot, 0, len(state.Snapshot.Services))
	for _, service := range state.Snapshot.Services {
		services = append(services, store.HostServiceSnapshot{
			Name:      service.Name,
			Port:      service.Port,
			PID:       service.PID,
			Status:    store.HostServiceStatus(service.Status),
			ExitCode:  service.ExitCode,
			Error:     service.Error,
			StartedAt: service.StartedAt,
			StoppedAt: service.StoppedAt,
		})
	}
	return store.SaveHostRuntimeParams{
		SessionID:      state.Snapshot.SessionID,
		RouteSlug:      state.Slug,
		WorkspacePath:  state.Workspace,
		ConfigPath:     configPath,
		RecipeName:     recipeName,
		RecipeHash:     digest,
		RecipeSnapshot: append([]byte(nil), state.RecipeSnapshot...),
		Status:         store.HostRuntimeStatus(state.Snapshot.Runtime.Status),
		Services:       services,
		StartedAt:      state.Snapshot.Runtime.StartedAt,
		StoppedAt:      state.Snapshot.Runtime.StoppedAt,
		LastError:      state.Snapshot.Runtime.Error,
	}
}

func appendHostRuntimeEvent(ctx context.Context, eventService *events.Service, event hosting.RuntimeEvent) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode hosted preview event: %w", err)
	}
	status := store.EventStatusCompleted
	switch event.Snapshot.Runtime.Status {
	case hosting.StatusStarting, hosting.StatusStopping:
		status = store.EventStatusStarted
	case hosting.StatusFailed:
		status = store.EventStatusFailed
	}
	if strings.TrimSpace(event.Error) != "" {
		status = store.EventStatusFailed
	}
	eventType := strings.TrimSpace(event.Type)
	if eventType == "" {
		eventType = "host.runtime.updated"
	}
	_, err = eventService.Append(ctx, events.AppendParams{
		SessionID: event.SessionID,
		Type:      eventType,
		Role:      "system",
		Status:    status,
		Payload:   payload,
	})
	return err
}
