package store

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

type dashboardShellOutcome struct {
	Kind      string
	Key       string
	Status    string
	Title     string
	Reference string
	URL       string
	Framework string
}

type dashboardShellInvocation struct {
	Words      []string
	FollowedBy string
}

var (
	dashboardShellAssignmentPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	dashboardCommitOutputPattern    = regexp.MustCompile(`(?m)^\[[^\]\r\n]*?([0-9a-fA-F]{7,64})\]\s+([^\r\n]+)$`)
	dashboardPullRequestURLPattern  = regexp.MustCompile(`https?://[^\s<>"']+/(?:pull|pulls|merge_requests)/[0-9]+`)
)

func dashboardShellOutcomes(event Event) []dashboardShellOutcome {
	if event.Type != "tool.call.completed" {
		return nil
	}
	var payload map[string]any
	if json.Unmarshal(event.Payload, &payload) != nil {
		return nil
	}
	command := dashboardStringValue(payload["command"])
	if command == "" {
		return nil
	}
	invocations := dashboardParseShellInvocations(command, 0)
	if len(invocations) == 0 {
		return nil
	}
	itemID := dashboardFirstString(payload, "item_id", "tool_call_id")
	if itemID == "" {
		itemID = event.ID
	}
	output := dashboardFirstString(payload, "aggregated_output", "output", "text")
	succeeded, hasStatus := dashboardToolSucceeded(event, payload)

	outcomes := make([]dashboardShellOutcome, 0)
	commitCommands := make([]int, 0)
	pullRequestCommands := make([]int, 0)
	tests := make([]dashboardShellOutcome, 0)
	for index, invocation := range invocations {
		words := dashboardNormalizeInvocation(invocation.Words)
		if len(words) == 0 {
			continue
		}
		if dashboardGitSubcommand(words) == "commit" {
			commitCommands = append(commitCommands, index)
		}
		if dashboardIsPullRequestCreate(words) {
			pullRequestCommands = append(pullRequestCommands, index)
		}
		if framework, title, ok := dashboardTestCommand(words); ok && hasStatus && dashboardShellResultAttributable(invocations, index, succeeded) {
			status := "failed"
			if succeeded {
				status = "passed"
			}
			tests = append(tests, dashboardShellOutcome{
				Kind:      "test",
				Key:       fmt.Sprintf("shell:%s:test:%d:%s", itemID, len(tests), framework),
				Status:    status,
				Title:     title,
				Framework: framework,
			})
		}
	}

	if len(commitCommands) > 0 {
		matches := dashboardCommitOutputPattern.FindAllStringSubmatch(output, -1)
		for _, match := range matches {
			sha := strings.ToLower(strings.TrimSpace(match[1]))
			if sha == "" {
				continue
			}
			outcomes = append(outcomes, dashboardShellOutcome{
				Kind:      "commit",
				Key:       "shell:commit:" + sha,
				Status:    "created",
				Title:     dashboardExcerpt(match[2]),
				Reference: sha,
			})
		}
		if len(matches) == 0 && hasStatus && succeeded {
			for outcomeIndex, invocationIndex := range commitCommands {
				if !dashboardShellResultAttributable(invocations, invocationIndex, succeeded) {
					continue
				}
				outcomes = append(outcomes, dashboardShellOutcome{
					Kind:   "commit",
					Key:    fmt.Sprintf("shell:%s:commit:%d", itemID, outcomeIndex),
					Status: "created",
					Title:  "Commit created",
				})
			}
		}
	}

	if len(pullRequestCommands) > 0 {
		urls := dashboardPullRequestURLPattern.FindAllString(output, -1)
		for _, rawURL := range urls {
			url := strings.TrimRight(rawURL, ").,];")
			outcomes = append(outcomes, dashboardShellOutcome{
				Kind:      "pull_request",
				Key:       "shell:pull_request:" + url,
				Status:    "created",
				Title:     "Pull request created",
				Reference: dashboardPullRequestReference(url),
				URL:       url,
			})
		}
		if len(urls) == 0 && hasStatus && succeeded {
			for outcomeIndex, invocationIndex := range pullRequestCommands {
				if !dashboardShellResultAttributable(invocations, invocationIndex, succeeded) {
					continue
				}
				outcomes = append(outcomes, dashboardShellOutcome{
					Kind:   "pull_request",
					Key:    fmt.Sprintf("shell:%s:pull_request:%d", itemID, outcomeIndex),
					Status: "created",
					Title:  "Pull request created",
				})
			}
		}
	}

	outcomes = append(outcomes, tests...)
	return dashboardUniqueShellOutcomes(outcomes)
}

func dashboardShellOutcomePayload(event Event, outcome dashboardShellOutcome) json.RawMessage {
	payload := map[string]any{
		"kind":             outcome.Kind,
		"outcome_id":       outcome.Key,
		"status":           outcome.Status,
		"title":            outcome.Title,
		"reference":        outcome.Reference,
		"url":              outcome.URL,
		"source":           "shell",
		"source_event_id":  event.ID,
		"source_event_seq": event.Seq,
	}
	if outcome.Framework != "" {
		payload["framework"] = outcome.Framework
	}
	if itemID := dashboardPayloadString(event.Payload, "item_id"); itemID != "" {
		payload["source_item_id"] = itemID
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return json.RawMessage(`{}`)
	}
	return encoded
}

func dashboardToolSucceeded(event Event, payload map[string]any) (bool, bool) {
	if value, ok := dashboardNumericValue(payload["exit_code"]); ok {
		return value == 0, true
	}
	if isError, ok := payload["is_error"].(bool); ok {
		return !isError, true
	}
	switch event.Status {
	case EventStatusCompleted:
		return true, true
	case EventStatusFailed, EventStatusCancelled:
		return false, true
	default:
		return false, false
	}
}

func dashboardNumericValue(value any) (int64, bool) {
	switch number := value.(type) {
	case float64:
		return int64(number), true
	case json.Number:
		parsed, err := number.Int64()
		return parsed, err == nil
	case int:
		return int64(number), true
	case int64:
		return number, true
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(number), 10, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func dashboardParseShellInvocations(script string, depth int) []dashboardShellInvocation {
	if depth > 4 {
		return nil
	}
	segments := dashboardShellSegments(script)
	result := make([]dashboardShellInvocation, 0, len(segments))
	for _, invocation := range segments {
		words := dashboardNormalizeInvocation(invocation.Words)
		if len(words) == 0 {
			continue
		}
		if nested, ok := dashboardShellWrapperScript(words); ok {
			nestedInvocations := dashboardParseShellInvocations(nested, depth+1)
			if len(nestedInvocations) > 0 {
				nestedInvocations[len(nestedInvocations)-1].FollowedBy = invocation.FollowedBy
				result = append(result, nestedInvocations...)
			}
			continue
		}
		result = append(result, dashboardShellInvocation{Words: words, FollowedBy: invocation.FollowedBy})
	}
	return result
}

func dashboardShellSegments(script string) []dashboardShellInvocation {
	commands := make([]dashboardShellInvocation, 0)
	words := make([]string, 0)
	var word strings.Builder
	wordStarted := false
	quote := rune(0)
	escaped := false
	backtick := false
	commandSubDepth := 0
	runes := []rune(script)

	flushWord := func() {
		if !wordStarted {
			return
		}
		words = append(words, word.String())
		word.Reset()
		wordStarted = false
	}
	flushCommand := func(followedBy string) {
		flushWord()
		if len(words) > 0 {
			commands = append(commands, dashboardShellInvocation{
				Words:      append([]string(nil), words...),
				FollowedBy: followedBy,
			})
			words = words[:0]
		}
	}

	for index := 0; index < len(runes); index++ {
		current := runes[index]
		if escaped {
			if current != '\n' {
				word.WriteRune(current)
				wordStarted = true
			}
			escaped = false
			continue
		}
		if current == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if backtick {
			word.WriteRune(current)
			wordStarted = true
			if current == '`' {
				backtick = false
			}
			continue
		}
		if current == '`' && quote != '\'' {
			backtick = true
			word.WriteRune(current)
			wordStarted = true
			continue
		}
		if quote != 0 {
			if current == quote {
				quote = 0
				wordStarted = true
				continue
			}
			word.WriteRune(current)
			wordStarted = true
			continue
		}
		if current == '\'' || current == '"' {
			if word.String() == "$" {
				word.Reset()
			}
			quote = current
			wordStarted = true
			continue
		}
		if current == '$' && index+1 < len(runes) && runes[index+1] == '(' {
			commandSubDepth++
			word.WriteString("$(")
			wordStarted = true
			index++
			continue
		}
		if commandSubDepth > 0 {
			word.WriteRune(current)
			wordStarted = true
			if current == '(' {
				commandSubDepth++
			} else if current == ')' {
				commandSubDepth--
			}
			continue
		}
		if current == '#' && !wordStarted {
			for index+1 < len(runes) && runes[index+1] != '\n' {
				index++
			}
			continue
		}
		if unicode.IsSpace(current) {
			if current == '\n' {
				flushCommand(";")
			} else {
				flushWord()
			}
			continue
		}
		if strings.ContainsRune(";|&(){}", current) {
			separator := string(current)
			if index+1 < len(runes) && runes[index+1] == current && (current == '|' || current == '&') {
				separator += string(current)
				index++
			}
			if current == '(' || current == ')' || current == '{' || current == '}' {
				separator = ";"
			}
			flushCommand(separator)
			continue
		}
		word.WriteRune(current)
		wordStarted = true
	}
	flushCommand("")
	return commands
}

// dashboardShellResultAttributable is deliberately conservative. A process
// exit code describes the whole shell program, not every command within it.
// We only assign it to an invocation when shell control flow proves the result:
// a lone command, the final sequential command, or a wholly successful && chain.
func dashboardShellResultAttributable(invocations []dashboardShellInvocation, index int, succeeded bool) bool {
	if len(invocations) == 1 {
		return true
	}
	if index == len(invocations)-1 {
		separator := invocations[index-1].FollowedBy
		switch separator {
		case ";":
			return true
		case "&&":
			return succeeded
		case "||":
			return !succeeded
		default:
			return false
		}
	}
	if !succeeded {
		return false
	}
	for invocationIndex := 0; invocationIndex < len(invocations)-1; invocationIndex++ {
		if invocations[invocationIndex].FollowedBy != "&&" {
			return false
		}
	}
	return true
}

func dashboardNormalizeInvocation(words []string) []string {
	index := 0
	for index < len(words) && dashboardShellAssignmentPattern.MatchString(words[index]) {
		index++
	}
	if index >= len(words) {
		return nil
	}
	words = words[index:]
	for len(words) > 0 {
		executable := strings.ToLower(filepath.Base(words[0]))
		switch executable {
		case "command", "builtin", "exec", "nohup":
			words = words[1:]
			for len(words) > 0 && strings.HasPrefix(words[0], "-") {
				words = words[1:]
			}
		case "env":
			words = words[1:]
			for len(words) > 0 && (strings.HasPrefix(words[0], "-") || dashboardShellAssignmentPattern.MatchString(words[0])) {
				words = words[1:]
			}
		default:
			return words
		}
	}
	return nil
}

func dashboardShellWrapperScript(words []string) (string, bool) {
	if len(words) < 3 {
		return "", false
	}
	executable := strings.ToLower(filepath.Base(words[0]))
	if executable != "sh" && executable != "bash" && executable != "zsh" && executable != "dash" && executable != "ksh" {
		return "", false
	}
	for index := 1; index < len(words)-1; index++ {
		option := words[index]
		if strings.HasPrefix(option, "-") && strings.Contains(strings.TrimPrefix(option, "-"), "c") {
			scriptIndex := index + 1
			if words[scriptIndex] == "--" && scriptIndex+1 < len(words) {
				scriptIndex++
			}
			return words[scriptIndex], true
		}
	}
	return "", false
}

func dashboardGitSubcommand(words []string) string {
	if len(words) < 2 || strings.ToLower(filepath.Base(words[0])) != "git" {
		return ""
	}
	for index := 1; index < len(words); index++ {
		word := words[index]
		if word == "-C" || word == "-c" || word == "--git-dir" || word == "--work-tree" || word == "--namespace" {
			index++
			continue
		}
		if strings.HasPrefix(word, "-") {
			continue
		}
		return strings.ToLower(word)
	}
	return ""
}

func dashboardIsPullRequestCreate(words []string) bool {
	if len(words) < 3 {
		return false
	}
	executable := strings.ToLower(filepath.Base(words[0]))
	if executable == "gh" {
		return strings.EqualFold(words[1], "pr") && strings.EqualFold(words[2], "create")
	}
	if executable == "glab" {
		return strings.EqualFold(words[1], "mr") && strings.EqualFold(words[2], "create")
	}
	return false
}

func dashboardTestCommand(words []string) (string, string, bool) {
	if len(words) == 0 {
		return "", "", false
	}
	executable := strings.ToLower(filepath.Base(words[0]))
	argument := func(index int) string {
		if index >= len(words) {
			return ""
		}
		return strings.ToLower(words[index])
	}
	title := dashboardExcerpt(strings.Join(words, " "))
	switch executable {
	case "go":
		if argument(1) == "test" {
			return "go", title, true
		}
	case "pytest", "py.test":
		return "pytest", title, true
	case "python", "python3":
		if argument(1) == "-m" && (argument(2) == "pytest" || argument(2) == "unittest") {
			return strings.TrimPrefix(argument(2), "py."), title, true
		}
	case "vitest", "jest", "mocha", "ava", "tox", "rspec":
		return executable, title, true
	case "npx", "bunx":
		if framework, _, ok := dashboardTestCommand(words[1:]); ok {
			return framework, title, true
		}
	case "bun", "npm", "pnpm", "yarn":
		if argument(1) == "test" {
			return executable, title, true
		}
		if argument(1) == "run" && dashboardTestScriptName(argument(2)) {
			return executable, title, true
		}
	case "cargo", "mix", "dotnet":
		if argument(1) == "test" {
			return executable, title, true
		}
	case "make":
		for _, word := range words[1:] {
			if dashboardTestScriptName(strings.ToLower(word)) {
				return "make", title, true
			}
		}
	case "mvn", "mvnw":
		for _, word := range words[1:] {
			if strings.EqualFold(word, "test") || strings.EqualFold(word, "verify") {
				return "maven", title, true
			}
		}
	case "gradle", "gradlew":
		for _, word := range words[1:] {
			if dashboardTestScriptName(strings.ToLower(strings.TrimPrefix(word, ":"))) {
				return "gradle", title, true
			}
		}
	}
	return "", "", false
}

func dashboardTestScriptName(value string) bool {
	return value == "test" || strings.HasPrefix(value, "test:") || strings.HasSuffix(value, ":test")
}

func dashboardUniqueShellOutcomes(outcomes []dashboardShellOutcome) []dashboardShellOutcome {
	seen := make(map[string]struct{}, len(outcomes))
	result := make([]dashboardShellOutcome, 0, len(outcomes))
	for _, outcome := range outcomes {
		key := outcome.Kind + "\x00" + outcome.Key
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, outcome)
	}
	return result
}

func dashboardPullRequestReference(url string) string {
	parts := strings.Split(strings.TrimRight(url, "/"), "/")
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func dashboardFirstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := dashboardStringValue(values[key]); value != "" {
			return value
		}
	}
	return ""
}

func dashboardStringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
