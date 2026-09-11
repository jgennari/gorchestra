package claude

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jgennari/gorchestra/internal/agents"
	"gopkg.in/yaml.v3"
)

var _ agents.SkillProvider = (*Agent)(nil)

// Skills reads on every request, so refresh and submit validation see disk changes.
// It deliberately does not use the managed .agents catalog or modify bridges.
func (a *Agent) Skills(ctx context.Context, query agents.SkillQuery) (agents.SkillCatalog, error) {
	workdir, err := a.workdirForRun(query.Workdir)
	if err != nil {
		return agents.SkillCatalog{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return agents.SkillCatalog{}, fmt.Errorf("resolve Claude home: %w", err)
	}
	config := os.Getenv("CLAUDE_CONFIG_DIR")
	if config == "" {
		config = filepath.Join(home, ".claude")
	}
	config, err = filepath.Abs(config)
	if err != nil {
		return agents.SkillCatalog{}, err
	}
	type root struct{ path, scope string }
	roots := []root{{filepath.Join(config, "skills"), "user"}}
	// Nearest project directory wins among project skills; personal skills win
	// over project skills, matching Claude's command resolution.
	for directory := workdir; ; directory = filepath.Dir(directory) {
		roots = append(roots, root{filepath.Join(directory, ".claude", "skills"), "repo"})
		if parent := filepath.Dir(directory); parent == directory {
			break
		}
	}
	catalog := agents.SkillCatalog{Skills: []agents.Skill{}, Errors: []agents.SkillError{}}
	seenRoots, seenNames, seenTargets := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, root := range roots {
		if err := ctx.Err(); err != nil {
			return catalog, err
		}
		if seenRoots[root.path] {
			continue
		}
		seenRoots[root.path] = true
		entries, err := os.ReadDir(root.path)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			catalog.Errors = append(catalog.Errors, agents.SkillError{Path: root.path, Message: err.Error()})
			continue
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return catalog, err
			}
			if !entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
				continue
			}
			path := filepath.Join(root.path, entry.Name(), "SKILL.md")
			content, err := os.ReadFile(path)
			if err != nil {
				catalog.Errors = append(catalog.Errors, agents.SkillError{Path: path, Message: err.Error()})
				continue
			}
			skill, err := parseSkill(content, entry.Name())
			if err != nil {
				catalog.Errors = append(catalog.Errors, agents.SkillError{Path: path, Message: err.Error()})
				continue
			}
			if seenNames[skill.Name] {
				continue
			}
			seenNames[skill.Name] = true
			target, err := filepath.EvalSymlinks(path)
			if err != nil {
				catalog.Errors = append(catalog.Errors, agents.SkillError{Path: path, Message: err.Error()})
				continue
			}
			if seenTargets[target] {
				continue
			}
			seenTargets[target] = true
			skill.Path, skill.Scope = path, root.scope
			catalog.Skills = append(catalog.Skills, skill)
		}
	}
	sort.Slice(catalog.Skills, func(i, j int) bool { return catalog.Skills[i].Name < catalog.Skills[j].Name })
	encoded, _ := json.Marshal(catalog)
	catalog.Revision = fmt.Sprintf("%x", sha256.Sum256(encoded))
	return catalog, nil
}

func parseSkill(content []byte, directoryName string) (agents.Skill, error) {
	text := strings.TrimPrefix(strings.ReplaceAll(string(content), "\r\n", "\n"), "\ufeff")
	var metadata struct {
		Name          string `yaml:"name"`
		Description   string `yaml:"description"`
		UserInvocable *bool  `yaml:"user-invocable"`
	}
	body := text
	if strings.HasPrefix(text, "---\n") {
		lines := strings.Split(text, "\n")
		end := 1
		for end < len(lines) && strings.TrimSpace(lines[end]) != "---" {
			end++
		}
		if end == len(lines) {
			return agents.Skill{}, fmt.Errorf("SKILL.md frontmatter is not closed")
		}
		if err := yaml.Unmarshal([]byte(strings.Join(lines[1:end], "\n")), &metadata); err != nil {
			return agents.Skill{}, fmt.Errorf("parse SKILL.md frontmatter: %w", err)
		}
		body = strings.Join(lines[end+1:], "\n")
	}
	name := strings.TrimSpace(metadata.Name)
	if name == "" {
		name = directoryName
	}
	description := strings.TrimSpace(metadata.Description)
	if description == "" {
		for _, line := range strings.Split(body, "\n") {
			if line = strings.TrimSpace(strings.TrimLeft(line, "#")); line != "" {
				description = line
				break
			}
		}
	}
	return agents.Skill{Name: name, Description: description, Enabled: metadata.UserInvocable == nil || *metadata.UserInvocable}, nil
}

// References travel only in provider input; the stored user message stays intact.
// Do not expand skill bodies or execute dynamic skill commands in Gorchestra.
func messageWithSkills(message string, skills []agents.SkillReference) string {
	if len(skills) == 0 {
		return message
	}
	encoded, _ := json.Marshal(skills)
	return message + "\n\nThe user explicitly selected these skills for this request (JSON name/path references):\n" + string(encoded) +
		"\nUse each selected skill. Read its exact SKILL.md path and follow its instructions, resolving supporting files relative to that skill's directory. Respect tool permissions; report unavailable skills instead of substituting another skill."
}
