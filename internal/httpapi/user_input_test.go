package httpapi

import (
	"testing"

	"github.com/jgennari/gorchestra/internal/agents"
)

func TestValidateUserInputMultipleSelections(t *testing.T) {
	for _, test := range []struct {
		name         string
		multi, other bool
		values       []string
		valid        bool
	}{
		{"single", false, false, []string{"Alpha"}, true},
		{"single rejects multiple", false, false, []string{"Alpha", "Beta"}, false},
		{"multiple", true, false, []string{"Alpha", "Beta"}, true},
		{"multiple accepts one", true, false, []string{"Alpha"}, true},
		{"multiple requires selection", true, false, nil, false},
		{"multiple rejects empty", true, true, []string{"Alpha", " "}, false},
		{"multiple rejects unknown", true, false, []string{"Alpha", "Gamma"}, false},
		{"multiple accepts free text", true, true, []string{"Alpha", "Custom"}, true},
		{"multiple rejects duplicates", true, true, []string{"Alpha", " Alpha "}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := agents.UserInputRequest{Questions: []agents.UserInputQuestion{{ID: "question", MultiSelect: test.multi, IsOther: test.other, Options: []agents.UserInputOption{{Label: "Alpha"}, {Label: "Beta"}}}}}
			err := validateUserInputAnswers(request, map[string]agents.UserInputQuestionAnswer{"question": {Answers: test.values}})
			if (err == nil) != test.valid {
				t.Fatalf("validation: %v", err)
			}
		})
	}
}
