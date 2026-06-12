package store

import "errors"

var (
	ErrInvalidArgument = errors.New("store: invalid argument")
	ErrNotFound        = errors.New("store: not found")
)
