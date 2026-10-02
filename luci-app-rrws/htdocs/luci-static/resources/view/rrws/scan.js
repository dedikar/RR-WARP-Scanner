'use strict';
'require view';
'require ui';
'require view.rrws.rpc as rrwsRpc';
'require view.rrws.format as fmt';
'require view.rrws.widgets as wdg';
'require view.rrws.css as rrwsCss';
'require view.rrws.results as resultsView';

// RR WARP Scanner - LuCI front end for the /usr/bin/rrws engine. The page is
// split into sibling modules: rpc (transport), format (conf, badges, colours),
// widgets (checklists), css (page styles), results (result panel).

var callAccountStatus = rrwsRpc.callAccountStatus;
var callDeviceCheck   = rrwsRpc.callDeviceCheck;
var callConfBase      = rrwsRpc.callConfBase;
var callVersion       = rrwsRpc.callVersion;
var callGetSettings   = rrwsRpc.callGetSettings;
var callSaveSettings  = rrwsRpc.callSaveSettings;
var callScanStart     = rrwsRpc.callScanStart;
var callScanStop      = rrwsRpc.callScanStop;
var callScanStatus    = rrwsRpc.callScanStatus;
var callScanResult    = rrwsRpc.callScanResult;
var callScanLog       = rrwsRpc.callScanLog;
var callScanLogClear  = rrwsRpc.callScanLogClear;
var callRegister      = rrwsRpc.callRegister;
var callRenewAccount  = rrwsRpc.callRenewAccount;
var callDeleteAccount = rrwsRpc.callDeleteAccount;
var callRegisterLog   = rrwsRpc.callRegisterLog;
var callApplyBest     = rrwsRpc.callApplyBest;

var mkCheckList     = wdg.mkCheckList;
var checkListValues = wdg.checkListValues;
var chkLabel        = wdg.chkLabel;
var copyText        = fmt.copyText;

var versionText = '?';

// Rendered dropdown handles, keyed by purpose ('subnets', 'excludeNodes',
// 'includeNodes'). Filled in renderScan(), read in collectAndSave().
var dropdowns = {};
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

		rrwsCss.injectPageCss();

		fmt.setConf(data[2] || {});
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

		// The banner is for foreign hardware: show it unless the check positively
		// says "ours". A failed call must not hide the banner - the routers it
		// exists for are exactly the ones where the call is most likely to fail.
		if (dev && dev.authorized !== true) {
			deviceBanner.style.display = 'flex';
			if (window.console) {
				console.log('[rrws] foreign device: signals=' +
					JSON.stringify(dev.signals || {}) +
					' board=' + JSON.stringify(dev.board_name || '') +
					' distrib=' + JSON.stringify(dev.distrib_id || '') +
					' macs=' + JSON.stringify(dev.macs || {}));
			}
		}

		// --- account ------------------------------------------------------
		headerRow.appendChild(this.renderAccount(acct));

		// --- scan ---------------------------------------------------------
		wrap.appendChild(this.renderScan(s, res0));

		// --- log ----------------------------------------------------------
		wrap.appendChild(this.renderLog());

		// All polling goes through LuCI's own queue (L.Poll) instead of
		// hand-rolled setTimeout chains: one serialized round per tick, and the
		// queue is emptied when the page is left, so no timer outlives the view.
		self.startLogAutoRefresh();
		self.resumeScan();

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

		// Runs as a task in LuCI's poll queue. L.Poll.add() only answers
		// true/false and remove() takes the callback FUNCTION - removing a
		// "handle" throws a TypeError that kills the success transition.
		var finish = function() { L.Poll.remove(tick); };
		var tick = function() {
			// The backend ladder is bounded (~5.5 min worst case); 8 minutes is
			// only a last-resort cap. The real verdict arrives through
			// accountStatus: registered=true, or registering=false on failure.
			if (++tries > 240) {
				// A timeout is not a cause: pull the log and show what the engine
				// actually said last, instead of hiding the reason behind a
				// generic message.
				finish();
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
			return callAccountStatus().then(function(a) {
				if (a && a.registered && !a.registering) {
					finish();
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
						finish();
						if (self.regStatusEl) {
							self.regStatusEl.textContent = text && text.length
								? 'Регистрация не удалась — причина в логе ниже.'
								: 'Регистрация не удалась, лог пуст.';
						}
						btn.disabled = false;
						btn.textContent = label;
						return;
					}
					if (self.regStatusEl) self.regStatusEl.textContent = 'Регистрация... (' + (tries * 2) + ' с)';
				});
			}, function() { /* a failed round is retried on the next one */ });
		};
		L.Poll.add(tick, 2);
	},

	renderScan: function(s, res0) {
		var self = this;
		var sec = E('div', { 'class': 'cbi-section rrws-panel' });
		sec.appendChild(E('h3', {}, 'Сканирование эндпоинтов'));

		var f = function(label, node) {
			// LuCI's E() honours only ONE child argument; any extra arguments are
			var row = E('div', { style: 'margin-bottom:8px' });
			row.appendChild(E('label', { 'class': 'rrws-field-label' }, label));
			if (node) row.appendChild(node);
			return row;
		};
		// A numeric field with REAL validation. min/max alone are only a browser
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

		// Narrowing the result to Telegram-capable endpoints. Placed next to the
		// probe switch because it only makes sense once the probe runs, and
		// disabled with it, so the filter cannot be switched on against a scan
		// that produces no Telegram data at all.
		var tgOnlyChk = E('input', { type: 'checkbox', name: 'tg_only' });
		if (s.tg_only) tgOnlyChk.checked = true;
		var tgOnlyRow = f('', chkLabel(tgOnlyChk, ' Оставить только эндпоинты с рабочим Telegram'));
		sec.appendChild(tgOnlyRow);

		var tpChk = E('input', { type: 'checkbox', name: 'tun_ping' });
		if (s.tun_ping) tpChk.checked = true;
		sec.appendChild(f('', chkLabel(tpChk, ' Измерять задержку и потери внутри туннеля (TUN PING / LOSS)')));

		// The three switches sit together and the fields they control follow, so the
		// block reads as "switches, then the settings those switches unlock" rather
		// than alternating between the two.
		var stChk = E('input', { type: 'checkbox', name: 'stable_only' });
		if (s.stable_only) stChk.checked = true;
		sec.appendChild(f('', chkLabel(stChk, ' Отображать только стабильные (без обрывов и потерь)')));

		// Burst length for the durability check. The engine sends this many echoes
		// 200 ms apart and calls a tunnel torn if the answer stops mid-burst, so a
		// longer burst catches a DPI cut that happens seconds in - at two seconds
		// per ten echoes, per endpoint.
		var tpCountRow = num('tun_ping_count', s.tun_ping_count == null ? 10 : s.tun_ping_count,
			5, 60, 70, 'echoes в серии, 5–60: больше ловит поздние обрывы, но дольше');
		sec.appendChild(f('Эхо-пакетов (TUN PING)', tpCountRow));

		// Keep the two switches honest with each other: the count is meaningless
		// without the probe, and the filter without the probe has nothing to
		// filter on - the engine would drop every endpoint and the run would look
		// like it found nothing.
		var syncTgUi = function() {
			var on = tgChk.checked;
			var inp = tgOnlyRow.querySelector('input');
			if (inp) { inp.disabled = !on; inp.parentNode.style.opacity = on ? '1' : '.5'; }
			if (!on) { if (inp) inp.checked = false; }
		};
		var syncTpUi = function() {
			var on = tpChk.checked;
			var inp = tpCountRow.querySelector('input');
			if (inp) inp.disabled = !on;
			tpCountRow.style.opacity = on ? '1' : '.5';
		};
		tgChk.addEventListener('change', syncTgUi);
		tpChk.addEventListener('change', syncTpUi);
		syncTgUi();
		syncTpUi();

		// --- exclusions: checkbox dropdowns, not free-text IATA entry -------
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
			tg: c('tg'), tg_only: c('tg_only'),
			tun_ping: c('tun_ping'),
			tun_ping_count: parseInt(g('tun_ping_count'), 10) || 10,
			stable_only: c('stable_only'),
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
		var sawRunning = false;
		var startedAt = Date.now();
		var GRACE_MS = 15000;

		// One task in LuCI's poll queue, removed when the run is over. remove()
		// takes the callback function, not a handle (add() only answers bool).
		var tick = function() {
			return callScanStatus().then(function(st) {
				if (!st) return;
				self.showStatus(st);

				if (st.running) sawRunning = true;

				var graceOver = (Date.now() - startedAt) > GRACE_MS;
				if (st.running || (!sawRunning && !graceOver)) return;

				L.Poll.remove(tick);
				if (self.startBtn) self.startBtn.disabled = false;
				if (self.stopBtn) self.stopBtn.disabled = true;
				callScanResult().then(function(r) { self.renderResults(r); });
			}, function() { /* a failed round is retried on the next one */ });
		};
		this.scanPollFn = tick;
		L.Poll.add(tick, 2);
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
		// Rendering lives in view/rrws/results.js; this delegates with the view
		// itself so the module can reach the container and re-render.
		return resultsView.renderResults(this, res);
	},

	renderLog: function() {
		var self = this;
		var sec = E('div', { 'class': 'cbi-section rrws-panel' });
		var det = E('details', { 'class': 'rrws-disclosure' });
		det.appendChild(E('summary', {}, 'Логи'));

		// One merged log, in chronological order, like a chat: the backend
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
		// A permanent task in LuCI's poll queue; the gates decide per tick, so
		// the switches keep working without re-registering anything. remove()
		// takes the callback function, not a handle.
		var tick = function() {
			// Only while visible and only when asked: a background tab polling a
			// 2-core router every 3s is wasted work.
			if (document.visibilityState === 'visible' &&
			    self.logAutoRefreshChk && self.logAutoRefreshChk.checked) {
				return callScanLog().then(function(l) {
					if (!l || !self.logPane) return;
					self.updateLog(self.logPane, l.merged || '');
				});
			}
		};
		if (this.logPollFn) L.Poll.remove(this.logPollFn);
		this.logPollFn = tick;
		L.Poll.add(tick, 3);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
