/* ============================================================
   app.js — Product QR Inventory System
   Sections:
     1. Constants & helpers
     2. Data layer (localStorage, import / export)
     3. Products tab (dashboard, filters, table, bulk actions)
     4. Generate tab (unit creation, label sheet, print / PDF / PNG)
     5. Scan tab (camera, counting session, report)
     6. Tabs & start-up
   Libraries (loaded in index.html): qrcode (QRCode), html5-qrcode (Html5Qrcode),
   jsPDF (window.jspdf).
   ============================================================ */
(function () {
  'use strict';

  /* ==========================================================
     1. CONSTANTS & HELPERS
     ========================================================== */
  const LS_STATE = 'qrinv.v1';            // products / units / counters
  const LS_SESSION = 'qrinv.session.v1';  // in-progress count (survives page reloads)
  const IN_STOCK = 'in stock';
  const MISSING = 'missing';
  const COOLDOWN_MS = 1500;               // ignore re-reads of the same code for this long
  const MAX_QTY = 500;                    // max units per generate batch
  const MAX_ROWS = 500;                   // max table rows rendered at once
  const PAGE_MARGIN = 10;                 // mm, used for print / PDF layout
  const GAP = 1;                          // mm between labels
  const PAPER = {
    a4:     { w: 210,   h: 297,   css: 'A4' },
    letter: { w: 215.9, h: 279.4, css: 'Letter' }
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  // Escape text before putting it into innerHTML
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer;
  /** Small message at the bottom of the screen. kind: ok | warn | bad | '' */
  function toast(msg, kind) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  }
  function stamp() {  // 20261007-1530 — used in file names
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }

  /** Normalise a SKU: upper-case, spaces -> "-", only A-Z 0-9 _ - */
  function sanitizeSku(s) {
    return String(s || '').trim().toUpperCase().replace(/\s+/g, '-')
      .replace(/[^A-Z0-9_-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  const makeId = (sku, n) => sku + '-' + String(n).padStart(4, '0');

  /* ---------- download helpers ---------- */
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const downloadText = (text, name, mime) => downloadBlob(new Blob([text], { type: mime }), name);

  /* ---------- CSV helpers ---------- */
  /** One CSV cell. Guards against spreadsheet formula injection (=, +, -, @) and quotes as needed. */
  function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const csvRow = (arr) => arr.map(csvCell).join(',');

  /** Minimal RFC-4180 style CSV parser -> array of rows (arrays of strings). */
  function parseCSV(text) {
    const rows = []; let row = [], cur = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cur); cur = ''; rows.push(row); row = [];
      } else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter((r) => r.some((x) => x.trim() !== ''));
  }

  /* ==========================================================
     2. DATA LAYER
     A "unit" = one physical item with its own QR code:
       { id, name, sku, category, notes, created (ISO), status }
     state.counters[sku] = last number issued for that SKU. It only
     ever goes UP, so IDs are never reused, even after deletion.
     ========================================================== */
  const state = { units: [], counters: {}, sheet: [] };  // sheet = unit IDs shown on the label sheet
  let unitIndex = new Map();                              // id -> unit (fast lookup while scanning)

  function rebuildIndex() { unitIndex = new Map(state.units.map((u) => [u.id, u])); }

  /** Make sure counters are at least the highest number found in existing IDs. */
  function rebuildCounters() {
    state.units.forEach((u) => {
      const prefix = u.sku + '-';
      if (u.id.startsWith(prefix)) {
        const n = parseInt(u.id.slice(prefix.length), 10);
        if (n > (state.counters[u.sku] || 0)) state.counters[u.sku] = n;
      }
    });
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      if (raw) {
        const o = JSON.parse(raw);
        state.units = Array.isArray(o.units) ? o.units : [];
        state.counters = o.counters || {};
        state.sheet = Array.isArray(o.sheet) ? o.sheet : [];
      }
    } catch (e) { console.warn('Could not load saved data', e); }
    rebuildCounters();
    rebuildIndex();
  }

  function saveState() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({ version: 1, units: state.units, counters: state.counters, sheet: state.sheet }));
    } catch (e) { toast('Could not save (storage full or blocked). Export your data!', 'bad'); }
  }

  /** Call after ANY change to units: re-index, save, refresh every view that depends on it. */
  function commit() { rebuildIndex(); saveState(); renderAll(); }

  /* ---------- Export ---------- */
  function exportJson() {
    const data = { version: 1, exported: new Date().toISOString(), units: state.units, counters: state.counters };
    downloadText(JSON.stringify(data, null, 2), 'inventory-' + stamp() + '.json', 'application/json');
  }
  function exportCsv() {
    const lines = [csvRow(['id', 'name', 'sku', 'category', 'created', 'status', 'notes'])];
    state.units.forEach((u) => lines.push(csvRow([u.id, u.name, u.sku, u.category, u.created, u.status, u.notes])));
    downloadText('﻿' + lines.join('\r\n'), 'inventory-' + stamp() + '.csv', 'text/csv');
  }

  /* ---------- Import (merge: existing IDs are kept, new ones added) ---------- */
  function normaliseRecord(r) {
    let id = String(r.id || '').trim().toUpperCase();
    if (!id) return null;
    let sku = sanitizeSku(r.sku);
    if (!sku) { const m = id.match(/^(.*)-\d+$/); sku = m ? sanitizeSku(m[1]) : ''; }
    if (!sku) return null;
    const unq = (s) => String(s == null ? '' : s).replace(/^'([=+\-@])/, '$1');  // undo csvCell guard
    return {
      id, sku,
      name: unq(r.name).trim() || sku,
      category: unq(r.category).trim(),
      notes: unq(r.notes).trim(),
      created: isNaN(new Date(r.created)) ? new Date().toISOString() : new Date(r.created).toISOString(),
      status: String(r.status || '').toLowerCase() === MISSING ? MISSING : IN_STOCK
    };
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file.', 'bad');
    reader.onload = () => {
      let records = [], counters = {};
      try {
        const text = String(reader.result).replace(/^﻿/, '');
        if (/^\s*[\[{]/.test(text)) {                       // JSON
          const o = JSON.parse(text);
          records = Array.isArray(o) ? o : (o.units || []);
          counters = (o && o.counters) || {};
        } else {                                            // CSV with a header row
          const rows = parseCSV(text);
          const head = rows.shift().map((h) => h.trim().toLowerCase());
          const col = (names) => head.findIndex((h) => names.includes(h));
          const ix = { id: col(['id', 'unit id', 'unit_id']), name: col(['name', 'product', 'product name']), sku: col(['sku', 'code']),
                       category: col(['category']), created: col(['created', 'date created', 'date']), status: col(['status']), notes: col(['notes']) };
          if (ix.id < 0) throw new Error('CSV needs an "id" column');
          records = rows.map((r) => {
            const get = (k) => (ix[k] >= 0 ? r[ix[k]] : '');
            return { id: get('id'), name: get('name'), sku: get('sku'), category: get('category'), created: get('created'), status: get('status'), notes: get('notes') };
          });
        }
      } catch (e) { toast('Import failed: ' + e.message, 'bad'); return; }

      let added = 0, skipped = 0;
      records.forEach((r) => {
        const u = normaliseRecord(r || {});
        if (!u || unitIndex.has(u.id)) { skipped++; return; }
        state.units.push(u); unitIndex.set(u.id, u); added++;
      });
      Object.keys(counters).forEach((k) => {                // keep the highest counter -> IDs never reused
        const n = parseInt(counters[k], 10);
        if (n > (state.counters[k] || 0)) state.counters[k] = n;
      });
      rebuildCounters();
      commit();
      toast('Imported ' + added + ' unit(s), skipped ' + skipped + ' (duplicate or invalid).', added ? 'ok' : 'warn');
    };
    reader.readAsText(file);
  }

  /* ==========================================================
     3. PRODUCTS TAB
     ========================================================== */
  const selected = new Set();   // selected unit IDs in the table

  function renderAll() {
    renderDashboard();
    renderFilters();
    renderTable();
    renderScopeOptions();
    renderLive();
    $('#catList').innerHTML = categories().map((c) => '<option value="' + esc(c) + '">').join('');
  }

  const categories = () => Array.from(new Set(state.units.map((u) => u.category).filter(Boolean))).sort();

  function renderDashboard() {
    $('#stProducts').textContent = new Set(state.units.map((u) => u.sku)).size;
    $('#stUnits').textContent = state.units.length;
    $('#stStock').textContent = state.units.filter((u) => u.status === IN_STOCK).length;
    $('#stMissing').textContent = state.units.filter((u) => u.status === MISSING).length;
  }

  function renderFilters() {
    const sel = $('#fCategory'), cur = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' +
      categories().map((c) => '<option>' + esc(c) + '</option>').join('');
    sel.value = categories().includes(cur) ? cur : '';
  }

  function filteredUnits() {
    const q = $('#fSearch').value.trim().toLowerCase();
    const st = $('#fStatus').value, cat = $('#fCategory').value;
    return state.units.filter((u) => {
      if (st && u.status !== st) return false;
      if (cat && u.category !== cat) return false;
      if (q && !(u.id + ' ' + u.name + ' ' + u.sku + ' ' + u.category).toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function renderTable() {
    for (const id of Array.from(selected)) if (!unitIndex.has(id)) selected.delete(id);  // drop deleted
    const list = filteredUnits();
    const shown = list.slice(0, MAX_ROWS);
    $('#unitTable tbody').innerHTML = shown.map((u) =>
      '<tr class="' + (selected.has(u.id) ? 'selected' : '') + '">' +
      '<td><input type="checkbox" class="rowsel" data-id="' + esc(u.id) + '"' + (selected.has(u.id) ? ' checked' : '') + '></td>' +
      '<td class="id">' + esc(u.id) + '</td><td>' + esc(u.name) + '</td><td>' + esc(u.sku) + '</td>' +
      '<td>' + esc(u.category) + '</td><td>' + esc(fmtDate(u.created)) + '</td>' +
      '<td><span class="badge ' + (u.status === IN_STOCK ? 'in' : 'miss') + '">' + esc(u.status) + '</span></td>' +
      '<td class="acts">' +
        '<button class="btn sm" data-act="label" data-id="' + esc(u.id) + '" title="Show on label sheet to reprint">Label</button>' +
        '<button class="btn sm" data-act="png" data-id="' + esc(u.id) + '" title="Download this label as PNG">PNG</button>' +
        '<button class="btn sm danger" data-act="del" data-id="' + esc(u.id) + '" title="Delete unit">✕</button>' +
      '</td></tr>').join('');
    $('#tableNote').textContent = state.units.length
      ? 'Showing ' + shown.length + ' of ' + list.length + ' matching unit(s)' + (list.length > MAX_ROWS ? ' — refine the filter to see the rest.' : '.')
      : 'No units yet. Use “Generate Labels” to create some.';
    $('#selCount').textContent = selected.size ? selected.size + ' selected' : '';
    $('#selAll').checked = shown.length > 0 && shown.every((u) => selected.has(u.id));
  }

  function setStatusFor(ids, status) {
    ids.forEach((id) => { const u = unitIndex.get(id); if (u) u.status = status; });
    commit();
  }

  function deleteUnits(ids) {
    if (!ids.length) return;
    if (!confirm('Delete ' + ids.length + ' unit(s)? Their ID numbers will NOT be reused.')) return;
    const gone = new Set(ids);
    state.units = state.units.filter((u) => !gone.has(u.id));
    state.sheet = state.sheet.filter((id) => !gone.has(id));
    ids.forEach((id) => selected.delete(id));
    commit();
    renderSheet();
  }

  /** Put the given units on the label sheet and jump to the Generate tab (reprint). */
  function showOnSheet(ids) {
    if (!ids.length) { toast('Select at least one unit first.', 'warn'); return; }
    state.sheet = ids.slice();
    saveState();
    switchTab('generate');
    renderSheet();
    $('#sheet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function bindProducts() {
    ['fSearch', 'fStatus', 'fCategory'].forEach((id) => $('#' + id).addEventListener('input', renderTable));
    $('#selAll').addEventListener('change', (e) => {
      filteredUnits().slice(0, MAX_ROWS).forEach((u) => (e.target.checked ? selected.add(u.id) : selected.delete(u.id)));
      renderTable();
    });
    const tbody = $('#unitTable tbody');
    tbody.addEventListener('change', (e) => {
      if (!e.target.classList.contains('rowsel')) return;
      e.target.checked ? selected.add(e.target.dataset.id) : selected.delete(e.target.dataset.id);
      renderTable();
    });
    tbody.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === 'label') showOnSheet([id]);
      else if (b.dataset.act === 'png') downloadSingleLabel(id);
      else if (b.dataset.act === 'del') deleteUnits([id]);
    });
    $('#bulkLabels').addEventListener('click', () => showOnSheet(Array.from(selected)));
    $('#bulkStock').addEventListener('click', () => selected.size ? setStatusFor(Array.from(selected), IN_STOCK) : toast('Select units first.', 'warn'));
    $('#bulkMissing').addEventListener('click', () => selected.size ? setStatusFor(Array.from(selected), MISSING) : toast('Select units first.', 'warn'));
    $('#bulkDelete').addEventListener('click', () => selected.size ? deleteUnits(Array.from(selected)) : toast('Select units first.', 'warn'));
    $('#expJson').addEventListener('click', exportJson);
    $('#expCsv').addEventListener('click', exportCsv);
    $('#impFile').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); e.target.value = ''; });
  }

  /* ==========================================================
     4. GENERATE TAB — unit creation + label sheet
     ========================================================== */
  const qrCache = new Map();   // unit id -> PNG data URL

  /** QR as PNG data URL. Error correction H (~30% damage tolerated), 4-module quiet zone. */
  async function qrDataUrl(text) {
    if (qrCache.has(text)) return qrCache.get(text);
    if (typeof QRCode === 'undefined') throw new Error('QR library not loaded (check your internet connection).');
    const url = await QRCode.toDataURL(text, {
      errorCorrectionLevel: 'H',
      margin: 4,            // quiet zone, in modules (the standard minimum)
      scale: 10,            // integer pixels per module -> razor-sharp edges
      color: { dark: '#000000', light: '#ffffff' }
    });
    qrCache.set(text, url);
    return url;
  }

  function onGenerate(e) {
    e.preventDefault();
    const name = $('#pName').value.trim();
    const sku = sanitizeSku($('#pSku').value);
    const category = $('#pCat').value.trim();
    const notes = $('#pNotes').value.trim();
    const qty = parseInt($('#pQty').value, 10);
    if (!name || !sku) { toast('Product name and a valid SKU are required.', 'bad'); return; }
    if (!(qty >= 1) || qty > MAX_QTY) { toast('Quantity must be between 1 and ' + MAX_QTY + '.', 'bad'); return; }
    const existing = state.units.find((u) => u.sku === sku);
    if (existing && existing.name !== name &&
        !confirm('SKU ' + sku + ' already exists as "' + existing.name + '". Add these units under the name "' + name + '"?')) return;

    const created = new Date().toISOString(), ids = [];
    for (let i = 0; i < qty; i++) {
      let n = (state.counters[sku] || 0) + 1;
      while (unitIndex.has(makeId(sku, n))) n++;           // paranoia: never collide with an existing ID
      state.counters[sku] = n;                             // counter only goes up -> never reused
      const unit = { id: makeId(sku, n), name, sku, category, notes, created, status: IN_STOCK };
      state.units.push(unit); unitIndex.set(unit.id, unit); ids.push(unit.id);
    }
    state.sheet = ids;                                     // show this batch on the sheet
    commit();
    renderSheet();
    toast('Created ' + qty + ' unit(s): ' + ids[0] + (qty > 1 ? ' … ' + ids[ids.length - 1] : ''), 'ok');
    $('#pQty').value = 1; $('#pNotes').value = '';
    $('#sheet').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- Sheet options ---------- */
  const textHeight = (size) => (size <= 25 ? 6 : 8);                 // mm reserved for name + ID
  const fontPt = (size) => (size <= 25 ? 5 : size <= 40 ? 7 : 8);

  function getOpts() {
    const size = parseInt($('#optSize').value, 10);
    const paper = $('#optPaper').value;
    const maxFit = Math.max(1, Math.floor((PAPER[paper].w - 2 * PAGE_MARGIN) / (size + GAP)));
    let perRow = parseInt($('#optPerRow').value, 10);
    if (!(perRow >= 1)) perRow = 1;
    if (perRow > 8) perRow = 8;
    const limited = perRow > maxFit;
    if (limited) perRow = maxFit;
    return { size, paper, perRow, limited, maxFit, showText: $('#optText').checked };
  }

  /** Apply options to the on-screen sheet (no need to regenerate the QR images). */
  function applySheetOpts() {
    const o = getOpts();
    if (o.limited) {
      $('#optPerRow').value = o.perRow;
      toast('Only ' + o.maxFit + ' labels of ' + o.size + ' mm fit across ' + PAPER[o.paper].css + '.', 'warn');
    }
    const host = $('#sheet');
    host.className = 'sheet' + (o.showText ? '' : ' notext');
    host.style.setProperty('--size', o.size + 'mm');
    host.style.setProperty('--cols', o.perRow);
    host.style.setProperty('--texth', textHeight(o.size) + 'mm');
    host.style.setProperty('--fs', fontPt(o.size) + 'pt');
    return o;
  }

  const sheetUnits = () => state.sheet.map((id) => unitIndex.get(id)).filter(Boolean);
  let sheetToken = 0;   // lets a newer render cancel an older one still in progress
  let sheetReady = true;

  async function renderSheet() {
    const token = ++sheetToken;
    const o = applySheetOpts();
    const units = sheetUnits();
    const host = $('#sheet');
    host.innerHTML = '';
    $('#sheetEmpty').hidden = units.length > 0;
    $('#sheetInfo').textContent = units.length ? 'Rendering ' + units.length + ' label(s)…' : '';
    if (!units.length) { sheetReady = true; return; }
    sheetReady = false;
    try {
      const frag = document.createDocumentFragment();
      for (const u of units) {
        const url = await qrDataUrl(u.id);
        if (token !== sheetToken) return;                    // superseded by a newer render
        const d = document.createElement('div');
        d.className = 'lbl';
        d.innerHTML = '<img alt="' + esc(u.id) + '" src="' + url + '">' +
          '<div class="lbl-text"><div class="lbl-name">' + esc(u.name) + '</div><div class="lbl-id">' + esc(u.id) + '</div></div>';
        frag.appendChild(d);
      }
      host.appendChild(frag);
      $('#sheetInfo').textContent = units.length + ' label(s) · ' + o.size + ' mm · ' + o.perRow + ' per row';
      sheetReady = true;
    } catch (err) {
      $('#sheetInfo').textContent = '';
      toast(err.message, 'bad');
      sheetReady = true;
    }
  }

  /* ---------- Print ---------- */
  function doPrint() {
    const units = sheetUnits();
    if (!units.length) { toast('Nothing to print — generate or select labels first.', 'warn'); return; }
    if (!sheetReady) { toast('Labels are still rendering, try again in a moment.', 'warn'); return; }
    const o = getOpts();
    // 1) set the paper size for @page   2) copy the sheet into the print-only container   3) print
    let ps = $('#pageStyle');
    if (!ps) { ps = document.createElement('style'); ps.id = 'pageStyle'; document.head.appendChild(ps); }
    ps.textContent = '@page { size: ' + PAPER[o.paper].css + ' portrait; margin: ' + PAGE_MARGIN + 'mm; }';
    const clone = $('#sheet').cloneNode(true);
    clone.removeAttribute('id');
    const root = $('#printRoot');
    root.innerHTML = '';
    root.appendChild(clone);
    window.print();
  }
  window.addEventListener('afterprint', () => { $('#printRoot').innerHTML = ''; });

  /* ---------- PDF / PNG layout (millimetres) ---------- */
  /** Work out where every label goes. paginate=true splits into pages; false makes one tall sheet. */
  function layout(units, o, paginate) {
    const p = PAPER[o.paper];
    const lw = o.size, lh = o.size + (o.showText ? textHeight(o.size) : 0);
    const gridW = o.perRow * lw + (o.perRow - 1) * GAP;
    const x0 = (p.w - gridW) / 2;
    const rowsPerPage = Math.max(1, Math.floor((p.h - 2 * PAGE_MARGIN + GAP) / (lh + GAP)));
    const pages = [];
    units.forEach((u, i) => {
      const row = Math.floor(i / o.perRow), col = i % o.perRow;
      const pg = paginate ? Math.floor(row / rowsPerPage) : 0;
      const r = paginate ? row % rowsPerPage : row;
      (pages[pg] = pages[pg] || []).push({ u, x: x0 + col * (lw + GAP), y: PAGE_MARGIN + r * (lh + GAP) });
    });
    const totalRows = Math.ceil(units.length / o.perRow);
    const pageH = paginate ? p.h : 2 * PAGE_MARGIN + totalRows * lh + (totalRows - 1) * GAP;
    return { pages, pageW: p.w, pageH, lw, lh };
  }

  async function downloadSheetPdf() {
    const units = sheetUnits();
    if (!units.length) { toast('Nothing to export yet.', 'warn'); return; }
    if (!window.jspdf) { toast('PDF library not loaded (check your internet connection).', 'bad'); return; }
    const o = getOpts();
    const L = layout(units, o, true);
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: o.paper === 'a4' ? 'a4' : 'letter', orientation: 'portrait' });
    const fit = (s, maxW) => {               // shorten text with "..." so it fits the label width
      if (doc.getTextWidth(s) <= maxW) return s;
      let t = s;
      while (t.length > 1 && doc.getTextWidth(t + '...') > maxW) t = t.slice(0, -1);
      return t + '...';
    };
    try {
      for (let pi = 0; pi < L.pages.length; pi++) {
        if (pi > 0) doc.addPage();
        doc.setLineWidth(0.25); doc.setDrawColor(136); doc.setLineDashPattern([1, 1], 0);   // dashed cut lines
        for (const it of L.pages[pi]) {
          doc.addImage(await qrDataUrl(it.u.id), 'PNG', it.x, it.y, L.lw, L.lw);
          doc.rect(it.x, it.y, L.lw, L.lh, 'S');
          if (o.showText) {
            const th = textHeight(o.size), cx = it.x + L.lw / 2, ty = it.y + L.lw;
            doc.setTextColor(0); doc.setFontSize(fontPt(o.size));
            doc.setFont('helvetica', 'normal');
            doc.text(fit(it.u.name, L.lw - 1.5), cx, ty + th * 0.45, { align: 'center' });
            doc.setFont('courier', 'bold');
            doc.text(fit(it.u.id, L.lw - 1.5), cx, ty + th * 0.85, { align: 'center' });
          }
        }
      }
      doc.save('labels-' + stamp() + '.pdf');
    } catch (err) { toast('PDF export failed: ' + err.message, 'bad'); }
  }

  /* ---------- PNG helpers ---------- */
  const loadImg = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });

  /** Draw one label on a canvas. (x, y) in px, ppm = pixels per millimetre. */
  async function drawLabel(ctx, u, x, y, o, ppm) {
    const s = o.size * ppm, th = textHeight(o.size) * ppm;
    const img = await loadImg(await qrDataUrl(u.id));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, s, s);
    ctx.imageSmoothingEnabled = true;
    ctx.strokeStyle = '#888'; ctx.lineWidth = 0.25 * ppm; ctx.setLineDash([ppm, ppm]);
    ctx.strokeRect(x, y, s, s + (o.showText ? th : 0));
    ctx.setLineDash([]);
    if (o.showText) {
      const px = fontPt(o.size) * 25.4 / 72 * ppm;           // pt -> mm -> px
      const fitText = (t, font) => {
        ctx.font = font;
        if (ctx.measureText(t).width <= s - 1.5 * ppm) return t;
        while (t.length > 1 && ctx.measureText(t + '...').width > s - 1.5 * ppm) t = t.slice(0, -1);
        return t + '...';
      };
      ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const f1 = px + 'px Arial, Helvetica, sans-serif', f2 = 'bold ' + px + 'px "Courier New", monospace';
      ctx.font = f1; ctx.fillText(fitText(u.name, f1), x + s / 2, y + s + th * 0.38);
      ctx.font = f2; ctx.fillText(fitText(u.id, f2), x + s / 2, y + s + th * 0.74);
    }
  }

  const canvasToBlob = (c) => new Promise((res) => c.toBlob(res, 'image/png'));

  async function downloadSheetPng() {
    const units = sheetUnits();
    if (!units.length) { toast('Nothing to export yet.', 'warn'); return; }
    const o = getOpts();
    const L = layout(units, o, false);                       // one continuous sheet
    const ppm = Math.min(300 / 25.4, 16000 / L.pageH);       // 300 dpi, shrunk if the image would be huge
    if (ppm < 4) { toast('Too many labels for one PNG — use PDF or print in smaller batches.', 'warn'); return; }
    try {
      const c = document.createElement('canvas');
      c.width = Math.round(L.pageW * ppm); c.height = Math.round(L.pageH * ppm);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      for (const it of L.pages[0]) await drawLabel(ctx, it.u, it.x * ppm, it.y * ppm, o, ppm);
      downloadBlob(await canvasToBlob(c), 'labels-' + stamp() + '.png');
    } catch (err) { toast('PNG export failed: ' + err.message, 'bad'); }
  }

  /** PNG of one label (uses the current size / text options). */
  async function downloadSingleLabel(id) {
    const u = unitIndex.get(id);
    if (!u) return;
    const o = getOpts(), ppm = 300 / 25.4;
    try {
      const c = document.createElement('canvas');
      c.width = Math.round(o.size * ppm) + 2;
      c.height = Math.round((o.size + (o.showText ? textHeight(o.size) : 0)) * ppm) + 2;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await drawLabel(ctx, u, 1, 1, o, ppm);
      downloadBlob(await canvasToBlob(c), id + '.png');
    } catch (err) { toast('PNG export failed: ' + err.message, 'bad'); }
  }

  function bindGenerate() {
    $('#genForm').addEventListener('submit', onGenerate);
    ['optSize', 'optPaper', 'optText'].forEach((id) => $('#' + id).addEventListener('change', applySheetOpts));
    $('#optPerRow').addEventListener('input', applySheetOpts);
    $('#btnPrint').addEventListener('click', doPrint);
    $('#btnPdf').addEventListener('click', downloadSheetPdf);
    $('#btnPng').addEventListener('click', downloadSheetPng);
    $('#btnClearSheet').addEventListener('click', () => { state.sheet = []; saveState(); renderSheet(); });
  }

  /* ==========================================================
     5. SCAN TAB
     A "session" is one counting run. It is saved to localStorage so a
     phone reload / accidental tab close does not lose the count.
       session = { scope, started, counted:[ids], dup, unknown:[codes],
                   log:[{t, kind, msg}], finished, report, applied }
     scope = '' (all products) or a SKU.
     ========================================================== */
  let session = null;
  let sessionCounted = new Set();      // fast duplicate check
  const lastSeen = new Map();          // code -> last time it was detected (for the cooldown)
  let html5 = null, scanning = false, cameras = [], camIdx = -1, audioCtx = null;

  function loadSession() {
    try { session = JSON.parse(localStorage.getItem(LS_SESSION) || 'null'); } catch (e) { session = null; }
    sessionCounted = new Set(session ? session.counted : []);
  }
  function saveSession() {
    try { session ? localStorage.setItem(LS_SESSION, JSON.stringify(session)) : localStorage.removeItem(LS_SESSION); } catch (e) { /* ignore */ }
  }
  function ensureSession() {
    if (!session) {
      session = { scope: $('#scanScope').value, started: new Date().toISOString(), counted: [], dup: 0, unknown: [], log: [], finished: false };
      sessionCounted = new Set();
      saveSession();
    }
  }

  /* ---------- feedback: sound + vibration + banner ---------- */
  function ensureAudio() {            // must be triggered by a user tap (Start / Add buttons)
    try {
      if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio available */ }
  }
  function tone(freq, dur, type, delay) {
    if (!audioCtx) return;
    const t = audioCtx.currentTime + (delay || 0), o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = type || 'sine'; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }
  const vibrate = (p) => { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* unsupported */ } };
  function signal(kind) {
    if (kind === 'ok') { tone(1000, 0.12, 'sine'); vibrate(120); }
    else if (kind === 'warn') { tone(500, 0.12, 'square'); tone(500, 0.12, 'square', 0.18); vibrate([60, 60, 60]); }
    else { tone(200, 0.35, 'sawtooth'); vibrate([200, 80, 200]); }
  }
  function setFeedback(kind, title, detail) {
    const f = $('#feedback');
    f.className = 'feedback ' + (kind || '');
    f.innerHTML = '<strong>' + esc(title) + '</strong>' + (detail ? '<br>' + esc(detail) : '');
  }

  /* ---------- core: handle one scanned / typed code ---------- */
  function processCode(raw, source) {
    if (session && session.finished) { toast('Close or apply the report before counting again.', 'warn'); return; }
    const code = String(raw || '').trim().toUpperCase();
    if (!code) return;
    const now = Date.now();
    if (source === 'camera') {
      // Cooldown: the decoder fires many times per second while a code is in view.
      // Refreshing the timestamp on every detection means a code held steadily in front of
      // the camera is ignored until it has been out of view for COOLDOWN_MS.
      const last = lastSeen.get(code);
      lastSeen.set(code, now);
      if (last && now - last < COOLDOWN_MS) return;
    }
    ensureSession();
    const unit = unitIndex.get(code);
    let kind, title, msg;
    if (!unit) {
      if (!session.unknown.includes(code)) session.unknown.push(code);
      kind = 'bad'; title = '✖ Unknown code'; msg = code;
    } else if (session.scope && unit.sku !== session.scope) {
      kind = 'warn'; title = '⚠ Outside selected scope'; msg = unit.id + ' · ' + unit.name + ' (not counted)';
    } else if (sessionCounted.has(unit.id)) {
      session.dup++;
      kind = 'warn'; title = '⚠ Duplicate'; msg = unit.id + ' was already counted';
    } else {
      sessionCounted.add(unit.id); session.counted.push(unit.id);
      kind = 'ok'; title = '✔ Counted'; msg = unit.id + ' · ' + unit.name + (unit.status === MISSING ? ' (was marked missing — found!)' : '');
    }
    session.log.unshift({ t: new Date().toISOString(), kind, msg: (kind === 'bad' ? 'Unknown: ' : '') + msg });
    if (session.log.length > 100) session.log.length = 100;
    saveSession();
    setFeedback(kind, title, msg);
    signal(kind);
    renderLive();
    updateScanUI();
  }

  /* ---------- live panel ---------- */
  function scopeUnits(scope) { return state.units.filter((u) => !scope || u.sku === scope); }

  function renderScopeOptions() {
    const sel = $('#scanScope');
    if (session) { return; }                                  // locked while a session exists
    const cur = sel.value, skus = new Map();
    state.units.forEach((u) => { if (!skus.has(u.sku)) skus.set(u.sku, u.name); });
    sel.innerHTML = '<option value="">All products</option>' +
      Array.from(skus).map(([sku, name]) => '<option value="' + esc(sku) + '">' + esc(name) + ' (' + esc(sku) + ')</option>').join('');
    sel.value = skus.has(cur) ? cur : '';
  }

  function renderLive() {
    const scope = session ? session.scope : $('#scanScope').value;
    $('#lvTotal').textContent = session ? session.counted.length : 0;
    $('#lvDup').textContent = session ? session.dup : 0;
    $('#lvUnknown').textContent = session ? session.unknown.length : 0;

    // Per-product breakdown: scanned vs expected (= units currently "in stock")
    const rows = new Map();
    scopeUnits(scope).forEach((u) => {
      const r = rows.get(u.sku) || { name: u.name, scanned: 0, expected: 0 };
      if (u.status === IN_STOCK) r.expected++;
      rows.set(u.sku, r);
    });
    (session ? session.counted : []).forEach((id) => { const u = unitIndex.get(id); if (u && rows.has(u.sku)) rows.get(u.sku).scanned++; });
    $('#liveTable tbody').innerHTML = rows.size
      ? Array.from(rows).map(([sku, r]) => '<tr><td>' + esc(r.name) + ' <span class="muted">' + esc(sku) + '</span></td><td><b>' + r.scanned + '</b></td><td>' + r.expected + '</td></tr>').join('')
      : '<tr><td colspan="3" class="muted">No products yet.</td></tr>';

    $('#scanLog').innerHTML = session && session.log.length
      ? session.log.slice(0, 50).map((l) => '<li class="' + l.kind + '"><time>' + esc(new Date(l.t).toLocaleTimeString()) + '</time>' + esc(l.msg) + '</li>').join('')
      : '<li class="muted">Nothing scanned yet.</li>';
  }

  function updateScanUI() {
    const has = !!session, fin = has && session.finished;
    $('#btnStart').disabled = scanning || fin;
    $('#btnStart').textContent = has ? '▶ Resume Count' : '▶ Start Count';
    $('#btnStop').disabled = !scanning;
    $('#btnSwitch').disabled = !scanning;
    $('#btnFinish').disabled = !has || fin;
    $('#btnDiscard').disabled = !has;
    $('#scanScope').disabled = has;
    $('#manualCode').disabled = fin;
    $('#reportCard').hidden = !fin;
  }

  /* ---------- camera ---------- */
  function showCamError(msg) { const e = $('#camError'); e.textContent = msg; e.hidden = false; }
  const hideCamError = () => { $('#camError').hidden = true; };

  function explainCameraError(err) {
    const s = String((err && (err.name || '')) + ' ' + (err && err.message ? err.message : err));
    if (/NotAllowed|Permission|denied/i.test(s))
      return 'Camera permission was denied. Allow camera access for this site (tap the lock / ⓘ icon next to the address bar → Permissions), then press Start Count again. You can keep counting with manual entry below.';
    if (/NotFound|DevicesNotFound|no camera/i.test(s))
      return 'No camera was found on this device. Use manual entry below, or try another device.';
    if (/NotReadable|TrackStart|in use|Could not start video/i.test(s))
      return 'The camera is busy or unavailable — close other apps or tabs that use it and try again.';
    if (/Overconstrained/i.test(s))
      return 'That camera is not available. Try “Switch camera”.';
    return 'Could not start the camera: ' + s.trim();
  }

  async function startCamera() {
    if (scanning) return;
    if (session && session.finished) { toast('Close or apply the report first.', 'warn'); return; }
    ensureAudio();
    hideCamError();
    if (typeof Html5Qrcode === 'undefined') { showCamError('The scanner library failed to load (check your internet connection). Manual entry still works.'); return; }
    if (!window.isSecureContext || !navigator.mediaDevices) {
      showCamError('Camera access needs HTTPS or localhost. Open this page via https:// (or http://localhost) — see the README. Manual entry still works.');
      return;
    }
    ensureSession();
    updateScanUI();
    try {
      html5 = new Html5Qrcode('reader', { formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], verbose: false });
      const source = camIdx >= 0 && cameras[camIdx] ? { deviceId: { exact: cameras[camIdx].id } } : { facingMode: 'environment' };  // rear camera first
      await html5.start(source,
        // qrbox = the square scan area. The library throws if it is under 50px, and it can call this
        // before the video has a height (h = 0), so guard against that.
        { fps: 10, qrbox: (w, h) => { const s = Math.max(50, Math.floor(Math.min(w || 0, h || w || 0) * 0.75)); return { width: s, height: s }; } },
        (text) => processCode(text, 'camera'),
        () => { /* per-frame "no QR found" — ignore */ });
      scanning = true;
      try {            // permission is granted now, so camera labels / ids are available
        if (!cameras.length) cameras = await Html5Qrcode.getCameras();
        const dev = html5.getRunningTrackSettings && html5.getRunningTrackSettings().deviceId;
        if (dev) camIdx = cameras.findIndex((c) => c.id === dev);
      } catch (e) { /* switching just won't be available */ }
      setFeedback('', 'Scanning…', 'Point the camera at a QR label.');
    } catch (err) {
      scanning = false;
      html5 = null;
      showCamError(explainCameraError(err));
    }
    updateScanUI();
  }

  async function stopCamera() {
    if (html5 && scanning) {
      try { await html5.stop(); } catch (e) { /* already stopped */ }
      try { html5.clear(); } catch (e) { /* ignore */ }
    }
    scanning = false; html5 = null;
    updateScanUI();
  }

  async function switchCamera() {
    if (!scanning) return;
    if (cameras.length < 2) { toast('Only one camera was found on this device.', 'warn'); return; }
    await stopCamera();
    camIdx = (camIdx + 1) % cameras.length;
    await startCamera();
  }

  /* ---------- finish, report ---------- */
  function buildReport() {
    const scope = session.scope, counted = new Set(session.counted);
    const rows = new Map();
    scopeUnits(scope).forEach((u) => {
      const r = rows.get(u.sku) || { sku: u.sku, name: u.name, counted: 0, expected: 0 };
      if (u.status === IN_STOCK) r.expected++;
      rows.set(u.sku, r);
    });
    const countedIds = session.counted.filter((id) => unitIndex.has(id));
    countedIds.forEach((id) => { const r = rows.get(unitIndex.get(id).sku); if (r) r.counted++; });
    const missing = scopeUnits(scope).filter((u) => u.status === IN_STOCK && !counted.has(u.id)).map((u) => u.id);
    return {
      date: new Date().toISOString(), scope, duplicates: session.dup,
      rows: Array.from(rows.values()), countedIds, missing, unknown: session.unknown.slice()
    };
  }

  async function finishCount() {
    if (!session || session.finished) return;
    if (!session.counted.length && !confirm('Nothing has been counted. Finish anyway? Every in-stock unit would be reported as missing.')) return;
    await stopCamera();
    session.finished = true;
    session.report = buildReport();
    saveSession();
    renderReport();
    updateScanUI();
    $('#reportCard').scrollIntoView({ behavior: 'smooth' });
  }

  function renderReport() {
    if (!session || !session.report) return;
    const r = session.report;
    $('#reportMeta').textContent = fmtDate(r.date) + ' · scope: ' + (r.scope || 'all products') +
      ' · counted ' + r.countedIds.length + ' · duplicates ignored ' + r.duplicates;
    $('#reportTable tbody').innerHTML = r.rows.map((x) => {
      const d = x.counted - x.expected;
      return '<tr><td>' + esc(x.name) + '</td><td>' + esc(x.sku) + '</td><td>' + x.counted + '</td><td>' + x.expected +
        '</td><td class="' + (d < 0 ? 'neg' : d > 0 ? 'pos' : '') + '">' + (d > 0 ? '+' : '') + d + '</td></tr>';
    }).join('') || '<tr><td colspan="5" class="muted">No products in scope.</td></tr>';
    $('#repMissingN').textContent = r.missing.length;
    $('#repMissing').innerHTML = r.missing.map((id) => '<span class="chip">' + esc(id) + '</span>').join('') || '<span class="muted">None — everything expected was found.</span>';
    $('#repUnknownN').textContent = r.unknown.length;
    $('#repUnknown').innerHTML = r.unknown.map((c) => '<span class="chip unk">' + esc(c) + '</span>').join('') || '<span class="muted">None.</span>';
    $('#repApply').disabled = !!session.applied;
    $('#repApply').textContent = session.applied ? 'Stock status updated ✓' : 'Update stock status';
  }

  /** Counted units stay / become "in stock"; expected-but-not-scanned units become "missing". */
  function applyReport() {
    if (!session || !session.report || session.applied) return;
    const r = session.report;
    if (!confirm('Mark ' + r.countedIds.length + ' counted unit(s) as "in stock" and ' + r.missing.length + ' unit(s) as "missing"?')) return;
    r.countedIds.forEach((id) => { const u = unitIndex.get(id); if (u) u.status = IN_STOCK; });
    r.missing.forEach((id) => { const u = unitIndex.get(id); if (u) u.status = MISSING; });
    session.applied = true;
    saveSession();
    commit();
    renderReport();
    toast('Stock status updated.', 'ok');
  }

  function exportReportCsv() {
    if (!session || !session.report) return;
    const r = session.report, lines = [];
    lines.push(csvRow(['type', 'unit_id', 'product', 'sku', 'counted', 'expected', 'difference']));
    r.rows.forEach((x) => lines.push(csvRow(['SUMMARY', '', x.name, x.sku, x.counted, x.expected, x.counted - x.expected])));
    r.countedIds.forEach((id) => { const u = unitIndex.get(id); lines.push(csvRow(['COUNTED', id, u ? u.name : '', u ? u.sku : '', '', '', ''])); });
    r.missing.forEach((id) => { const u = unitIndex.get(id); lines.push(csvRow(['MISSING', id, u ? u.name : '', u ? u.sku : '', '', '', ''])); });
    r.unknown.forEach((c) => lines.push(csvRow(['UNKNOWN', c, '', '', '', '', ''])));
    downloadText('﻿' + lines.join('\r\n'), 'count-report-' + stamp() + '.csv', 'text/csv');
  }

  async function clearSession() {
    await stopCamera();
    session = null; sessionCounted = new Set(); lastSeen.clear();
    saveSession();
    setFeedback('', 'Ready.', 'Press “Start Count”.');
    renderScopeOptions(); renderLive(); updateScanUI();
  }

  function bindScan() {
    $('#btnStart').addEventListener('click', startCamera);
    $('#btnStop').addEventListener('click', stopCamera);
    $('#btnSwitch').addEventListener('click', switchCamera);
    $('#btnFinish').addEventListener('click', finishCount);
    $('#btnDiscard').addEventListener('click', () => { if (confirm('Discard this count? Scanned data will be lost.')) clearSession(); });
    $('#scanScope').addEventListener('change', renderLive);
    $('#manualForm').addEventListener('submit', (e) => {      // fallback when the camera fails
      e.preventDefault();
      ensureAudio();
      processCode($('#manualCode').value, 'manual');
      $('#manualCode').value = '';
    });
    $('#repApply').addEventListener('click', applyReport);
    $('#repCsv').addEventListener('click', exportReportCsv);
    $('#repClose').addEventListener('click', () => {
      if (!session.applied && !confirm('Close the report without updating stock status?')) return;
      clearSession();
    });
    // Release the camera when the page is hidden (phone locked, app switched).
    document.addEventListener('visibilitychange', () => { if (document.hidden && scanning) stopCamera(); });
  }

  /* ==========================================================
     6. TABS & START-UP
     ========================================================== */
  function switchTab(name) {
    if (name !== 'scan' && scanning) { stopCamera(); toast('Camera paused.', ''); }
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    window.scrollTo(0, 0);
  }

  function init() {
    loadState();
    loadSession();
    $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
    bindProducts(); bindGenerate(); bindScan();
    renderAll();
    renderSheet();
    if (session && session.finished) renderReport();
    updateScanUI();
    if (session && !session.finished) setFeedback('', 'Count in progress', session.counted.length + ' unit(s) counted so far. Press “Resume Count”.');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
