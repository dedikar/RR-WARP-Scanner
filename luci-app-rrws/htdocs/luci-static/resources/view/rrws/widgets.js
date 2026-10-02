'use strict';

// Collapsible checkbox list and checkbox-label helpers shared by the scan
// form and the log controls.

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

// A checkbox with its caption. LuCI's E() honours only ONE child argument, so
// E('label', {}, box, 'text') drops both the box and the text.
function chkLabel(box, text) {
	var l = E('label', {});
	l.appendChild(box);
	l.appendChild(document.createTextNode(' ' + text));
	return l;
}

return {
	mkCheckList: mkCheckList,
	checkListValues: checkListValues,
	chkLabel: chkLabel
};
