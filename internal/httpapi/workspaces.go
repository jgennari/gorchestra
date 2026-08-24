package httpapi

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jgennari/gorchestra/internal/store"
)

const (
	maxFilePreviewBytes       = 256 * 1024
	maxWorkspaceUploadBytes   = 100 * 1024 * 1024
	maxWorkspaceUploadMemory  = 8 * 1024 * 1024
	maxSearchResults          = 50
	maxSearchWalkItems        = 5000
	maxSearchLineSnippetRunes = 180
)

type workspaceConfig struct {
	defaultPath string
	roots       []workspaceRoot
}

type workspaceRoot struct {
	ID      string
	Name    string
	Path    string
	Default bool
}

type workspaceRootsResponse struct {
	Roots []workspaceRootResponse `json:"roots"`
}

type workspaceRootResponse struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Default bool   `json:"default"`
}

type workspaceBrowseResponse struct {
	RootID     string                       `json:"root_id,omitempty"`
	RootPath   string                       `json:"root_path"`
	Path       string                       `json:"path"`
	Entries    []workspaceEntryResponse     `json:"entries"`
	GitSummary *workspaceGitSummaryResponse `json:"git_summary,omitempty"`
}

type workspaceGitSummaryResponse struct {
	Branch   string `json:"branch,omitempty"`
	Added    int    `json:"added"`
	Modified int    `json:"modified"`
	Deleted  int    `json:"deleted"`
}

type workspaceEntryResponse struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	SizeBytes  int64  `json:"size_bytes"`
	ModifiedAt string `json:"modified_at"`
	GitStatus  string `json:"git_status,omitempty"`
}

type workspaceFileContentResponse struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	SizeBytes   int64  `json:"size_bytes"`
	ModifiedAt  string `json:"modified_at"`
	Content     string `json:"content"`
	Encoding    string `json:"encoding"`
	MediaType   string `json:"media_type"`
	PreviewKind string `json:"preview_kind"`
	Truncated   bool   `json:"truncated"`
	GitStatus   string `json:"git_status,omitempty"`
}

type updateWorkspaceFileContentRequest struct {
	Content *string `json:"content"`
}

type workspaceFileUploadResponse struct {
	Files []workspaceEntryResponse `json:"files"`
}

type workspaceSearchResponse struct {
	Query   string                          `json:"query"`
	Path    string                          `json:"path"`
	Results []workspaceSearchResultResponse `json:"results"`
}

type workspaceSearchResultResponse struct {
	workspaceEntryResponse
	MatchType  string `json:"match_type"`
	LineNumber int    `json:"line_number,omitempty"`
	LineText   string `json:"line_text,omitempty"`
}

func newWorkspaceConfig(defaultPath string, rootPaths []string) workspaceConfig {
	defaultPath = normalizeWorkspaceRoot(defaultPath)
	paths := make([]string, 0, len(rootPaths)+1)
	if defaultPath != "" {
		paths = append(paths, defaultPath)
	}
	paths = append(paths, rootPaths...)

	seen := map[string]bool{}
	roots := make([]workspaceRoot, 0, len(paths))
	for _, rootPath := range paths {
		normalized := normalizeWorkspaceRoot(rootPath)
		if normalized == "" || seen[normalized] {
			continue
		}
		seen[normalized] = true
		roots = append(roots, workspaceRoot{
			ID:      fmt.Sprintf("root_%d", len(roots)+1),
			Name:    workspaceRootName(normalized),
			Path:    normalized,
			Default: normalized == defaultPath,
		})
	}

	return workspaceConfig{
		defaultPath: defaultPath,
		roots:       roots,
	}
}

func normalizeWorkspaceRoot(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	absolute, err := filepath.Abs(value)
	if err != nil {
		return ""
	}
	if evaluated, err := filepath.EvalSymlinks(absolute); err == nil {
		absolute = evaluated
	}
	return filepath.Clean(absolute)
}

func workspaceRootName(rootPath string) string {
	name := filepath.Base(rootPath)
	if name == "." || name == string(filepath.Separator) || name == "" {
		return rootPath
	}
	return name
}

func (api API) workspaceRootsHandler(w http.ResponseWriter, _ *http.Request) {
	roots := make([]workspaceRootResponse, 0, len(api.workspaces.roots))
	for _, root := range api.workspaces.roots {
		roots = append(roots, workspaceRootResponse{
			ID:      root.ID,
			Name:    root.Name,
			Path:    root.Path,
			Default: root.Default,
		})
	}
	writeJSON(w, http.StatusOK, workspaceRootsResponse{Roots: roots})
}

func (api API) workspaceBrowseHandler(w http.ResponseWriter, r *http.Request) {
	root, err := api.workspaces.rootByID(r.URL.Query().Get("root_id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	relativePath, err := cleanRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	directory, err := api.workspaces.childPath(root.Path, relativePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	entries, err := listWorkspaceDirectory(root.Path, directory)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, workspaceBrowseResponse{
		RootID:   root.ID,
		RootPath: root.Path,
		Path:     relativePath,
		Entries:  entries,
	})
}

func (api API) sessionFilesHandler(w http.ResponseWriter, r *http.Request) {
	session, workspacePath, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	relativePath, err := cleanRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	directory, err := api.workspaces.childPath(workspacePath, relativePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	entries, err := listWorkspaceDirectory(workspacePath, directory)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	gitStatuses := gitStatusesForWorkspace(workspacePath)
	applyGitStatusesFromMap(gitStatuses, entries)

	writeJSON(w, http.StatusOK, workspaceBrowseResponse{
		RootPath:   session.WorkspacePath,
		Path:       relativePath,
		Entries:    entries,
		GitSummary: gitSummaryForWorkspace(workspacePath, gitStatuses),
	})
}

func (api API) sessionFileContentHandler(w http.ResponseWriter, r *http.Request) {
	_, workspacePath, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	relativePath, err := cleanRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if relativePath == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	filePath, err := api.workspaces.childPath(workspacePath, relativePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	content, err := readWorkspaceFile(workspacePath, filePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, content)
}

func (api API) sessionFileRawHandler(w http.ResponseWriter, r *http.Request) {
	_, workspacePath, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	relativePath, err := cleanRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if relativePath == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	filePath, err := api.workspaces.childPath(workspacePath, relativePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}

	file, err := os.Open(filePath)
	if err != nil {
		writeWorkspacePathError(w, fmt.Errorf("read file: %w", err))
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeWorkspacePathError(w, fmt.Errorf("inspect file: %w", err))
		return
	}
	if !info.Mode().IsRegular() {
		writeWorkspacePathError(w, errors.New("path must be a regular file"))
		return
	}

	prefix := make([]byte, 512)
	readBytes, readErr := file.Read(prefix)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		writeWorkspacePathError(w, fmt.Errorf("read file: %w", readErr))
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		writeWorkspacePathError(w, fmt.Errorf("read file: %w", err))
		return
	}

	mediaType, previewKind := workspaceFileMedia(info.Name(), prefix[:readBytes])
	raw := r.URL.Query().Get("raw") == "1"
	if raw && previewKind == "none" && shouldServeWorkspaceRawAsText(mediaType, prefix[:readBytes]) {
		mediaType = "text/plain; charset=utf-8"
	}
	disposition := "inline"
	if r.URL.Query().Get("download") == "1" || (!raw && previewKind == "none") {
		disposition = "attachment"
	}
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{
		"filename": sanitizeAttachmentFilename(info.Name()),
	}))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func (api API) uploadSessionFilesHandler(w http.ResponseWriter, r *http.Request) {
	_, workspacePath, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	relativePath, err := cleanRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	directory, err := api.workspaces.childPath(workspacePath, relativePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxWorkspaceUploadBytes)
	if err := r.ParseMultipartForm(maxWorkspaceUploadMemory); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "upload exceeds 100 MB limit")
			return
		}
		writeError(w, http.StatusBadRequest, "invalid multipart upload")
		return
	}
	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		writeError(w, http.StatusBadRequest, "at least one file is required")
		return
	}

	uploaded, err := uploadWorkspaceFiles(workspacePath, directory, files)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, workspaceFileUploadResponse{Files: uploaded})
}

func (api API) updateSessionFileContentHandler(w http.ResponseWriter, r *http.Request) {
	_, workspacePath, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}

	var request updateWorkspaceFileContentRequest
	if !decodeJSONBody(w, r, &request) {
		return
	}
	if request.Content == nil {
		writeError(w, http.StatusBadRequest, "content is required")
		return
	}
	if !utf8.ValidString(*request.Content) {
		writeError(w, http.StatusBadRequest, "content must be valid UTF-8")
		return
	}
	if len([]byte(*request.Content)) > maxFilePreviewBytes {
		writeError(w, http.StatusBadRequest, "content exceeds editable size limit")
		return
	}

	relativePath, err := cleanRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if relativePath == "" {
		writeError(w, http.StatusBadRequest, "path is required")
		return
	}
	filePath, err := api.workspaces.childPath(workspacePath, relativePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	content, err := writeWorkspaceFile(workspacePath, filePath, *request.Content)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, content)
}

func (api API) sessionFileSearchHandler(w http.ResponseWriter, r *http.Request) {
	_, workspacePath, ok := api.sessionWorkspace(w, r)
	if !ok {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	relativePath, err := cleanRelativePath(r.URL.Query().Get("path"))
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	startPath, err := api.workspaces.childPath(workspacePath, relativePath)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	results, err := searchWorkspace(workspacePath, startPath, query)
	if err != nil {
		writeWorkspacePathError(w, err)
		return
	}
	applyGitStatusesToSearchResults(workspacePath, results)

	writeJSON(w, http.StatusOK, workspaceSearchResponse{
		Query:   query,
		Path:    relativePath,
		Results: results,
	})
}

func (api API) sessionWorkspace(w http.ResponseWriter, r *http.Request) (store.Session, string, bool) {
	sessionID := chi.URLParam(r, "sessionId")
	session, err := api.store.GetSession(r.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session not found")
			return store.Session{}, "", false
		}
		writeError(w, http.StatusInternalServerError, "failed to load session")
		return store.Session{}, "", false
	}

	workspacePath, err := api.workspaces.resolveWorkspacePath(sessionWorkspacePath(session, api.workdir))
	if err != nil {
		writeWorkspacePathError(w, err)
		return store.Session{}, "", false
	}
	if workspacePath == "" {
		writeError(w, http.StatusConflict, "workspace is not configured")
		return store.Session{}, "", false
	}
	session.WorkspacePath = workspacePath
	return session, workspacePath, true
}

func sessionWorkspacePath(session store.Session, fallback string) string {
	if strings.TrimSpace(session.WorkspacePath) != "" {
		return session.WorkspacePath
	}
	return strings.TrimSpace(fallback)
}

func (c workspaceConfig) rootByID(rootID string) (workspaceRoot, error) {
	rootID = strings.TrimSpace(rootID)
	if rootID == "" {
		for _, root := range c.roots {
			if root.Default {
				return root, nil
			}
		}
		if len(c.roots) > 0 {
			return c.roots[0], nil
		}
		return workspaceRoot{}, errors.New("workspace roots are not configured")
	}
	for _, root := range c.roots {
		if root.ID == rootID {
			return root, nil
		}
	}
	return workspaceRoot{}, errors.New("workspace root not found")
}

func (c workspaceConfig) resolveWorkspacePath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = c.defaultPath
	}
	if value == "" {
		return "", nil
	}
	workspacePath, err := existingDirectory(value)
	if err != nil {
		return "", err
	}
	if len(c.roots) == 0 {
		return "", errors.New("workspace roots are not configured")
	}
	for _, root := range c.roots {
		if isPathWithin(root.Path, workspacePath) {
			return workspacePath, nil
		}
	}
	return "", fmt.Errorf("workspace is outside allowed roots")
}

func existingDirectory(value string) (string, error) {
	absolute, err := filepath.Abs(strings.TrimSpace(value))
	if err != nil {
		return "", fmt.Errorf("resolve path: %w", err)
	}
	evaluated, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", fmt.Errorf("workspace is unavailable: %w", err)
	}
	info, err := os.Stat(evaluated)
	if err != nil {
		return "", fmt.Errorf("workspace is unavailable: %w", err)
	}
	if !info.IsDir() {
		return "", errors.New("workspace must be a directory")
	}
	return filepath.Clean(evaluated), nil
}

func (c workspaceConfig) childPath(rootPath string, relativePath string) (string, error) {
	rootPath, err := existingDirectory(rootPath)
	if err != nil {
		return "", err
	}
	relativePath, err = cleanRelativePath(relativePath)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(rootPath, filepath.FromSlash(relativePath))
	evaluated, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", fmt.Errorf("path is unavailable: %w", err)
	}
	if !isPathWithin(rootPath, evaluated) {
		return "", errors.New("path is outside workspace")
	}
	return evaluated, nil
}

func cleanRelativePath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || value == "." {
		return "", nil
	}
	value = strings.ReplaceAll(value, "\\", "/")
	if strings.HasPrefix(value, "/") || filepath.IsAbs(value) {
		return "", errors.New("path must be relative")
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." {
			return "", errors.New("path cannot contain ..")
		}
	}
	clean := strings.TrimPrefix(pathpkg.Clean("/"+value), "/")
	if clean == "." {
		return "", nil
	}
	return clean, nil
}

func isPathWithin(rootPath string, candidate string) bool {
	rootPath = filepath.Clean(rootPath)
	candidate = filepath.Clean(candidate)
	relative, err := filepath.Rel(rootPath, candidate)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func listWorkspaceDirectory(rootPath string, directory string) ([]workspaceEntryResponse, error) {
	info, err := os.Stat(directory)
	if err != nil {
		return nil, fmt.Errorf("path is unavailable: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("path must be a directory")
	}

	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, fmt.Errorf("read directory: %w", err)
	}
	responses := make([]workspaceEntryResponse, 0, len(entries))
	for _, entry := range entries {
		fullPath := filepath.Join(directory, entry.Name())
		entryInfo, err := os.Stat(fullPath)
		if err != nil {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			evaluated, err := filepath.EvalSymlinks(fullPath)
			if err != nil || !isPathWithin(rootPath, evaluated) {
				continue
			}
		}
		responses = append(responses, workspaceEntry(rootPath, fullPath, entryInfo))
	}

	sort.Slice(responses, func(i, j int) bool {
		if responses[i].Type != responses[j].Type {
			return responses[i].Type == "directory"
		}
		return strings.ToLower(responses[i].Name) < strings.ToLower(responses[j].Name)
	})
	return responses, nil
}

func workspaceEntry(rootPath string, fullPath string, info fs.FileInfo) workspaceEntryResponse {
	relative, err := filepath.Rel(rootPath, fullPath)
	if err != nil || relative == "." {
		relative = ""
	}
	entryType := "file"
	if info.IsDir() {
		entryType = "directory"
	}
	return workspaceEntryResponse{
		Name:       info.Name(),
		Path:       filepath.ToSlash(relative),
		Type:       entryType,
		SizeBytes:  info.Size(),
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
	}
}

func readWorkspaceFile(rootPath string, filePath string) (workspaceFileContentResponse, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return workspaceFileContentResponse{}, fmt.Errorf("path is unavailable: %w", err)
	}
	if info.IsDir() {
		return workspaceFileContentResponse{}, errors.New("path must be a file")
	}

	file, err := os.Open(filePath)
	if err != nil {
		return workspaceFileContentResponse{}, fmt.Errorf("read file: %w", err)
	}
	defer file.Close()

	data, err := io.ReadAll(io.LimitReader(file, maxFilePreviewBytes+1))
	if err != nil {
		return workspaceFileContentResponse{}, fmt.Errorf("read file: %w", err)
	}
	truncated := len(data) > maxFilePreviewBytes
	if truncated {
		data = data[:maxFilePreviewBytes]
	}

	relative, err := filepath.Rel(rootPath, filePath)
	if err != nil {
		relative = info.Name()
	}
	response := workspaceFileContentResponse{
		Name:       info.Name(),
		Path:       filepath.ToSlash(relative),
		SizeBytes:  info.Size(),
		ModifiedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
		Truncated:  truncated,
		GitStatus:  gitStatusForPath(gitStatusesForWorkspace(rootPath), filepath.ToSlash(relative), false),
	}
	response.MediaType, response.PreviewKind = workspaceFileMedia(info.Name(), data)
	if isBinaryPreview(data) {
		response.Encoding = "binary"
		return response, nil
	}
	response.Encoding = "utf-8"
	response.Content = string(data)
	return response, nil
}

func writeWorkspaceFile(rootPath string, filePath string, content string) (workspaceFileContentResponse, error) {
	info, err := os.Stat(filePath)
	if err != nil {
		return workspaceFileContentResponse{}, fmt.Errorf("path is unavailable: %w", err)
	}
	if info.IsDir() {
		return workspaceFileContentResponse{}, errors.New("path must be a file")
	}
	if info.Size() > maxFilePreviewBytes {
		return workspaceFileContentResponse{}, errors.New("file exceeds editable size limit")
	}

	current, err := readWorkspaceFile(rootPath, filePath)
	if err != nil {
		return workspaceFileContentResponse{}, err
	}
	if current.Truncated {
		return workspaceFileContentResponse{}, errors.New("file exceeds editable size limit")
	}
	if current.Encoding != "utf-8" {
		return workspaceFileContentResponse{}, errors.New("file must be UTF-8 text")
	}

	if err := os.WriteFile(filePath, []byte(content), info.Mode().Perm()); err != nil {
		return workspaceFileContentResponse{}, fmt.Errorf("write file: %w", err)
	}
	return readWorkspaceFile(rootPath, filePath)
}

type stagedWorkspaceUpload struct {
	temporaryPath string
	targetPath    string
}

func uploadWorkspaceFiles(rootPath string, directory string, headers []*multipart.FileHeader) ([]workspaceEntryResponse, error) {
	seen := make(map[string]bool, len(headers))
	staged := make([]stagedWorkspaceUpload, 0, len(headers))
	cleanup := func() {
		for _, upload := range staged {
			_ = os.Remove(upload.temporaryPath)
		}
	}
	defer cleanup()

	for _, header := range headers {
		name := strings.TrimSpace(header.Filename)
		if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
			return nil, errors.New("upload filename must not contain a path")
		}
		if seen[name] {
			return nil, fmt.Errorf("duplicate upload filename %q", name)
		}
		seen[name] = true

		targetPath := filepath.Join(directory, name)
		if !isPathWithin(rootPath, targetPath) {
			return nil, errors.New("upload path is outside workspace")
		}
		mode := fs.FileMode(0o644)
		if info, err := os.Lstat(targetPath); err == nil {
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("upload target %q must be a regular file", name)
			}
			mode = info.Mode().Perm()
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("inspect upload target %q: %w", name, err)
		}

		source, err := header.Open()
		if err != nil {
			return nil, fmt.Errorf("open upload %q: %w", name, err)
		}
		temporary, err := os.CreateTemp(directory, ".gorchestra-upload-*")
		if err != nil {
			source.Close()
			return nil, fmt.Errorf("stage upload %q: %w", name, err)
		}
		temporaryPath := temporary.Name()
		staged = append(staged, stagedWorkspaceUpload{temporaryPath: temporaryPath, targetPath: targetPath})
		_, copyErr := io.Copy(temporary, source)
		closeErr := temporary.Close()
		source.Close()
		if copyErr != nil {
			return nil, fmt.Errorf("write upload %q: %w", name, copyErr)
		}
		if closeErr != nil {
			return nil, fmt.Errorf("close upload %q: %w", name, closeErr)
		}
		if err := os.Chmod(temporaryPath, mode); err != nil {
			return nil, fmt.Errorf("set upload permissions %q: %w", name, err)
		}
	}

	responses := make([]workspaceEntryResponse, 0, len(staged))
	for _, upload := range staged {
		if err := os.Rename(upload.temporaryPath, upload.targetPath); err != nil {
			return nil, fmt.Errorf("save upload %q: %w", filepath.Base(upload.targetPath), err)
		}
		info, err := os.Stat(upload.targetPath)
		if err != nil {
			return nil, fmt.Errorf("inspect uploaded file %q: %w", filepath.Base(upload.targetPath), err)
		}
		responses = append(responses, workspaceEntry(rootPath, upload.targetPath, info))
	}
	return responses, nil
}

func isBinaryPreview(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	if !utf8.Valid(data) {
		return true
	}
	for _, value := range data {
		if value == 0 {
			return true
		}
	}
	return false
}

func workspaceFileMedia(name string, data []byte) (string, string) {
	extension := strings.ToLower(filepath.Ext(name))
	if extension == ".ts" {
		if !isBinaryPreview(data) {
			return "text/typescript", "none"
		}
		return "video/mp2t", "video"
	}
	mediaType := map[string]string{
		".aac":   "audio/aac",
		".avif":  "image/avif",
		".bmp":   "image/bmp",
		".flac":  "audio/flac",
		".gif":   "image/gif",
		".heic":  "image/heic",
		".heics": "image/heic-sequence",
		".heif":  "image/heif",
		".heifs": "image/heif-sequence",
		".ico":   "image/x-icon",
		".jpeg":  "image/jpeg",
		".jpg":   "image/jpeg",
		".m4a":   "audio/mp4",
		".m4v":   "video/mp4",
		".mov":   "video/quicktime",
		".mp3":   "audio/mpeg",
		".mp4":   "video/mp4",
		".mpeg":  "video/mpeg",
		".mpg":   "video/mpeg",
		".oga":   "audio/ogg",
		".ogg":   "audio/ogg",
		".ogv":   "video/ogg",
		".opus":  "audio/ogg",
		".pdf":   "application/pdf",
		".png":   "image/png",
		".tif":   "image/tiff",
		".tiff":  "image/tiff",
		".cts":   "text/typescript",
		".mts":   "text/typescript",
		".tsx":   "text/typescript",
		".wav":   "audio/wav",
		".weba":  "audio/webm",
		".webm":  "video/webm",
		".webp":  "image/webp",
	}[extension]
	if mediaType == "" {
		mediaType = mime.TypeByExtension(extension)
	}
	if mediaType == "" {
		mediaType = http.DetectContentType(data)
	}
	if parsed, _, err := mime.ParseMediaType(mediaType); err == nil {
		mediaType = strings.ToLower(parsed)
	}
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}

	previewKind := "none"
	switch {
	case mediaType == "application/pdf":
		previewKind = "pdf"
	case strings.HasPrefix(mediaType, "image/") && mediaType != "image/svg+xml":
		previewKind = "image"
	case strings.HasPrefix(mediaType, "audio/"):
		previewKind = "audio"
	case strings.HasPrefix(mediaType, "video/"):
		previewKind = "video"
	}
	return mediaType, previewKind
}

func shouldServeWorkspaceRawAsText(mediaType string, data []byte) bool {
	if strings.HasPrefix(mediaType, "text/") || strings.HasSuffix(mediaType, "+json") || strings.HasSuffix(mediaType, "+xml") {
		return true
	}
	switch mediaType {
	case "application/javascript", "application/json", "application/x-javascript", "application/xhtml+xml", "application/xml", "image/svg+xml":
		return true
	default:
		return !isBinaryPreview(data)
	}
}

func searchWorkspace(rootPath string, startPath string, query string) ([]workspaceSearchResultResponse, error) {
	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return nil, nil
	}
	startInfo, err := os.Stat(startPath)
	if err != nil {
		return nil, fmt.Errorf("path is unavailable: %w", err)
	}
	if !startInfo.IsDir() {
		return nil, errors.New("path must be a directory")
	}

	results := make([]workspaceSearchResultResponse, 0)
	walked := 0
	err = filepath.WalkDir(startPath, func(fullPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if fullPath != startPath && entry.IsDir() && shouldSkipSearchDirectory(entry.Name()) {
			return filepath.SkipDir
		}
		walked++
		if walked > maxSearchWalkItems || len(results) >= maxSearchResults {
			return fs.SkipAll
		}
		if fullPath == startPath {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}

		nameMatches := strings.Contains(strings.ToLower(entry.Name()), query)
		lineNumber, lineText, contentMatches := searchFileContent(fullPath, info, query)
		if nameMatches || contentMatches {
			result := workspaceSearchResultResponse{
				workspaceEntryResponse: workspaceEntry(rootPath, fullPath, info),
				MatchType:              "name",
				LineNumber:             lineNumber,
				LineText:               lineText,
			}
			if !nameMatches && contentMatches {
				result.MatchType = "content"
			}
			results = append(results, result)
		}
		return nil
	})
	if err != nil && !errors.Is(err, fs.SkipAll) {
		return nil, fmt.Errorf("search workspace: %w", err)
	}
	sort.Slice(results, func(i, j int) bool {
		return strings.ToLower(results[i].Path) < strings.ToLower(results[j].Path)
	})
	return results, nil
}

func searchFileContent(fullPath string, info fs.FileInfo, query string) (int, string, bool) {
	if info.IsDir() || info.Size() > maxFilePreviewBytes {
		return 0, "", false
	}
	data, err := os.ReadFile(fullPath)
	if err != nil || isBinaryPreview(data) {
		return 0, "", false
	}
	for index, line := range strings.Split(string(data), "\n") {
		if strings.Contains(strings.ToLower(line), query) {
			return index + 1, searchLineSnippet(line), true
		}
	}
	return 0, "", false
}

func searchLineSnippet(line string) string {
	line = strings.TrimSpace(strings.ReplaceAll(line, "\t", " "))
	if utf8.RuneCountInString(line) <= maxSearchLineSnippetRunes {
		return line
	}
	runes := []rune(line)
	return string(runes[:maxSearchLineSnippetRunes]) + "..."
}

func shouldSkipSearchDirectory(name string) bool {
	switch name {
	case ".git", "node_modules", "vendor", "dist", "build", ".next", ".cache":
		return true
	default:
		return false
	}
}

func applyGitStatuses(rootPath string, entries []workspaceEntryResponse) {
	statuses := gitStatusesForWorkspace(rootPath)
	applyGitStatusesFromMap(statuses, entries)
}

func applyGitStatusesFromMap(statuses map[string]string, entries []workspaceEntryResponse) {
	if len(statuses) == 0 {
		return
	}
	for index := range entries {
		entries[index].GitStatus = gitStatusForPath(statuses, entries[index].Path, entries[index].Type == "directory")
	}
}

func gitSummaryForWorkspace(rootPath string, statuses map[string]string) *workspaceGitSummaryResponse {
	summary := workspaceGitSummaryResponse{
		Branch: gitBranchForWorkspace(rootPath),
	}
	if len(statuses) == 0 && summary.Branch == "" {
		return nil
	}
	for _, status := range statuses {
		switch status {
		case "added", "untracked":
			summary.Added++
		case "deleted":
			summary.Deleted++
		case "modified", "renamed", "copied", "conflicted":
			summary.Modified++
		default:
			if status != "" {
				summary.Modified++
			}
		}
	}
	return &summary
}

func gitBranchForWorkspace(rootPath string) string {
	cmd := exec.Command("git", "-C", rootPath, "branch", "--show-current")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func applyGitStatusesToSearchResults(rootPath string, entries []workspaceSearchResultResponse) {
	statuses := gitStatusesForWorkspace(rootPath)
	if len(statuses) == 0 {
		return
	}
	for index := range entries {
		entries[index].GitStatus = gitStatusForPath(statuses, entries[index].Path, entries[index].Type == "directory")
	}
}

func gitStatusesForWorkspace(rootPath string) map[string]string {
	cmd := exec.Command("git", "-C", rootPath, "status", "--porcelain=v1", "-z")
	output, err := cmd.Output()
	if err != nil || len(output) == 0 {
		return nil
	}

	statuses := map[string]string{}
	parts := strings.Split(string(output), "\x00")
	for index := 0; index < len(parts); index++ {
		part := parts[index]
		if len(part) < 4 {
			continue
		}
		code := strings.TrimSpace(part[:2])
		pathValue := strings.TrimSpace(part[3:])
		if pathValue == "" {
			continue
		}
		statuses[filepath.ToSlash(pathValue)] = gitStatusLabel(code)
		if strings.ContainsAny(code, "RC") && index+1 < len(parts) {
			index++
		}
	}
	return statuses
}

func gitStatusForPath(statuses map[string]string, relativePath string, directory bool) string {
	relativePath = strings.Trim(relativePath, "/")
	if relativePath == "" || len(statuses) == 0 {
		return ""
	}
	if status := statuses[relativePath]; status != "" {
		return status
	}
	if !directory {
		return ""
	}
	prefix := relativePath + "/"
	for pathValue, status := range statuses {
		if strings.HasPrefix(pathValue, prefix) {
			return status
		}
	}
	return ""
}

func gitStatusLabel(code string) string {
	if strings.Contains(code, "U") {
		return "conflicted"
	}
	if strings.Contains(code, "?") {
		return "untracked"
	}
	if strings.Contains(code, "!") {
		return "ignored"
	}
	if strings.Contains(code, "A") {
		return "added"
	}
	if strings.Contains(code, "D") {
		return "deleted"
	}
	if strings.Contains(code, "R") {
		return "renamed"
	}
	if strings.Contains(code, "C") {
		return "copied"
	}
	if strings.Contains(code, "M") {
		return "modified"
	}
	return strings.TrimSpace(code)
}

func writeWorkspacePathError(w http.ResponseWriter, err error) {
	message := err.Error()
	switch {
	case strings.Contains(message, "outside"):
		writeError(w, http.StatusForbidden, message)
	case strings.Contains(message, "not found"), errors.Is(err, os.ErrNotExist):
		writeError(w, http.StatusNotFound, message)
	default:
		writeError(w, http.StatusBadRequest, message)
	}
}
