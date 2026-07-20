package hosting

import (
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
)

const routeSlugSuffix = "-gorchestra"

var nonSlugCharacterRE = regexp.MustCompile(`[^a-z0-9]+`)

// RouteSlug returns a deterministic single-label DNS name ending in
// -gorchestra. The session suffix keeps previews for the same recipe isolated.
func RouteSlug(recipeName string, sessionID string) string {
	name := normalizeSlugPart(recipeName)
	if name == "" {
		name = "preview"
	}
	session := normalizeSlugPart(sessionID)
	if session == "" {
		session = "session"
	}
	if len(session) > 8 {
		session = session[:8]
	}
	maxName := 63 - len(routeSlugSuffix) - 1 - len(session)
	if maxName < 1 {
		maxName = 1
	}
	if len(name) > maxName {
		name = strings.Trim(name[:maxName], "-")
	}
	if name == "" {
		name = "p"
	}
	return name + "-" + session + routeSlugSuffix
}

func normalizeSlugPart(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = nonSlugCharacterRE.ReplaceAllString(value, "-")
	return strings.Trim(value, "-")
}

// ValidatePreviewURLTemplate verifies that dynamic preview routing is host
// based. The placeholder must occur in the hostname, not merely the path.
func ValidatePreviewURLTemplate(template string) error {
	if strings.TrimSpace(template) == "" {
		return fmt.Errorf("preview URL template is required")
	}
	if strings.Count(template, "{slug}") != 1 {
		return fmt.Errorf("preview URL template must contain {slug} exactly once")
	}
	probe := strings.Replace(template, "{slug}", "preview-gorchestra", 1)
	parsed, err := url.Parse(probe)
	if err != nil {
		return fmt.Errorf("parse preview URL template: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("preview URL template scheme must be http or https")
	}
	if parsed.Hostname() == "" {
		return fmt.Errorf("preview URL template must include a hostname")
	}
	if !strings.Contains(hostnameTemplate(template), "{slug}") {
		return fmt.Errorf("preview URL template must place {slug} in the hostname")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("preview URL template may not include credentials, query, or fragment")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return fmt.Errorf("preview URL template may not include a path")
	}
	return nil
}

func hostnameTemplate(template string) string {
	withoutScheme := template
	if index := strings.Index(withoutScheme, "://"); index >= 0 {
		withoutScheme = withoutScheme[index+3:]
	}
	authority := strings.SplitN(withoutScheme, "/", 2)[0]
	if strings.HasPrefix(authority, "[") {
		return authority
	}
	host, _, err := net.SplitHostPort(authority)
	if err == nil {
		return host
	}
	return authority
}

func ExpandPreviewURL(template string, slug string) (string, error) {
	if err := ValidatePreviewURLTemplate(template); err != nil {
		return "", err
	}
	slug = normalizeSlugPart(slug)
	if slug == "" || len(slug) > 63 {
		return "", fmt.Errorf("invalid preview route slug")
	}
	expanded := strings.Replace(template, "{slug}", slug, 1)
	parsed, err := url.Parse(expanded)
	if err != nil || parsed.Hostname() == "" {
		return "", fmt.Errorf("expand preview URL: %w", err)
	}
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	return parsed.String(), nil
}
