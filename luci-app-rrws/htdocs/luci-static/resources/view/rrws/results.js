'use strict';
'require ui';
'require view.rrws.format as fmt';
'require view.rrws.rpc as rrwsRpc';

// The result panel: summary line with node codes, sort bar, endpoint cards,
// .conf export and result deletion. Receives the view instance so it can read
// the container and re-render through the same path as the live pollers.

function renderResults(view, res) {
	var box = view.resultsEl;
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
			nodesRow.appendChild(E('span', { style: 'color:' + fmt.NODE_COLOR + ';font-weight:600' }, x.code));
			// The count stays theme-coloured: the accent marks which node it is,
			// and colouring the number too would make the row read as a solid
			// block of yellow.
			if (x.n > 1) nodesRow.appendChild(document.createTextNode(' ×' + x.n));
		});
		left.appendChild(nodesRow);
	}
	head.appendChild(left);

	if (list.length) {
		// Both result actions live in one right-side group: the head is
		// space-between, so bare children would spread across the whole row.
		var actions = E('div', { style: 'display:flex;align-items:center;gap:8px' });
		var dlBtn = E('button', { 'class': 'btn cbi-button' }, 'Скачать всё .txt');
		dlBtn.addEventListener('click', function() {
			// A blank line plus a numbered header between configs: glued
			// back-to-back they read as one cut-off config in an editor.
			// '#' comments are legal in wg-format files.
			var txt = list.map(function(r, i) {
				return '# ' + (i + 1) + ': ' + r.endpoint + '\n' + fmt.makeConf(r.endpoint);
			}).join('\n\n');
			var blob = new Blob([txt], { type: 'text/plain' });
			var a = document.createElement('a');
			a.href = URL.createObjectURL(blob);
			a.download = 'rrws-configs.txt';
			a.click();
			setTimeout(function() { URL.revokeObjectURL(a.href); }, 2000);
		});
		actions.appendChild(dlBtn);

		// Destructive, so one confirmation guards it: a misclick must not
		// wipe a full-pool result worth 1.5MB of scanning time.
		var delBtn = E('button', { 'class': 'btn cbi-button cbi-button-remove' }, 'Удалить результаты');
		delBtn.addEventListener('click', function() {
			if (!window.confirm('Удалить все результаты скана?'))
				return;
			rrwsRpc.ubusCall('luci.rrws', 'scanResultClear', {}).then(function() {
				view.renderResults({ endpoints: [] });
			});
		});
		actions.appendChild(delBtn);
		head.appendChild(actions);
	}

	// Sort keys offered as buttons under the summary line.
	var SORTS = [
		{ id: 'default', label: 'По умолчанию', defDir: 'asc',
		  title: 'Сначала с рабочим Telegram, затем стабильные, затем меньший пинг в туннеле',
		  // The default order IS the engine's recommendation, so its best row is
		  // the first one it put there.
		  bestOf: function(rows) {
			  for (var i = 0; i < rows.length; i++)
				  if (!rows[i].torn && rows[i].tg_ok) return i;
			  return -1;
		  } },
		{ id: 'speed', label: 'Скорость', defDir: 'desc',
		  title: 'Измеренные при наличии замера стоят наверху от быстрых к медленным; повторное нажатие переворачивает блок',
		  // Fastest measured, whatever direction the block is flipped to:
		  // the best speed is the fast one, not the first one shown.
		  bestOf: function(rows) {
			  var bi = -1, top = -1;
			  for (var i = 0; i < rows.length; i++)
				  if (rows[i].speed_measured && (rows[i].speed_mbps || 0) > top) {
					  top = rows[i].speed_mbps || 0;
					  bi = i;
				  }
			  return bi;
		  } },
		{ id: 'node', label: 'Узел', defDir: 'asc',
		  title: 'По коду узла Cloudflare',
		  // A node code is a label, not a quality: there is no "best" node to
		  // point at, and badging the alphabetically first row would be noise.
		  bestOf: function() { return -1; } },
		{ id: 'ping', label: 'Пинг', defDir: 'asc',
		  title: 'По пингу до эндпоинта, от меньшего к большему',
		  // First row that actually has a measurement: the lowest ping present.
		  bestOf: function(rows) {
			  for (var i = 0; i < rows.length; i++)
				  if (rows[i].ping_ms > 0) return i;
			  return -1;
		  } },
		{ id: 'tun', label: 'Туннель', defDir: 'asc',
		  title: 'По задержке внутри туннеля, от меньшей к большей',
		  bestOf: function(rows) {
			  for (var i = 0; i < rows.length; i++)
				  if (rows[i].measured && rows[i].tun_ping_ms > 0) return i;
			  return -1;
		  } },
		{ id: 'tg', label: 'Telegram', defDir: 'asc',
		  title: 'По времени отклика Telegram, от меньшего к большему',
		  // Lowest Telegram RTT, so only a row that actually answered counts.
		  bestOf: function(rows) {
			  for (var i = 0; i < rows.length; i++)
				  if (rows[i].tg_ok && rows[i].tg_rtt_ms > 0) return i;
			  return -1;
		  } },
	];

	// How many endpoints actually carry a speed figure, so the sort bar can
	// say so. Without it, "Скорость" looks broken: most of the list drops out
	// of the ordering and the reason is not visible anywhere on the page.
	var measuredCount = 0;
	list.forEach(function(r) { if (r.speed_measured) measuredCount++; });

	// Compare by the chosen key. Endpoints missing a value always sink to the
	var dir = function(c, d) { return d > 0 ? c : -c; };

	// Compare two possibly-absent numbers so that absence always sorts last,
	// whichever direction is in force. A missing value is not a small one:
	// letting "0 / not measured" act as a value put untested endpoints at the
	// top of a descending sort.
	var missingLast = function(a, b) {
		var am = (a > 0), bm = (b > 0);
		if (am !== bm) return am ? -1 : 1;
		if (!am && !bm) return 0;
		return a - b;
	};

	var comparators = {
		default: function(a, b, d) {
			// The order that answers "which of these should I actually use",
			if (!!b.tg_ok !== !!a.tg_ok) return b.tg_ok ? 1 : -1;
			if (a.tg_ok && b.tg_ok) {
				var ag = a.tg_rtt_ms || 9999;
				var bg = b.tg_rtt_ms || 9999;
				if (ag !== bg) return ag - bg;
			}
			if (!!a.torn !== !!b.torn) return a.torn ? 1 : -1;
			var al = a.loss_pct || 0;
			var bl = b.loss_pct || 0;
			if (al !== bl) return al - bl;
			var at = a.tun_ping_ms || a.ping_ms || 9999;
			var bt = b.tun_ping_ms || b.ping_ms || 9999;
			return at - bt;
		},
		speed: function(a, b, d) {
			var am = !!a.speed_measured, bm = !!b.speed_measured;
			// Unmeasured always last, whatever the direction.
			if (am !== bm) return am ? -1 : 1;
			if (!am && !bm) return 0;
			return dir((a.speed_mbps || 0) - (b.speed_mbps || 0), d);
		},
		node: function(a, b, d) {
			var an = a.node || '~', bn = b.node || '~';
			return dir(an < bn ? -1 : (an > bn ? 1 : 0), d);
		},
		ping: function(a, b, d) {
			return dir(missingLast(a.ping_ms, b.ping_ms), d);
		},
		tun: function(a, b, d) {
			// "measured" is the engine's flag for "this endpoint was probed in
			// the tunnel"; a zero without it means no measurement, not a fast one.
			var am = a.measured && a.tun_ping_ms > 0;
			var bm = b.measured && b.tun_ping_ms > 0;
			if (am !== bm) return am ? -1 : 1;
			if (!am && !bm) return 0;
			return dir(a.tun_ping_ms - b.tun_ping_ms, d);
		},
		tg: function(a, b, d) {
			// tg_ok first: an endpoint whose Telegram is blocked has no RTT, and
			// its absence must not read as a very fast zero.
			if (!!b.tg_ok !== !!a.tg_ok) return b.tg_ok ? 1 : -1;
			return dir((a.tg_rtt_ms || 9999) - (b.tg_rtt_ms || 9999), d);
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
		// A speed sort with nothing measured would just reorder noise, so the
		// key is offered only when the run actually produced figures.
		if (s.id === 'speed' && !measuredCount) return;
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
	// Say how many rows the speed sort actually covers: with 20 measured out of
	// 535 the ordering looks arbitrary until you know why most rows ignore it.
	if (measuredCount) {
		var note = E('span', { 'class': 'rrws-sortbar-label' },
			'замерено ' + measuredCount + ' из ' + list.length);
		note.title = 'Замер скорости идёт только по эндпоинтам, отобранным движком ' +
			'(лучший на узел и на подсеть), поэтому они собраны вверху списка, ' +
			'а остальные остаются ниже';
		sortBar.appendChild(note);
	}
	content.appendChild(sortBar);

	// Mark the active key and show which way it runs, so the list order is
	// never a guess.
	var paintSort = function() {
		SORTS.forEach(function(s) {
			var b = sortBtns[s.id];
			// A key not offered this run (speed with nothing measured) has no
			// button; skipping it here is what keeps paintSort total.
			if (!b) return;
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

		var sorted;
		if ((sortId === 'default' || sortId === 'speed') && measuredCount) {
			// The run measured speed, so the measured endpoints lead the list -
			var dirMul = (sortId === 'speed' ? sortDir : -1);
			var head = list.filter(function(r) { return r.speed_measured; })
				.sort(function(a, b) { return dirMul * ((a.speed_mbps || 0) - (b.speed_mbps || 0)); });
			sorted = head.concat(list.filter(function(r) { return !r.speed_measured; }));
		} else {
			sorted = list.slice().sort(function(a, b) {
				// Direction is applied by each comparator, not by negating its
				// result here. Negating the whole comparison also flipped the
				// "unmeasured sinks to the bottom" rule, which is what put 515
				// endpoints without a speed figure at the TOP of a descending sort.
				return comparators[sortId](a, b, sortDir);
			});
		}

		// "ЛУЧШИЙ" follows the sort: it marks the first row in the order shown
		var bestIdx = -1;
		for (var si = 0; si < SORTS.length; si++) {
			if (SORTS[si].id !== sortId) continue;
			bestIdx = SORTS[si].bestOf(sorted);
			break;
		}

		sorted.forEach(function(r, i) {
			var isBest = (i === bestIdx);
			// The left stripe carries the meaning (best / torn / plain) and the rest
			// of the card's surface comes from the .rrws-card rules, so the list
			// stays readable at 141 entries instead of turning into one grey slab.
			var cls = 'rrws-card' + (r.torn ? ' rrws-card-torn' : (isBest ? ' rrws-card-best' : ''));
			var row = E('div', { 'class': cls });

			// One row per result: identity on the left, actions pinned right.
			row.style.display = 'flex';
			row.style.alignItems = 'center';
			row.style.gap = '12px';

			var info = E('div', { style: 'flex:1 1 auto;min-width:0' });

			var line1 = E('div', { style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' });
			line1.appendChild(E('code', { style: 'font-size:14px' }, r.endpoint));
			line1.appendChild(fmt.tgBadge(r));
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
				style: 'color:' + fmt.NODE_COLOR + ';font-weight:600',
				title: 'Узел Cloudflare (IATA-код города) и страна выхода'
			}, (r.node || '?') + (r.country ? ' / ' + r.country : '')));
			if (r.city) {
				sep();
				meta.appendChild(document.createTextNode(r.city));
			}
			sep();
			meta.appendChild(fmt.metric('пинг', fmt.pingText(r.ping_ms), fmt.pingColor(r.ping_ms)));
			if (r.measured) {
				sep();
				meta.appendChild(fmt.metric('в туннеле', fmt.pingText(r.tun_ping_ms), fmt.pingColor(r.tun_ping_ms)));
			}
			if (r.tg_ok && r.tg_rtt_ms) {
				sep();
				meta.appendChild(fmt.metric('Telegram', fmt.pingText(r.tg_rtt_ms), fmt.tgColor(r.tg_rtt_ms)));
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
			cpBtn.addEventListener('click', function() { fmt.copyText(fmt.makeConf(r.endpoint), cpBtn); });
			actions.appendChild(cpBtn);

			// No margin-left here: the row is a flex container with a gap, so a
			// per-button margin would double the spacing.
			var showBtn = E('button', { 'class': 'btn cbi-button', style: 'font-size:12px' }, 'Показать .conf');
			showBtn.addEventListener('click', function() {
				ui.showModal('AmneziaWG .conf — ' + r.endpoint, [
					E('pre', { style: 'white-space:pre-wrap;word-break:break-all;max-height:420px;overflow:auto;font-size:12px' },
						fmt.makeConf(r.endpoint)),
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
}

return {
	renderResults: renderResults
};
