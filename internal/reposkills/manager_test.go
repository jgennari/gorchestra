package reposkills

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListDoesNotCreateSkillsDirectories(t *testing.T) {
	workspace := t.TempDir()
	catalog, err := NewManager().List(workspace)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Skills) != 0 {
		t.Fatalf("expected empty catalog, got %#v", catalog.Skills)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".agents")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("list mutated workspace: %v", err)
	}
}

func TestCreateUpdateRenameAndDeleteBundle(t *testing.T) {
	workspace := t.TempDir()
	manager := NewManager()
	created, err := manager.Create(workspace, Input{Name: "review-code", Description: "Review code changes", Instructions: "# Review\n\nBe precise.\n"})
	if err != nil {
		t.Fatal(err)
	}
	if created.ClaudeBridge.Status != "linked" {
		t.Fatalf("expected linked Claude bridge, got %#v", created.ClaudeBridge)
	}
	supportPath := filepath.Join(workspace, ".agents", "skills", "review-code", "references", "checklist.md")
	if err := os.MkdirAll(filepath.Dir(supportPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(supportPath, []byte("check everything"), 0o644); err != nil {
		t.Fatal(err)
	}
	skillPath := filepath.Join(workspace, ".agents", "skills", "review-code", "SKILL.md")
	current, err := os.ReadFile(skillPath)
	if err != nil {
		t.Fatal(err)
	}
	current = []byte(strings.Replace(string(current), "description: Review code changes", "description: Review code changes\nlicense: MIT", 1))
	if err := os.WriteFile(skillPath, current, 0o644); err != nil {
		t.Fatal(err)
	}
	detail, err := manager.Get(workspace, "review-code")
	if err != nil {
		t.Fatal(err)
	}
	updated, err := manager.Update(workspace, "review-code", Input{Name: "review-pr", Description: "Review pull requests", Instructions: "# Review\n\nCheck tests.\n", Revision: detail.Revision})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Name != "review-pr" || updated.ResourceCount != 1 {
		t.Fatalf("unexpected updated skill: %#v", updated)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".agents", "skills", "review-pr", "references", "checklist.md")); err != nil {
		t.Fatalf("supporting resource was not preserved: %v", err)
	}
	updatedContent, err := os.ReadFile(filepath.Join(workspace, ".agents", "skills", "review-pr", "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(updatedContent), "license: MIT") {
		t.Fatalf("unknown frontmatter was not preserved:\n%s", updatedContent)
	}
	if _, err := os.Lstat(filepath.Join(workspace, ".claude", "skills", "review-code")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("old Claude bridge remains: %v", err)
	}
	if err := manager.Delete(workspace, "review-pr"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(workspace, ".agents", "skills", "review-pr")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("bundle was not deleted: %v", err)
	}
}

func TestUpdateRejectsStaleRevision(t *testing.T) {
	workspace := t.TempDir()
	manager := NewManager()
	created, err := manager.Create(workspace, Input{Name: "test-skill", Description: "Test a skill", Instructions: "Original"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Update(workspace, created.Name, Input{Name: created.Name, Description: "Changed", Instructions: "Changed", Revision: "stale"})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("expected revision conflict, got %v", err)
	}
}

func TestBridgeConflictIsNonDestructive(t *testing.T) {
	workspace := t.TempDir()
	conflict := filepath.Join(workspace, ".claude", "skills", "review-code")
	if err := os.MkdirAll(conflict, 0o755); err != nil {
		t.Fatal(err)
	}
	manager := NewManager()
	created, err := manager.Create(workspace, Input{Name: "review-code", Description: "Review code", Instructions: "Review it."})
	if err != nil {
		t.Fatal(err)
	}
	if created.ClaudeBridge.Status != "conflict" {
		t.Fatalf("expected bridge conflict, got %#v", created.ClaudeBridge)
	}
	if info, err := os.Stat(conflict); err != nil || !info.IsDir() {
		t.Fatalf("conflicting entry was modified: %v", err)
	}
}

func TestReplaceBridgeConflictBacksUpExistingEntry(t *testing.T) {
	workspace := t.TempDir()
	conflict := filepath.Join(workspace, ".claude", "skills", "review-code")
	if err := os.MkdirAll(conflict, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(conflict, "keep.txt")
	if err := os.WriteFile(marker, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}
	manager := NewManager()
	if _, err := manager.Create(workspace, Input{Name: "review-code", Description: "Review code", Instructions: "Review it."}); err != nil {
		t.Fatal(err)
	}
	result, err := manager.RepairBridge(workspace, "review-code", true)
	if err != nil {
		t.Fatal(err)
	}
	if result.Skill.ClaudeBridge.Status != "linked" || result.BackupPath == "" {
		t.Fatalf("unexpected repair result: %#v", result)
	}
	backupMarker := filepath.Join(workspace, filepath.FromSlash(result.BackupPath), "keep.txt")
	if data, err := os.ReadFile(backupMarker); err != nil || string(data) != "keep me" {
		t.Fatalf("existing Claude entry was not preserved: data=%q err=%v", data, err)
	}
	bridgeTarget, err := os.Readlink(conflict)
	if err != nil {
		t.Fatal(err)
	}
	if bridgeTarget != filepath.Join("..", "..", ".agents", "skills", "review-code") {
		t.Fatalf("unexpected bridge target %q", bridgeTarget)
	}
}

func TestExternalSkillDirectoryLinkIsReadOnlyAndDeleteOnlyRemovesLink(t *testing.T) {
	workspace := t.TempDir()
	external := t.TempDir()
	if err := os.WriteFile(filepath.Join(external, "SKILL.md"), []byte("---\nname: linked-skill\ndescription: Linked skill\n---\n\nDo work."), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(workspace, ".agents", "skills")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, "linked-skill")); err != nil {
		t.Fatal(err)
	}
	manager := NewManager()
	item, err := manager.Get(workspace, "linked-skill")
	if err != nil {
		t.Fatal(err)
	}
	if item.Editable || !item.Linked {
		t.Fatalf("expected read-only linked skill, got %#v", item)
	}
	if err := manager.Delete(workspace, "linked-skill"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(external, "SKILL.md")); err != nil {
		t.Fatalf("external target was deleted: %v", err)
	}
}

func TestInternalSkillDirectoryLinkIsAlsoReadOnly(t *testing.T) {
	workspace := t.TempDir()
	target := filepath.Join(workspace, "shared-skill")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "SKILL.md"), []byte("---\nname: shared-skill\ndescription: Shared skill\n---\n\nDo work."), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(workspace, ".agents", "skills")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(root, "shared-skill")); err != nil {
		t.Fatal(err)
	}
	item, err := NewManager().Get(workspace, "shared-skill")
	if err != nil {
		t.Fatal(err)
	}
	if item.Editable || len(item.ValidationErrors) != 0 {
		t.Fatalf("expected valid read-only linked skill, got %#v", item)
	}
}

func TestManagedRootsCannotEscapeWorkspaceThroughSymlinks(t *testing.T) {
	workspace := t.TempDir()
	external := t.TempDir()
	if err := os.Symlink(external, filepath.Join(workspace, ".agents")); err != nil {
		t.Fatal(err)
	}
	manager := NewManager()
	if _, err := manager.List(workspace); err == nil {
		t.Fatal("expected escaped .agents path to be rejected")
	}
	if _, err := manager.Create(workspace, Input{Name: "unsafe", Description: "Unsafe", Instructions: "No"}); err == nil {
		t.Fatal("expected create through escaped .agents path to be rejected")
	}
	if err := os.Mkdir(filepath.Join(external, "keep-me"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := manager.Delete(workspace, "keep-me"); err == nil {
		t.Fatal("expected delete through escaped .agents path to be rejected")
	}
	if _, err := os.Stat(filepath.Join(external, "keep-me")); err != nil {
		t.Fatalf("external directory was modified: %v", err)
	}
}

func TestSkillDocumentSymlinkIsNotEditable(t *testing.T) {
	workspace := t.TempDir()
	external := filepath.Join(t.TempDir(), "SKILL.md")
	if err := os.WriteFile(external, []byte("---\nname: linked-file\ndescription: Linked file\n---\n\nNo"), 0o644); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(workspace, ".agents", "skills", "linked-file")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(directory, "SKILL.md")); err != nil {
		t.Fatal(err)
	}
	item, err := NewManager().Get(workspace, "linked-file")
	if err != nil {
		t.Fatal(err)
	}
	if item.Editable || len(item.ValidationErrors) == 0 {
		t.Fatalf("expected symlink validation error, got %#v", item)
	}
}
