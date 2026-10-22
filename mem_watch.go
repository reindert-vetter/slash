package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	httppprof "net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	runtimedebug "runtime/debug"
	"runtime/pprof"
	"strings"
	"sync"
	"syscall"
	"time"
)

// This file answers "why did the server die with a bare `signal: killed`?".
// A SIGKILL leaves nothing in server.log, and the usual sender is macOS's
// jetsam killing the largest process under memory pressure. So the server
//   - sets a soft Go memory limit (the GC works harder before the OS steps in),
//   - logs its own memory/goroutine/fd numbers periodically,
//   - writes a heap profile to <dataDir>/heap-profiles/ when the heap is huge
//     (removed again by the settings page's "Log wissen", see
//     removeHeapProfiles), and
//   - keeps a lock file so the next start can say "previous run did not exit
//     cleanly" together with the last heap size it saw.
// Purely operational: nothing here is a source of truth.

const (
	memSoftLimitBytes   = 3 << 30
	memWatchEvery       = 5 * time.Second
	memProfileThreshold = 2 << 30
	// memEmergencyBytes: above this the process writes a profile, logs and exits
	// rather than letting a runaway allocation swap the whole Mac to death and end
	// in a SIGKILL (measured: one request reached 96 GB within one 30 s tick).
	memEmergencyBytes  = 8 << 30
	memProfileMinGap   = 10 * time.Minute
	memProfileKeep     = 5
	heapProfileDirName = "heap-profiles"
	runLockFileName    = "server.lock"
)

func heapProfileDir(dataDir string) string { return filepath.Join(dataDir, heapProfileDirName) }

// startMemWatch applies the soft limit, reports on a previous unclean exit,
// and starts the sampler. Safe to call once from runServe.
func startMemWatch(dataDir string) {
	if os.Getenv("GOMEMLIMIT") == "" {
		runtimedebug.SetMemoryLimit(memSoftLimitBytes)
	}
	if msg := checkPreviousRun(dataDir, os.Getpid(), time.Now()); msg != "" {
		log.Print(msg)
	}
	// A normal Ctrl-C/kill must not look like a SIGKILL next time.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	go func() {
		s := <-sigs
		removeRunLock(dataDir)
		log.Printf("received %v, exiting", s)
		os.Exit(0)
	}()
	go func() {
		var lastProfile time.Time
		t := time.NewTicker(memWatchEvery)
		defer t.Stop()
		for now := range t.C {
			var ms runtime.MemStats
			runtime.ReadMemStats(&ms)
			line := memLine(&ms)
			if ms.HeapAlloc > memEmergencyBytes {
				p, err := writeHeapProfile(dataDir, now)
				log.Printf("mem_watch: EMERGENCY heap=%dMB > %dMB, exiting (profile %s, err %v): %s",
					ms.HeapAlloc>>20, memEmergencyBytes>>20, p, err, line)
				removeRunLock(dataDir)
				os.Exit(1)
			}
			writeRunLock(dataDir, os.Getpid(), now, line)
			if ms.HeapAlloc > memProfileThreshold {
				log.Printf("mem_watch: HEAP LARGE %s", line)
				if now.Sub(lastProfile) >= memProfileMinGap {
					lastProfile = now
					if p, err := writeHeapProfile(dataDir, now); err != nil {
						log.Printf("mem_watch: heap profile: %v", err)
					} else {
						log.Printf("mem_watch: heap profile written to %s", p)
					}
				}
			} else if ms.HeapAlloc > 512<<20 {
				log.Printf("mem_watch: %s", line)
			}
		}
	}()
}

func memLine(ms *runtime.MemStats) string {
	return fmt.Sprintf("heap=%dMB sys=%dMB goroutines=%d fds=%d gc=%d",
		ms.HeapAlloc>>20, ms.Sys>>20, runtime.NumGoroutine(), countOpenFDs(), ms.NumGC)
}

var fdCountErrOnce sync.Once

func countOpenFDs() int {
	entries, err := os.ReadDir("/dev/fd")
	if err != nil {
		fdCountErrOnce.Do(func() { log.Printf("mem_watch: fd count: %v", err) })
		return -1
	}
	return len(entries)
}

// writeRunLock records pid + time + the latest memory line. Removed on a clean
// shutdown (removeRunLock); whatever is left at the next start is the trail of
// a run that was killed.
func writeRunLock(dataDir string, pid int, now time.Time, line string) {
	body := fmt.Sprintf("%d\n%s\n%s\n", pid, now.Format(time.RFC3339), line)
	_ = os.WriteFile(filepath.Join(dataDir, runLockFileName), []byte(body), 0o644)
}

func removeRunLock(dataDir string) { _ = os.Remove(filepath.Join(dataDir, runLockFileName)) }

// checkPreviousRun returns a log message when a lock file from an earlier
// process is still there ("" otherwise), then claims the lock for pid.
func checkPreviousRun(dataDir string, pid int, now time.Time) string {
	path := filepath.Join(dataDir, runLockFileName)
	var msg string
	if raw, err := os.ReadFile(path); err == nil {
		parts := strings.SplitN(strings.TrimSpace(string(raw)), "\n", 3)
		for len(parts) < 3 {
			parts = append(parts, "?")
		}
		if parts[0] == fmt.Sprint(pid) {
			// Same pid: self_update's syscall.Exec restart, not a kill.
			writeRunLock(dataDir, pid, now, "starting")
			return ""
		}
		msg = fmt.Sprintf("mem_watch: previous run (pid %s) did not exit cleanly (SIGKILL/jetsam/crash?); last sample at %s: %s",
			parts[0], parts[1], parts[2])
	}
	writeRunLock(dataDir, pid, now, "starting")
	return msg
}

func writeHeapProfile(dataDir string, now time.Time) (string, error) {
	dir := heapProfileDir(dataDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	// Keep only the newest few so a long session cannot fill the disk.
	if entries, err := os.ReadDir(dir); err == nil && len(entries) >= memProfileKeep {
		for _, e := range entries[:len(entries)-memProfileKeep+1] {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
	path := filepath.Join(dir, "heap-"+now.Format("20060102-150405")+".pprof")
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	return path, pprof.WriteHeapProfile(f)
}

// removeHeapProfiles deletes every heap profile; called ONLY from the
// debug_log workflow's "clearDebugLog" Activity (write boundary).
func removeHeapProfiles(dataDir string) error {
	if dataDir == "" {
		return nil
	}
	err := os.RemoveAll(heapProfileDir(dataDir))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// servePprofIfEnabled exposes net/http/pprof on loopback when SLASH_PPROF is
// set to an address (e.g. 127.0.0.1:6060). Opt-in, read-only diagnostics.
func servePprofIfEnabled() {
	addr := os.Getenv("SLASH_PPROF")
	if addr == "" {
		return
	}
	if host, _, err := net.SplitHostPort(addr); err != nil || (host != "127.0.0.1" && host != "localhost") {
		log.Printf("mem_watch: SLASH_PPROF must be a loopback host:port, got %q", addr)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", httppprof.Index)
	go func() { log.Printf("mem_watch: pprof: %v", http.ListenAndServe(addr, mux)) }()
}
