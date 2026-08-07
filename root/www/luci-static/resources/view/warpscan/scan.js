'use strict';
'require rpc';
'require ui';

console.log('[warpscan] view loading');

var callWarpScan = rpc.declare({
	object: 'luci.warpscan',
	method: 'accountStatus'
});

var callRegister = rpc.declare({
	object: 'luci.warpscan',
	method: 'register'
});

var callConfBase = rpc.declare({
	object: 'luci.warpscan',
	method: 'confBase'
});

var callScanStart = rpc.declare({
	object: 'luci.warpscan',
	method: 'scanStart',
	params: [ 'hosts', 'timeout', 'mode', 'jobs' ]
});

var callScanStatus = rpc.declare({
	object: 'luci.warpscan',
	method: 'scanStatus'
});

var callScanResult = rpc.declare({
	object: 'luci.warpscan',
	method: 'scanResult'
});

var callScanLog = rpc.declare({
	object: 'luci.warpscan',
	method: 'scanLog'
});

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
	// modern API first
	if (navigator.clipboard && navigator.clipboard.writeText) {
		navigator.clipboard.writeText(text).then(function() {
			btn.textContent = 'Скопировано';
			window.setTimeout(function() { btn.textContent = 'Скопировать .conf'; }, 2000);
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
		btn.textContent = 'Скопировано';
	} catch (e) {
		btn.textContent = 'Ошибка копирования';
	}
	document.body.removeChild(ta);
	window.setTimeout(function() { btn.textContent = 'Скопировать .conf'; }, 2000);
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
	var title = E('h3', {}, 'Результаты сканирования');
	box.appendChild(title);
	if (updated) {
		var t = saved ? 'Сохранённый скан от ' : 'Скан от ';
		box.appendChild(E('p', { 'class': 'text-muted', 'style': 'margin:2px 0 8px 0' },
			t + new Date(updated * 1000).toLocaleString()));
	}

	if (results.length) {
		var best = results[0].endpoint;
		var topBar = E('div', { 'style': 'display:flex; align-items:center; flex-wrap:wrap; margin:8px 0' });
		box.appendChild(topBar);

		var bestBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' },
			'Скопировать лучший .conf (' + best + ')');
		bestBtn.addEventListener('click', function() {
			if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
			copyToClipboard(makeConf(confData, best), bestBtn);
		});
		topBar.appendChild(bestBtn);
		topBar.appendChild(document.createTextNode(' '));

		var viewBtnT = E('button', { 'class': 'btn cbi-button', 'type': 'button' }, 'Показать .conf');
		viewBtnT.addEventListener('click', function() {
			if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
			confPreBox(topBar, 'ws-pre-best', confData, best);
		});
		topBar.appendChild(viewBtnT);
		topBar.appendChild(document.createTextNode(' '));

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
			var a = E('a', { 'href': url, 'download': 'warpscan-configs.txt' });
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			window.setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
		});
		topBar.appendChild(dlBtn);
	}

	// one row per endpoint: label on the left, copy button right beside it.
	// a simple block list (not a wide table) so the buttons are always visible.
	for (var i = 0; i < results.length; i++) {
		var r = results[i];
		var row = E('div', { 'class': 'cbi-section', 'style': 'display:flex; align-items:center; flex-wrap:wrap; margin:4px 0; padding:6px 8px; border:1px solid #444; border-radius:4px' });
		var ep = E('code', { 'style': 'flex:1 1 auto; min-width:150px; word-break:break-all' }, r.endpoint);
		row.appendChild(ep);
		row.appendChild(E('span', { 'class': 'text-muted', 'style': 'margin:0 8px' },
			(r.node || '') + ' ' + (r.country || '') + (r.ping != null ? ' ' + r.ping + ' ms' : '')));
		if (i == 0)
			row.appendChild(E('span', { 'class': 'label label-success' }, 'BEST'));
		var btn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Скопировать .conf');
		btn.addEventListener('click', function(endpoint, that) {
			return function() {
				if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
				copyToClipboard(makeConf(confData, endpoint), that);
			};
		}(r.endpoint, btn));
		row.appendChild(btn);

		var viewBtn = E('button', { 'class': 'btn cbi-button', 'type': 'button' }, 'Показать .conf');
		row.appendChild(viewBtn);
		viewBtn.addEventListener('click', function(rowEl, endpoint) {
			return function() {
				if (!confData) { statusLine(statusElCurrent, 'Нет параметров конфига', true); return; }
				confPreBox(rowEl, 'ws-pre-row-pre', confData, endpoint);
			};
		}(row, r.endpoint));
		box.appendChild(row);
	}
	return box;
}

var logEl = null;
var logRefresh = null;

function logBox() {
	var box = E('div', { 'class': 'cbi-section', 'style': 'margin-top:12px' });
	box.appendChild(E('h3', {}, 'Логи'));
	logEl = E('pre', {
		'id': 'ws-log',
		'style': 'white-space:pre-wrap; word-break:break-all; background:#111; color:#9f9; padding:8px; border-radius:4px; font-size:11px; max-height:260px; overflow:auto; margin:0 0 8px 0'
	}, '(пока пусто)');
	box.appendChild(logEl);
	var btn = E('button', { 'class': 'btn cbi-button', 'type': 'button' }, 'Обновить лог');
	btn.addEventListener('click', refreshLog);
	box.appendChild(btn);
	box.appendChild(document.createTextNode(' '));
	var clearBtn = E('button', { 'class': 'btn cbi-button', 'type': 'button' }, 'Очистить');
	clearBtn.addEventListener('click', function() {
		if (logEl) logEl.textContent = '(пока пусто)';
	});
	box.appendChild(clearBtn);
	return box;
}

function refreshLog() {
	callScanLog().then(function(d) {
		if (!logEl) return;
		var txt = '';
		if (d && d.wscan) txt += '--- wscan.log ---\n' + d.wscan;
		if (d && d.rpc) txt += '\n\n--- rpcd log ---\n' + d.rpc;
		logEl.textContent = txt || '(пока пусто)';
		logEl.scrollTop = logEl.scrollHeight;
	}).catch(function(e) {
		if (logEl) logEl.textContent = 'Ошибка чтения лога: ' + e.message;
	});
}

function startLogAutoRefresh() {
	if (logRefresh)
		window.clearInterval(logRefresh);
	logRefresh = window.setInterval(refreshLog, 3000);
}

function stopLogAutoRefresh() {
	if (logRefresh) {
		window.clearInterval(logRefresh);
		logRefresh = null;
	}
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

		// account info
		var accSection = E('div', { 'class': 'cbi-section', 'style': 'margin-bottom: 12px' });
		var accText = E('p', { 'class': 'text-muted' }, 'Предупреждение: невозможно');
		var accDetail = E('p', { 'class': 'text-muted', 'id': 'acc-detail' });
		accSection.appendChild(accText);
		accSection.appendChild(accDetail);
		container.appendChild(accSection);

		var renderAccount = function(account) {
			console.log('[warpscan] account:', JSON.stringify(account));
			accText.innerHTML = '';
			accDetail.innerHTML = '';
			if (account && account.registered) {
				accText.appendChild(E('strong', {}, 'Аккаунт WARP зарегистрирован'));
				var s = E('span', {}, ' Peer: ');
				s.appendChild(E('code', {}, account.peer_public_key || ''));
				s.appendChild(document.createTextNode('  Address: '));
				s.appendChild(E('code', {}, account.address || ''));
				accDetail.appendChild(s);
			} else {
				accText.textContent = 'Аккаунт WARP не зарегистрирован.';
			}
		};

		var regBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Зарегистрировать WARP');
		regBtn.addEventListener('click', function() {
			console.log('[warpscan] register click');
			regBtn.disabled = true;
			regBtn.textContent = 'Регистрация...';
			callRegister().then(function(res) {
				console.log('[warpscan] register:', JSON.stringify(res));
				renderAccount(res && res.account);
				regBtn.disabled = false;
				regBtn.textContent = 'Зарегистрировать WARP';
				if (res && res.error)
					statusLine(statusEl, 'Регистрация не удалась: ' + res.error, true);
				else if (res && res.output && res.output.indexOf('failed') >= 0)
					statusLine(statusEl, 'Регистрация не удалась: ' + res.output, true);
			}).catch(function(e) {
				console.error('[warpscan] register error', e);
				statusLine(statusEl, 'Ошибка регистрации: ' + e.message, true);
				regBtn.disabled = false;
				regBtn.textContent = 'Зарегистрировать WARP';
			});
		});
		accSection.appendChild(regBtn);

		callWarpScan().then(renderAccount).catch(function(e) {
			accText.textContent = 'Ошибка получения аккаунта: ' + e.message;
		});

		callConfBase().then(function(base) {
			console.log('[warpscan] confBase:', JSON.stringify(base));
			confData = base;
		}).catch(function(e) {
			console.error('[warpscan] confBase error', e);
		});

		// scan form
		var scanSection = E('div', { 'class': 'cbi-section' });
		scanSection.appendChild(E('h3', {}, 'Сканирование эндпоинтов'));

		var f = E('div', { 'class': 'cbi-page-actions' });

		var hostsInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-hosts',
			value: '40', min: '1', max: '600', style: 'width: 70px'
		});
		scanSection.appendChild(E('label', { 'for': 'ws-hosts' }, 'Хостов: '));
		scanSection.appendChild(hostsInput);
		scanSection.appendChild(document.createTextNode(' '));

		var timeoutInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-timeout',
			value: '3', min: '1', max: '10', style: 'width: 70px'
		});
		scanSection.appendChild(E('label', { 'for': 'ws-timeout' }, ' Таймаут (сек): '));
		scanSection.appendChild(timeoutInput);
		scanSection.appendChild(document.createTextNode(' '));

		var jobsInput = E('input', {
			'class': 'cbi-input-text', 'type': 'number', id: 'ws-jobs',
			value: '3', min: '1', max: '6', style: 'width: 70px'
		});
		scanSection.appendChild(E('label', { 'for': 'ws-jobs' }, ' Потоков (1-6): '));
		scanSection.appendChild(jobsInput);
		scanSection.appendChild(document.createTextNode(' '));

		var progressEl = E('div', { 'style': 'display:none; margin-top:8px; height:18px; background:#f0f0f0; border:1px solid #ccc; border-radius:3px; overflow:hidden' });
		var progressBar = E('div', { 'role': 'progressbar', 'style': 'width:0%; height:100%; background:#1e88e5; color:#fff; font-size:11px; line-height:18px; text-align:center; transition:width .4s' });
		progressEl.appendChild(progressBar);

		var setProgress = function(st) {
			var pct = st && st.percent != null ? st.percent : 0;
			var txt = '';
			if (st && st.running) {
				if (st.phaseName === 'phase1')
					txt = 'Фаза 1: перебор ' + (st.scanned || 0) + '/' + (st.total || 0) + ' хостов, активно: ' + (st.alive || 0);
				else if (st.phaseName === 'phase2')
					txt = 'Фаза 2: замеры пинга и метаданных, обработано ' + (st.scanned || 0) + '/' + (st.alive || 0);
				else
					txt = 'Сканирование... ' + (st.phase || '');
				txt += ' [' + pct + '%]';
			}
			progressBar.style.width = pct + '%';
			progressBar.textContent = pct ? pct + '%' : '';
			statusLine(statusEl, txt || 'Готово.');
		};

		var scanButtons = [];

		var lockButtons = function(lock) {
			for (var i = 0; i < scanButtons.length; i++)
				scanButtons[i].disabled = lock;
		};

		var startScan = function(mode) {
			console.log('[warpscan] scan click', mode);
			var hosts = parseInt(hostsInput.value, 10) || 40;
			var timeout = parseInt(timeoutInput.value, 10) || 3;
			var jobs = parseInt(jobsInput.value, 10) || 3;
			resultEl.innerHTML = '';
			statusLine(statusEl, 'Запуск...');
			progressBar.style.width = '0%';
			progressBar.textContent = '';
			progressEl.style.display = '';
			lockButtons(true);
			startLogAutoRefresh();
			callScanStart(hosts, timeout, mode, jobs).then(function(res) {
				console.log('[warpscan] scanStart:', JSON.stringify(res));
				if (res.error) {
					statusLine(statusEl, 'Ошибка: ' + res.error, true);
					progressEl.style.display = 'none';
					lockButtons(false);
					stopLogAutoRefresh();
					refreshLog();
					return;
				}
				statusLine(statusEl, 'Сканирование запущено...');

				var timer = null;
				var active = false;

				var poll = function() {
					callScanStatus().then(function(st) {
						console.log('[warpscan] status:', JSON.stringify(st));
						if (st.running) {
							setProgress(st);
							active = true;
							timer = window.setTimeout(poll, 3000);
						} else {
							active = false;
							progressBar.style.width = '100%';
							progressBar.textContent = '100%';
							statusLine(statusEl, 'Готово.');
							lockButtons(false);
							stopLogAutoRefresh();
							refreshLog();
							return callScanResult().then(function(data) {
								console.log('[warpscan] result:', JSON.stringify(data));
								resultEl.innerHTML = '';
								if (data && data.results && data.results.length) {
									resultEl.appendChild(renderTable(data.results, data.updated, data.saved));
								} else {
									resultEl.appendChild(E('p', { 'class': 'text-muted' }, 'Рабочих эндпоинтов не найдено.'));
								}
							});
						}
					}).catch(function(e) {
						console.error('[warpscan] status err', e);
						statusLine(statusEl, 'Ошибка статуса: ' + e.message, true);
					});
				};

				// immediately catch up when the tab regains focus/visibility
				var onVisible = function() {
					if (!active) return;
					if (timer) { window.clearTimeout(timer); timer = null; }
					poll();
				};
				window.addEventListener('focus', onVisible);
				document.addEventListener('visibilitychange', function() {
					if (document.visibilityState === 'visible') onVisible();
				});

				poll();
			}).catch(function(e) {
				console.error('[warpscan] scanStart err', e);
				statusLine(statusEl, 'Ошибка запуска: ' + e.message, true);
				progressEl.style.display = 'none';
				lockButtons(false);
			});
		};

		var scanBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' }, 'Быстрый поиск');
		scanBtn.addEventListener('click', function() { startScan('fast'); });
		scanButtons.push(scanBtn);
		scanSection.appendChild(scanBtn);
		scanSection.appendChild(document.createTextNode(' '));

		var fullBtn = E('button', { 'class': 'btn cbi-button cbi-button-apply', 'type': 'button' },
			'Полный поиск (долго!)');
		fullBtn.addEventListener('click', function() { startScan('full'); });
		scanButtons.push(fullBtn);
		scanSection.appendChild(fullBtn);
		scanSection.appendChild(document.createTextNode(' '));

		scanSection.appendChild(statusEl);
		scanSection.appendChild(progressEl);
		scanSection.appendChild(resultEl);
		scanSection.appendChild(logBox());
		container.appendChild(scanSection);

		// show the previous scan's saved results (if any) from the router
		callScanResult().then(function(data) {
			if (data && data.results && data.results.length) {
				resultEl.appendChild(renderTable(data.results, data.updated, data.saved));
				statusLine(statusEl, data.saved ? 'Показаны сохранённые результаты предыдущего скана.'
					: 'Показаны результаты последнего скана.');
			}
		}).catch(function(e) {
			console.error('[warpscan] initial scanResult err', e.message);
		});

		console.log('[warpscan] render done');
		return container;
	}
});