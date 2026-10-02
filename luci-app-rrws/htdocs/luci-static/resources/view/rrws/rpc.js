'use strict';
'require baseclass';
'require rpc';

// Transport to luci.rrws. rpc.declare wrappers for the ubus methods, plus a
// direct fetch('/ubus/') path for the calls this build's rpc.declare drops.

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

// Named saveOpts, not saveSettings: LuCI already owns a `saveSettings` on the rpc
function callSaveSettings(opts) {
	return ubusCall('luci.rrws', 'saveOpts', opts);
}

var callAccountStatus = declare({ object: 'luci.rrws', method: 'accountStatus', params: {}, reject: false });
var callDeviceCheck   = declare({ object: 'luci.rrws', method: 'deviceCheck', params: {}, reject: false });
var callConfBase      = declare({ object: 'luci.rrws', method: 'confBase', params: {}, reject: false });
var callVersion       = declare({ object: 'luci.rrws', method: 'version', params: {}, reject: false });
var callGetSettings   = declare({ object: 'luci.rrws', method: 'getSettings', params: {}, reject: false });
var callScanStart     = declare({ object: 'luci.rrws', method: 'scanStart', params: {}, reject: false });
var callScanStop      = declare({ object: 'luci.rrws', method: 'scanStop', params: {}, reject: false });
var callScanStatus    = declare({ object: 'luci.rrws', method: 'scanStatus', params: {}, reject: false });

// scanResult travels in pages: a full-pool run is ~1.5MB of JSON and the ubus
// reply path times out on replies that big. Page 1 carries the run summary;
// the endpoints of every page are stitched back together here.
var callScanResult = function() {
	return ubusCall('luci.rrws', 'scanResult', { page: '1' }).then(function(first) {
		var pages = first.pages || 1;
		var acc = first;
		var eps = first.endpoints || [];
		var next = function() {
			p++;
			if (p > pages) {
				acc.endpoints = eps;
				return acc;
			}
			return ubusCall('luci.rrws', 'scanResult', { page: String(p) }).then(function(r) {
				eps = eps.concat(r.endpoints || []);
				return next();
			});
		};
		var p = 1;
		return next();
	});
};

var callScanLog       = declare({ object: 'luci.rrws', method: 'scanLog', params: {}, reject: false });
var callScanLogClear  = declare({ object: 'luci.rrws', method: 'scanLogClear', params: {}, reject: false });
var callRegister      = declare({ object: 'luci.rrws', method: 'register', params: {}, reject: false });
var callRenewAccount  = declare({ object: 'luci.rrws', method: 'renewAccount', params: {}, reject: false });
var callDeleteAccount = declare({ object: 'luci.rrws', method: 'deleteAccount', params: {}, reject: false });
var callRegisterLog   = declare({ object: 'luci.rrws', method: 'registerLog', params: {}, reject: false });
var callApplyBest     = declare({ object: 'luci.rrws', method: 'applyBest', params: { iface: 'iface', endpoint: 'endpoint' }, reject: false });

return baseclass.extend({
	declare: declare,
	ubusCall: ubusCall,
	callAccountStatus: callAccountStatus,
	callDeviceCheck: callDeviceCheck,
	callConfBase: callConfBase,
	callVersion: callVersion,
	callGetSettings: callGetSettings,
	callSaveSettings: callSaveSettings,
	callScanStart: callScanStart,
	callScanStop: callScanStop,
	callScanStatus: callScanStatus,
	callScanResult: callScanResult,
	callScanLog: callScanLog,
	callScanLogClear: callScanLogClear,
	callRegister: callRegister,
	callRenewAccount: callRenewAccount,
	callDeleteAccount: callDeleteAccount,
	callRegisterLog: callRegisterLog,
	callApplyBest: callApplyBest
});
