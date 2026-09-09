package claude

import (
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/jgennari/gorchestra/internal/agents"
)

// Claude accepts images as content blocks on the streaming user message.
// Never place image data in command arguments or read provider-supplied paths.
func userMessageContent(message string, attachments []agents.Attachment) (any, error) {
	if len(attachments) == 0 {
		return message, nil
	}
	blocks := make([]map[string]any, 0, len(attachments)+1)
	if message != "" {
		blocks = append(blocks, map[string]any{"type": "text", "text": message})
	}
	for index, attachment := range attachments {
		switch attachment.MediaType {
		case "image/png", "image/jpeg", "image/gif", "image/webp":
		default:
			return nil, fmt.Errorf("claude attachment %d must be PNG, JPEG, GIF, or WebP", index+1)
		}
		header, data, ok := strings.Cut(attachment.DataURL, ",")
		if !ok || header != "data:"+attachment.MediaType+";base64" {
			return nil, fmt.Errorf("claude attachment %d has an invalid image data URL", index+1)
		}
		decoded, err := base64.StdEncoding.DecodeString(data)
		if err != nil || len(decoded) == 0 {
			return nil, fmt.Errorf("claude attachment %d has invalid base64 image data", index+1)
		}
		blocks = append(blocks, map[string]any{
			"type":   "image",
			"source": map[string]any{"type": "base64", "media_type": attachment.MediaType, "data": data},
		})
	}
	return blocks, nil
}
