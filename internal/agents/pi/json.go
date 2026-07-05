package pi

import "encoding/json"

func rawOrNil(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return json.RawMessage(raw)
	}
	return value
}

func anyAt(raw json.RawMessage, path ...string) any {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil
	}
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}

func stringAt(raw json.RawMessage, path ...string) string {
	value, _ := anyAt(raw, path...).(string)
	return value
}

func stringFromRaw(raw json.RawMessage, key string) string {
	return stringAt(raw, key)
}

func boolAt(raw json.RawMessage, path ...string) bool {
	value, _ := anyAt(raw, path...).(bool)
	return value
}

func numberAt(raw json.RawMessage, path ...string) (int, bool) {
	switch value := anyAt(raw, path...).(type) {
	case float64:
		return int(value), true
	case int:
		return value, true
	default:
		return 0, false
	}
}

func stringFromMap(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return value
}

func firstStringFromMap(object map[string]any, keys ...string) string {
	for _, key := range keys {
		if value := stringFromMap(object, key); value != "" {
			return value
		}
	}
	return ""
}

func stringFromPayload(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}
