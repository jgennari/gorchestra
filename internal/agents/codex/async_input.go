package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/jgennari/gorchestra/internal/agents"
)

// Only handleIncoming reads provider responses. HTTP answer handlers can send a
// steer concurrently, then wait here while the ordinary event stream continues.
type asyncInputState struct {
	mu        sync.Mutex
	closed    bool
	done      chan struct{}
	responses map[string]asyncAnswerResponse
	waiters   []agents.UserInputWaiter // owned by the event loop
}

type asyncAnswerResponse struct {
	turnID string
	result chan error
}

func asyncQuestions(item map[string]any) []agents.UserInputQuestion {
	data, err := json.Marshal(item["questions"])
	if err != nil {
		return nil
	}
	var questions []struct {
		Title   string   `json:"title"`
		Options []string `json:"options"`
	}
	if json.Unmarshal(data, &questions) != nil {
		return nil
	}
	result := make([]agents.UserInputQuestion, 0, len(questions))
	for i, question := range questions {
		if strings.TrimSpace(question.Title) == "" {
			return nil
		}
		options := make([]agents.UserInputOption, 0, len(question.Options))
		seen := make(map[string]bool)
		for _, option := range question.Options {
			option = strings.TrimSpace(option)
			if option != "" && !seen[option] {
				options = append(options, agents.UserInputOption{Label: option})
				seen[option] = true
			}
		}
		result = append(result, agents.UserInputQuestion{
			ID: fmt.Sprintf("question_%d", i+1), Question: question.Title,
			IsOther: true, Options: options,
		})
	}
	return result
}

func (r *appServerRun) openAsyncInput(ctx context.Context, event agents.AgentEvent) error {
	payload := event.Payload.(map[string]any)
	request := agents.UserInputRequest{
		SessionID: r.sessionID, RequestID: stringFromMap(payload, "request_id"),
		Provider: "codex", ProviderEventType: "item/completed", Delivery: "async",
		ThreadID: stringFromMap(payload, "thread_id"), TurnID: stringFromMap(payload, "turn_id"),
		ItemID: stringFromMap(payload, "item_id"), Questions: payload["questions"].([]agents.UserInputQuestion),
	}
	broker, ok := r.userInput.(agents.AsyncUserInputBroker)
	if !ok {
		return errors.New("Gorchestra cannot answer asynchronous Codex questions")
	}
	waiter, err := broker.OpenAsyncUserInput(ctx, request, func(answerCtx context.Context, response agents.UserInputResponse) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return r.steerAnswer(answerCtx, request, response)
	})
	if err != nil {
		return err
	}
	r.asyncInput.waiters = append(r.asyncInput.waiters, waiter)
	return nil
}

func (r *appServerRun) steerAnswer(ctx context.Context, request agents.UserInputRequest, response agents.UserInputResponse) error {
	var text strings.Builder
	text.WriteString("Answers to your questions:\n")
	for _, question := range request.Questions {
		answer := response.Answers[question.ID].Answers
		if len(answer) != 1 || strings.TrimSpace(answer[0]) == "" {
			return errors.New("missing question answer")
		}
		fmt.Fprintf(&text, "\n%s\n%s\n", question.Question, answer[0])
	}
	return r.steerInput(ctx, request.ThreadID, request.TurnID, agents.SteeringInput{Message: text.String()})
}

func (r *appServerRun) steerInput(ctx context.Context, threadID, turnID string, input agents.SteeringInput) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	state := &r.asyncInput
	state.mu.Lock()
	if state.closed {
		state.mu.Unlock()
		return errors.New("the question's run has ended")
	}
	// Hold the registration lock over the write: a very fast acknowledgement must
	// not arrive before its response channel is registered.
	id, err := r.rpc.sendRequest("turn/steer", map[string]any{
		"threadId": threadID, "expectedTurnId": turnID,
		"input": userInputItems(input.Message, input.Attachments, input.Skills),
	})
	if err != nil {
		state.mu.Unlock()
		return err
	}
	result := make(chan error, 1)
	state.responses[id] = asyncAnswerResponse{turnID: turnID, result: result}
	state.mu.Unlock()
	defer func() {
		state.mu.Lock()
		delete(state.responses, id)
		state.mu.Unlock()
	}()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-state.done:
		// A terminal notification can immediately follow an accepted steer.
		select {
		case err := <-result:
			return err
		default:
		}
		return errors.New("the question's run ended before answer delivery was confirmed")
	}
}

func (r *appServerRun) resolveAsyncAnswer(message *rpcMessage) bool {
	state := &r.asyncInput
	state.mu.Lock()
	defer state.mu.Unlock()
	result, ok := state.responses[message.idKey()]
	if !ok {
		return false
	}
	delete(state.responses, message.idKey())
	var err error
	if message.Error != nil {
		err = fmt.Errorf("Codex rejected the answer: %s", message.Error.Message)
	} else if stringAt(message.Result, "turnId") != result.turnID {
		err = errors.New("Codex did not confirm the answer's turn")
	}
	result.result <- err
	return true
}

func (r *appServerRun) closeAsyncInput() {
	state := &r.asyncInput
	state.mu.Lock()
	if !state.closed {
		state.closed = true
		if state.done != nil {
			close(state.done)
		}
	}
	state.mu.Unlock()
	for _, waiter := range state.waiters {
		waiter.Close()
	}
	state.waiters = nil
}
