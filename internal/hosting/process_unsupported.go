//go:build !darwin && !linux

package hosting

import (
	"os/exec"
	"syscall"
)

func processRuntimeSupported() bool { return false }
func configureProcess(_ *exec.Cmd)  {}
func signalProcessGroup(_ *exec.Cmd, _ syscall.Signal) error {
	return ErrUnsupported
}
