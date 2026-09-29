package main

import (
	"fmt"
	"os"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
)

// Progress file for the LuCI front end.
//
// The page cannot stream stdout: it polls over ubus while the scan runs, and it
// tears the rpc request down after ~20s. So the scan writes a single small file
// the backend reads on every poll, the same way the shell engine wrote
// /tmp/wscan/progress. Format, one line, rewritten whole each time:
//
//	phase1:<scanned>:<total>      port discovery
//	phase2:<scanned>:<total>      tunnel verification
//	done
//
// Writes are atomic (tmp + rename) so a poll never reads a half-written line.
type progressWriter struct {
	path string
	mu   sync.Mutex
}

func newProgressWriter(path string) *progressWriter {
	if path == "" {
		return nil
	}
	p := &progressWriter{path: path}
	return p
}

func (p *progressWriter) set(label string, done, total int) {
	if p == nil {
		return
	}
	p.write(fmt.Sprintf("%s:%d:%d", label, done, total))
}

func (p *progressWriter) done() {
	if p == nil {
		return
	}
	p.write("done")
}

func (p *progressWriter) write(line string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	tmp := p.path + ".tmp"
	if err := os.WriteFile(tmp, []byte(line+"\n"), 0644); err != nil {
		return
	}
	_ = os.Rename(tmp, p.path)
}

// emitProgress mirrors the scan's emit stream into the progress file, so the UI
// gets a live percentage without the backend having to parse stderr.
type progressEmitter struct {
	pw    *progressWriter
	inner emitter
	total int
	done  int
	label string
	mu    sync.Mutex
}

func wrapEmitter(pw *progressWriter, inner emitter) emitter {
	if pw == nil {
		return inner
	}
	pe := &progressEmitter{pw: pw, inner: inner}
	return pe.emit
}

func (pe *progressEmitter) emit(msg tea.Msg) {
	if pe.inner != nil {
		pe.inner(msg)
	}
	pe.mu.Lock()
	defer pe.mu.Unlock()
	switch m := msg.(type) {
	case stepMsg:
		// Phase 1 (port discovery) reports as a step; give the UI something to
		// show while it runs, since it has no item count.
		if !m.done && !m.fail {
			pe.label = "phase1"
			pe.done, pe.total = 0, 0
			pe.pw.set(pe.label, pe.done, pe.total)
		}
	case barBeginMsg:
		pe.label = "phase2"
		pe.total = m.total
		pe.done = 0
		pe.pw.set(pe.label, pe.done, pe.total)
	case probedMsg:
		pe.done++
		pe.pw.set(pe.label, pe.done, pe.total)
	case doneMsg:
		pe.pw.done()
	}
}
