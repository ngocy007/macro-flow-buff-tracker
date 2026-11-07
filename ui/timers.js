/* Timers page: bind a hotkey, press it in game and a countdown of N seconds starts (shown on the overlay). */
var Timers = (function () {
  var X = { ctx: null, list: [], sel: 0, runs: {} };
  var PRESETS = [5, 8, 10, 15, 30, 60];

  var TEMPLATE = [
    '<header class="phead"><div><h1>Hẹn giờ</h1><p>Gán phím, bấm trong game là bắt đầu đếm ngược số giây bạn đặt. Hiện trên cửa sổ nổi, có đếm 5-4-3-2-1 và âm báo hết giờ.</p></div>',
    '<button id="tNew" type="button" class="btn primary">' + ICON.plus + 'Hẹn giờ mới</button></header>',
    '<div class="cols"><section id="tList" class="panel mlist" aria-label="Danh sách hẹn giờ"></section>',
    '<section id="tEdit" class="panel medit" aria-label="Sửa hẹn giờ"></section></div>',
  ].join('');

  function cur() { return X.list[X.sel]; }
  function newId() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function fmt(s) { return String(Math.round(s * 10) / 10).replace('.', ','); }

  /* ---------- persistence ---------- */
  function saveNow() {
    return API.invoke('save_timers', { timers: X.list }).then(function (r) {
      X.ctx.setState(r.state);
      if (r.errors && r.errors.length) X.ctx.toast('Không gán được phím tắt: ' + r.errors.join(' · '), 'warn');
    }).catch(X.ctx.fail);
  }
  var saveSoon = debounce(saveNow, 400);
  function changed(redraw) { saveSoon(); renderList(); renderMonitor(); if (redraw) renderEdit(); }

  function toggle(t) {
    if (X.runs[t.id]) { API.invoke('cancel_timer', { id: t.id }).catch(X.ctx.fail); return; }
    saveNow().then(function () { return API.invoke('start_timer', { id: t.id }); }).catch(X.ctx.fail);
  }

  /* ---------- live countdown ---------- */
  function liveText(t) {
    var r = X.runs[t.id]; if (!r) return null;
    var ms = r.endsAtUnixMs - Date.now();
    return ms > 0 ? Math.ceil(ms / 1000) + 's' : 'Hết giờ';
  }
  function tick() {
    $$('[data-timer]').forEach(function (n) {
      var t = X.list.filter(function (x) { return x.id === n.dataset.timer; })[0]; if (!t) return;
      var r = X.runs[t.id], kind = n.dataset.kind;
      if (kind === 'text') n.textContent = liveText(t) || (fmt(t.seconds || 0) + ' giây');
      else if (kind === 'bar') {
        var pct = r ? Math.max(0, Math.min(1, (r.endsAtUnixMs - Date.now()) / r.durationMs)) : 0;
        n.style.width = Math.round(pct * 100) + '%';
        n.parentNode.style.visibility = r ? 'visible' : 'hidden';
      }
    });
  }

  /* ---------- list ---------- */
  function renderList() {
    var box = $('#tList');
    box.innerHTML = '';
    if (!X.list.length) box.appendChild(el('div', { class: 'empty', text: 'Chưa có hẹn giờ. Bấm “Hẹn giờ mới”.' }));
    X.list.forEach(function (t, i) {
      function pick() { X.sel = i; renderList(); renderEdit(); }
      box.appendChild(el('div', { class: 'mrow' + (i === X.sel ? ' sel' : '') + (t.enabled === false ? ' off' : '') + (X.runs[t.id] ? ' running' : ''),
          role: 'button', tabindex: '0', 'aria-pressed': i === X.sel ? 'true' : 'false', onclick: pick,
          onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
        el('span', { class: 'nm' }, el('b', { text: t.name }), el('small', { 'data-timer': t.id, 'data-kind': 'text', text: fmt(t.seconds || 0) + ' giây' })),
        t.hotkey ? el('kbd', { text: t.hotkey }) : el('span', { class: 'muted', text: 'Chưa gán phím' })));
    });
    var c = $('#navTimerCount'); if (c) c.textContent = X.list.length || '';
    tick();
  }

  /* ---------- editor ---------- */
  function renderEdit() {
    var box = $('#tEdit'), t = cur();
    box.innerHTML = '';
    if (!t) { box.appendChild(el('div', { class: 'empty', text: 'Tạo hẹn giờ đầu tiên để bắt đầu.' })); return; }
    var running = !!X.runs[t.id];

    box.appendChild(el('div', { class: 'row' },
      el('label', { class: 'fld grow' }, el('span', { text: 'Tên (hiện trên cửa sổ nổi)' }),
        el('input', { type: 'text', value: t.name, onchange: function (e) { t.name = e.target.value.trim() || t.name; e.target.value = t.name; changed(false); } })),
      el('label', { class: 'chk', title: 'Tắt thì phím tắt của hẹn giờ này không hoạt động' },
        el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: t.enabled !== false, onchange: function (e) { t.enabled = e.target.checked; changed(false); } }), el('span')), 'Bật')));

    var secs = el('input', { type: 'number', min: '0.5', max: '3600', step: '0.5', value: String(t.seconds || 8), style: 'height:56px;font:700 28px var(--mono)',
      onchange: function (e) { t.seconds = clamp(parseFloat(e.target.value) || 1, 0.5, 3600); e.target.value = t.seconds; changed(false); } });
    var chips = el('div', { class: 'row' });
    PRESETS.forEach(function (p) {
      chips.appendChild(el('button', { class: 'btn small' + (t.seconds === p ? ' primary' : ''), type: 'button', text: p + 's', onclick: function () { t.seconds = p; changed(true); } }));
    });
    box.appendChild(el('div', { class: 'fld' }, el('span', { text: 'Thời gian đếm (giây)' }), secs, chips));

    var hk = el('input', { type: 'text', value: t.hotkey || '', placeholder: 'Bấm để gán', class: 'grow' });
    bindComboInput(hk, function (c) { t.hotkey = c; hk.value = c; changed(false); });
    var rp = el('select', { onchange: function () { t.repress = rp.value; changed(false); } });
    [['restart', 'Đếm lại từ đầu'], ['cancel', 'Hủy hẹn giờ']].forEach(function (o) { rp.appendChild(el('option', { value: o[0], text: o[1] })); });
    rp.value = t.repress || 'restart';
    box.appendChild(el('div', { class: 'grid2' },
      el('label', { class: 'fld' }, el('span', { text: 'Phím tắt bắt đầu' }),
        el('div', { class: 'row' }, hk, el('button', { class: 'btn ghost', type: 'button', text: 'Xóa', onclick: function () { t.hotkey = ''; hk.value = ''; changed(false); } }))),
      el('label', { class: 'fld' }, el('span', { text: 'Bấm lại khi đang đếm' }), rp)));

    var sndId = t.sound && t.sound.assetId || '';
    box.appendChild(el('div', { class: 'row' },
      el('label', { class: 'fld grow' }, el('span', { text: 'Âm khi hết giờ' }),
        X.ctx.soundSelect(sndId, function (v) { t.sound = v ? { type: 'custom', assetId: v, fileName: v + '.wav' } : null; changed(false); }, 'ready', 'Âm khi hết giờ')),
      el('label', { class: 'chk', title: 'Dùng bộ âm đếm ngược ở Cài đặt › Âm thanh (chỉ khi đếm trên 5 giây)' },
        el('input', { type: 'checkbox', checked: t.prewarn !== false, onchange: function (e) { t.prewarn = e.target.checked; changed(false); } }), 'Đếm ngược 5-4-3-2-1')));

    box.appendChild(el('div', { class: 'bar', style: 'visibility:hidden' }, el('i', { 'data-timer': t.id, 'data-kind': 'bar', style: 'background:var(--amber)' })));

    box.appendChild(el('div', { class: 'foot' },
      el('button', { class: 'btn ' + (running ? 'stop' : 'primary'), type: 'button', html: running ? ICON.stop + 'Hủy' : ICON.play + 'Bắt đầu thử', onclick: function () { toggle(t); } }),
      el('span', { class: 'muted mono', 'data-timer': t.id, 'data-kind': 'text' }),
      el('button', { class: 'btn danger right', type: 'button', text: 'Xóa hẹn giờ', onclick: function () {
        if (!confirm('Xóa hẹn giờ “' + t.name + '”?')) return;
        if (running) API.invoke('cancel_timer', { id: t.id }).catch(function () {});
        X.list.splice(X.sel, 1); X.sel = Math.max(0, X.sel - 1); changed(true);
      } })));
    box.appendChild(el('p', { class: 'hint', text: 'Phím tắt hoạt động cả khi đang ở trong game và không chặn phím đó với game — ví dụ gán đúng phím chiêu để vừa ra chiêu vừa bắt đầu đếm. (Nếu game chạy quyền Admin, app cũng cần quyền Admin.)' }));
    tick();
  }

  /* ---------- monitor page panel ---------- */
  function renderMonitor() {
    var box = $('#monTimers'); if (!box) return;
    box.innerHTML = '';
    var on = X.list.filter(function (t) { return t.enabled !== false; });
    if (!on.length) { box.appendChild(el('p', { class: 'hint', text: 'Chưa có hẹn giờ nào đang bật.' })); return; }
    on.forEach(function (t) {
      var running = !!X.runs[t.id];
      box.appendChild(el('div', { class: 'row', style: 'flex-wrap:nowrap' },
        el('span', { class: 'grow', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600', text: t.name }),
        el('span', { class: 'mono', style: 'color:' + (running ? 'var(--amber)' : 'var(--muted)'), 'data-timer': t.id, 'data-kind': 'text' }),
        t.hotkey ? el('kbd', { text: t.hotkey }) : null,
        el('button', { class: 'btn small icon ' + (running ? 'stop' : ''), type: 'button', title: running ? 'Hủy' : 'Bắt đầu', 'aria-label': (running ? 'Hủy ' : 'Bắt đầu ') + t.name,
          html: running ? ICON.stop : ICON.play, onclick: function () { toggle(t); } })));
    });
    tick();
  }

  function applyRuns(s) {
    var was = Object.keys(X.runs).sort().join(',');
    X.runs = {};
    ((s && s.timers) || []).forEach(function (r) { X.runs[r.id] = r; });
    if (Object.keys(X.runs).sort().join(',') !== was) {
      renderList(); renderMonitor();
      if (!$('#tEdit').contains(document.activeElement)) renderEdit();
    }
  }

  function init(ctx) {
    X.ctx = ctx;
    var saved = ctx.cfg().timers;
    X.list = Array.isArray(saved) ? saved : [];
    $('#tNew').onclick = function () {
      X.list.push({ id: newId(), name: 'Hẹn giờ ' + (X.list.length + 1), enabled: true, hotkey: '', seconds: 8, prewarn: true, sound: null, repress: 'restart' });
      X.sel = X.list.length - 1; changed(true);
    };
    API.listen('timer-state', applyRuns);
    API.invoke('get_timer_state').then(applyRuns).catch(function () {});
    renderList(); renderEdit(); renderMonitor();
    setInterval(tick, 100);
  }

  return { TEMPLATE: TEMPLATE, init: init };
})();
