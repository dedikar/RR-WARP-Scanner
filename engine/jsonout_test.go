package main

import (
	"bytes"
	"encoding/json"
	"net/netip"
	"testing"
	"time"
)

// The JSON report is a contract with the LuCI backend (luci.rrws reads these
// exact field names), so the shape is pinned here rather than left to chance.

func TestJSONFromPhaseReportsCounts(t *testing.T) {
	mk := func(ok, tgOK, torn bool) endpointResult {
		return endpointResult{
			ok:       ok,
			durable:  !torn,
			tgSeen:   true,
			tgOK:     tgOK,
			tgDCs:    allDCs,
			endpoint: "1.2.3.4:2408",
			ip:       netip.MustParseAddr("1.2.3.4"),
			epPing:   40 * time.Millisecond,
			tunPing:  45 * time.Millisecond,
			measured: true,
		}
	}
	ph := phaseResult{results: []endpointResult{
		mk(true, true, false),
		mk(true, false, false),
		mk(true, false, true),
		mk(false, false, false), // not ok: must not be counted at all
	}}

	rep := jsonFromPhase(ph)

	if rep.Working != 3 {
		t.Errorf("working = %d, want 3 (only ok results count)", rep.Working)
	}
	if rep.Probed != 4 {
		t.Errorf("probed = %d, want 4 (every result is probed)", rep.Probed)
	}
	if rep.TGOK != 1 {
		t.Errorf("tg_working = %d, want 1", rep.TGOK)
	}
	if len(rep.Endpoints) != 3 {
		t.Fatalf("endpoints = %d, want 3", len(rep.Endpoints))
	}
	if rep.TGTotal != len(telegramDCs) {
		t.Errorf("tg_total = %d, want %d", rep.TGTotal, len(telegramDCs))
	}
	if rep.Endpoints[2].Torn != true {
		t.Error("third endpoint should be torn")
	}
	if rep.Endpoints[0].TGDCs != len(telegramDCs) {
		t.Errorf("tg_dcs = %d, want %d", rep.Endpoints[0].TGDCs, len(telegramDCs))
	}
}

func TestJSONFieldNamesAreStable(t *testing.T) {
	// The backend matches on these keys; a rename would silently blank the UI.
	rep := jsonFromPhase(phaseResult{results: []endpointResult{{
		ok: true, endpoint: "9.9.9.9:2408", ip: netip.MustParseAddr("9.9.9.9"),
	}}})
	var buf bytes.Buffer
	if err := writeJSON(&buf, rep); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}

	var raw map[string]any
	if err := json.Unmarshal(buf.Bytes(), &raw); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	for _, k := range []string{"working", "probed", "tg_working", "tg_total", "endpoints"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("missing top-level key %q", k)
		}
	}

	eps, ok := raw["endpoints"].([]any)
	if !ok || len(eps) != 1 {
		t.Fatalf("endpoints is not a 1-element array: %#v", raw["endpoints"])
	}
	first, ok := eps[0].(map[string]any)
	if !ok {
		t.Fatal("endpoint entry is not an object")
	}
	for _, k := range []string{
		"endpoint", "ip", "node", "country", "city", "ping_ms", "tun_ping_ms",
		"loss_pct", "torn", "tg_seen", "tg_ok", "tg_rtt_ms", "tg_dcs", "tg_total", "measured",
		"speed_mbps", "speed_measured",
	} {
		if _, ok := first[k]; !ok {
			t.Errorf("missing endpoint key %q", k)
		}
	}
}

func TestJSONEmptyResultIsStillValid(t *testing.T) {
	// "found nothing" must serialize as an empty array, never null: the UI calls
	// .length on it.
	rep := jsonFromPhase(phaseResult{})
	var buf bytes.Buffer
	if err := writeJSON(&buf, rep); err != nil {
		t.Fatalf("writeJSON: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte(`"endpoints": []`)) {
		t.Errorf("empty endpoints should serialize as [], got:\n%s", buf.String())
	}
	if rep.Working != 0 || rep.Probed != 0 {
		t.Errorf("empty phase should report zero counts, got working=%d probed=%d", rep.Working, rep.Probed)
	}
}

func TestJSONErrorCarriesMessage(t *testing.T) {
	var buf bytes.Buffer
	if err := writeJSONError(&buf, "no reachable WARP port"); err != nil {
		t.Fatalf("writeJSONError: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if got["error"] != "no reachable WARP port" {
		t.Errorf("error = %v, want the message", got["error"])
	}
	if eps, ok := got["endpoints"].([]any); !ok || len(eps) != 0 {
		t.Errorf("an error report should still carry an empty endpoints array, got %#v", got["endpoints"])
	}
}

func TestMsRoundsAndTreatsUnsetAsZero(t *testing.T) {
	// Unmeasured stays 0 so the UI can render "?" instead of "0 ms".
	cases := []struct {
		in   time.Duration
		want int64
	}{
		{0, 0},
		{-5 * time.Millisecond, 0},
		{time.Millisecond, 1},
		{1500 * time.Microsecond, 2}, // rounds to nearest
		{40499 * time.Microsecond, 40},
		{40500 * time.Microsecond, 41},
		{2 * time.Second, 2000},
	}
	for _, c := range cases {
		if got := ms(c.in); got != c.want {
			t.Errorf("ms(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

func TestPopcountMatchesDCBitmask(t *testing.T) {
	// tg_dcs is the count of Telegram DCs that answered, derived from a bitmask.
	for mask := uint8(0); mask < 32; mask++ {
		want := 0
		for i := 0; i < len(telegramDCs); i++ {
			if mask&(1<<i) != 0 {
				want++
			}
		}
		if got := popcount8(mask); got != want {
			t.Errorf("popcount8(%05b) = %d, want %d", mask, got, want)
		}
	}
	if got := popcount8(allDCs); got != len(telegramDCs) {
		t.Errorf("allDCs popcount = %d, want %d", got, len(telegramDCs))
	}
}

func TestJSONReflectsPartialTelegram(t *testing.T) {
	// A partial mask (some DCs blocked) must be reported as such: it means some
	// Telegram accounts cannot connect, which is the whole point of the column.
	partial := uint8(0)
	for i := 0; i < len(telegramDCs)-2; i++ {
		partial |= 1 << i
	}
	rep := jsonFromPhase(phaseResult{results: []endpointResult{{
		ok: true, tgSeen: true, tgOK: false, tgDCs: partial,
		endpoint: "1.1.1.1:2408", ip: netip.MustParseAddr("1.1.1.1"),
	}}})
	e := rep.Endpoints[0]
	if e.TGOK {
		t.Error("a partial mask must not be marked tg_ok")
	}
	if e.TGDCs != len(telegramDCs)-2 {
		t.Errorf("tg_dcs = %d, want %d", e.TGDCs, len(telegramDCs)-2)
	}
	if rep.TGOK != 0 {
		t.Errorf("tg_working = %d, want 0 for a partial endpoint", rep.TGOK)
	}
}
