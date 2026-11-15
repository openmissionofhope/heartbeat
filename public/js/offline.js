// Offline contact recording: entries are encrypted with a non-extractable key kept in IndexedDB
// and hold only a participant code, kind, identity confidence and time.
(function () {
  'use strict';
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
  var DB = 'heartbeat-offline';
  function open() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('keys'); r.result.createObjectStore('entries', { autoIncrement: true }); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  function tx(db, store, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(store, mode); var s = t.objectStore(store); var out = fn(s);
      t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
      t.onerror = function () { reject(t.error); };
    });
  }
  async function key(db) {
    var k = await tx(db, 'keys', 'readonly', function (s) { return s.get('k'); });
    if (k) return k;
    k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await tx(db, 'keys', 'readwrite', function (s) { s.put(k, 'k'); });
    return k;
  }
  var status = document.getElementById('offline-status');
  function say(t) { if (status) status.textContent = t; }
  async function count(db) { return tx(db, 'entries', 'readonly', function (s) { return s.count(); }); }
  async function refresh() { try { var db = await open(); say((await count(db)) + ' entr(y/ies) saved on this device.'); } catch (e) { say('Offline storage is not available in this browser.'); } }
  var form = document.getElementById('offline-form');
  if (form) form.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var fd = new FormData(form);
    var entry = { code: String(fd.get('code') || '').trim(), kind: fd.get('kind'), confidence: fd.get('confidence'), occurredAt: Date.now() };
    if (entry.kind === 'secondhand') entry.confidence = 'reported';
    var db = await open(); var k = await key(db); var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(JSON.stringify(entry)));
    await tx(db, 'entries', 'readwrite', function (s) { s.add({ iv: iv, ct: ct }); });
    form.reset(); refresh();
  });
  var sync = document.getElementById('offline-sync');
  if (sync) sync.addEventListener('click', async function () {
    var db = await open(); var k = await key(db);
    var rows = await new Promise(function (resolve) {
      var out = []; var t = db.transaction('entries', 'readonly');
      t.objectStore('entries').openCursor().onsuccess = function (e) { var c = e.target.result; if (c) { out.push({ id: c.key, v: c.value }); c.continue(); } else resolve(out); };
    });
    if (!rows.length) { say('Nothing to send.'); return; }
    var entries = [];
    for (var i = 0; i < rows.length; i++) entries.push(JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rows[i].v.iv }, k, rows[i].v.ct))));
    var res = await fetch('/offline/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': document.getElementById('csrf').value, Accept: 'application/json' }, body: JSON.stringify({ entries: entries }), credentials: 'same-origin' });
    if (res.status === 303 || res.redirected || !res.ok) { say('Sign in first (open the Heartbeat home page while online), then come back and send.'); return; }
    var data = await res.json(); var failed = [];
    for (var j = 0; j < data.results.length; j++) {
      if (data.results[j].ok) await tx(db, 'entries', 'readwrite', function (s) { s.delete(rows[j].id); });
      else failed.push(data.results[j].code + ': ' + data.results[j].error);
    }
    say(failed.length ? 'Some entries were not accepted: ' + failed.join('; ') : 'All entries sent.');
    refresh();
  });
  refresh();
})();
