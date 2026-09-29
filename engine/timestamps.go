package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// routerLocation resolves the timezone the way busybox date(1) does: /etc/TZ
// holds a POSIX TZ string ("MSK-3") and the TZ environment variable is often
// unset. Go would otherwise fall back to UTC, and the merged log - which mixes
// these lines with the backend's date(1) lines - would show the same event three
// hours apart.
func routerLocation() *time.Location {
	if tz := os.Getenv("TZ"); tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			return loc
		}
		if loc, err := time.LoadLocation(":" + tz); err == nil {
			return loc
		}
	}
	// /etc/TZ is the OpenWrt convention; read it directly rather than relying on
	// the embedded tzdata, which a minimal firmware may not carry.
	if b, err := os.ReadFile("/etc/TZ"); err == nil {
		spec := strings.TrimSpace(string(b))
		if spec != "" {
			// A POSIX spec such as "MSK-3" is offsets-only; parse the common
			// "ABBR<sign><hours>" form ourselves.
			if loc := posixFixedZone(spec); loc != nil {
				return loc
			}
			if loc, err := time.LoadLocation(spec); err == nil {
				return loc
			}
		}
	}
	return time.Local
}

// posixFixedZone parses the fixed-offset subset of POSIX TZ strings that
// OpenWrt writes, e.g. "MSK-3" (UTC+3), "<+05>-5" (UTC+5) or "UTC0".
//
// POSIX puts the sign the opposite way from what it reads as: the number is what
// you add to local time to reach UTC, so "MSK-3" means local = UTC+3.
// FixedZone wants an east-positive offset, so the parsed value is used as-is
// after "-" and negated after "+". Getting this backwards put the engine hours
// away from the backend rather than aligned with it.
func posixFixedZone(spec string) *time.Location {
	// A quoted name ("<+05>") may contain digits and signs of its own, so it is
	// skipped whole; scanning for the first digit would otherwise read the "+05"
	// inside the name as the offset.
	i := 0
	if strings.HasPrefix(spec, "<") {
		end := strings.Index(spec, ">")
		if end < 0 {
			return nil
		}
		i = end + 1
	} else {
		for i < len(spec) && (spec[i] < '0' || spec[i] > '9') && spec[i] != '+' && spec[i] != '-' {
			i++
		}
	}
	name, rest := spec[:i], spec[i:]
	if rest == "" {
		return nil
	}

	// FixedZone wants an east-positive offset while POSIX stores the value you
	// add to local time to reach UTC, so the sign flips: "MSK-3" is UTC+3 and a
	// bare "EST5" is UTC-5.
	sign := -1
	if rest[0] == '+' {
		rest = rest[1:]
	} else if rest[0] == '-' {
		sign, rest = 1, rest[1:]
	}

	// Digits only up to the next letter: a DST suffix such as the "MSD" in
	// "MSK-3MSD" describes a rule this fixed-offset parser does not implement.
	digits := 0
	for digits < len(rest) && rest[digits] >= '0' && rest[digits] <= '9' {
		digits++
	}
	if digits == 0 {
		return nil
	}
	hours, err := strconv.Atoi(rest[:digits])
	if err != nil {
		return nil
	}
	return time.FixedZone(name, sign*hours*3600)
}

// The LuCI page merges this engine's stderr with the backend's own log into one
// chronological view, so every line needs a timestamp. Doing it by wrapping the
// writer, rather than editing each call site, means every existing and future
// Fprintln gets it for free.
//
// The format matches the backend's (`2006-01-02 15:04:05`) so the merged log
// sorts and reads as a single stream. The `engine` tag distinguishes the source
// from the backend's `rpcd` lines at a glance.
type timestampWriter struct {
	mu  sync.Mutex
	dst io.Writer
	buf bytes.Buffer
	loc *time.Location
}

func newTimestampWriter(dst io.Writer) *timestampWriter {
	return &timestampWriter{dst: dst, loc: routerLocation()}
}

func (w *timestampWriter) stamp() string {
	return time.Now().In(w.loc).Format("2006-01-02 15:04:05")
}

func (w *timestampWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	// Lines arrive in pieces, so hold a partial line until its newline shows up.
	w.buf.Write(p)
	total := len(p)

	for {
		line, err := w.buf.ReadString('\n')
		if err != nil {
			// No newline yet: keep the remnant for the next call.
			w.buf.Reset()
			w.buf.WriteString(line)
			return total, nil
		}
		if _, err := fmt.Fprintf(w.dst, "%s  engine  %s", w.stamp(), line); err != nil {
			return total, err
		}
	}
}

// Flush writes any trailing line that never got a newline.
func (w *timestampWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.buf.Len() == 0 {
		return
	}
	fmt.Fprintf(w.dst, "%s  engine  %s\n", w.stamp(), w.buf.String())
	w.buf.Reset()
}

// enableTimestamps redirects os.Stderr through the writer and returns a flush
// function. Called once from main, before anything writes.
func enableTimestamps() func() {
	real := os.Stderr
	w := newTimestampWriter(real)

	// os.Stderr is an *os.File and several call sites print to it directly, so
	// it is replaced rather than only re-pointing the fmt helpers.
	r, pipeW, err := os.Pipe()
	if err != nil {
		// Without a pipe the timestamps are lost, but the program still works.
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(w, r)
	}()
	os.Stderr = pipeW

	return func() {
		w.Flush()
		_ = pipeW.Close()
		<-done
		r.Close()
	}
}
