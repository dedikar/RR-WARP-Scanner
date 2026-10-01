package main

import (
	"fmt"
	"os"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
)

// Progress file for the LuCI front end, which polls over ubus and cannot
// stream stdout. One line, rewritten atomically (tmp + rename):
//
//	phase1:<scanned>:<total> | phase2:<scanned>:<total> | done
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
	// sawDone marks that a phase emitted its closing doneMsg. The next barBegin
	// after that is the speed phase, not a repeat of phase 2.
	sawDone bool
	mu      sync.Mutex
}

// newProgressEmitter builds the single emitter shared by every phase of one run.
func newProgressEmitter(pw *progressWriter) *progressEmitter {
	if pw == nil {
		return nil
	}
	return &progressEmitter{pw: pw}
}

// finish writes the terminal "done" marker. Called once, when the whole run is
// over - not per phase, because the scan's own end is followed by the speed
// phase and the UI must keep showing progress through it.
func (pe *progressEmitter) finish() {
	if pe == nil {
		return
	}
	pe.mu.Lock()
	defer pe.mu.Unlock()
	pe.pw.done()
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
		// The speed phase emits a barBegin after the scan's own; tell the two
		// apart by who started them.
		pe.total = m.total
		pe.done = 0
		if pe.sawDone {
			pe.label = "speed"
		} else {
			pe.label = "phase2"
		}
		pe.pw.set(pe.label, pe.done, pe.total)
	case probedMsg:
		pe.done++
		pe.pw.set(pe.label, pe.done, pe.total)
	case doneMsg:
		// A doneMsg ends the phase that was running, not necessarily the whole
		// run: the scan's own done arrives before the speed phase begins.
		pe.sawDone = true
		pe.pw.set(pe.label, pe.done, pe.total)
	}
}
