package main

import (
	"encoding/json"
	"io"
	"time"
)

// Machine-readable output for the OpenWrt front end. The terminal tables in
// report.go are for humans; the LuCI page needs stable field names instead of
// fixed-width columns it would have to parse with a regex.

type jsonEndpoint struct {
	Endpoint  string `json:"endpoint"`
	IP        string `json:"ip"`
	Node      string `json:"node"`
	Country   string `json:"country"`
	City      string `json:"city"`
	PingMs    int64  `json:"ping_ms"`
	TunPingMs int64  `json:"tun_ping_ms"`
	LossPct   int    `json:"loss_pct"`
	// Download throughput measured inside the tunnel, in Mbit/s. Only filled
	// when the run asked for -speed; 0 means "not measured" rather than "zero
	// throughput", which is why speed_measured carries the distinction.
	SpeedMbps     float64 `json:"speed_mbps"`
	SpeedMeasured bool    `json:"speed_measured"`
	Torn          bool    `json:"torn"`
	TGSeen        bool    `json:"tg_seen"`
	TGOK          bool    `json:"tg_ok"`
	TGRTTMs       int64   `json:"tg_rtt_ms"`
	TGDCs         int     `json:"tg_dcs"`
	TGTotal       int     `json:"tg_total"`
	Measured      bool    `json:"measured"`
}

type jsonReport struct {
	Working   int            `json:"working"`
	Probed    int            `json:"probed"`
	TGOK      int            `json:"tg_working"`
	TGTotal   int            `json:"tg_total"`
	Error     string         `json:"error,omitempty"`
	Endpoints []jsonEndpoint `json:"endpoints"`
}

func jsonFromPhase(ph phaseResult) jsonReport {
	rep := jsonReport{
		Probed:    len(ph.results),
		Endpoints: make([]jsonEndpoint, 0, len(ph.results)),
	}
	if len(telegramDCs) > 0 {
		rep.TGTotal = len(telegramDCs)
	}
	for _, r := range ph.results {
		if !r.ok {
			continue
		}
		rep.Working++
		e := jsonEndpoint{
			Endpoint:  r.endpoint,
			IP:        r.ip.String(),
			Node:      r.exit.colo,
			Country:   r.exit.loc,
			City:      r.exit.coloCity,
			PingMs:    ms(r.epPing),
			TunPingMs: ms(r.tunPing),
			LossPct:   int(r.loss*100 + 0.5),
			// speed is only set by the -speed phase; leave it unmeasured
			// otherwise so the UI can tell "0 Mbit" from "not tested".
			SpeedMbps:     r.speed,
			SpeedMeasured: r.speed > 0,
			Torn:          !r.durable,
			TGSeen:        r.tgSeen,
			TGOK:          r.tgOK,
			TGRTTMs:       ms(r.tg),
			TGDCs:         popcount8(r.tgDCs),
			TGTotal:       len(telegramDCs),
			Measured:      r.measured,
		}
		if e.TGOK {
			rep.TGOK++
		}
		rep.Endpoints = append(rep.Endpoints, e)
	}
	return rep
}

// ms renders a duration as whole milliseconds; an unmeasured value stays 0,
// which the UI reads as "not sampled" rather than "instant".
func ms(d time.Duration) int64 {
	if d <= 0 {
		return 0
	}
	return int64(d.Round(time.Millisecond) / time.Millisecond)
}

func popcount8(v uint8) int {
	n := 0
	for v != 0 {
		n += int(v & 1)
		v >>= 1
	}
	return n
}

func writeJSON(w io.Writer, rep jsonReport) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(rep)
}

func writeJSONError(w io.Writer, msg string) error {
	return writeJSON(w, jsonReport{Error: msg, Endpoints: []jsonEndpoint{}})
}
