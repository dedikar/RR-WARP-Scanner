'use strict';
'require rpc';
'require ui';

console.log('[rrws] view loading (WS_R60)');

// XHR failure resilience net (pattern from zeroblock): when a request to the
// router genuinely fails (rpcd restart, network blip, or a call that outlived
// the ~20s rpc timeout) the page must not stay stuck showing an error - the UI
// is fully rebuildable from server state (scan/speed/registration run detached
// and are resumed on load), so just reload once. The 30s window prevents a
// reload loop while the router is still down.
var XHR_RELOAD_GUARD_KEY = 'rrws:xhr-reload-at';
var XHR_RELOAD_GUARD_WINDOW_MS = 30000;

var isXhrError = function(e) {
	var msg = String((e && e.message) || '');
	return msg === 'XHR request timed out' || msg.indexOf('XHR') !== -1;
};

var forceReloadAfterXhrError = function() {
	var now = Date.now();
	var last = 0;
	try { last = parseInt(window.sessionStorage.getItem(XHR_RELOAD_GUARD_KEY) || '0', 10) || 0; } catch (e) {}
	if (now - last < XHR_RELOAD_GUARD_WINDOW_MS)
		return;
	try { window.sessionStorage.setItem(XHR_RELOAD_GUARD_KEY, String(now)); } catch (e) {}
	console.warn('[rrws] XHR failure, reloading page');
	var url = new URL(window.location.href);
	url.searchParams.set('_rrws_xhr_reload', String(now));
	window.location.replace(url.toString());
};

// every rpc call on this page goes through this wrapper: an XHR-level failure
// schedules the reload above, then the error still propagates to the caller
// (and to the global handler below if nobody catches it)
var rrwsDeclare = function(opts) {
	// nobatch: bypass LuCI's request batching (luci.js flushRequestQueue).
	// When several RPC calls run concurrently (scanStatus + scanLog + account
	// status + settings + conf base), LuCI joins them into ONE POST whose reply
	// must be a JSON array; any hiccup (mixed frame / empty array / timeout on
	// the router under 100% CPU load) rejects the WHOLE batch with the generic
	// "No related RPC reply" and the progress UI dies. Sending each call on its
	// own XHR makes the page resilient - one failure only drops that call.
	opts.nobatch = true;
	var fn = rpc.declare(opts);
	return function() {
		return fn.apply(null, arguments).then(function(res) {
			return res;
		}, function(e) {
			if (isXhrError(e))
				forceReloadAfterXhrError();
			throw e;
		});
	};
};

window.addEventListener('unhandledrejection', function(e) {
	if (e.reason && isXhrError(e.reason)) {
		e.preventDefault();
		forceReloadAfterXhrError();
	}
});

var callRRWS = rrwsDeclare({
	object: 'luci.rrws',
	method: 'accountStatus'
});

var callRegister = rrwsDeclare({
	object: 'luci.rrws',
	method: 'register'
});

var callDeleteAccount = rrwsDeclare({
	object: 'luci.rrws',
	method: 'deleteAccount'
});

var callRenewAccount = rrwsDeclare({
	object: 'luci.rrws',
	method: 'renewAccount'
});

var callRegisterLog = rrwsDeclare({
	object: 'luci.rrws',
	method: 'registerLog'
});

var callConfBase = rrwsDeclare({
	object: 'luci.rrws',
	method: 'confBase'
});

var callAppVersion = rrwsDeclare({
	object: 'luci.rrws',
	method: 'version'
});

var callScanStart = rrwsDeclare({
	object: 'luci.rrws',
	method: 'scanStart',
	params: [ 'hosts', 'timeout', 'mode', 'jobs', 'discover', 'discover_hosts', 'exclude', 'exclude_nodes' ]
});

var callScanStatus = rrwsDeclare({
	object: 'luci.rrws',
	method: 'scanStatus'
});

var callScanStop = rrwsDeclare({
	object: 'luci.rrws',
	method: 'scanStop'
});

var callScanResult = rrwsDeclare({
	object: 'luci.rrws',
	method: 'scanResult'
});

var callScanLog = rrwsDeclare({
	object: 'luci.rrws',
	method: 'scanLog'
});

var callScanLogClear = rrwsDeclare({
	object: 'luci.rrws',
	method: 'scanLogClear'
});

var callSpeedStart = rrwsDeclare({
	object: 'luci.rrws',
	method: 'speedStart',
	params: [ 'count', 'duration' ]
});

var callSpeedAvailable = rrwsDeclare({
	object: 'luci.rrws',
	method: 'speedAvailable'
});

var callSpeedStatus = rrwsDeclare({
	object: 'luci.rrws',
	method: 'speedStatus'
});

var callSpeedStop = rrwsDeclare({
	object: 'luci.rrws',
	method: 'speedStop'
});

var callSpeedResult = rrwsDeclare({
	object: 'luci.rrws',
	method: 'speedResult'
});

var callGetSettings = rrwsDeclare({
	object: 'luci.rrws',
	method: 'getSettings'
});

var callSaveSettings = rrwsDeclare({
	object: 'luci.rrws',
	method: 'saveSettings',
	params: [ 'hosts', 'timeout', 'jobs', 'discover', 'discover_hosts', 'exclude', 'exclude_nodes' ]});

var uiStore = function(key, val) {
	try { window.localStorage.setItem('rrws.' + key, val ? '1' : '0'); }
	catch (e) {}
};
var uiLoad = function(key, dflt) {
	try {
		var v = window.localStorage.getItem('rrws.' + key);
		return v === null ? dflt : (v === '1');
	} catch (e) { return dflt; }
};

var confData = null;
var statusElCurrent = null;

function statusLine(el, text, isError) {
	el.textContent = String(text);
	el.classList.remove('text-danger');
	if (isError)
		el.classList.add('text-danger');
}

function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function makeConf(base, endpoint) {
	var lines = [];
	lines.push('[Interface]');
	if (base.address) lines.push('Address = ' + base.address);
	if (base.private_key) lines.push('PrivateKey = ' + base.private_key);
	if (base.dns) lines.push('DNS = ' + base.dns);
	if (base.mtu) lines.push('MTU = ' + base.mtu);
	if (base.jc) lines.push('Jc = ' + base.jc);
	if (base.jmin) lines.push('Jmin = ' + base.jmin);
	if (base.jmax) lines.push('Jmax = ' + base.jmax);
	if (base.s1 != null) lines.push('S1 = ' + base.s1);
	if (base.s2 != null) lines.push('S2 = ' + base.s2);
	if (base.s3 != null) lines.push('S3 = ' + base.s3);
	if (base.s4 != null) lines.push('S4 = ' + base.s4);
	if (base.h1) lines.push('H1 = ' + base.h1);
	if (base.h2) lines.push('H2 = ' + base.h2);
	if (base.h3) lines.push('H3 = ' + base.h3);
	if (base.h4) lines.push('H4 = ' + base.h4);
	if (base.i1) lines.push('I1 = ' + base.i1);
	lines.push('');
	lines.push('[Peer]');
	if (base.peer_public_key) lines.push('PublicKey = ' + base.peer_public_key);
	lines.push('Endpoint = ' + endpoint);
	if (base.allowed_ips) lines.push('AllowedIPs = ' + base.allowed_ips);
	if (base.keepalive) lines.push('PersistentKeepalive = ' + base.keepalive);
	return lines.join('\n');
}

function copyToClipboard(text, btn) {
	// after a successful copy the button turns read-only ("Скопировано") so the
	// user can't fire it again and sees at a glance that the copy is done
	var restore = function() {
		window.setTimeout(function() {
			btn.disabled = false;
			btn.textContent = 'Скопировать .conf';
		}, 2000);
	};
	// modern API first
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(function() {
			btn.disabled = true;
			btn.textContent = 'Скопировано';
			restore();
		}).catch(function() {
			legacyCopy(text, btn);
		});
		return;
	}
	legacyCopy(text, btn);
}

function legacyCopy(text, btn) {
	var ta = E('textarea', { 'style': 'position:fixed;left:-9999px;top:0' });
	ta.value = text;
	document.body.appendChild(ta);
	ta.select();
	try {
		document.execCommand('copy');
		btn.disabled = true;
		btn.textContent = 'Скопировано';
	} catch (e) {
		btn.textContent = 'Ошибка копирования';
	}
	document.body.removeChild(ta);
	window.setTimeout(function() {
		btn.disabled = false;
		btn.textContent = 'Скопировать .conf';
	}, 2000);
}

function confPreBox(holder, preClass, conf, endpoint) {
	var preBox = holder.querySelector('.' + preClass);
	if (!preBox) {
		preBox = E('div', { 'class': preClass, 'style': 'width:100%; display:none; margin-top:6px' });
		holder.appendChild(preBox);
	}
	if (preBox.style.display === 'none') {
		preBox.innerHTML = '';
		preBox.appendChild(E('pre', { 'style': 'white-space:pre-wrap; word-break:break-all; background:#111; color:#9f9; padding:8px; border-radius:4px; font-size:11px; margin:0' },
			escapeHtml(makeConf(conf, endpoint))));
		preBox.style.display = '';
	} else {
		preBox.style.display = 'none';
	}
}

function renderTable(results, updated, saved) {
	var box = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px' });
	var titleBar = E('div', { 'style': 'display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px' });
	titleBar.appendChild(E('h3', {}, 'Результаты сканирования'));
	box.appendChild(titleBar);
	box.appendChild(E('p', { 'class': 'text-muted', 'style': 'margin:2px 0 4px 0' },
		saved ? 'Показаны сохранённые результаты предыдущего скана.' : 'Показаны результаты последнего скана.'));
	if (updated) {
		var t = saved ? 'Сохранённый скан от ' : 'Скан от ';
		box.appendChild(E('p', { 'class': 'text-muted', 'style': 'margin:2px 0 8px 0' },
			t + new Date(updated * 1000).toLocaleString() + ' Всего - ' + results.length));
	}

	if (results.length) {
		var best = null;
		var bestIdx = 0;
		for (var bi = 0; bi < results.length; bi++) {
			if (!results[bi].torn) { best = results[bi].endpoint; bestIdx = bi; break; }
		}
		var topBar = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:8px 0' });
		box.appendChild(topBar);

		var bestBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' },
			best ? 'Скопировать лучший .conf (' + best + ')' : 'Нет рабочих эндпоинтов');
		bestBtn.disabled = !best;
		bestBtn.addEventListener('click', function() {
			if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
			copyToClipboard(makeConf(confData, best), bestBtn);
		});
		topBar.appendChild(bestBtn);

		var viewBtnT = E('button', { 'class': 'btn cbi-button', 'type': 'button' }, 'Показать .conf');
		viewBtnT.addEventListener('click', function() {
			if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
			confPreBox(topBar, 'ws-pre-best', confData, best);
		});
		topBar.appendChild(viewBtnT);

		var dlBtn = E('button', { 'class': 'btn cbi-button cbi-button-action', 'type': 'button' }, 'Скачать всё .txt');
		dlBtn.addEventListener('click', function() {
			if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
			var blocks = results.map(function(r) {
				var head = '# ' + r.endpoint + '  ' + (r.node || '') + ' ' + (r.country || '') +
					(r.ping != null ? ' ' + r.ping + ' ms' : '');
				return head + '\n' + makeConf(confData, r.endpoint);
			});
			var txt = '# WARP AmneziaWG конфиги (' + results.length + ')\n' +
				'# Скан: ' + new Date().toLocaleString() + '\n\n' + blocks.join('\n\n') + '\n';
			var blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
			var url = URL.createObjectURL(blob);
			var a = E('a', { 'href': url, 'download': 'rrws-configs.txt' });
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			window.setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
		});
		topBar.appendChild(dlBtn);
	}

	// one row per endpoint: label on the left, copy button right beside it.
	// a simple block list (not a wide table) so the buttons are always visible.
	var rows = [];
	for (var i = 0; i < results.length; i++) {
		var r = results[i];
		var row = E('div', { 'class': 'cbi-section', 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:4px 0; padding:6px 8px; border:1px solid ' + (r.torn ? '#a33' : '#444') + '; border-radius:4px;' + (r.torn ? 'opacity:.7' : '') });
		var ep = E('code', { 'style': 'flex:1 1 auto; min-width:150px; word-break:break-all' }, r.endpoint);
		row.appendChild(ep);
		var detail = (r.node || '') + ' ' + (r.country || '') +
			(r.ping != null ? ' ' + r.ping + ' ms' : '') +
			(r.tun_ping && r.tun_ping != '?' ? ' | туннель ' + r.tun_ping + ' мс' : '') +
			(r.tun_loss && r.tun_loss != '?' && r.tun_loss > 0 ? ', потеря ' + r.tun_loss + '%' : '');
		row.appendChild(E('span', { 'class': 'text-muted' }, detail));
		if (r.torn)
			row.appendChild(E('span', { 'class': 'label label-negative' }, 'TORN'));
		else if (r.tun_loss && r.tun_loss != '?' && r.tun_loss > 0)
			row.appendChild(E('span', { 'class': 'label label-warning' }, 'Потери ' + r.tun_loss + '%'));
		if (i == bestIdx && !r.torn)
			row.appendChild(E('span', { 'class': 'label label-success' }, 'BEST'));
		var btnGroup = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-left:auto; flex:0 0 auto' });
		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Скопировать .conf');
		btn.addEventListener('click', function(endpoint, that) {
			return function() {
				if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
				copyToClipboard(makeConf(confData, endpoint), that);
			};
		}(r.endpoint, btn));
		btnGroup.appendChild(btn);

		var viewBtn = E('button', { 'class': 'btn cbi-button', 'type': 'button' }, 'Показать .conf');
		viewBtn.addEventListener('click', function(rowEl, endpoint) {
			return function() {
				if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
				confPreBox(rowEl, 'ws-pre-row-pre', confData, endpoint);
			};
		}(row, r.endpoint));
		btnGroup.appendChild(viewBtn);
		row.appendChild(btnGroup);
		rows.push({ row: row, endpoint: r.endpoint, torn: !!r.torn });
		box.appendChild(row);
	}

	// collapse/expand toggle: keep only the best (first non-torn) row visible
	// so long result lists don't bury the Logs block below. State is remembered
	// across page reloads.
	var collapsed = uiLoad('resultsCollapsed', false);
	var toggleRowVisibility = function() {
		for (var ri = 0; ri < rows.length; ri++)
			rows[ri].row.style.display = (collapsed && ri != bestIdx) ? 'none' : 'flex';
	};
	var collapseBtn = E('button', { 'class': 'btn cbi-button', 'type': 'button' }, collapsed ? 'Развернуть (' + results.length + ')' : 'Свернуть');
	collapseBtn.addEventListener('click', function() {
		collapsed = !collapsed;
		uiStore('resultsCollapsed', collapsed);
		collapseBtn.textContent = collapsed ? 'Развернуть (' + results.length + ')' : 'Свернуть';
		toggleRowVisibility();
	});
	if (rows.length > 1) {
		topBar.appendChild(collapseBtn);
		toggleRowVisibility();
	}
	return box;
}

var logEl = null;
var logRefresh = null;
// auto-update the log every 3s while checked (default on); unchecking stops
// the polling so the user can scroll up and read earlier lines
var logAutoRefresh = uiLoad('logAutoRefresh', true);

function logBox() {
	var box = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px' });
	var body = E('div', {});

	var toggle = function() {
		var wasCollapsed = body.style.display === 'none';
		body.style.display = wasCollapsed ? '' : 'none';
		toggler.textContent = wasCollapsed ? '▾ Логи' : '▸ Логи';
		uiStore('logsCollapsed', body.style.display === 'none');
	};
	var toggler = E('h3', {
		'style': 'cursor:pointer; user-select:none; margin:0; padding:4px 0',
		'title': 'Клик — свернуть/развернуть'
	}, '▾ Логи');
	toggler.addEventListener('click', toggle);
	if (uiLoad('logsCollapsed', false)) {
		body.style.display = 'none';
		toggler.textContent = '▸ Логи';
	}
	box.appendChild(toggler);

	logEl = E('pre', {
		'id': 'ws-log',
		'style': 'white-space:pre-wrap; word-break:break-all; background:#111; color:#9f9; padding:8px; border-radius:4px; font-size:11px; max-height:260px; overflow:auto; margin:0 0 8px 0'
	}, '(пока пусто)');
	body.appendChild(logEl);
	var btn = E('button', {
		'class': 'btn cbi-button',
		'type': 'button',
		'style': 'color:var(--success); border-color:var(--success)'
	}, 'Обновить лог');
	btn.addEventListener('click', refreshLog);
	var btnRow = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:8px 0' });
	body.appendChild(btnRow);
	btnRow.appendChild(btn);
	var clearBtn = E('button', {
		'class': 'btn cbi-button',
		'type': 'button',
		'style': 'color:var(--danger); border-color:var(--danger)'
	}, 'Очистить');
	clearBtn.addEventListener('click', function() {
		callScanLogClear().then(function() {
			if (logEl) logEl.textContent = '(пока пусто)';
		}).catch(function(e) {
			if (logEl) logEl.textContent = 'Ошибка очистки лога: ' + e.message;
		});
	});
	btnRow.appendChild(clearBtn);
	// auto-refresh checkbox: while checked the log is fetched every 3s and the
	// view follows the newest lines; unchecking stops the polling so the user
	// can scroll up and read earlier lines without the box jumping
	var autoLbl = E('label', {
		'style': 'display:inline-flex; align-items:center; gap:4px; margin-left:8px; cursor:pointer'
	});
	var autoChk = E('input', { 'type': 'checkbox' });
	autoChk.checked = logAutoRefresh;
	autoLbl.appendChild(autoChk);
	autoLbl.appendChild(document.createTextNode(' Автообновление лога'));
	autoChk.addEventListener('change', function() {
		logAutoRefresh = autoChk.checked;
		uiStore('logAutoRefresh', logAutoRefresh);
		if (logAutoRefresh)
			startLogAutoRefresh();
		else
			stopLogAutoRefresh();
	});
	btnRow.appendChild(autoLbl);
	box.appendChild(body);
	return box;
}

function refreshLog() {
	callScanLog().then(function(d) {
		if (!logEl) return;
		var txt = '';
		if (d && d.rpc) txt += '--- rpcd log ---\n' + d.rpc;
		if (d && d.wscan) txt += '\n\n--- wscan.log ---\n' + d.wscan;
		logEl.textContent = txt || '(пока пусто)';
		// only force the view to the newest lines when auto-refresh is active;
		// while it's off the user controls the scroll position
		if (logAutoRefresh)
			logEl.scrollTop = logEl.scrollHeight;
	}).catch(function(e) {
		if (logEl) logEl.textContent = 'Ошибка чтения лога: ' + e.message;
	});
}

function startLogAutoRefresh() {
	if (!logAutoRefresh)
		return;
	if (logRefresh)
		window.clearInterval(logRefresh);
	logRefresh = window.setInterval(refreshLog, 3000);
}

function stopLogAutoRefresh() {
	if (logRefresh) {
		window.clearInterval(logRefresh);
		logRefresh = null;
	}
	// the checkbox is the master switch: lifecycle stops (scan done,
	// registration finished, ...) must not turn the log polling off while the
	// user left "Автообновление лога" checked
	if (logAutoRefresh)
		startLogAutoRefresh();
}

	return L.view.extend({
	render: function() {
var view = this;
	var container = E('div', {});
	confData = null;
	statusElCurrent = null;

	var statusEl = E('p', { 'class': 'text-muted' }, 'Готов.');
	statusElCurrent = statusEl;
	var resultEl = E('div', {});

		// --- header (style: zeroblock) -------------------------------------
		var headerEl = E('div', { 'style': 'margin-bottom: 14px;' });
		var appVerEl = E('code', { 'style': 'font-size: 12px;' }, '...');
		var accStatusLabel = E('span', { 'class': 'label label-default' }, '...');

		headerEl.appendChild(E('h2', {}, 'RR WARP Scanner'));
		headerEl.appendChild(E('div', { 'class': 'cbi-map-descr' },
			'Поиск быстрых Cloudflare WARP-эндпоинтов через AmneziaWG. Версия: '));
		headerEl.lastChild.appendChild(appVerEl);

		var accStatusRow = E('table', { 'class': 'table', 'style': 'margin-bottom: 10px;' }, [
			E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td left', 'style': 'width: 160px;' }, 'Аккаунт WARP'),
				E('td', { 'class': 'td right' }, accStatusLabel)
			])
		]);
		headerEl.appendChild(accStatusRow);
		container.appendChild(headerEl);

		callAppVersion().then(function(v) {
			appVerEl.textContent = (v && v.version) ? v.version : '?';
		}).catch(function(e) {
			console.error('[rrws] version err', e.message);
			appVerEl.textContent = '?';
		});

		// account info
		var accSection = E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 14px; border:1px solid #ddd; border-radius:4px; padding:10px 12px' });
		var accHead = E('div', { 'style': 'display:flex; align-items:flex-start; justify-content:space-between; gap:16px' });
		accHead.appendChild(E('h3', {}, 'Аккаунт WARP'));
		var accBtns = E('div', { 'style': 'display:flex; flex-direction:row; flex-wrap:wrap; justify-content:flex-end; flex-shrink:0; gap:8px' });
		accHead.appendChild(accBtns);
		accSection.appendChild(accHead);
		var accBody = E('div', { 'style': 'display:flex; align-items:flex-start; gap:16px; margin-top:8px' });
		var accInfo = E('div', { 'style': 'flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:6px' });
		var accDetail = E('p', { 'style': 'margin:0; word-break:break-all' });
		var accHint = E('p', { 'class': 'text-muted', 'style': 'margin:0; font-size:11px' });
		accInfo.appendChild(accDetail);
		accInfo.appendChild(accHint);
		accBody.appendChild(accInfo);
		accSection.appendChild(accBody);
		container.appendChild(accSection);

		var renderAccount = function(account) {
			console.log('[rrws] account:', JSON.stringify(account));
			accDetail.innerHTML = '';
			accHint.innerHTML = '';
			if (account && account.registered) {
				accStatusLabel.textContent = 'Зарегистрирован';
				accStatusLabel.className = 'label success';
				accStatusLabel.style.background = '';
				accStatusLabel.style.color = '';
				var s = E('span', {}, 'ID: ');
				s.appendChild(E('code', {}, account.id || '?'));
				s.appendChild(document.createTextNode('  Address: '));
				s.appendChild(E('code', {}, account.address || '?'));
				accDetail.appendChild(s);
				accHint.textContent = 'Peer-ключ и адрес у всех аккаунтов WARP одинаковы; меняются id и private_key.';
			} else {
				accStatusLabel.textContent = 'Не зарегистрирован';
				accStatusLabel.className = 'label';
				accStatusLabel.style.background = '#d9534f';
				accStatusLabel.style.color = '#fff';
			}
			setAccButtons(account && account.registered);
		};

		// registration runs in the background (a bootstrap tunnel may take ~1 min),
		// so we start it, lock the account buttons and poll accountStatus until the
		// wregister.sh marker clears. This survives the LuCI 20s rpc timeout.
		var regState = { poll: null, startedAt: 0, oldId: null };
		var stopRegPoll = function() {
			if (regState.poll) { clearTimeout(regState.poll); regState.poll = null; }
		};
		var regDone = function(ok, msg) {
			stopRegPoll();
			stopLogAutoRefresh();
			refreshLog();
			lockScanButtons(false);
			if (ok) statusLine(statusEl, msg);
			else statusLine(statusEl, msg, true);
		};
		var showRegLogTail = function(fallback) {
			callRegisterLog().then(function(d) {
				var tail = (d && d.log) ? d.log.slice(-1200) : '';
				regDone(false, fallback + (tail ? ' Лог: ' + tail : ''));
			}).catch(function() {
				regDone(false, fallback);
			});
		};
		var regPoll = function() {
			callRRWS().then(function(st) {
				if (st && st.registering) {
					var sec = Math.round((Date.now() - regState.startedAt) / 1000);
					statusLine(statusEl, 'Регистрация... ' + sec + ' с');
					regState.poll = window.setTimeout(regPoll, 2000);
					return;
				}
				if (st && st.registered) {
					// renew-style run: the account was already present, so a result
					// with an UNCHANGED id means the new registration failed
					if (regState.oldId && st.id === regState.oldId) {
						renderAccount(st);
						showRegLogTail('Перерегистрация не завершилась.');
						return;
					}
					renderAccount(st);
					refreshConf();
					regDone(true, 'Аккаунт зарегистрирован.');
					return;
				}
				// no account and no registration running => it failed
				renderAccount(st);
				showRegLogTail('Регистрация не завершилась.');
			}).catch(function(e) {
				console.error('[rrws] reg poll err', e.message);
				callRRWS().then(renderAccount).catch(function() {});
				regDone(false, 'Ошибка проверки регистрации: ' + e.message);
			});
		};
		var regStart = function(oldId) {
			regState.startedAt = Date.now();
			regState.oldId = oldId || null;
			stopRegPoll();
			startLogAutoRefresh();
			lockScanButtons(true);
			// registration "плашка" on the account badge while wregister.sh runs
			accStatusLabel.textContent = 'Регистрация...';
			accStatusLabel.className = 'label';
			accStatusLabel.style.background = '#f0ad4e';
			accStatusLabel.style.color = '#fff';
			statusLine(statusEl, 'Регистрация...');
			regState.poll = window.setTimeout(regPoll, 2000);
		};

		var regBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Зарегистрировать WARP');
		regBtn.addEventListener('click', function() {
			console.log('[rrws] register click');
			callRegister().then(function(res) {
				console.log('[rrws] register:', JSON.stringify(res));
				if (res && res.error) {
					statusLine(statusEl, 'Регистрация не удалась: ' + res.error, true);
					return;
				}
				regStart(null);
			}).catch(function(e) {
				console.error('[rrws] register err', e.message);
				statusLine(statusEl, 'Ошибка запуска регистрации: ' + e.message, true);
			});
		});
		accBtns.appendChild(regBtn);

		// refresh .conf key material after the account's identity changed
		var refreshConf = function() {
			callConfBase().then(function(base) {
				console.log('[rrws] confBase refreshed:', JSON.stringify(base));
				confData = base;
			}).catch(function(e) {
				console.error('[rrws] confBase refresh error', e);
			});
		};

		var renewBtn = E('button', { 'class': 'btn cbi-button cbi-button-action', 'type': 'button' }, 'Перерегистрировать');
		renewBtn.addEventListener('click', function() {
			if (!window.confirm('Запросить НОВЫЙ аккаунт WARP?\nАккаунт на роутере заменится на новый. Старые ключи останутся рабочими (Cloudflare их не отзывает).'))
				return;
			console.log('[rrws] renew click');
			callRRWS().then(function(st) {
				var oldId = (st && st.id) ? st.id : null;
				return callRenewAccount().then(function(res) {
					console.log('[rrws] renew:', JSON.stringify(res));
					if (res && res.error) {
						statusLine(statusEl, 'Перерегистрация не удалась: ' + res.error, true);
						return;
					}
					regStart(oldId);
				});
			}).catch(function(e) {
				console.error('[rrws] renew err', e.message);
				statusLine(statusEl, 'Ошибка запуска перерегистрации: ' + e.message, true);
			});
		});
		accBtns.appendChild(renewBtn);

		var delBtn = E('button', { 'class': 'btn cbi-button cbi-button-negative', 'type': 'button' }, 'Удалить аккаунт');
		delBtn.addEventListener('click', function() {
			if (!window.confirm('Удалить аккаунт WARP с роутера?\nВыданные ранее ключи останутся рабочими, но скан на роутере будет невозможен до новой регистрации.'))
				return;
			console.log('[rrws] delete click');
			startLogAutoRefresh();
			delBtn.disabled = true;
			delBtn.textContent = 'Удаление...';
			callDeleteAccount().then(function(res) {
				console.log('[rrws] delete:', JSON.stringify(res));
				renderAccount(res && res.account);
				refreshConf();
				delBtn.disabled = false;
				delBtn.textContent = 'Удалить аккаунт';
				stopLogAutoRefresh();
				refreshLog();
				if (res && res.error)
					statusLine(statusEl, 'Не удалось удалить: ' + res.error, true);
				else if (res && res.deleted)
					statusLine(statusEl, 'Аккаунт удалён.');
				else
					statusLine(statusEl, 'Не удалось удалить аккаунт (файл отсутствует?).', true);
			}).catch(function(e) {
				console.error('[rrws] delete error', e);
				statusLine(statusEl, 'Ошибка удаления: ' + e.message, true);
				delBtn.disabled = false;
				delBtn.textContent = 'Удалить аккаунт';
				stopLogAutoRefresh();
				refreshLog();
			});
		});
		accBtns.appendChild(delBtn);

		// only register/renew/delete make sense when the account file is missing
		var accRegistered = false;
		// scan buttons are useless without a registered WARP account, so they
		// stay disabled until account status flips to registered
		var updateScanAuth = function() {
			if (scanBtn) scanBtn.disabled = !accRegistered;
		};
		var setAccButtons = function(registered) {
			accRegistered = registered;
			regBtn.style.display = registered ? 'none' : '';
			renewBtn.style.display = registered ? '' : 'none';
			delBtn.style.display = registered ? '' : 'none';
			updateScanAuth();
		};

		callRRWS().then(function(st) {
			renderAccount(st);
			// pick up a registration still running on the router after a reload
			if (st && st.registering)
				regStart(null);
		}).catch(function(e) {
			accHint.textContent = 'Ошибка получения аккаунта: ' + e.message;
		});

		callConfBase().then(function(base) {
			console.log('[rrws] confBase:', JSON.stringify(base));
			confData = base;
		}).catch(function(e) {
			console.error('[rrws] confBase error', e);
		});

		// scan form
		var scanSection = E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 14px; border:1px solid #ddd; border-radius:4px; padding:10px 12px' });
		scanSection.appendChild(E('h3', {}, 'Сканирование эндпоинтов'));

		var f = E('div', { 'class': 'cbi-page-actions' });

		// clamp a numeric input to [min,max] when the user edits it (max on a
		// type=number field only validates, it does not stop over-typing).
		// max can be a number or a function returning the current ceiling (for
		// fields whose cap changes dynamically, e.g. speed test endpoints).
		var clampInput = function(input, min, max) {
			input.addEventListener('change', function() {
				var m = (typeof max === 'function') ? max() : max;
				var v = parseInt(input.value, 10);
				if (isNaN(v)) v = min;
				input.value = Math.max(min, Math.min(m, v));
			});
		};

		var hostsInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-hosts',
			value: '500', min: '1', max: '4318', style: 'width: 70px'
		});
		clampInput(hostsInput, 1, 4318);
		scanSection.appendChild(E('label', { 'for': 'ws-hosts' }, 'Хостов (весь пул: 4318): '));
		scanSection.appendChild(hostsInput);
		scanSection.appendChild(document.createTextNode(' '));

		var timeoutInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-timeout',
			value: '3', min: '1', max: '10', style: 'width: 70px'
		});
		clampInput(timeoutInput, 1, 10);
		scanSection.appendChild(E('label', { 'for': 'ws-timeout' }, ' Таймаут (сек): '));
		scanSection.appendChild(timeoutInput);
		scanSection.appendChild(document.createTextNode(' '));

		var jobsInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-jobs',
			value: '50', min: '1', max: '50', style: 'width: 70px'
		});
		clampInput(jobsInput, 1, 50);
		scanSection.appendChild(E('label', { 'for': 'ws-jobs' }, ' Потоков (1-50): '));
		scanSection.appendChild(jobsInput);
		scanSection.appendChild(document.createTextNode(' '));

		var progressEl = E('div', { 'style': 'display:none; position:relative; margin-top:8px; height:18px; background:#f0f0f0; border:1px solid #ccc; border-radius:3px; overflow:hidden' });
		var progressBar = E('div', { 'role': 'progressbar', 'style': 'width:0%; height:100%; background:#1e88e5; transition:width .4s' });
		var progressLabel = E('div', { 'style': 'position:absolute; top:1px; left:50%; transform:translateX(-50%); padding:0 6px; background:rgba(0,0,0,0.55); color:#fff; border-radius:3px; font-weight:bold; font-size:12px; line-height:14px; text-align:center; white-space:nowrap' });
		progressEl.appendChild(progressBar);
		progressEl.appendChild(progressLabel);

		var setProgress = function(st) {
			var pct = st && st.percent != null ? st.percent : 0;
			var txt = '';
			if (st && st.running) {
				if (st.phaseName === 'phase1')
					txt = 'Фаза 1: перебор ' + (st.scanned || 0) + '/' + (st.total || 0) + ' хостов, активно: ' + (st.alive || 0);
				else if (st.phaseName === 'phase2')
					txt = 'Фаза 2: замеры пинга и метаданных, обработано ' + (st.scanned || 0) + '/' + (st.alive || 0);
				else if (st.phaseName === 'discovery')
					txt = 'Discovery Mode: проверяю порты ' + (st.discDone || 0) + '/' + (st.discTotal || 0) + '...';
				else
					txt = 'Сканирование... ' + (st.phase || '');
				txt += ' [' + pct + '%]';
			}
			progressBar.style.width = pct + '%';
			progressLabel.textContent = pct + '%';
			statusLine(statusEl, txt || 'Готово.');
		};

		var scanButtons = [];
		// account buttons must not change identity while a scan is running:
		// the running wscan.sh already holds the old keys, and a delete/renew
		// mid-scan would produce broken .conf afterwards.
		scanButtons.push(regBtn, renewBtn, delBtn);

		var lockButtons = function(lock) {
			for (var i = 0; i < scanButtons.length; i++)
				scanButtons[i].disabled = lock;
			if (!lock) updateScanAuth();
		};

		// scan polling is shared: used after starting a scan and to pick up a
		// scan that is still running after a page reload
		var scanTimer = null;
		var scanActive = false;
		var pendingResult = false;
		var scanPoll = function() {
			callScanStatus().then(function(st) {
				console.log('[rrws] status:', JSON.stringify(st));
				if (st.running) {
					setProgress(st);
					scanActive = true;
					scanTimer = window.setTimeout(scanPoll, 3000);
				} else {
					scanActive = false;
					progressEl.style.display = 'none';
					progressBar.style.width = '0%';
					progressLabel.textContent = '0%';
					statusLine(statusEl, 'Готово.');
					lockButtons(false);
					stopBtn.style.display = 'none';
					stopLogAutoRefresh();
					refreshLog();
					refreshSpeedAvailable();
					pendingResult = true;
					return callScanResult().then(function(data) {
						pendingResult = false;
						console.log('[rrws] result:', JSON.stringify(data));
						resultEl.innerHTML = '';
						if (data && data.results && data.results.length) {
							resultEl.appendChild(renderTable(data.results, data.updated, data.saved));
						} else {
							resultEl.appendChild(E('p', { 'class': 'text-muted' }, 'Рабочих эндпоинтов не найдено.'));
						}
					});
				}
			}).catch(function(e) {
				// a transient RPC failure must not kill the poll loop: the scan
				// keeps running on the router, so keep polling instead of freezing.
				// but only if the user hasn't pressed Stop meanwhile (that sets
				// scanActive=false) and there's no pending result to render,
				// otherwise a late error would resurrect the loop
				console.error('[rrws] status err', e);
				statusLine(statusEl, 'Ошибка статуса: ' + e.message, true);
				if (scanActive || pendingResult)
					scanTimer = window.setTimeout(scanPoll, 3000);
			});
		};
		var scanOnVisible = function() {
			if (!scanActive) return;
			if (scanTimer) { window.clearTimeout(scanTimer); scanTimer = null; }
			scanPoll();
		};
		var startScanPolling = function() {
			window.addEventListener('focus', scanOnVisible);
			document.addEventListener('visibilitychange', function() {
				if (document.visibilityState === 'visible') scanOnVisible();
			});
			scanPoll();
		};

		var startScan = function(mode) {
			console.log('[rrws] scan click', mode);
			var hosts = parseInt(hostsInput.value, 10) || 500;
			var timeout = parseInt(timeoutInput.value, 10) || 3;
			var jobs = parseInt(jobsInput.value, 10) || 50;
			var discover = discInput.checked ? 1 : 0;
			var dhosts = parseInt(discHostsInput.value, 10) || 5;
			var exclude = getExclude();
			var excludeNodes = getExcludeNodes();
			callSaveSettings(hosts, timeout, jobs, discover, dhosts, exclude, excludeNodes);
			resultEl.innerHTML = '';
			statusLine(statusEl, 'Запуск...');
			progressBar.style.width = '0%';
			progressLabel.textContent = '0%';
			progressEl.style.display = '';
			lockButtons(true);
			stopBtn.style.display = '';
			stopBtn.disabled = false;
			stopBtn.textContent = 'Остановить';
			startLogAutoRefresh();
			callScanStart(hosts, timeout, mode, jobs, discover, dhosts, exclude, excludeNodes).then(function(res) {
				console.log('[rrws] scanStart:', JSON.stringify(res));
				if (res.error) {
					statusLine(statusEl, 'Ошибка: ' + res.error, true);
					progressEl.style.display = 'none';
					lockButtons(false);
					stopBtn.style.display = 'none';
					stopLogAutoRefresh();
					refreshLog();
					return;
				}
				statusLine(statusEl, 'Сканирование запущено...');
				startScanPolling();
			}).catch(function(e) {
				console.error('[rrws] scanStart err', e);
				statusLine(statusEl, 'Ошибка запуска: ' + e.message, true);
				progressEl.style.display = 'none';
				lockButtons(false);
			});
		};

		var scanBtns = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:8px 0' });
		scanSection.appendChild(scanBtns);

		var scanBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Найти туннели');
		scanBtn.addEventListener('click', function() { startScan('full'); });
		scanButtons.push(scanBtn);
		scanBtns.appendChild(scanBtn);
		updateScanAuth();

		var stopBtn = E('button', { 'class': 'btn cbi-button cbi-button-negative', 'type': 'button' }, 'Остановить');
		stopBtn.style.display = 'none';
		stopBtn.addEventListener('click', function() {
			console.log('[rrws] stop click');
			stopBtn.disabled = true;
			stopBtn.textContent = 'Остановка...';
			callScanStop().then(function(res) {
				console.log('[rrws] scanStop:', JSON.stringify(res));
				stopBtn.disabled = false;
				stopBtn.textContent = 'Остановить';
				if (res && res.stopped) {
				progressEl.style.display = 'none';
				progressBar.style.width = '0%';
				progressLabel.textContent = '0%';
				statusLine(statusEl, 'Остановлено.');
					lockButtons(false);
					stopBtn.style.display = 'none';
					stopLogAutoRefresh();
					refreshLog();
					return callScanResult().then(function(data) {
						console.log('[rrws] result:', JSON.stringify(data));
						resultEl.innerHTML = '';
						if (data && data.results && data.results.length) {
							resultEl.appendChild(renderTable(data.results, data.updated, data.saved));
						} else {
							resultEl.appendChild(E('p', { 'class': 'text-muted' }, 'Рабочих эндпоинтов не найдено.'));
						}
					});
				}
				statusLine(statusEl, 'Не удалось остановить: ' + (res && res.error), true);
			}).catch(function(e) {
				console.error('[rrws] stop error', e);
				statusLine(statusEl, 'Ошибка остановки: ' + e.message, true);
				stopBtn.disabled = false;
				stopBtn.textContent = 'Остановить';
			});
		});
		scanBtns.appendChild(stopBtn);

		// discovery mode - its own section for clarity, right below the buttons
		var discSection = E('div', { 'class': 'cbi-section', 'style': 'margin-top: 14px; border:1px solid #555; border-radius:4px; padding:10px 12px' });
		discSection.appendChild(E('h3', {}, 'Discovery Mode'));
		discSection.appendChild(E('p', { 'class': 'text-muted', 'style': 'margin:2px 0 8px 0' },
			'Умный поиск портов: проверяет, какие UDP-порты пропускает сеть, и сужает список. Полезно, если 2408 порт заблокирован.'));
		var discRow = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:10px' });
		var discLabel = E('label', { 'for': 'ws-disc', 'style': 'display:inline-flex; align-items:center; cursor:pointer; gap:8px' });
		var discInput = E('input', { 'type': 'checkbox', id: 'ws-disc', 'style': 'width:auto; margin:0; flex:0 0 auto' });
		discLabel.appendChild(discInput);
		discLabel.appendChild(document.createTextNode('Включить Discovery Mode'));
		discRow.appendChild(discLabel);

		var discHostsInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-disc-hosts',
			value: '5', min: '1', max: '10', style: 'width: 50px'
		});
		clampInput(discHostsInput, 1, 10);
		discRow.appendChild(E('label', { 'for': 'ws-disc-hosts' }, 'Пробных хостов (1-10):'));
		discRow.appendChild(discHostsInput);
		discSection.appendChild(discRow);
		scanSection.appendChild(discSection);

		// excluded subnets: native LuCI ui.Dropdown (multi-select, like zeroblock).
		// The pool list comes from the backend (getSettings.subnets) and is added
		// as choices when it arrives.
		var exclWidget = null;   // ui.Dropdown instance
		var exclSection = E('div', { 'class': 'cbi-section', 'style': 'margin-top: 14px; border:1px solid #555; border-radius:4px; padding:10px 12px' });
		exclSection.appendChild(E('h3', {}, 'Исключить подсети'));
		exclSection.appendChild(E('p', { 'class': 'text-muted', 'style': 'margin:2px 0 8px 0' },
			'Отмеченные подсети будут пропущены при сканировании.'));
		scanSection.appendChild(exclSection);

		var getExclude = function() {
			if (!exclWidget) return [];
			var v = exclWidget.getValue();
			return Array.isArray(v) ? v : (v ? [v] : []);
		};
		var buildExcl = function(subnets) {
			if (!subnets || !subnets.length) return;
			// subnet -> label (plain list; grouping by octet is implicit in the
			// natural sort of the pool list the backend already returns)
			var choices = {};
			for (var i = 0; i < subnets.length; i++)
				choices[subnets[i]] = subnets[i];
			exclWidget = new ui.Dropdown([], choices, {
				multiple: true,
				optional: true,
				select_placeholder: 'Исключить подсети...',
				display_items: 3,
				dropdown_items: -1,
				sort: true
			});
			exclSection.appendChild(exclWidget.render());
			// DME checkbox sits BELOW the dropdown, with a clear gap: it is added
			// here (after the dropdown) so the vertical order is stable - if it
			// were appended to exclSection at build time, the async dropdown
			// render would push it above, next to nothing.
			exclSection.appendChild(exclNodeSection);
			// any change re-persists settings
			exclSection.addEventListener('cbi-dropdown-change', function() {
				persistCurrent();
			});
		};

		// exclude DME node: on RU provider networks DME (Moscow) is DPI-filtered,
		// so endpoints landing on it are dropped from the result. Appended inside
		// buildExcl() after the dropdown so it always sits below it with a gap.
		var exclNodeSection = E('div', { 'style': 'margin-top:18px; display:flex; align-items:center; gap:8px' });
		var exclNodeInput = E('input', { 'type': 'checkbox', id: 'ws-excl-node', style: 'margin:0' });
		exclNodeSection.appendChild(exclNodeInput);
		exclNodeSection.appendChild(E('label', { 'for': 'ws-excl-node' }, 'Исключить узел DME (Москва)'));

		// restore persisted scan settings (hosts / timeout / jobs / discovery)
		var persistCurrent = function() {
			var h = parseInt(hostsInput.value, 10) || 500;
			var t = parseInt(timeoutInput.value, 10) || 3;
			var j = parseInt(jobsInput.value, 10) || 50;
			var d = discInput.checked ? 1 : 0;
			var dh = parseInt(discHostsInput.value, 10) || 5;
			callSaveSettings(h, t, j, d, dh, getExclude(), getExcludeNodes());
		};
		hostsInput.addEventListener('change', persistCurrent);
		timeoutInput.addEventListener('change', persistCurrent);
		jobsInput.addEventListener('change', persistCurrent);
		discInput.addEventListener('change', persistCurrent);
		discHostsInput.addEventListener('change', persistCurrent);
		exclNodeInput.addEventListener('change', persistCurrent);

		var getExcludeNodes = function() {
			return exclNodeInput.checked ? [ 'DME' ] : [];
		};

		callGetSettings().then(function(s) {
			if (!s) return;
			if (s.hosts) hostsInput.value = s.hosts;
			if (s.timeout) timeoutInput.value = s.timeout;
			if (s.jobs) jobsInput.value = s.jobs;
			if (s.discover) discInput.checked = !!s.discover;
			if (s.discover_hosts) discHostsInput.value = s.discover_hosts;
			// build the exclusion dropdown from the backend's pool list, then
			// select the ones persisted in settings
			buildExcl(s.subnets);
			if (exclWidget && s.exclude && s.exclude.length)
				exclWidget.setValue(s.exclude);
			if (s.exclude_nodes && s.exclude_nodes.indexOf('DME') >= 0)
				exclNodeInput.checked = true;
		}).catch(function(e) {
			console.error('[rrws] getSettings err', e.message);
		});

		scanSection.appendChild(statusEl);
		scanSection.appendChild(progressEl);
		scanSection.appendChild(resultEl);
		scanSection.appendChild(logBox());
		container.appendChild(scanSection);

		// speed test section
		var speedSection = E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 14px; border:1px solid #ddd; border-radius:4px; padding:10px 12px' });
		speedSection.appendChild(E('h3', {}, 'Тест скорости туннелей'));
		speedSection.appendChild(E('p', { 'class': 'text-muted', 'style': 'margin:2px 0 8px 0' },
			'Меряет download и upload через уже найденные эндпоинты (первые рабочие из результата скана). Топ-количество можно выбрать.'));
		speedSection.appendChild(E('p', { 'class': 'text-muted', 'style': 'margin:0 0 8px 0' },
			'Время на эндпоинт — это потолок замера; сверху добавляется подъём туннеля и ожидание handshake (до 8с). Тест носит справочный характер.'));

		var speedCountInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-speed-count',
			value: '5', min: '1', max: '40', style: 'width: 70px'
		});
		var speedCountCap = 40;
		clampInput(speedCountInput, 1, function() { return speedCountCap; });
		var speedCountLabel = E('label', { 'for': 'ws-speed-count' }, 'Эндпоинтов (1-40): ');
		speedSection.appendChild(speedCountLabel);
		speedSection.appendChild(speedCountInput);
		speedSection.appendChild(document.createTextNode(' '));

		var speedTimeInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-speed-time',
			value: '12', min: '10', max: '30', style: 'width: 70px'
		});
		clampInput(speedTimeInput, 10, 30);
		speedSection.appendChild(E('label', { 'for': 'ws-speed-time' }, ' Время замера на эндпоинт (сек, мин 10): '));
		speedSection.appendChild(speedTimeInput);
		speedSection.appendChild(document.createTextNode(' '));

		// cap the endpoint count at what the scan actually found, so the user
		// can't request more tunnels than exist
		var refreshSpeedAvailable = function() {
			callSpeedAvailable().then(function(d) {
				var avail = (d && d.available) ? parseInt(d.available, 10) : 0;
				if (avail < 1) {
					speedCountCap = 40;
					speedCountInput.max = '40';
					speedCountLabel.textContent = 'Эндпоинтов (1-40): ';
					return;
				}
				var cap = Math.min(avail, 40);
				speedCountCap = cap;
				speedCountInput.max = String(cap);
				speedCountLabel.textContent = 'Эндпоинтов (1-' + cap + '): ';
				var v = parseInt(speedCountInput.value, 10) || 1;
				if (v > cap)
					speedCountInput.value = String(cap);
			}).catch(function(e) {
				console.error('[rrws] speedAvailable err', e.message);
			});
		};
		refreshSpeedAvailable();

		var speedBtns = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:8px 0' });
		speedSection.appendChild(speedBtns);

		var speedBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Запустить тест скорости');
		speedBtns.appendChild(speedBtn);

		var speedStopBtn = E('button', { 'class': 'btn cbi-button cbi-button-negative', 'type': 'button' }, 'Остановить');
		speedStopBtn.style.display = 'none';
		speedBtns.appendChild(speedStopBtn);

		var speedStatusEl = E('p', { 'class': 'text-muted', 'style': 'margin:4px 0' }, '');
		speedSection.appendChild(speedStatusEl);

		var speedProgressEl = E('div', { 'style': 'display:none; position:relative; margin:8px 0; height:18px; background:#f0f0f0; border:1px solid #ccc; border-radius:3px; overflow:hidden' });
		var speedProgressBar = E('div', { 'role': 'progressbar', 'style': 'width:0%; height:100%; background:#1e88e5; transition:width .4s' });
		var speedProgressLabel = E('div', { 'style': 'position:absolute; top:1px; left:50%; transform:translateX(-50%); padding:0 6px; background:rgba(0,0,0,0.55); color:#fff; border-radius:3px; font-weight:bold; font-size:12px; line-height:14px; text-align:center; white-space:nowrap' });
		speedProgressEl.appendChild(speedProgressBar);
		speedProgressEl.appendChild(speedProgressLabel);
		speedSection.appendChild(speedProgressEl);

		var speedResultEl = E('div', {});
		speedSection.appendChild(speedResultEl);

		var fmtSpeed = function(kbps) {
			kbps = parseInt(kbps, 10) || 0;
			if (kbps >= 1000)
				return (kbps / 1000).toFixed(2) + ' Мбит/с';
			return kbps + ' кбит/с';
		};

		var renderSpeed = function(items) {
			speedResultEl.innerHTML = '';
			if (!items || !items.length) {
				speedResultEl.appendChild(E('p', { 'class': 'text-muted' }, 'Нет результатов теста скорости.'));
				return;
			}
			// fastest tunnels first: by download speed, upload as tiebreak
			items = items.slice().sort(function(a, b) {
				return (b.dl - a.dl) || (b.ul - a.ul);
			});
			for (var si = 0; si < items.length; si++) {
				var it = items[si];
				var row = E('div', { 'class': 'cbi-section', 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:4px 0; padding:6px 8px; border:1px solid #444; border-radius:4px' });
				row.appendChild(E('code', { 'style': 'flex:1 1 auto; min-width:150px; word-break:break-all' }, it.endpoint || '?'));
				var nm = (it.node || '') + (it.country ? ' ' + it.country : '');
				if (nm)
					row.appendChild(E('span', { 'class': 'text-muted', 'style': 'margin-right:8px' }, nm));
				var sd = (it.rtt && it.rtt != '?' ? it.rtt + ' мс  ' : '') + '▼ ' + fmtSpeed(it.dl) + '  ▲ ' + fmtSpeed(it.ul);
				row.appendChild(E('span', { 'class': 'text-muted' }, sd));
				var btnGroup = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin-left:auto; flex:0 0 auto' });
				var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Скопировать .conf');
				btn.addEventListener('click', function(endpoint, that) {
					return function() {
						if (!confData) { statusLine(speedStatusEl, 'Нет параметров конфига', true); return; }
						copyToClipboard(makeConf(confData, endpoint), that);
					};
				}(it.endpoint, btn));
				btnGroup.appendChild(btn);
				row.appendChild(btnGroup);
				speedResultEl.appendChild(row);
			}
		};

		// block the scan/account buttons while the speed test is running
		var lockScanButtons = function(lock) {
			var other = [ scanBtn, regBtn, renewBtn, delBtn ];
			for (var i = 0; i < other.length; i++)
				if (other[i]) other[i].disabled = lock;
			if (!lock) updateScanAuth();
		};

		// speed polling is shared: used after starting the test and to pick up a
		// test that is still running after a page reload
		var speedTimer = null;
		var speedActive = false;
		var speedPoll = function() {
			callSpeedStatus().then(function(st) {
				console.log('[rrws] speedStatus:', JSON.stringify(st));
				if (st && st.running) {
					speedActive = true;
					var txt = 'Тест скорости... ';
					if (st.current)
						txt += (st.index || 0) + '/' + (st.total || 0) + ' — ' + st.current;
					else
						txt += st.phase || '';
					speedStatusEl.textContent = txt;
					var pct = st.total > 0 ? Math.floor(st.index * 100 / st.total) : 0;
					if (pct < 0) pct = 0;
					speedProgressEl.style.display = '';
					speedProgressBar.style.width = pct + '%';
					speedProgressLabel.textContent = pct + '%';
					speedTimer = window.setTimeout(speedPoll, 2000);
				} else {
					speedActive = false;
					speedStatusEl.textContent = 'Готово.';
					speedProgressEl.style.display = 'none';
					speedProgressBar.style.width = '0%';
					speedBtn.disabled = false;
					speedStopBtn.style.display = 'none';
					lockScanButtons(false);
					return callSpeedResult().then(function(d) {
						console.log('[rrws] speedResult:', JSON.stringify(d));
						speedResultEl.innerHTML = '';
						if (d && d.results && d.results.length)
							renderSpeed(d.results);
						else
							speedResultEl.appendChild(E('p', { 'class': 'text-muted' }, 'Результатов нет.'));
					});
				}
			}).catch(function(e) {
				console.error('[rrws] speedStatus err', e.message);
				speedStatusEl.textContent = 'Ошибка статуса: ' + e.message;
			});
		};
		var speedOnVisible = function() {
			if (!speedActive) return;
			if (speedTimer) { window.clearTimeout(speedTimer); speedTimer = null; }
			speedPoll();
		};
		var startSpeedPolling = function() {
			window.addEventListener('focus', speedOnVisible);
			document.addEventListener('visibilitychange', function() {
				if (document.visibilityState === 'visible') speedOnVisible();
			});
			speedPoll();
		};

		speedBtn.addEventListener('click', function() {
			var count = parseInt(speedCountInput.value, 10) || 5;
			count = Math.max(1, Math.min(count, speedCountCap));
			speedCountInput.value = String(count);
			var duration = parseInt(speedTimeInput.value, 10) || 12;
			console.log('[rrws] speed click', count, duration);
			speedResultEl.innerHTML = '';
			speedStatusEl.textContent = 'Запуск...';
			speedProgressEl.style.display = '';
			speedProgressBar.style.width = '0%';
			speedProgressLabel.textContent = '0%';
			speedBtn.disabled = true;
			speedStopBtn.style.display = '';
			speedStopBtn.disabled = false;
			speedStopBtn.textContent = 'Остановить';
			callSpeedStart(count, duration).then(function(res) {
				console.log('[rrws] speedStart:', JSON.stringify(res));
				if (res && res.error) {
					speedStatusEl.textContent = 'Ошибка: ' + res.error;
					speedStatusEl.classList.add('text-danger');
					speedBtn.disabled = false;
					speedStopBtn.style.display = 'none';
					speedProgressEl.style.display = 'none';
					speedProgressBar.style.width = '0%';
					speedProgressLabel.textContent = '0%';
					return;
				}
				lockScanButtons(true);
				if (res && res.available && res.count && res.count < res.available)
					speedStatusEl.textContent = 'Тест скорости запущен... (найдено рабочих: ' + res.available + ', тестирую: ' + res.count + ')';
				else
					speedStatusEl.textContent = 'Тест скорости запущен...';
				startSpeedPolling();
			}).catch(function(e) {
				console.error('[rrws] speedStart err', e.message);
				speedStatusEl.textContent = 'Ошибка запуска: ' + e.message;
				speedStatusEl.classList.add('text-danger');
				speedBtn.disabled = false;
				speedStopBtn.style.display = 'none';
				speedProgressEl.style.display = 'none';
				speedProgressBar.style.width = '0%';
				speedProgressLabel.textContent = '0%';
			});
		});

		speedStopBtn.addEventListener('click', function() {
			speedStopBtn.disabled = true;
			speedStopBtn.textContent = 'Остановка...';
			callSpeedStop().then(function(res) {
				console.log('[rrws] speedStop:', JSON.stringify(res));
				speedStopBtn.disabled = false;
				speedStopBtn.textContent = 'Остановить';
				speedStatusEl.textContent = 'Остановлено.';
				speedProgressEl.style.display = 'none';
				speedProgressBar.style.width = '0%';
				speedBtn.disabled = false;
				speedStopBtn.style.display = 'none';
				lockScanButtons(false);
				return callSpeedResult().then(function(d) {
					speedResultEl.innerHTML = '';
					if (d && d.results && d.results.length)
						renderSpeed(d.results);
					else
						speedResultEl.appendChild(E('p', { 'class': 'text-muted' }, 'Результатов нет.'));
				});
			}).catch(function(e) {
				console.error('[rrws] speedStop err', e.message);
				speedStatusEl.textContent = 'Ошибка остановки: ' + e.message;
				speedStopBtn.disabled = false;
				speedStopBtn.textContent = 'Остановить';
			});
		});

		// lock speed controls while the account is missing / scan is running
		speedBtn.disabled = true;
		scanButtons.push(speedBtn, speedStopBtn);
		var origUpdateScanAuth = updateScanAuth;
		updateScanAuth = function() {
			origUpdateScanAuth();
			speedBtn.disabled = !accRegistered;
		};
		container.appendChild(speedSection);

		// a page reload doesn't stop the scan/speed test on the router, so pick
		// up a still-running process and resume its progress UI
		var resumeScanUI = function() {
			callScanStatus().then(function(st) {
				if (!st || !st.running) return;
				progressEl.style.display = '';
				statusLine(statusEl, 'Сканирование продолжается...');
				setProgress(st);
				lockButtons(true);
				stopBtn.style.display = '';
				stopBtn.disabled = false;
				stopBtn.textContent = 'Остановить';
				startLogAutoRefresh();
				startScanPolling();
			}).catch(function(e) {
				console.error('[rrws] resume scan err', e.message);
			});
		};
		var resumeSpeedUI = function() {
			callSpeedStatus().then(function(st) {
				if (!st || !st.running) return;
				lockScanButtons(true);
				speedBtn.disabled = true;
				speedStopBtn.style.display = '';
				speedStopBtn.disabled = false;
				speedStopBtn.textContent = 'Остановить';
				speedProgressEl.style.display = '';
				startSpeedPolling();
			}).catch(function(e) {
				console.error('[rrws] resume speed err', e.message);
			});
		};

		// show the previous scan's saved results (if any) from the router
		callScanResult().then(function(data) {
			if (data && data.results && data.results.length)
				resultEl.appendChild(renderTable(data.results, data.updated, data.saved));
		}).catch(function(e) {
			console.error('[rrws] initial scanResult err', e.message);
		});

		// show the last speed test's results (if any) from the router
		callSpeedResult().then(function(data) {
			if (data && data.results && data.results.length) {
				renderSpeed(data.results);
				speedStatusEl.textContent = 'Показаны результаты последнего теста скорости.';
			}
		}).catch(function(e) {
			console.error('[rrws] initial speedResult err', e.message);
		});

		// resume the progress UI for a scan / speed test still running on the router
		resumeScanUI();
		resumeSpeedUI();

		// honor the persisted auto-refresh checkbox even when idle
		startLogAutoRefresh();

		console.log('[rrws] render done');
		return container;
	}
});