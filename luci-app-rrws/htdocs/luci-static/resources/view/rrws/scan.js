'use strict';
'require view';
'require form';
'require rpc';
'require ui';
'require uci';
'require dom';

// RR WARP Scanner - LuCI front end for the /usr/bin/rrws engine.
//
// The page no longer parses fixed-width result lines: the engine emits JSON and
// this view renders it directly, which is what makes the Telegram column
// possible (the old 7-field parser could not carry an 8th field).

var XHR_RELOAD_GUARD_KEY = 'rrws:xhr-reload-at';
var XHR_RELOAD_GUARD_WINDOW_MS = 30000;

function isXhrError(e) {
	if (!e) return false;
	var s = String(e.message || e.statusText || e);
	return /XHR|timeout|network|abort/i.test(s);
}

function forceReloadAfterXhrError() {
	try {
		var last = parseInt(sessionStorage.getItem(XHR_RELOAD_GUARD_KEY) || '0', 10);
		if (Date.now() - last < XHR_RELOAD_GUARD_WINDOW_MS) return;
		sessionStorage.setItem(XHR_RELOAD_GUARD_KEY, String(Date.now()));
	} catch (e) { /* sessionStorage unavailable - reload anyway */ }
	window.location.replace(window.location.pathname + '?_rrws_xhr_reload=' + Date.now());
}

function declare(opts) {
	opts.nobatch = true;
	var fn = rpc.declare(opts);
	return function() {
		return fn.apply(null, arguments).then(function(res) { return res; },
			function(e) {
				if (isXhrError(e)) forceReloadAfterXhrError();
				throw e;
			});
	};
}

window.addEventListener('unhandledrejection', function(e) {
	if (e.reason && isXhrError(e.reason)) {
		e.preventDefault();
		forceReloadAfterXhrError();
	}
});

// ------------------------------------------------------------------- rpc ----

var callAccountStatus = declare({ object: 'luci.rrws', method: 'accountStatus', params: {}, reject: false });
var callDeviceCheck   = declare({ object: 'luci.rrws', method: 'deviceCheck', params: {}, reject: false });
var callConfBase      = declare({ object: 'luci.rrws', method: 'confBase', params: {}, reject: false });
var callVersion       = declare({ object: 'luci.rrws', method: 'version', params: {}, reject: false });
var callGetSettings   = declare({ object: 'luci.rrws', method: 'getSettings', params: {}, reject: false });
// Named saveOpts, not saveSettings: LuCI already owns a `saveSettings` on the rpc
// surface, and a backend method sharing that name never saw this page's calls.
//
// Called by posting JSON-RPC straight to /ubus with the page's session id rather
// than through L.rpc.call. On this build the framework wrapper answered 200 with
// an empty body and never reached rpcd, so every save looked successful and
// changed nothing; the direct POST is verified to work against the router.
// Monotonic request id. Date.now() was used before, and three pollers run at
// once (status every 2s, both logs every 3s), so two requests could leave in the
// same millisecond carrying the same id - JSON-RPC cannot tell such replies
// apart, and a caller could be handed the other one's answer.
var __rpcSeq = 0;

function ubusCall(object, method, params) {
	var sid = (L.env && L.env.sessionid) || '';
	return fetch('/ubus/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0', id: ++__rpcSeq,
			method: 'call', params: [sid, object, method, params || {}]
		})
	}).then(function(res) {
		return res.json();
	}).then(function(msg) {
		// ubus wraps the payload as [rc, data]; rc 0 means success.
		if (msg && msg.result) return msg.result[1];
		throw new Error('ubus ' + object + '.' + method + ' failed');
	});
}

function callSaveSettings(opts) {
	return ubusCall('luci.rrws', 'saveOpts', opts);
}
var callScanStart     = declare({ object: 'luci.rrws', method: 'scanStart', params: {}, reject: false });
var callScanStop      = declare({ object: 'luci.rrws', method: 'scanStop', params: {}, reject: false });
var callScanStatus    = declare({ object: 'luci.rrws', method: 'scanStatus', params: {}, reject: false });
var callScanResult    = declare({ object: 'luci.rrws', method: 'scanResult', params: {}, reject: false });
var callScanLog       = declare({ object: 'luci.rrws', method: 'scanLog', params: {}, reject: false });
var callScanLogClear  = declare({ object: 'luci.rrws', method: 'scanLogClear', params: {}, reject: false });
var callRegister      = declare({ object: 'luci.rrws', method: 'register', params: {}, reject: false });
var callRenewAccount  = declare({ object: 'luci.rrws', method: 'renewAccount', params: {}, reject: false });
var callDeleteAccount = declare({ object: 'luci.rrws', method: 'deleteAccount', params: {}, reject: false });
var callRegisterLog   = declare({ object: 'luci.rrws', method: 'registerLog', params: {}, reject: false });
var callApplyBest     = declare({ object: 'luci.rrws', method: 'applyBest', params: { iface: 'iface', endpoint: 'endpoint' }, reject: false });

var TG_TOTAL = 5;

// ---------------------------------------------------------------- helpers ---

// ------------------------------------------------------------- theming ---

// Panel styling for the whole page, injected once.
//
// The borders were hardcoded (#555 on #1a1a1a) and only looked right in the
// dark theme; on a light background the panels disappeared. These rules use the
// theme's own CSS variables with fallbacks, so the same markup works either way.
// Applied by class rather than inline styles so every section stays consistent
// and one edit changes all of them.
//
// LuCI themes do not style .cbi-section with a visible border, which is why the
// account and scan blocks looked like bare text while the filter blocks had
// frames - the frames were mine, added ad hoc. Now every block uses .rrws-panel.
var pageCssInjected = false;
function injectPageCss() {
	if (pageCssInjected) return;
	pageCssInjected = true;
	var css = [
		// Panels sit one theme step above the page background and carry a frame.
		//
		// The frame uses the theme's own border token, NOT a white overlay. A
		// near-opaque white frame (rgba(255,255,255,.85)) looked "foreign" against
		// this theme: measured on the router, the theme is nearly monochrome -
		// background high/medium/low are rgb(20,24,31) / (29,34,42) / (37,41,49),
		// steps of ~1.1:1 - and anything brighter than that band reads as a
		// different material rather than as part of the page. The sidebar looks
		// right for the same reason: it is built from these steps alone.
		'html .cbi-section.rrws-panel, html .rrws-panel {',
		'  border: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-radius: 6px;',
		'  padding: 12px 14px;',
		'  margin: 14px 0;',
		'  background: var(--background-color-medium, transparent);',
		'}',
		// On a light background the same token resolves the other way, so no
		// separate light-theme frame is needed.
		'.rrws-panel > h3:first-child {',
		'  margin-top: 0;',
		'  padding-bottom: 6px;',
		'  border-bottom: 1px solid var(--border-color-low, #e4e4e4);',
		'}',
		// The log pane and the checkbox lists sit inside a panel and need the
		// same treatment as the panel border, not the old fixed colours.
		'.rrws-panel pre {',
		'  background: var(--background-color-high, #111);',
		'  border: 1px solid var(--border-color-low, #e4e4e4);',
		'}',
		'.rrws-checklist {',
		'  border: 1px solid var(--border-color-medium, rgba(128,128,128,.5));',
		'  border-radius: 4px;',
		'}',
		// A clickable disclosure needs to look clickable: the log summary was
		// plain text and read as an empty area.
		'.rrws-disclosure > summary {',
		'  cursor: pointer;',
		'  padding: 6px 14px;',
		'  font-weight: 600;',
		'  border: 1px solid var(--border-color-medium, rgba(128,128,128,.5));',
		'  border-radius: 6px;',
		'  background: var(--background-color-low, transparent);',
		'  list-style: none;',
		// inline-flex, not flex: a block-level summary stretches to the full
		// width of the panel, so the button looked like a bar rather than a
		// button. inline-flex sizes it to its own label and triangle.
		'  display: inline-flex;',
		'  align-items: center;',
		'  gap: 8px;',
		'  user-select: none;',
		'}',
		'.rrws-disclosure > summary::-webkit-details-marker { display: none; }',
		// Triangle drawn from a border so it does not depend on a font glyph
		// being present on the router's browser.
		'.rrws-disclosure > summary::before {',
		'  content: "";',
		'  width: 0; height: 0;',
		'  border-left: 6px solid currentColor;',
		'  border-top: 5px solid transparent;',
		'  border-bottom: 5px solid transparent;',
		'  transition: transform .15s;',
		'}',
		'.rrws-disclosure[open] > summary::before { transform: rotate(90deg); }',
		'.rrws-disclosure[open] > summary { margin-bottom: 8px; }',
		'.rrws-disclosure[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }',
		// Result cards.
		//
		// These were an inline #2228 on the panel's own dark grey: two
		// near-identical greys stacked, so with hundreds of results the list read
		// as one undifferentiated slab. The first fix overcorrected with a white
		// overlay (rgba(255,255,255,.14)) that reached 1.55:1 - readable, but it
		// put the cards outside the theme's own tonal range and they looked like a
		// foreign material next to the sidebar.
		//
		// The theme's steps are close together by design (high/medium/low are
		// rgb(20,24,31) / (29,34,42) / (37,41,49), roughly 1.1:1 apart), so a card
		// cannot be separated by fill alone in either direction. It leans on the
		// 4px left stripe and a themed border for the edges, and takes
		// --background-color-low - the one step above its panel - so it belongs to
		// the palette while still being a distinguishable surface.
		'.rrws-card {',
		'  border-left: 4px solid var(--border-color-high, #444);',
		'  border-top: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-right: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-bottom: 1px solid var(--border-color-medium, rgba(128,128,128,.35));',
		'  border-radius: 4px;',
		'  padding: 8px 10px;',
		'  margin: 6px 0;',
		'  background: var(--background-color-low, rgba(255,255,255,.06));',
		'}',
		'.rrws-card-best { border-left-color: #16a34a; }',
		'.rrws-card-torn { border-left-color: #b91c1c; opacity: .65; }',
		// The metadata line follows the theme so it stays legible on whatever
		// surface the card got, instead of the fixed #aaa that assumed dark.
		//
		// 13px rather than 12: on a router page read at arm's length the endpoint
		// line is small enough already, and this is the line that carries the
		// facts being compared between rows (ping, tunnel, Telegram).
		'.rrws-card-meta { font-size: 13px; margin-top: 4px; color: var(--text-color-medium, #666); }',
		// The actions sit on the same line as the endpoint, pinned to the right edge
		// of the card. `flex: 0 0 auto` keeps them at their natural width so the
		// text column is the part that shrinks on a narrow screen.
		'.rrws-card-actions {',
		'  display: flex;',
		'  align-items: center;',
		'  gap: 6px;',
		'  flex: 0 0 auto;',
		'  margin: 0;',
		'}',
		// On a phone the one-row layout has no room: the text column shrinks until
		// every label wraps onto its own line, which is what the mobile screenshot
		// showed. Below this width the card stacks instead - data on top, actions
		// underneath - and the actions get their own full-width row.
		'@media (max-width: 700px) {',
		'  .rrws-card { flex-direction: column; align-items: stretch; }',
		'  .rrws-card-actions { justify-content: flex-start; margin-top: 8px; }',
		'  .rrws-card-actions > .btn { flex: 1 1 auto; }',
		// The endpoint line and the node summary both wrap on a phone; without this
		// the badges and node codes pile up with no separation.
		'  .rrws-card-meta { line-height: 1.6; }',
		// The label column in the settings blocks shrinks to a share of the row
		// instead of a fixed 230px, so the input keeps a usable width.
		'  .rrws-field-label { width: 40% !important; }',
		'}',
		'.rrws-field-label {',
		'  display: inline-block;',
		'  width: 230px;',
		'  color: var(--text-color-medium, #bbb);',
		'  vertical-align: top;',
		'}',
		// Sort keys, sitting between the summary and the cards.
		'.rrws-sortbar {',
		'  display: flex;',
		'  align-items: center;',
		'  gap: 6px;',
		'  flex-wrap: wrap;',
		'  margin: 4px 0 10px 0;',
		'}',
		'.rrws-sortbar-label {',
		'  font-size: 12px;',
		'  color: var(--text-color-medium, #888);',
		'  margin-right: 2px;',
		'}',
	].join('\n');

	var el = document.createElement('style');
	el.type = 'text/css';
	el.appendChild(document.createTextNode(css));
	document.head.appendChild(el);
}


var confData = null;
var versionText = '?';

// Rendered dropdown handles, keyed by purpose ('subnets', 'excludeNodes',
// 'includeNodes'). Filled in renderScan(), read in collectAndSave().
var dropdowns = {};

// A collapsible checkbox list: a <details> whose summary shows the current
// picks, containing one checkbox per choice.
//
// ui.Dropdown is deliberately NOT used here. On this LuCI build (24.10 /
// RouteRich, ui.js as shipped) it exposes no getValue()/getSelected(), stores
// its selection in a `selected` attribute that only its own trusted-pointer
// handler writes, and fires cbi-dropdown-change in a way that is awkward to
// drive programmatically. Two rounds of trying to read it back produced a UI
// that looked right while saving nothing. Plain checkboxes have one source of
// truth - el.checked - which cannot drift from what the user sees.
function mkCheckList(selected, choices, placeholder) {
	var keys = Object.keys(choices || {});
	if (!keys.length) return null;

	var sel = {};
	for (var i = 0; i < (selected || []).length; i++)
		sel[String(selected[i]).toUpperCase()] = true;

	var box = E('div', { class: 'rrws-checklist' });
	var summary = E('div', {
		style: 'padding:6px 10px;cursor:pointer;user-select:none;color:#8cf'
	});
	var list = E('div', {
		style: 'display:none;max-height:260px;overflow:auto;border-top:1px solid #555;padding:6px 10px'
	});

	var inputs = [];
	var updateSummary = function() {
		var picked = [];
		for (var j = 0; j < inputs.length; j++)
			if (inputs[j].checked) picked.push(inputs[j].value);
		summary.textContent = (picked.length ? picked.join(', ') : placeholder) +
			'  (' + picked.length + ') ▾';
	};

	for (var k = 0; k < keys.length; k++) {
		var cb = E('input', { type: 'checkbox', value: keys[k] });
		if (sel[keys[k]]) cb.checked = true;
		inputs.push(cb);
		var row = E('label', { style: 'display:block;padding:2px 0;cursor:pointer' });
		row.appendChild(cb);
		row.appendChild(document.createTextNode(' ' + keys[k]));
		list.appendChild(row);
	}

	summary.addEventListener('click', function() {
		list.style.display = (list.style.display === 'none') ? 'block' : 'none';
	});
	updateSummary();

	box.appendChild(summary);
	box.appendChild(list);
	// The change event must reach the page's persist() through the section, so a
	// plain bubbling listener is enough - unlike the widget's custom event.
	box.addEventListener('change', function() { updateSummary(); });

	return { node: box, inputs: inputs, updateSummary: updateSummary };
}

function checkListValues(cl) {
	if (!cl || !cl.inputs) return [];
	var out = [];
	for (var i = 0; i < cl.inputs.length; i++) {
		if (!cl.inputs[i].checked) continue;
		var v = String(cl.inputs[i].value).trim().toUpperCase();
		if (v) out.push(v);
	}
	return out;
}

function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// A checkbox with its caption. LuCI's E() honours only ONE child argument, so
// E('label', {}, box, 'text') drops both the box and the text. Module scope
// because several render methods need it (scan form and log controls).
function chkLabel(box, text) {
	var l = E('label', {});
	l.appendChild(box);
	l.appendChild(document.createTextNode(' ' + text));
	return l;
}

function copyText(txt, btn) {
	var done = function() {
		if (!btn) return;
		var old = btn.textContent;
		btn.textContent = 'Скопировано';
		setTimeout(function() { btn.textContent = old; }, 1500);
	};
	if (navigator.clipboard && window.isSecureContext) {
		navigator.clipboard.writeText(txt).then(done, function() { fallback(); });
	} else fallback();

	function fallback() {
		var ta = document.createElement('textarea');
		ta.value = txt;
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		try { document.execCommand('copy'); done(); } catch (e) {}
		document.body.removeChild(ta);
	}
}

// AmneziaWG client config for one found endpoint, built from confBase + account.
function makeConf(endpoint) {
	if (!confData) return '';
	var l = [];
	l.push('[Interface]');
	l.push('PrivateKey = ' + (confData.private_key || ''));
	l.push('Address = ' + (confData.address || '172.16.0.2/32'));
	l.push('DNS = ' + (confData.dns || '1.1.1.1, 1.0.0.1'));
	l.push('MTU = ' + (confData.mtu || '1280'));
	l.push('Jc = ' + (confData.jc || '6'));
	l.push('Jmin = ' + (confData.jmin || '10'));
	l.push('Jmax = ' + (confData.jmax || '50'));
	if (confData.i1) l.push('I1 = ' + confData.i1);
	l.push('');
	l.push('[Peer]');
	l.push('PublicKey = ' + (confData.peer_public_key || ''));
	l.push('Endpoint = ' + endpoint);
	l.push('AllowedIPs = ' + (confData.allowed_ips || '0.0.0.0/0'));
	l.push('PersistentKeepalive = ' + (confData.keepalive || '25'));
	// No trailing newline. It is harmless in a file, but this string is also
	// pasted into a textarea (zeroblock's interface field), where a dangling
	// blank line reads as a stray character and some paste paths keep it.
	return l.join('\n');
}

// Telegram badge: "5/5" is a full pass, "3/5" a partial (some accounts cannot
// connect - a DC an account lives on is not reachable), "blocked" none.
function tgBadge(r) {
	if (!r.tg_seen) return E('span', { style: 'color:#888' }, '—');
	if (r.tg_ok) {
		return E('span', {
			style: 'background:#16a34a;color:#fff;padding:1px 6px;border-radius:3px;font-weight:600',
			title: 'Все ' + (r.tg_total || TG_TOTAL) + ' дата-центров Telegram ответили'
		}, 'TG ' + (r.tg_dcs || 0) + '/' + (r.tg_total || TG_TOTAL));
	}
	if (r.tg_dcs > 0) {
		return E('span', {
			style: 'background:#b45309;color:#fff;padding:1px 6px;border-radius:3px',
			title: 'Отвечают не все ДЦ: часть аккаунтов Telegram не подключится'
		}, 'TG ' + r.tg_dcs + '/' + (r.tg_total || TG_TOTAL));
	}
	return E('span', {
		style: 'background:#b91c1c;color:#fff;padding:1px 6px;border-radius:3px',
		title: 'Ни один ДЦ Telegram не ответил через этот эндпоинт'
	}, 'TG blocked');
}

function pingText(v) {
	if (!v || v <= 0) return '?';
	return v + ' мс';
}

// Colour a latency value by how usable it is on this network.
//
// The thresholds come from the measurements in the README: on this router the
// good endpoints sit around 40-70 ms in-tunnel and Telegram round-trips land in
// the 400-600 ms range, which is normal for MTProto over WARP and not a fault.
// So the bands are set for "is this worth keeping", not for absolute quality:
// green is what the top of the list looks like, yellow is workable, red is the
// tail. They are deliberately generous - colouring half the list red would say
// nothing.
//
// Kept as a single place so the card and any future summary agree.
var PING_GOOD_MS = 80;
var PING_OK_MS = 150;

function pingColor(v) {
	if (!v || v <= 0) return null;
	if (v <= PING_GOOD_MS) return '#16a34a';
	if (v <= PING_OK_MS) return '#b45309';
	return '#dc2626';
}

// The node code (IATA) is the field people scan for, so it gets the same accent
// colour everywhere it appears - in a card and in the result summary.
var NODE_COLOR = '#eab308';

// Telegram gets its own, much higher bands. An MTProto round-trip through WARP is
// not comparable to an ICMP ping: 400-600 ms is the normal range here, so the
// ICMP thresholds would paint every row red and say nothing. These are set for
// "is this endpoint usable for Telegram at all", not for latency quality.
var TG_GOOD_MS = 400;
var TG_OK_MS = 1000;

function tgColor(v) {
	if (!v || v <= 0) return null;
	if (v <= TG_GOOD_MS) return '#16a34a';
	if (v <= TG_OK_MS) return '#b45309';
	return '#dc2626';
}

// Build "подпись значение" with only the value coloured.
//
// The colour belongs on the number, not on the word: colouring the whole pair
// turned the labels themselves green and yellow, so "пинг" and "в туннеле" read
// as the measured values and the row looked like it was highlighting the wrong
// thing.
function metric(label, value, color) {
	var frag = document.createDocumentFragment();
	frag.appendChild(document.createTextNode(label + ' '));
	frag.appendChild(E('span', {
		style: 'font-weight:600' + (color ? ';color:' + color : '')
	}, value));
	return frag;
}

function lossText(v) {
	if (v == null) return '?';
	return v + '%';
}

// -------------------------------------------------------------- the view ----

return view.extend({
	load: function() {
		return Promise.all([
			callAccountStatus(),
			callDeviceCheck(),
			callConfBase(),
			callVersion(),
			callGetSettings(),
			callScanResult(),
		]);
	},

	render: function(data) {
		var acct = data[0] || {};
		var dev = data[1] || {};
		var cs = data[3] || {};
		var self = this;

		injectPageCss();

		confData = data[2] || {};
		versionText = cs.version || '?';

		var s = data[4] || {};
		var res0 = data[5] || {};

		var wrap = E('div', { 'class': 'cbi-map' });

		// --- header (same shape as the previous package) -------------------
		// Title + version line, then the WARP account status row. The status
		// lives here rather than inside the account block so it is visible
		// before the (taller) account section.
		var headerEl = E('div', { style: 'margin-bottom:14px' });
		var appVerEl = E('code', { style: 'font-size:12px' }, versionText);
		var accStatusLabel = E('span', {
			'class': 'label',
			style: acct.registered
				? 'background:#16a34a;color:#fff;padding:2px 8px;border-radius:3px;font-weight:600'
				: 'background:#b91c1c;color:#fff;padding:2px 8px;border-radius:3px;font-weight:600'
		}, acct.registered ? 'ЗАРЕГИСТРИРОВАН' : 'НЕ ЗАРЕГИСТРИРОВАН');

		headerEl.appendChild(E('h2', {}, 'RR WARP Scanner'));
		var descr = E('div', { 'class': 'cbi-map-descr' },
			'Поиск рабочих Cloudflare WARP-эндпоинтов через userspace-движок AmneziaWG. Версия: ');
		descr.appendChild(appVerEl);
		headerEl.appendChild(descr);

		var statusRow = E('table', { 'class': 'table', style: 'margin-bottom:10px' });
		var statusTr = E('tr', { 'class': 'tr' });
		statusTr.appendChild(E('td', { 'class': 'td left', style: 'width:160px' }, 'Аккаунт WARP'));
		var statusTd = E('td', { 'class': 'td right' });
		statusTd.appendChild(accStatusLabel);
		statusTr.appendChild(statusTd);
		statusRow.appendChild(statusTr);
		headerEl.appendChild(statusRow);
		wrap.appendChild(headerEl);

		// --- account block and the vendor banner, side by side -------------
		// The banner is a single clickable tile (logo + "Информация") pointing at
		// the vendor page. It is shown ONLY when deviceCheck says the hardware is
		// not a RouteRich unit (no 24:0F:5E OUI), so on a real RouteRich router
		// this space stays empty.
		var headerRow = E('div', { style: 'display:flex;align-items:stretch;gap:14px;margin-bottom:14px;flex-wrap:wrap' });
		wrap.appendChild(headerRow);

		var deviceBanner = E('a', {
			'class': 'cbi-section',
			href: 'https://routerich.ru/qr',
			target: '_blank',
			rel: 'noopener',
			style: 'display:none;text-decoration:none;cursor:pointer;outline:none;border:1px solid #d9534f;border-radius:4px;padding:10px 12px;box-sizing:border-box;align-items:center;gap:6px'
		});
		deviceBanner.appendChild(E('img', {
			src: L.resource('rrws/logo.png'),
			style: 'width:40px;height:40px;object-fit:contain;flex-shrink:0'
		}));
		deviceBanner.appendChild(E('span', { style: 'color:#4a9eff;font-weight:600' }, 'Информация'));

		// Wide screens: a narrow column tile to the left of the account block.
		// Phones: full width, so it does not float alone above it.
		var narrow = function() {
			return (window.innerWidth || document.documentElement.clientWidth) < 700;
		};
		var layoutBanner = function() {
			if (!narrow()) {
				deviceBanner.style.flexDirection = 'column';
				deviceBanner.style.justifyContent = 'center';
				deviceBanner.style.flex = '0 0 132px';
				deviceBanner.style.width = '';
			} else {
				deviceBanner.style.flexDirection = 'row';
				deviceBanner.style.justifyContent = 'center';
				deviceBanner.style.flex = '1 1 100%';
				deviceBanner.style.width = '100%';
			}
		};
		headerRow.appendChild(deviceBanner);
		layoutBanner();
		var wasNarrow = narrow();
		window.addEventListener('resize', function() {
			var n = narrow();
			if (n !== wasNarrow) { wasNarrow = n; layoutBanner(); }
		});

		if (dev.authorized === false) {
			deviceBanner.style.display = 'flex';
			if (window.console) {
				console.log('[rrws] unsupported device (no ' + (dev.oui || '24:0F:5E') +
					' OUI): ' + JSON.stringify(dev.macs || {}));
			}
		}

		// --- account ------------------------------------------------------
		headerRow.appendChild(this.renderAccount(acct));

		// --- scan ---------------------------------------------------------
		wrap.appendChild(this.renderScan(s, res0));

		// --- log ----------------------------------------------------------
		wrap.appendChild(this.renderLog());

		// resume whatever was running before the page was opened
		window.setTimeout(function() { self.resumeScan(); }, 0);
		window.setTimeout(function() { self.startLogAutoRefresh(); }, 0);

		return wrap;
	},

	renderAccount: function(acct) {
		var self = this;
		// flex:1 so the block fills the row next to the vendor banner (which is
		// hidden on supported hardware, leaving this full width). min-width:0
		// stops long keys from forcing the row wider than the viewport.
		var sec = E('div', { 'class': 'cbi-section rrws-panel', style: 'flex:1 1 auto;min-width:0' });
		sec.appendChild(E('h3', {}, 'Аккаунт WARP'));

		if (acct.registered) {
			// Each cell is appended explicitly: E('tr', {}, td1, td2) silently
			// drops td2 (single-child rule), which is why the ID/Address/Key
			// values were missing from an otherwise correct-looking table.
			// `copy` adds a copy button beside the value; the ID and the private
			// key are what people paste into a client, so both get one.
			var cell = function(label, value, copy) {
				var tr = E('tr', {});
				tr.appendChild(E('td', { style: 'width:140px;color:#888;vertical-align:top' }, label));
				var td = E('td', {});
				var code = E('code', { style: 'word-break:break-all' }, value);
				if (copy && value) {
					var wrap = E('span', { style: 'display:inline-flex;align-items:center;gap:6px;max-width:100%' });
					wrap.appendChild(code);
					var btn = E('button', {
						'class': 'btn cbi-button',
						style: 'font-size:11px;padding:1px 6px;white-space:nowrap',
						title: 'Скопировать ' + label
					}, 'Копировать');
					btn.addEventListener('click', function() { copyText(value, btn); });
					wrap.appendChild(btn);
					td.appendChild(wrap);
				} else {
					td.appendChild(code);
				}
				tr.appendChild(td);
				return tr;
			};
			var tbl = E('table', { 'class': 'table' });
			tbl.appendChild(cell('ID', acct.id || '', true));
			tbl.appendChild(cell('Address', acct.address || '', false));
			tbl.appendChild(cell('PrivateKey', acct.private_key || '', true));
			sec.appendChild(tbl);
		}

		var btns = E('div', { style: 'margin-top:10px' });
		var regBtn = E('button', { 'class': 'btn cbi-button cbi-button-action' },
			acct.registered ? 'Перерегистрировать' : 'Зарегистрировать WARP');
		regBtn.addEventListener('click', function() {
			regBtn.disabled = true;
			regBtn.textContent = 'Регистрация...';
			// Clear the previous run's pane before the backend truncates its log,
			// so a stale failure from an earlier attempt is not read as this one.
			self.setRegLog('');
			if (self.regStatusEl) self.regStatusEl.textContent = 'Регистрация...';
			var p = acct.registered ? callRenewAccount() : callRegister();
			p.then(function(r) {
				if (r && r.error) {
					ui.addNotification(null, E('p', {}, r.error), 'error');
					regBtn.disabled = false;
					regBtn.textContent = acct.registered ? 'Перерегистрировать' : 'Зарегистрировать WARP';
					return;
				}
				self.pollRegistration(regBtn);
			}, function() {
				regBtn.disabled = false;
				regBtn.textContent = acct.registered ? 'Перерегистрировать' : 'Зарегистрировать WARP';
			});
		});
		btns.appendChild(regBtn);
		this.regBtn = regBtn;

		if (acct.registered) {
			var delBtn = E('button', { 'class': 'btn cbi-button cbi-button-remove', style: 'margin-left:8px' }, 'Удалить аккаунт');
			delBtn.addEventListener('click', function() {
				if (!confirm('Удалить аккаунт WARP? Скан без него работать не будет.')) return;
				callDeleteAccount().then(function() { window.location.reload(); });
			});
			btns.appendChild(delBtn);
			this.delBtn = delBtn;
		}
		sec.appendChild(btns);

		var regStatus = E('div', { style: 'margin-top:8px;color:var(--text-color-medium, #888)' });
		sec.appendChild(regStatus);
		this.regStatusEl = regStatus;

		// Registration takes up to three minutes and walks a chain: direct API,
		// then a relay, then a WARP tunnel with awg and wg attempts. Without this
		// pane the user watched a seconds counter and, on failure, got nothing but
		// "did not finish" - no way to tell a blocked API from a dead tunnel.
		var regLogWrap = E('div', { style: 'margin-top:8px;display:none' });
		var regLogHead = E('div', { style: 'font-size:12px;color:var(--text-color-medium, #888);margin-bottom:4px' },
			'Ход регистрации:');
		var regLogPre = E('pre', {
			style: 'white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;' +
				'font-size:11px;line-height:1.45;margin:0;padding:8px 10px'
		}, '');
		regLogWrap.appendChild(regLogHead);
		regLogWrap.appendChild(regLogPre);
		sec.appendChild(regLogWrap);
		this.regLogWrap = regLogWrap;
		this.regLogPre = regLogPre;
		return sec;
	},

	// Show the registration pane and keep it filled from the backend. Called on
	// start (so the wait has a reason) and on failure (so it has a cause).
	setRegLog: function(text) {
		if (!this.regLogWrap) return;
		if (text == null || !text.length) {
			this.regLogWrap.style.display = 'none';
			return;
		}
		this.regLogWrap.style.display = '';
		if (this.regLogPre) this.regLogPre.textContent = text;
	},

	// Fetch and display the current registration log. Returns the text so the
	// caller can decide whether it already contains a failure.
	refreshRegLog: function() {
		var self = this;
		return callRegisterLog().then(function(r) {
			self.setRegLog(r && r.log ? r.log : '');
			return (r && r.log) || '';
		}, function() { return ''; });
	},

	pollRegistration: function(btn) {
		var self = this;
		var tries = 0;
		var label = btn.textContent;
		var tick = function() {
			if (++tries > 90) {   // ~3 minutes
				// A timeout is not a cause: pull the log and show what the engine
				// actually said last, instead of hiding the reason behind a
				// generic message.
				self.refreshRegLog().then(function(text) {
					if (self.regStatusEl) {
						self.regStatusEl.textContent = text && text.length
							? 'Регистрация не завершилась — подробности ниже.'
							: 'Регистрация не завершилась, лог пуст.';
					}
					btn.disabled = false;
					btn.textContent = label;
				});
				return;
			}
			callAccountStatus().then(function(a) {
				if (a && a.registered && !a.registering) {
					if (self.regStatusEl) self.regStatusEl.textContent = 'Аккаунт готов.';
					window.location.reload();
					return;
				}
				// A registration can end without producing an account - the engine
				// exits non-zero and never writes one. accountStatus cannot tell
				// that apart from "still working", so the pidfile is the signal:
				// once nothing is running and no account appeared, it failed.
				self.refreshRegLog().then(function(text) {
					if (!a || !a.registering) {
						if (self.regStatusEl) {
							self.regStatusEl.textContent = text && text.length
								? 'Регистрация не удалась — причина в логе ниже.'
								: 'Регистрация не удалась, лог пуст.';
						}
						btn.disabled = false;
						btn.textContent = label;
						return;
					}
					if (self.regStatusEl) self.regStatusEl.textContent = 'Регистрация... (' + tries + ' с)';
					window.setTimeout(tick, 2000);
				});
			}, function() { window.setTimeout(tick, 2000); });
		};
		tick();
	},

	renderScan: function(s, res0) {
		var self = this;
		var sec = E('div', { 'class': 'cbi-section rrws-panel' });
		sec.appendChild(E('h3', {}, 'Сканирование эндпоинтов'));

		var f = function(label, node) {
			// LuCI's E() honours only ONE child argument; any extra arguments are
			// dropped silently. That is how the first version of this page ended
			// up rendering bare empty labels with no input beside them.
			//
			// The label width is a class, not an inline style: a fixed 230px label
			// on a 390px screen left the input a sliver and opened a wide gap
			// between the two, so the media query narrows this column on a phone.
			var row = E('div', { style: 'margin-bottom:8px' });
			row.appendChild(E('label', { 'class': 'rrws-field-label' }, label));
			if (node) row.appendChild(node);
			return row;
		};
		// A numeric field with REAL validation. min/max alone are only a browser
		// hint: they do not stop a typed value from being sent, and the backend
		// clamps silently, so the user would never learn their input was reduced.
		// Each field therefore gets an inline error and a visible range, and
		// startScan refuses to run while any is invalid.
		var invalidFields = [];
		var num = function(name, val, min, max, w, hint) {
			var row = E('div', { style: 'display:inline-block;vertical-align:top' });
			var inp = E('input', {
				type: 'number', name: name, value: val == null ? '' : val,
				min: min, max: max, step: 1,
				style: 'width:' + (w || 90) + 'px'
			});
			var err = E('div', {
				style: 'color:#e05a5a;font-size:11px;margin-top:2px;display:none;max-width:280px'
			});
			var note = E('div', { style: 'color:#777;font-size:11px;margin-top:2px' },
				hint || (min + '–' + max));
			row.appendChild(inp);
			row.appendChild(note);
			row.appendChild(err);

			var check = function() {
				var raw = String(inp.value).trim();
				var msg = '';
				if (raw === '') {
					msg = 'Укажите значение (' + min + '–' + max + ').';
				} else if (!/^-?\d+$/.test(raw)) {
					msg = 'Только целое число.';
				} else {
					var n = parseInt(raw, 10);
					if (n < min) msg = 'Минимум ' + min + '.';
					else if (n > max) msg = 'Максимум ' + max + '.';
				}
				if (msg) {
					inp.style.borderColor = '#e05a5a';
					inp.style.boxShadow = '0 0 0 1px #e05a5a';
					err.textContent = msg;
					err.style.display = 'block';
				} else {
					inp.style.borderColor = '';
					inp.style.boxShadow = '';
					err.style.display = 'none';
				}
				var i = invalidFields.indexOf(inp);
				if (msg && i < 0) invalidFields.push(inp);
				else if (!msg && i >= 0) invalidFields.splice(i, 1);
				if (self.startBtn) self.startBtn.disabled = invalidFields.length > 0;
			};
			// 'input' so the error clears as soon as the value becomes valid, and
			// so a user typing "999" sees the problem before pressing anything.
			inp.addEventListener('input', check);
			inp.addEventListener('change', check);
			window.setTimeout(check, 0);
			return row;
		};

		// --- core params --------------------------------------------------
		sec.appendChild(f('Хостов на подсеть', num('sample', s.sample, 1, 256, 90, 'адресов на каждую подсеть, 1–256; всего подсетей 14')));
		sec.appendChild(f('Таймаут (сек)', num('timeout', s.timeout, 1, 30, 70, 'ожидание handshake, 1–30')));
		sec.appendChild(f('Потоков', num('jobs', s.jobs, 1, 64, 70, 'параллельных туннелей, 1–64')));

		var protoSel = E('select', { name: 'proto' });
		[['awg', 'AmneziaWG (обфусцированный, рекомендуется)'],
		 ['wg', 'WireGuard (чистый, часто режется DPI)']].forEach(function(o) {
			var opt = E('option', { value: o[0] }, o[1]);
			if (s.proto === o[0]) opt.selected = true;
			protoSel.appendChild(opt);
		});
		sec.appendChild(f('Протокол', protoSel));

		var tgChk = E('input', { type: 'checkbox', name: 'tg' });
		if (s.tg) tgChk.checked = true;
		sec.appendChild(f('', chkLabel(tgChk, ' Проверять Telegram (MTProto по всем 5 ДЦ)')));

		var tpChk = E('input', { type: 'checkbox', name: 'tun_ping' });
		if (s.tun_ping) tpChk.checked = true;
		sec.appendChild(f('', chkLabel(tpChk, ' Измерять задержку и потери внутри туннеля (TUN PING / LOSS)')));

		var stChk = E('input', { type: 'checkbox', name: 'stable_only' });
		if (s.stable_only) stChk.checked = true;
		sec.appendChild(f('', chkLabel(stChk, ' Отображать только стабильные (без обрывов и потерь)')));

		// --- exclusions: checkbox dropdowns, not free-text IATA entry -------
		// Each pick-list is a native LuCI multi-select. The engine wants the three
		// filters separate: --target (subnets), --exclude-node and --node are
		// independent. Choosing from a list also removes the silent no-match of a
		// mistyped code, which the old free-text fields allowed.
		var mkChoices = function(list) {
			var c = {};
			for (var i = 0; i < list.length; i++) c[list[i]] = list[i];
			return c;
		};

		var addSection = function(title, hint, selected, choices, placeholder, items, key) {
			var wrap = E('div', { class: 'cbi-section rrws-panel' });
			wrap.appendChild(E('h3', {}, title));
			wrap.appendChild(E('p', { class: 'text-muted', style: 'margin:2px 0 8px 0' }, hint));
			var dd = mkCheckList(selected, choices, placeholder);
			if (dd) {
				wrap.appendChild(dd.node);
				// Bind ON THE WIDGET NODE, not on the wrapper: this LuCI build fires
				// cbi-dropdown-change without bubbles, so a listener on an ancestor
				// never sees it. A listener on the node itself always does.
				dd.node.addEventListener('change', function() { self.persist(); });
				dropdowns[key] = dd;
			}
			sec.appendChild(wrap);
		};

		addSection('Исключить подсети', 'Отмеченные подсети будут пропущены при сканировании.',
			s.exclude || [], mkChoices(s.subnets || []), 'Исключить подсети...', 3, 'subnets');

		addSection('Исключить узлы', 'Эндпоинты на отмеченных узлах будут убраны из результата. Код узла — IATA-код города, где стоит сервер Cloudflare: ARN — Стокгольм, FRA — Франкфурт, AMS — Амстердам, DME — Москва.',
			s.exclude_nodes || [], mkChoices(s.nodes || []), 'Исключить узлы...', 4, 'excludeNodes');

		addSection('Только узлы', 'Оставить только эндпоинты на отмеченных узлах. Пусто — без ограничения.',
			s.include_nodes || [], mkChoices(s.nodes || []), 'Только узлы...', 4, 'includeNodes');

		// --- advanced: obfuscation ---------------------------------------
		var adv = E('div', { 'class': 'cbi-section rrws-panel' });
		adv.appendChild(E('h3', {}, 'Дополнительно: обфускация, порт, IPv6, полный перебор'));
		var advBody = E('div', {});

		// Three inputs in one row, appended one by one: E('span', {}, a, b, c)
		// keeps only `a`.
		var junkRow = E('span', {});
		junkRow.appendChild(num('jc', s.jc, 1, 128, 60));
		junkRow.appendChild(document.createTextNode(' '));
		junkRow.appendChild(num('jmin', s.jmin, 1, 1280, 70));
		junkRow.appendChild(document.createTextNode(' '));
		junkRow.appendChild(num('jmax', s.jmax, 1, 1280, 70));
		advBody.appendChild(f('Jc / Jmin / Jmax', junkRow));

		var i1Sel = E('select', { name: 'gen_i1' });
		[['', '(не генерировать)'], ['quic', 'QUIC'], ['dns', 'DNS'], ['sip', 'SIP'],
		 ['stun', 'STUN'], ['random', 'случайный']].forEach(function(o) {
			var opt = E('option', { value: o[0] }, o[1]);
			if ((s.gen_i1 || '') === o[0]) opt.selected = true;
			i1Sel.appendChild(opt);
		});
		advBody.appendChild(f('Генерировать I1', i1Sel));
		// max-width alongside width: on a phone a fixed 280/380px input is wider
		// than the screen and gave the whole page a horizontal scrollbar. The
		// max-width lets it shrink and the width in px keeps the desktop look.
		advBody.appendChild(f('I1-sni (хост для маскировки)',
			E('input', { type: 'text', name: 'i1_sni', style: 'width:280px;max-width:100%', value: s.i1_sni || '' })));
		advBody.appendChild(f('Свой I1',
			E('input', { type: 'text', name: 'i1', style: 'width:380px;max-width:100%', value: s.i1 || '', placeholder: '(по умолчанию — встроенный)' })));
		advBody.appendChild(f('Только порт', num('port', s.port, 0, 65535, 90, '0 — искать автоматически; иначе 1–65535')));

		var fullChk = E('input', { type: 'checkbox', name: 'full' });
		if (s.full) fullChk.checked = true;
		advBody.appendChild(f('', chkLabel(fullChk, ' Полный перебор (все 256 адресов на подсеть — очень долго)')));

		var ipv6Chk = E('input', { type: 'checkbox', name: 'ipv6' });
		if (s.ipv6) ipv6Chk.checked = true;
		advBody.appendChild(f('', chkLabel(ipv6Chk, ' Использовать IPv6-пул')));

		adv.appendChild(advBody);
		sec.appendChild(adv);

		// --- speed test section -------------------------------------------
		// The switch and the endpoint count belong together: the phase downloads
		// through each endpoint one at a time, so how many get measured is what
		// tells the user how long the run will take. The checkbox used to live in
		// "Дополнительно", far from the field it controls.
		var spSection = E('div', { 'class': 'cbi-section rrws-panel' });
		spSection.appendChild(E('h3', {}, 'Тест скорости'));
		spSection.appendChild(E('p', { 'class': 'text-muted', style: 'margin:2px 0 8px 0' },
			'Замер download внутри туннеля, по одному эндпоинту за раз. Идёт после обычного скана ' +
			'и не меняет порядок результатов. Медленно.'));

		var spChk = E('input', { type: 'checkbox', name: 'speed' });
		if (s.speed) spChk.checked = true;
		spSection.appendChild(E('div', { style: 'margin-bottom:10px' },
			chkLabel(spChk, 'Включить замер скорости')));

		var spTopRow = num('speed_top', s.speed_top == null ? 5 : s.speed_top, 1, 40, 70,
			'эндпоинтов из начала списка, 1–40');
		spSection.appendChild(f('Эндпоинтов', spTopRow));

		// Dimming alone was not enough: the field stayed editable and the value
		// was still saved, so the setting looked active after switching the run
		// off. Disable the input itself so it cannot be changed while the phase
		// is off.
		var syncSpeedUI = function() {
			spTopRow.style.opacity = spChk.checked ? '1' : '.5';
			var inp = spTopRow.querySelector('input');
			if (inp) inp.disabled = !spChk.checked;
		};
		spChk.addEventListener('change', syncSpeedUI);
		syncSpeedUI();
		sec.appendChild(spSection);

		// --- buttons ------------------------------------------------------
		var startBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply' }, 'Найти тоннели');
		var stopBtn = E('button', { 'class': 'btn cbi-button cbi-button-reset', style: 'margin-left:8px' }, 'Остановить');
		stopBtn.disabled = true;

		startBtn.addEventListener('click', function() {
			self.collectAndSave().then(function() {
				startBtn.disabled = true;
				stopBtn.disabled = false;
				self.setAccountActionsEnabled(false);
				callScanStart().then(function(r) {
					if (r && r.error) {
						ui.addNotification(null, E('p', {}, r.error), 'error');
						startBtn.disabled = false;
						stopBtn.disabled = true;
						self.setAccountActionsEnabled(true);
						return;
					}
					self.pollScan();
				}, function() {
					startBtn.disabled = false;
					stopBtn.disabled = true;
				});
			});
		});

		stopBtn.addEventListener('click', function() {
			callScanStop().then(function() { self.pollScan(); });
		});

		var btnRow = E('div', { style: 'margin:14px 0' });
		btnRow.appendChild(startBtn);
		btnRow.appendChild(stopBtn);
		sec.appendChild(btnRow);

		// --- progress -----------------------------------------------------
		var bar = E('div', { style: 'height:8px;background:#333;border-radius:4px;overflow:hidden;display:none' },
			E('div', { style: 'height:100%;width:0%;background:#4a8;transition:width .3s' }));
		var barInner = bar.firstChild;
		var statusLine = E('div', { style: 'margin:8px 0;color:#bbb' }, 'Готово.');
		sec.appendChild(bar);
		sec.appendChild(statusLine);
		this.barEl = bar;
		this.barInner = barInner;
		this.statusEl = statusLine;
		this.startBtn = startBtn;
		this.stopBtn = stopBtn;

		// --- results ------------------------------------------------------
		var resBox = E('div', { id: 'rrws-results' });
		sec.appendChild(resBox);
		this.resultsEl = resBox;
		this.renderResults(res0);

		// Persist on ANY field change, not only on the exclusion lists. Without
		// this, edits to hosts/timeout/jobs/speed_top sat in the DOM and were
		// only written when a scan was started - so reloading the page silently
		// discarded them. 'change' (not 'input') so a half-typed number is not
		// saved on every keystroke; the numeric fields already validate on input.
		sec.addEventListener('change', function(ev) {
			var t = ev.target;
			if (!t || !t.name) return;                    // dropdown rows have no name
			self.persist();
		});
		sec.addEventListener('blur', function(ev) {
			var t = ev.target;
			if (t && t.name && t.tagName === 'INPUT') self.persist();
		}, true);

		return sec;
	},

	// Read the form, persist it, and keep the exclusion checkboxes in sync.
	collectAndSave: function() {
		var self = this;
		var root = document.querySelector('.cbi-map');
		if (!root) return Promise.resolve();
		var g = function(n) { var e = root.querySelector('[name="' + n + '"]'); return e ? e.value : null; };
		var c = function(n) { var e = root.querySelector('[name="' + n + '"]'); return e ? e.checked : false; };
		// Excluded subnets come from the ui.Dropdown widget, which keeps its own
		// selection; there are no checkboxes to scrape any more.
		var ex = checkListValues(dropdowns.subnets);

		var payload = {
			sample: parseInt(g('sample'), 10) || 0,
			timeout: parseInt(g('timeout'), 10) || 3,
			jobs: parseInt(g('jobs'), 10) || 8,
			port: parseInt(g('port'), 10) || 0,
			jc: parseInt(g('jc'), 10) || 0,
			jmin: parseInt(g('jmin'), 10) || 0,
			jmax: parseInt(g('jmax'), 10) || 0,
			proto: g('proto') || 'awg',
			gen_i1: g('gen_i1') || '',
			i1: g('i1') || '',
			i1_sni: g('i1_sni') || '',
			tg: c('tg'), tun_ping: c('tun_ping'), stable_only: c('stable_only'),
			full: c('full'), ipv6: c('ipv6'), speed: c('speed'),
			speed_top: parseInt(g('speed_top'), 10) || 5,
			exclude: ex,
			exclude_nodes: checkListValues(dropdowns.excludeNodes),
			include_nodes: checkListValues(dropdowns.includeNodes),
		};
		// A silently-empty payload here means the widget registry was not filled:
		// log it so a future regression is visible instead of looking like a
		// successful save.
		if (window.console && (!payload.exclude || !payload.exclude.length) &&
		    (!payload.exclude_nodes || !payload.exclude_nodes.length)) {
			console.warn('rrws: saving with no subnet/node selection', payload);
		}
		return callSaveSettings(payload);
	},

	persist: function() {
		// Surface failures: a rejection here used to vanish silently, leaving the
		// UI showing a selection that was never saved.
		var self = this;
		try {
			var p = this.collectAndSave();
			if (p && p.then) p.then(null, function(e) {
				if (window.console) console.error('rrws persist failed:', e);
			});
		} catch (e) {
			if (window.console) console.error('rrws persist threw:', e);
		}
	},

	resumeScan: function() {
		var self = this;
		callScanStatus().then(function(st) {
			if (st && st.running) {
				if (self.startBtn) self.startBtn.disabled = true;
				if (self.stopBtn) self.stopBtn.disabled = false;
				self.setAccountActionsEnabled(false);
				self.pollScan();
			} else if (st && st.phase === 'done') {
				callScanResult().then(function(r) { self.renderResults(r); });
			}
		});
	},

	pollScan: function() {
		var self = this;
		// A scan that has just been launched has not written its pidfile yet, so
		// the first one or two polls legitimately see running=false. Treating that
		// as "finished" ended the loop seconds after start: the page then sat on
		// the PREVIOUS result until the user reloaded, which is the minute-long
		// stall this guard exists to prevent. Only accept "not running" once we
		// have seen the run actually alive, or after the grace period.
		var sawRunning = false;
		var startedAt = Date.now();
		var GRACE_MS = 15000;

		var tick = function() {
			callScanStatus().then(function(st) {
				if (!st) { window.setTimeout(tick, 3000); return; }
				self.showStatus(st);

				if (st.running) sawRunning = true;

				var graceOver = (Date.now() - startedAt) > GRACE_MS;
				if (st.running || (!sawRunning && !graceOver)) {
					window.setTimeout(tick, 2000);
					return;
				}

				if (self.startBtn) self.startBtn.disabled = false;
				if (self.stopBtn) self.stopBtn.disabled = true;
				callScanResult().then(function(r) { self.renderResults(r); });
			}, function() { window.setTimeout(tick, 3000); });
		};
		tick();
	},

	showStatus: function(st) {
		if (!this.barEl) return;
		var phaseName = {
			starting: 'Запуск...', phase1: 'Фаза 1: поиск доступных портов',
			phase2: 'Фаза 2: проверка туннелей',
			speed: 'Тест скорости', done: 'Готово', idle: 'Ожидание'
		}[st.phase] || st.phase;

		if (st.running) {
			this.barEl.style.display = 'block';
			this.barInner.style.width = (st.percent || 0) + '%';
			var extra = '';
			if (st.total > 0) extra = ' ' + st.done + ' из ' + st.total;
			// While a scan is live the engine has not written its result file yet,
			// so "рабочих: 0" was not a count of anything - it was missing data,
			// shown beside a result list still displaying the PREVIOUS run. Report
			// only what is actually known: how far the run has got.
			this.statusEl.textContent = phaseName + extra;
		} else {
			this.barEl.style.display = 'none';
			// Without this the line kept the last in-flight text ("Фаза 2 … 69 из
			// 70") after the run had finished, so a completed scan still looked
			// like it was mid-phase.
			this.statusEl.textContent = 'Готово.';
		}

		// Account actions are locked while a scan runs: registering or deleting
		// the account mid-scan swaps the keys the running engine is using, and
		// deleting it removes the file an in-flight run reads.
		this.setAccountActionsEnabled(!st.running);
	},

	// Enable/disable the account buttons, leaving a re-registration that is
	// already in progress alone (pollRegistration owns that state).
	setAccountActionsEnabled: function(on) {
		var btn = this.regBtn;
		if (btn && btn.textContent !== 'Регистрация...') {
			btn.disabled = !on;
			btn.style.opacity = on ? '' : '.5';
		}
		if (this.delBtn) {
			this.delBtn.disabled = !on;
			this.delBtn.style.opacity = on ? '' : '.5';
		}
	},

	renderResults: function(res) {
		var self = this;
		var box = this.resultsEl;
		if (!box) return;
		while (box.firstChild) box.removeChild(box.firstChild);

		var list = (res && res.endpoints) || [];
		var head = E('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin:10px 0;gap:8px' });
		var title = 'Найдено: ' + (res && res.working || 0) +
			(res && res.tg_working ? ' (с Telegram: ' + res.tg_working + ')' : '') + '.';

		// Node codes present in this result, most frequent first. Read from `list`
		// rather than the sorted copy below: this runs before the sort exists, and
		// the counts are the same either way.
		var nodeCounts = {};
		list.forEach(function(r) {
			var n = r.node;
			if (typeof n === 'string' && n.length) nodeCounts[n] = (nodeCounts[n] || 0) + 1;
		});
		var nodeList = Object.keys(nodeCounts).map(function(k) { return { code: k, n: nodeCounts[k] }; });
		nodeList.sort(function(a, b) { return b.n - a.n || (a.code < b.code ? -1 : 1); });

		// Collapse control lives with the title so it stays reachable when the
		// list is long; the button label says what the click will do.
		var left = E('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' });
		var toggleBtn = E('button', {
			'class': 'btn cbi-button',
			style: 'font-size:12px;padding:2px 8px',
			title: 'Свернуть или развернуть список результатов'
		}, 'Свернуть');
		left.appendChild(toggleBtn);
		left.appendChild(E('div', { style: 'font-weight:600' }, title));
		if (nodeList.length) {
			var nodesRow = E('div', { style: 'font-size:13px',
				title: 'Узлы Cloudflare, на которые попали найденные эндпоинты (IATA-код города)' });
			nodeList.forEach(function(x, i) {
				if (i) nodesRow.appendChild(document.createTextNode('  '));
				nodesRow.appendChild(E('span', { style: 'color:' + NODE_COLOR + ';font-weight:600' }, x.code));
				// The count stays theme-coloured: the accent marks which node it is,
				// and colouring the number too would make the row read as a solid
				// block of yellow.
				if (x.n > 1) nodesRow.appendChild(document.createTextNode(' ×' + x.n));
			});
			left.appendChild(nodesRow);
		}
		head.appendChild(left);

		if (list.length) {
			var dlBtn = E('button', { 'class': 'btn cbi-button' }, 'Скачать всё .txt');
			dlBtn.addEventListener('click',function() {
				var txt = list.map(function(r) { return makeConf(r.endpoint); }).join('\n');
				var blob = new Blob([txt], { type: 'text/plain' });
				var a = document.createElement('a');
				a.href = URL.createObjectURL(blob);
				a.download = 'rrws-configs.txt';
				a.click();
				setTimeout(function() { URL.revokeObjectURL(a.href); }, 2000);
			});
			head.appendChild(dlBtn);
		}
		// Sort keys offered as buttons under the summary line.
		//
		// Each has a natural default direction, because "ping" is almost always
		// wanted ascending (fastest first) and "node" alphabetically, while a
		// separate direction toggle would be one more control for the common case
		// to get wrong. Clicking the active key flips the direction anyway.
		var SORTS = [
			{ id: 'default', label: 'По умолчанию', defDir: 'asc',
			  title: 'Сначала с рабочим Telegram, затем стабильные, затем меньший пинг в туннеле' },
			{ id: 'node', label: 'Узел', defDir: 'asc',
			  title: 'По коду узла Cloudflare' },
			{ id: 'ping', label: 'Пинг', defDir: 'asc',
			  title: 'По пингу до эндпоинта, от меньшего к большему' },
			{ id: 'tun', label: 'Туннель', defDir: 'asc',
			  title: 'По задержке внутри туннеля, от меньшей к большей' },
			{ id: 'tg', label: 'Telegram', defDir: 'asc',
			  title: 'По времени отклика Telegram, от меньшего к большему' },
		];

		// Compare by the chosen key. Endpoints missing a value always sink to the
		// bottom regardless of direction: an endpoint without a Telegram probe has
		// nothing to compare, and floating it to the top on a descending sort would
		// present "no data" as the best result.
		var comparators = {
			default: function(a, b) {
				if (!!b.tg_ok !== !!a.tg_ok) return b.tg_ok ? 1 : -1;
				if (!!a.torn !== !!b.torn) return a.torn ? 1 : -1;
				var at = a.tun_ping_ms || a.ping_ms || 9999;
				var bt = b.tun_ping_ms || b.ping_ms || 9999;
				return at - bt;
			},
			node: function(a, b) {
				var an = a.node || '~', bn = b.node || '~';
				return an < bn ? -1 : (an > bn ? 1 : 0);
			},
			ping: function(a, b) { return (a.ping_ms || 9999) - (b.ping_ms || 9999); },
			tun: function(a, b) { return (a.tun_ping_ms || 9999) - (b.tun_ping_ms || 9999); },
			tg: function(a, b) {
				// tg_ok first: an endpoint whose Telegram is blocked has no RTT, and
				// its absence must not read as a very fast zero.
				if (!!b.tg_ok !== !!a.tg_ok) return b.tg_ok ? 1 : -1;
				return (a.tg_rtt_ms || 9999) - (b.tg_rtt_ms || 9999);
			},
		};

		var sortId = 'default';
		var sortDir = 1;   // 1 ascending, -1 descending

		var content = E('div', {});
		box.appendChild(head);
		box.appendChild(content);

		if (!list.length) {
			content.appendChild(E('div', { style: 'color:#888;padding:8px 0' },
				'Рабочих эндпоинтов не найдено.'));
			// Nothing to fold when the list is empty.
			toggleBtn.disabled = true;
			toggleBtn.style.opacity = '.5';
			return;
		}

		// The sort bar lives directly under the summary, above the cards.
		var sortBar = E('div', { 'class': 'rrws-sortbar' });
		sortBar.appendChild(E('span', { 'class': 'rrws-sortbar-label' }, 'Сортировка:'));
		var sortBtns = {};
		SORTS.forEach(function(s) {
			var b = E('button', { 'class': 'btn cbi-button', style: 'font-size:12px;padding:2px 10px' },
				s.label);
			b.title = s.title;
			b.addEventListener('click', function() {
				if (sortId === s.id) {
					sortDir = -sortDir;      // same key again: flip the direction
				} else {
					sortId = s.id;
					sortDir = (s.defDir === 'desc') ? -1 : 1;
				}
				paintSort();
				renderCards();
			});
			sortBtns[s.id] = b;
			sortBar.appendChild(b);
		});
		content.appendChild(sortBar);

		// Mark the active key and show which way it runs, so the list order is
		// never a guess.
		var paintSort = function() {
			SORTS.forEach(function(s) {
				var b = sortBtns[s.id];
				var on = (sortId === s.id);
				b.style.fontWeight = on ? '600' : '';
				b.style.borderColor = on ? 'var(--primary-color-high, #3a5474)' : '';
				if (on && sortId !== 'default')
					b.textContent = s.label + (sortDir > 0 ? ' ↑' : ' ↓');
				else
					b.textContent = s.label;
			});
		};
		paintSort();

		var cardsBox = E('div', {});
		content.appendChild(cardsBox);

		// Rebuild the card list for the current sort. Kept as a function so the
		// sort buttons re-render only the cards, not the whole panel - rebuilding
		// the header would drop the sort bar the click came from.
		var renderCards = function() {
			while (cardsBox.firstChild) cardsBox.removeChild(cardsBox.firstChild);

			var sorted = list.slice().sort(function(a, b) {
				var c = comparators[sortId](a, b);
				return sortDir > 0 ? c : -c;
			});

			// "Лучший" marks the first row that is both stable and Telegram-capable,
			// which is a property of the data, not of the current sort. Under an
			// explicit sort it can sit anywhere in the list, so it is found by scan
			// rather than assumed to be first.
			var bestIdx = -1;
			sorted.forEach(function(r, i) { if (bestIdx < 0 && !r.torn && r.tg_ok) bestIdx = i; });

			sorted.forEach(function(r, i) {
				var isBest = (i === bestIdx);
			// The left stripe carries the meaning (best / torn / plain) and the rest
			// of the card's surface comes from the .rrws-card rules, so the list
			// stays readable at 141 entries instead of turning into one grey slab.
			var cls = 'rrws-card' + (r.torn ? ' rrws-card-torn' : (isBest ? ' rrws-card-best' : ''));
			var row = E('div', { 'class': cls });

			// One row per result: identity on the left, actions pinned right.
			//
			// This used to stack three blocks - endpoint line, metadata line,
			// buttons - which spent a full row on the buttons alone. They now sit
			// on the same line as the data they act on, so a screen shows roughly a
			// third more endpoints. `min-width:0` on the text column is what lets it
			// shrink instead of pushing the buttons off the card.
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '12px';

			var info = E('div', { style: 'flex:1 1 auto;min-width:0' });

			var line1 = E('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' });
			line1.appendChild(E('code', { style: 'font-size:14px' }, r.endpoint));
			line1.appendChild(tgBadge(r));
			if (isBest) line1.appendChild(E('span', {
				style: 'background:#16a34a;color:#fff;padding:1px 6px;border-radius:3px;font-weight:600'
			}, 'ЛУЧШИЙ'));
			if (r.torn) line1.appendChild(E('span', {
				style: 'background:#b91c1c;color:#fff;padding:1px 6px;border-radius:3px',
				title: 'DPI обрывает туннель — данные через него не идут'
			}, 'ОБРЫВ'));
			if (r.loss_pct > 0) line1.appendChild(E('span', { style: 'color:#e8a' }, 'потери ' + r.loss_pct + '%'));
			info.appendChild(line1);

			// Metadata is built as separate spans, not one joined string: only the
			// values carry colour, and a plain text node cannot be partly styled.
			var meta = E('div', { 'class': 'rrws-card-meta' });
			var sep = function() { meta.appendChild(document.createTextNode(' • ')); };

			// The node code itself is the accent; the word "узел" stays neutral so
			// the colour marks the code rather than the label.
			meta.appendChild(document.createTextNode('узел '));
			meta.appendChild(E('span', {
				style: 'color:' + NODE_COLOR + ';font-weight:600',
				title: 'Узел Cloudflare (IATA-код города) и страна выхода'
			}, (r.node || '?') + (r.country ? ' / ' + r.country : '')));
			if (r.city) {
				sep();
				meta.appendChild(document.createTextNode(r.city));
			}
			sep();
			meta.appendChild(metric('пинг', pingText(r.ping_ms), pingColor(r.ping_ms)));
			if (r.measured) {
				sep();
				meta.appendChild(metric('в туннеле', pingText(r.tun_ping_ms), pingColor(r.tun_ping_ms)));
			}
			if (r.tg_ok && r.tg_rtt_ms) {
				sep();
				meta.appendChild(metric('Telegram', pingText(r.tg_rtt_ms), tgColor(r.tg_rtt_ms)));
			}
			// speed_measured tells "not tested" from "tested, got nothing": a
			// failed measurement is a real datum, not a missing one.
			if (r.speed_measured) {
				sep();
				meta.appendChild(document.createTextNode('скорость ' + r.speed_mbps.toFixed(1) + ' Мбит/с'));
			}
			info.appendChild(meta);
			row.appendChild(info);

			var actions = E('div', { 'class': 'rrws-card-actions', style: 'flex:0 0 auto' });
			var cpBtn = E('button', { 'class': 'btn cbi-button cbi-button-action', style: 'font-size:12px' }, 'Скопировать .conf');
			cpBtn.addEventListener('click', function() { copyText(makeConf(r.endpoint), cpBtn); });
			actions.appendChild(cpBtn);

			// No margin-left here: the row is a flex container with a gap, so a
			// per-button margin would double the spacing.
			var showBtn = E('button', { 'class': 'btn cbi-button', style: 'font-size:12px' }, 'Показать .conf');
			showBtn.addEventListener('click', function() {
				ui.showModal('AmneziaWG .conf — ' + r.endpoint, [
					E('pre', { style: 'white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto;font-size:12px' },
						makeConf(r.endpoint)),
					E('div', { 'class': 'right' }, E('button', {
						'class': 'btn', click: ui.hideModal
					}, 'Закрыть'))
				]);
			});
			actions.appendChild(showBtn);
			row.appendChild(actions);

				cardsBox.appendChild(row);
			});
		};

		// The collapse control hides the whole content block, so it also hides the
		// sort bar - that is the intent, and collapsing stays a way to get the list
		// out of the way entirely.
		var collapsed = false;
		toggleBtn.addEventListener('click', function() {
			collapsed = !collapsed;
			content.style.display = collapsed ? 'none' : '';
			toggleBtn.textContent = collapsed ? 'Развернуть' : 'Свернуть';
		});

		renderCards();
	},

	renderLog: function() {
		var self = this;
		var sec = E('div', { 'class': 'cbi-section rrws-panel' });
		var det = E('details', { 'class': 'rrws-disclosure' });
		det.appendChild(E('summary', {}, 'Логи'));

		// One merged log, in chronological order, like a chat: the backend
		// interleaves engine and rpcd lines by their timestamps, so the page
		// renders a single stream. Two side-by-side panes were hard to follow -
		// the reader had to match up what happened when across two scrollbars.
		// Each line is tagged with its source instead, which costs three
		// characters and keeps the order intact.
		var logWrap = E('div', { style: 'margin-top:8px' });
		var pre = E('pre', {
			style: 'height:320px;overflow:auto;font-size:11px;white-space:pre-wrap;padding:8px;margin:0;border-radius:3px'
		}, '...');
		logWrap.appendChild(pre);
		det.appendChild(logWrap);

		var controls = E('div', { style: 'margin-top:8px;display:flex;align-items:center;gap:14px;flex-wrap:wrap' });

		// Auto-refresh and auto-scroll are separate on purpose: reading back
		// through a long log while it keeps jumping to the bottom is impossible,
		// so turning the first off must not force the second.
		var autoRefreshChk = E('input', { type: 'checkbox' });
		if (self.logAutoRefresh !== false) autoRefreshChk.checked = true;
		// chkLabel, not E('label', {}, box, text): LuCI's E() keeps only its first
		// child, which rendered both switches without their captions.
		controls.appendChild(chkLabel(autoRefreshChk, 'Автообновление'));
		controls.lastChild.style.display = 'flex';
		controls.lastChild.style.alignItems = 'center';
		controls.lastChild.style.gap = '6px';
		controls.lastChild.style.cursor = 'pointer';

		var autoScrollChk = E('input', { type: 'checkbox' });
		if (self.logAutoScroll !== false) autoScrollChk.checked = true;
		controls.appendChild(chkLabel(autoScrollChk, 'Автопрокрутка'));
		controls.lastChild.style.display = 'flex';
		controls.lastChild.style.alignItems = 'center';
		controls.lastChild.style.gap = '6px';
		controls.lastChild.style.cursor = 'pointer';

		var clearBtn = E('button', { 'class': 'btn cbi-button', style: 'margin-left:auto' }, 'Очистить');
		clearBtn.addEventListener('click', function() {
			callScanLogClear().then(function() {
				pre.textContent = '';
				self.logSeen = '';
			});
		});
		controls.appendChild(clearBtn);
		det.appendChild(controls);

		sec.appendChild(det);
		this.logPane = pre;
		this.logAutoRefreshChk = autoRefreshChk;
		this.logAutoScrollChk = autoScrollChk;
		this.logSeen = '';
		return sec;
	},

	// The merged log is rebuilt server-side in timestamp order, so a line can
	// appear between two existing ones - the stream is not append-only any more
	// and diffing the tail would show it out of order. Replacing the text is
	// therefore the simple correct thing, and the scroll position is preserved
	// by restoring it around the swap.
	updateLog: function(el, text) {
		if (text === this.logSeen) return;
		this.logSeen = text;
		var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
		var keep = el.scrollTop;
		el.textContent = text;
		if (this.logAutoScrollChk && this.logAutoScrollChk.checked && atBottom) {
			el.scrollTop = el.scrollHeight;
		} else {
			// Not following: keep the reader where they were.
			el.scrollTop = keep;
		}
	},

	startLogAutoRefresh: function() {
		var self = this;
		var tick = function() {
			// Only while visible and only when asked: a background tab polling a
			// 2-core router every 3s is wasted work.
			if (document.visibilityState === 'visible' &&
			    self.logAutoRefreshChk && self.logAutoRefreshChk.checked) {
				callScanLog().then(function(l) {
					if (!l || !self.logPane) return;
					self.updateLog(self.logPane, l.merged || '');
				});
			}
			window.setTimeout(tick, 3000);
		};
		tick();
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
