//go:build darwin || linux

package hosting

import (
	"errors"
	"os/exec"
	"syscall"
)

func processRuntimeSupported() bool { return true }

func signalProcessGroup(cmd *exec.Cmd, signal syscall.Signal) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	err := syscall.Kill(-cmd.Process.Pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
