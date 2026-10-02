'use strict';
'require baseclass';

// Formatting and small builders shared by the account table and the result
// cards: .conf generation, copy-to-clipboard, coloured metrics, Telegram badge.

var TG_TOTAL = 5;

// Account data (keys, addresses, obfuscation settings) the .conf is built from.
var confData = null;

function setConf(d) {
	confData = d;
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
function metric(label, value, color) {
	var frag = document.createDocumentFragment();
	frag.appendChild(document.createTextNode(label + ' '));
	frag.appendChild(E('span', {
		style: 'font-weight:600' + (color ? ';color:' + color : '')
	}, value));
	return frag;
}

return baseclass.extend({
	setConf: setConf,
	copyText: copyText,
	makeConf: makeConf,
	tgBadge: tgBadge,
	pingText: pingText,
	pingColor: pingColor,
	tgColor: tgColor,
	metric: metric,
	NODE_COLOR: NODE_COLOR
});
