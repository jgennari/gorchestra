package scheduler

import (
	"fmt"
	"strings"
	"time"

	cron "github.com/robfig/cron/v3"
)

type Cadence struct {
	Kind       string   `json:"kind"`
	Every      int      `json:"every,omitempty"`
	Unit       string   `json:"unit,omitempty"`
	Time       string   `json:"time,omitempty"`
	Weekdays   []string `json:"weekdays,omitempty"`
	Expression string   `json:"expression,omitempty"`
}

var weekdayNumbers = map[string]string{
	"sun": "0", "mon": "1", "tue": "2", "wed": "3", "thu": "4", "fri": "5", "sat": "6",
}

func ValidateCadence(c Cadence, timezone string) error {
	_, err := Next(c, timezone, time.Now())
	return err
}

func Next(c Cadence, timezone string, after time.Time) (time.Time, error) {
	location, err := time.LoadLocation(strings.TrimSpace(timezone))
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid timezone")
	}
	switch strings.TrimSpace(c.Kind) {
	case "interval":
		if c.Every < 1 {
			return time.Time{}, fmt.Errorf("interval must be at least one")
		}
		var unit time.Duration
		switch c.Unit {
		case "minutes":
			unit = time.Minute
		case "hours":
			unit = time.Hour
		case "days":
			unit = 24 * time.Hour
		default:
			return time.Time{}, fmt.Errorf("interval unit must be minutes, hours, or days")
		}
		return after.Add(time.Duration(c.Every) * unit).UTC(), nil
	case "daily":
		hour, minute, err := parseWallTime(c.Time)
		if err != nil {
			return time.Time{}, err
		}
		return parseCron(fmt.Sprintf("%d %d * * *", minute, hour), location, after)
	case "weekly":
		hour, minute, err := parseWallTime(c.Time)
		if err != nil {
			return time.Time{}, err
		}
		if len(c.Weekdays) == 0 {
			return time.Time{}, fmt.Errorf("at least one weekday is required")
		}
		days := make([]string, 0, len(c.Weekdays))
		seen := map[string]bool{}
		for _, day := range c.Weekdays {
			number, ok := weekdayNumbers[strings.ToLower(strings.TrimSpace(day))]
			if !ok {
				return time.Time{}, fmt.Errorf("invalid weekday %q", day)
			}
			if !seen[number] {
				days = append(days, number)
				seen[number] = true
			}
		}
		return parseCron(fmt.Sprintf("%d %d * * %s", minute, hour, strings.Join(days, ",")), location, after)
	case "cron":
		expression := strings.TrimSpace(c.Expression)
		if strings.HasPrefix(expression, "TZ=") || strings.HasPrefix(expression, "CRON_TZ=") {
			return time.Time{}, fmt.Errorf("set timezone separately")
		}
		return parseCron(expression, location, after)
	default:
		return time.Time{}, fmt.Errorf("cadence kind must be interval, daily, weekly, or cron")
	}
}

func parseCron(expression string, location *time.Location, after time.Time) (time.Time, error) {
	parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
	schedule, err := parser.Parse(expression)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid cron expression: %w", err)
	}
	next := schedule.Next(after.In(location))
	if next.IsZero() {
		return time.Time{}, fmt.Errorf("cron expression has no future occurrence")
	}
	return next.UTC(), nil
}

func parseWallTime(value string) (int, int, error) {
	parsed, err := time.Parse("15:04", strings.TrimSpace(value))
	if err != nil {
		return 0, 0, fmt.Errorf("time must use HH:MM")
	}
	return parsed.Hour(), parsed.Minute(), nil
}
