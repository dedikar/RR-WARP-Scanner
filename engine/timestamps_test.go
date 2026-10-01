package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// The merged log puts engine lines next to backend lines that busybox date(1)
// produced, so the offset must match what the router's /etc/TZ actually means.
// Getting the POSIX sign backwards misaligned them by twice the offset - six
// hours instead of three on MSK-3 - which is exactly what happened once.
func TestPosixFixedZoneMatchesRouterTZ(t *testing.T) {
	cases := []struct {
		spec       string
		wantOffset int // seconds east of UTC
	}{
		{"MSK-3", 3 * 3600},    // Moscow: local = UTC+3
		{"UTC0", 0},            // no offset
		{"CET-1", 1 * 3600},    // local = UTC+1
		{"EST5", -5 * 3600},    // west of Greenwich
		{"MSK-3MSD", 3 * 3600}, // DST suffix: the base offset still applies
		// A quoted name carries digits and signs of its own; OpenWrt writes this
		// form for zones without an abbreviation, e.g. Asia/Yekaterinburg.
		{"<+05>-5", 5 * 3600},
		{"<-03>3", -3 * 3600},
	}
	for _, c := range cases {
		loc := posixFixedZone(c.spec)
		if loc == nil {
			t.Errorf("posixFixedZone(%q) = nil, want a location", c.spec)
			continue
		}
		_, got := time.Now().In(loc).Zone()
		if got != c.wantOffset {
			t.Errorf("posixFixedZone(%q) offset = %d, want %d", c.spec, got, c.wantOffset)
		}
	}
}

// The last line of a run - the failure verdict, most often - ends the process
// and may arrive without a newline. Losing it meant the registration log ended
// without its cause. Flush must drain the pipe, stamp and write the trailing
// partial line, and leave no empty "engine" line behind.
func TestFlushDrainsTrailingPartialLine(t *testing.T) {
	tmp, err := os.CreateTemp(t.TempDir(), "stderr")
	if err != nil {
		t.Fatal(err)
	}
	defer tmp.Close()

	real := os.Stderr
	os.Stderr = tmp
	defer func() { os.Stderr = real }()

	flush := enableTimestamps()
	fmt.Fprintln(os.Stderr, "first line")
	fmt.Fprint(os.Stderr, "final verdict without newline")
	flush()

	data, err := os.ReadFile(tmp.Name())
	if err != nil {
		t.Fatal(err)
	}
	out := string(data)
	if !strings.Contains(out, "first line") {
		t.Errorf("lost the newline-terminated line:\n%s", out)
	}
	if !strings.Contains(out, "final verdict without newline") {
		t.Errorf("lost the trailing partial line:\n%s", out)
	}
	for _, ln := range strings.Split(out, "\n") {
		if strings.HasPrefix(ln, "2") && strings.HasSuffix(ln, "engine  ") {
			t.Errorf("flush emitted an empty engine line: %q", ln)
		}
	}
}
