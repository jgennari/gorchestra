package reposkills

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

const MaxEditableBytes = 256 * 1024

var (
	ErrNotFound = errors.New("repository skill not found")
	ErrConflict = errors.New("repository skill changed")
	ErrReadOnly = errors.New("repository skill is read-only")
	namePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

type Bridge struct {
	Status  string `json:"status"`
	Path    string `json:"path"`
	Message string `json:"message,omitempty"`
}

type Skill struct {
	DirectoryName    string   `json:"directory_name"`
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Path             string   `json:"path"`
	ModifiedAt       string   `json:"modified_at,omitempty"`
	Revision         string   `json:"revision,omitempty"`
	ValidationErrors []string `json:"validation_errors"`
	ResourceCount    int      `json:"resource_count"`
	Editable         bool     `json:"editable"`
	Linked           bool     `json:"linked"`
	Instructions     string   `json:"instructions,omitempty"`
	ClaudeBridge     Bridge   `json:"claude_bridge"`
}

type Input struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
	Revision     string `json:"revision,omitempty"`
}

type Catalog struct {
	Skills []Skill `json:"skills"`
}

type RepairResult struct {
	Skills   []Skill `json:"skills"`
	Repaired int     `json:"repaired"`
}

type BridgeRepairResult struct {
	Skill      Skill  `json:"skill"`
	BackupPath string `json:"backup_path,omitempty"`
}

type Manager struct{}

func NewManager() *Manager { return &Manager{} }

func (m *Manager) List(workspace string) (Catalog, error) {
	root := skillsRoot(workspace)
	if err := validateManagedPath(workspace, root); err != nil {
		return Catalog{}, err
	}
	entries, err := os.ReadDir(root)
	if errors.Is(err, fs.ErrNotExist) {
		return Catalog{Skills: []Skill{}}, nil
	}
	if err != nil {
		return Catalog{}, fmt.Errorf("read repository skills: %w", err)
	}
	items := make([]Skill, 0, len(entries))
	for _, entry := range entries {
		item, ok := m.inspect(workspace, entry.Name(), false)
		if ok {
			items = append(items, item)
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].DirectoryName < items[j].DirectoryName })
	return Catalog{Skills: items}, nil
}

func (m *Manager) Get(workspace, directoryName string) (Skill, error) {
	if err := validateEntryName(directoryName); err != nil {
		return Skill{}, err
	}
	if err := validateManagedPath(workspace, skillsRoot(workspace)); err != nil {
		return Skill{}, err
	}
	item, ok := m.inspect(workspace, directoryName, true)
	if !ok {
		return Skill{}, ErrNotFound
	}
	return item, nil
}

func (m *Manager) Create(workspace string, input Input) (Skill, error) {
	input = normalizeInput(input)
	if err := validateInput(input); err != nil {
		return Skill{}, err
	}
	root := skillsRoot(workspace)
	if err := validateManagedPath(workspace, root); err != nil {
		return Skill{}, err
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return Skill{}, fmt.Errorf("create skills directory: %w", err)
	}
	directory := filepath.Join(root, input.Name)
	if _, err := os.Lstat(directory); err == nil {
		return Skill{}, fmt.Errorf("%w: skill %q already exists", ErrConflict, input.Name)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Skill{}, fmt.Errorf("check skill: %w", err)
	}
	if err := os.Mkdir(directory, 0o755); err != nil {
		return Skill{}, fmt.Errorf("create skill: %w", err)
	}
	content, err := newDocument(input)
	if err != nil {
		_ = os.Remove(directory)
		return Skill{}, err
	}
	if err := atomicWrite(filepath.Join(directory, "SKILL.md"), content, 0o644); err != nil {
		_ = os.RemoveAll(directory)
		return Skill{}, err
	}
	_, _ = m.ensureBridge(workspace, input.Name)
	return m.Get(workspace, input.Name)
}

func (m *Manager) Update(workspace, directoryName string, input Input) (Skill, error) {
	if err := validateEntryName(directoryName); err != nil {
		return Skill{}, err
	}
	input = normalizeInput(input)
	if err := validateInput(input); err != nil {
		return Skill{}, err
	}
	current, err := m.Get(workspace, directoryName)
	if err != nil {
		return Skill{}, err
	}
	if !current.Editable {
		return Skill{}, ErrReadOnly
	}
	if input.Revision == "" || input.Revision != current.Revision {
		return Skill{}, ErrConflict
	}
	oldDirectory := filepath.Join(skillsRoot(workspace), directoryName)
	oldFile := filepath.Join(oldDirectory, "SKILL.md")
	content, mode, err := readEditableDocument(oldFile)
	if err != nil {
		return Skill{}, err
	}
	updated, err := updateDocument(content, input)
	if err != nil {
		return Skill{}, err
	}
	if input.Name == directoryName {
		if err := atomicWrite(oldFile, updated, mode); err != nil {
			return Skill{}, err
		}
		return m.Get(workspace, directoryName)
	}
	newDirectory := filepath.Join(skillsRoot(workspace), input.Name)
	if _, err := os.Lstat(newDirectory); err == nil {
		return Skill{}, fmt.Errorf("%w: skill %q already exists", ErrConflict, input.Name)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return Skill{}, fmt.Errorf("check renamed skill: %w", err)
	}
	if err := os.Rename(oldDirectory, newDirectory); err != nil {
		return Skill{}, fmt.Errorf("rename skill: %w", err)
	}
	if err := atomicWrite(filepath.Join(newDirectory, "SKILL.md"), updated, mode); err != nil {
		_ = os.Rename(newDirectory, oldDirectory)
		return Skill{}, err
	}
	m.removeOwnedBridge(workspace, directoryName)
	_, _ = m.ensureBridge(workspace, input.Name)
	return m.Get(workspace, input.Name)
}

func (m *Manager) Delete(workspace, directoryName string) error {
	if err := validateEntryName(directoryName); err != nil {
		return err
	}
	if err := validateManagedPath(workspace, skillsRoot(workspace)); err != nil {
		return err
	}
	path := filepath.Join(skillsRoot(workspace), directoryName)
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("inspect skill: %w", err)
	}
	m.removeOwnedBridge(workspace, directoryName)
	if info.Mode()&os.ModeSymlink != 0 {
		if err := os.Remove(path); err != nil {
			return fmt.Errorf("remove skill link: %w", err)
		}
		return nil
	}
	if !info.IsDir() {
		return ErrNotFound
	}
	if err := os.RemoveAll(path); err != nil {
		return fmt.Errorf("remove skill: %w", err)
	}
	return nil
}

func (m *Manager) RepairBridge(workspace, name string, replaceConflict bool) (BridgeRepairResult, error) {
	if _, err := m.Get(workspace, name); err != nil {
		return BridgeRepairResult{}, err
	}
	backupPath := ""
	if replaceConflict {
		var err error
		backupPath, err = m.replaceBridgeConflict(workspace, name)
		if err != nil {
			return BridgeRepairResult{}, err
		}
	} else if _, err := m.ensureBridge(workspace, name); err != nil {
		return BridgeRepairResult{}, err
	}
	item, err := m.Get(workspace, name)
	return BridgeRepairResult{Skill: item, BackupPath: backupPath}, err
}

func (m *Manager) RepairAll(workspace string) (RepairResult, error) {
	catalog, err := m.List(workspace)
	if err != nil {
		return RepairResult{}, err
	}
	repaired := 0
	for _, item := range catalog.Skills {
		if item.ClaudeBridge.Status != "missing" {
			continue
		}
		if _, err := m.ensureBridge(workspace, item.DirectoryName); err == nil {
			repaired++
		}
	}
	catalog, err = m.List(workspace)
	return RepairResult{Skills: catalog.Skills, Repaired: repaired}, err
}

func (m *Manager) inspect(workspace, directoryName string, detail bool) (Skill, bool) {
	entryPath := filepath.Join(skillsRoot(workspace), directoryName)
	info, err := os.Lstat(entryPath)
	if err != nil {
		return Skill{}, false
	}
	item := Skill{DirectoryName: directoryName, Name: directoryName, Path: filepath.ToSlash(filepath.Join(".agents", "skills", directoryName, "SKILL.md")), ValidationErrors: []string{}, ClaudeBridge: m.bridgeStatus(workspace, directoryName)}
	resolved := entryPath
	if info.Mode()&os.ModeSymlink != 0 {
		item.Linked = true
		resolved, err = filepath.EvalSymlinks(entryPath)
		if err != nil {
			item.ValidationErrors = append(item.ValidationErrors, "skill directory link is broken")
			return item, true
		}
		if !pathWithin(workspace, resolved) {
			item.ValidationErrors = append(item.ValidationErrors, "skill directory links outside this workspace")
			return item, true
		}
		info, err = os.Stat(resolved)
		if err != nil {
			item.ValidationErrors = append(item.ValidationErrors, "skill directory is unavailable")
			return item, true
		}
	}
	if !info.IsDir() {
		return Skill{}, false
	}
	if err := validateName(directoryName); err != nil {
		item.ValidationErrors = append(item.ValidationErrors, err.Error())
	}
	filePath := filepath.Join(resolved, "SKILL.md")
	if fileLink, linkErr := os.Lstat(filePath); linkErr == nil && fileLink.Mode()&os.ModeSymlink != 0 {
		item.ValidationErrors = append(item.ValidationErrors, "SKILL.md must not be a symlink")
		if !item.Linked {
			item.ResourceCount = countResources(resolved)
		}
		return item, true
	}
	data, fileInfo, err := readDocument(filePath)
	if err != nil {
		item.ValidationErrors = append(item.ValidationErrors, err.Error())
		if !item.Linked {
			item.ResourceCount = countResources(resolved)
		}
		return item, true
	}
	item.ModifiedAt = fileInfo.ModTime().UTC().Format(time.RFC3339Nano)
	item.Revision = revision(data)
	if !item.Linked {
		item.ResourceCount = countResources(resolved)
	}
	if len(data) > MaxEditableBytes {
		item.ValidationErrors = append(item.ValidationErrors, "SKILL.md exceeds the 256 KB editor limit")
		return item, true
	}
	doc, err := parseDocument(data)
	if err != nil {
		item.ValidationErrors = append(item.ValidationErrors, err.Error())
		return item, true
	}
	item.Name = doc.Name
	item.Description = doc.Description
	if doc.Name != directoryName {
		item.ValidationErrors = append(item.ValidationErrors, "frontmatter name must match the skill directory")
	}
	if err := validateName(doc.Name); err != nil {
		item.ValidationErrors = append(item.ValidationErrors, "frontmatter "+err.Error())
	}
	if utf8.RuneCountInString(doc.Description) < 1 || utf8.RuneCountInString(doc.Description) > 1024 {
		item.ValidationErrors = append(item.ValidationErrors, "description must be between 1 and 1024 characters")
	}
	item.Editable = len(item.ValidationErrors) == 0 && !item.Linked
	if detail && item.Editable {
		item.Instructions = doc.Body
	}
	return item, true
}

type document struct {
	Name        string
	Description string
	Body        string
	Metadata    *yaml.Node
}

func parseDocument(data []byte) (document, error) {
	if !utf8.Valid(data) {
		return document{}, errors.New("SKILL.md must be UTF-8")
	}
	lines := bytes.Split(data, []byte("\n"))
	if len(lines) < 3 || string(bytes.TrimSpace(lines[0])) != "---" {
		return document{}, errors.New("SKILL.md must begin with YAML frontmatter")
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if string(bytes.TrimSpace(lines[i])) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		return document{}, errors.New("SKILL.md frontmatter is not closed")
	}
	var metadata yaml.Node
	if err := yaml.Unmarshal(bytes.Join(lines[1:end], []byte("\n")), &metadata); err != nil {
		return document{}, fmt.Errorf("invalid YAML frontmatter: %w", err)
	}
	if len(metadata.Content) == 0 || metadata.Content[0].Kind != yaml.MappingNode {
		return document{}, errors.New("SKILL.md frontmatter must be a mapping")
	}
	name := mappingString(metadata.Content[0], "name")
	description := mappingString(metadata.Content[0], "description")
	body := string(bytes.Join(lines[end+1:], []byte("\n")))
	body = strings.TrimPrefix(body, "\n")
	return document{Name: name, Description: description, Body: body, Metadata: &metadata}, nil
}

func newDocument(input Input) ([]byte, error) {
	mapping := &yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{
		{Kind: yaml.ScalarNode, Value: "name"}, {Kind: yaml.ScalarNode, Value: input.Name},
		{Kind: yaml.ScalarNode, Value: "description"}, {Kind: yaml.ScalarNode, Value: input.Description},
	}}
	metadata := &yaml.Node{Kind: yaml.DocumentNode, Content: []*yaml.Node{mapping}}
	return encodeDocument(metadata, input.Instructions)
}

func updateDocument(current []byte, input Input) ([]byte, error) {
	doc, err := parseDocument(current)
	if err != nil {
		return nil, err
	}
	setMappingString(doc.Metadata.Content[0], "name", input.Name)
	setMappingString(doc.Metadata.Content[0], "description", input.Description)
	return encodeDocument(doc.Metadata, input.Instructions)
}

func encodeDocument(metadata *yaml.Node, body string) ([]byte, error) {
	var frontmatter bytes.Buffer
	encoder := yaml.NewEncoder(&frontmatter)
	encoder.SetIndent(2)
	if err := encoder.Encode(metadata.Content[0]); err != nil {
		return nil, fmt.Errorf("encode frontmatter: %w", err)
	}
	_ = encoder.Close()
	return []byte("---\n" + strings.TrimSuffix(frontmatter.String(), "\n") + "\n---\n\n" + body), nil
}

func mappingString(node *yaml.Node, key string) string {
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key && node.Content[i+1].Kind == yaml.ScalarNode {
			return strings.TrimSpace(node.Content[i+1].Value)
		}
	}
	return ""
}

func setMappingString(node *yaml.Node, key, value string) {
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			node.Content[i+1] = &yaml.Node{Kind: yaml.ScalarNode, Value: value}
			return
		}
	}
	node.Content = append(node.Content, &yaml.Node{Kind: yaml.ScalarNode, Value: key}, &yaml.Node{Kind: yaml.ScalarNode, Value: value})
}

func normalizeInput(input Input) Input {
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	return input
}

func validateInput(input Input) error {
	if err := validateName(input.Name); err != nil {
		return err
	}
	if utf8.RuneCountInString(input.Description) < 1 || utf8.RuneCountInString(input.Description) > 1024 {
		return errors.New("description must be between 1 and 1024 characters")
	}
	if !utf8.ValidString(input.Description) || !utf8.ValidString(input.Instructions) {
		return errors.New("skill content must be UTF-8")
	}
	if len(input.Instructions) > MaxEditableBytes {
		return errors.New("instructions exceed the 256 KB editor limit")
	}
	return nil
}

func validateName(name string) error {
	if len(name) < 1 || len(name) > 64 || !namePattern.MatchString(name) {
		return errors.New("name must be 1-64 lowercase letters, numbers, or single hyphens")
	}
	return nil
}

func validateEntryName(name string) error {
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, `/\\`) {
		return errors.New("invalid skill path")
	}
	return nil
}

func readDocument(path string) ([]byte, fs.FileInfo, error) {
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, errors.New("SKILL.md is missing")
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read SKILL.md: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, nil, errors.New("SKILL.md must be a regular file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, fmt.Errorf("read SKILL.md: %w", err)
	}
	return data, info, nil
}

func readEditableDocument(path string) ([]byte, fs.FileMode, error) {
	data, info, err := readDocument(path)
	if err != nil {
		return nil, 0, err
	}
	if len(data) > MaxEditableBytes {
		return nil, 0, ErrReadOnly
	}
	return data, info.Mode().Perm(), nil
}

func atomicWrite(path string, data []byte, mode fs.FileMode) error {
	temp, err := os.CreateTemp(filepath.Dir(path), ".skill-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary skill file: %w", err)
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(mode); err != nil {
		_ = temp.Close()
		return fmt.Errorf("set skill permissions: %w", err)
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write skill: %w", err)
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("sync skill: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("close skill: %w", err)
	}
	if err := os.Rename(tempName, path); err != nil {
		return fmt.Errorf("replace skill: %w", err)
	}
	return nil
}

func validateManagedPath(workspace, path string) error {
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return err
	}
	path, err = filepath.Abs(path)
	if err != nil || !pathWithin(workspace, path) {
		return errors.New("skills path is outside workspace")
	}
	relative, err := filepath.Rel(workspace, path)
	if err != nil {
		return err
	}
	current := workspace
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		if part == "" || part == "." {
			continue
		}
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err == nil {
			if info.Mode()&os.ModeSymlink != 0 {
				return errors.New("managed skills paths must not contain symlinks")
			}
			continue
		}
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func countResources(directory string) int {
	count := 0
	_ = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == directory {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			count++
			return nil
		}
		if !entry.IsDir() && filepath.Base(path) != "SKILL.md" {
			count++
		}
		return nil
	})
	return count
}

func revision(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func skillsRoot(workspace string) string { return filepath.Join(workspace, ".agents", "skills") }

func pathWithin(root, candidate string) bool {
	resolvedRoot, rootErr := filepath.EvalSymlinks(root)
	resolvedCandidate, candidateErr := filepath.EvalSymlinks(candidate)
	if rootErr == nil && candidateErr == nil {
		root = resolvedRoot
		candidate = resolvedCandidate
	}
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(candidate))
	return err == nil && (relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))))
}

func (m *Manager) bridgeStatus(workspace, name string) Bridge {
	path := filepath.Join(workspace, ".claude", "skills", name)
	relativePath := filepath.ToSlash(filepath.Join(".claude", "skills", name))
	if err := validateManagedPath(workspace, filepath.Dir(path)); err != nil {
		return Bridge{Status: "error", Path: relativePath, Message: err.Error()}
	}
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Bridge{Status: "missing", Path: relativePath}
	}
	if err != nil {
		return Bridge{Status: "error", Path: relativePath, Message: err.Error()}
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return Bridge{Status: "conflict", Path: relativePath, Message: "an existing non-symlink entry is in the way"}
	}
	target, err := os.Readlink(path)
	if err != nil {
		return Bridge{Status: "error", Path: relativePath, Message: err.Error()}
	}
	resolved := target
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(filepath.Dir(path), resolved)
	}
	expected := filepath.Join(skillsRoot(workspace), name)
	if filepath.Clean(resolved) != filepath.Clean(expected) {
		return Bridge{Status: "conflict", Path: relativePath, Message: "the symlink points somewhere else"}
	}
	return Bridge{Status: "linked", Path: relativePath}
}

func (m *Manager) ensureBridge(workspace, name string) (Bridge, error) {
	status := m.bridgeStatus(workspace, name)
	if status.Status == "linked" {
		return status, nil
	}
	if status.Status != "missing" {
		return status, fmt.Errorf("Claude bridge conflict: %s", status.Message)
	}
	directory := filepath.Join(workspace, ".claude", "skills")
	if err := validateManagedPath(workspace, directory); err != nil {
		return status, err
	}
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return status, fmt.Errorf("create Claude skills directory: %w", err)
	}
	if err := os.Symlink(filepath.Join("..", "..", ".agents", "skills", name), filepath.Join(directory, name)); err != nil {
		return status, fmt.Errorf("create Claude bridge: %w", err)
	}
	return m.bridgeStatus(workspace, name), nil
}

func (m *Manager) replaceBridgeConflict(workspace, name string) (string, error) {
	status := m.bridgeStatus(workspace, name)
	if status.Status == "linked" {
		return "", nil
	}
	if status.Status == "missing" {
		_, err := m.ensureBridge(workspace, name)
		return "", err
	}
	if status.Status != "conflict" {
		return "", fmt.Errorf("Claude bridge cannot be replaced: %s", status.Message)
	}
	directory := filepath.Join(workspace, ".claude", "skills")
	if err := validateManagedPath(workspace, directory); err != nil {
		return "", err
	}
	bridgePath := filepath.Join(directory, name)
	backupPath, err := availableBridgeBackupPath(directory, name, time.Now().UTC())
	if err != nil {
		return "", err
	}
	if err := os.Rename(bridgePath, backupPath); err != nil {
		return "", fmt.Errorf("back up existing Claude entry: %w", err)
	}
	target := filepath.Join("..", "..", ".agents", "skills", name)
	if err := os.Symlink(target, bridgePath); err != nil {
		if rollbackErr := os.Rename(backupPath, bridgePath); rollbackErr != nil {
			return "", fmt.Errorf("create Claude bridge: %w (restore existing entry: %v)", err, rollbackErr)
		}
		return "", fmt.Errorf("create Claude bridge: %w", err)
	}
	relative, err := filepath.Rel(workspace, backupPath)
	if err != nil {
		return filepath.ToSlash(backupPath), nil
	}
	return filepath.ToSlash(relative), nil
}

func availableBridgeBackupPath(directory, name string, now time.Time) (string, error) {
	base := filepath.Join(directory, fmt.Sprintf("%s.gorchestra-backup-%s", name, now.Format("20060102T150405Z")))
	for suffix := 0; ; suffix++ {
		candidate := base
		if suffix > 0 {
			candidate = fmt.Sprintf("%s-%d", base, suffix)
		}
		if _, err := os.Lstat(candidate); errors.Is(err, fs.ErrNotExist) {
			return candidate, nil
		} else if err != nil {
			return "", fmt.Errorf("check Claude backup path: %w", err)
		}
	}
}

func (m *Manager) removeOwnedBridge(workspace, name string) {
	if m.bridgeStatus(workspace, name).Status == "linked" {
		_ = os.Remove(filepath.Join(workspace, ".claude", "skills", name))
	}
}
