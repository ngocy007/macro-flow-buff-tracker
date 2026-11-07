/* Macro page: record or build key/mouse sequences, bind a global hotkey, play them in the game. */
var Macros = (function () {
  var X = { ctx: null, list: [], sel: 0, running: null, rec: null };

  var TYPES = [['tap', 'Nhấn phím'], ['down', 'Giữ phím xuống'], ['up', 'Thả phím'], ['delay', 'Chờ'], ['click', 'Click chuột']];
  var BUTTONS = [['left', 'Chuột trái'], ['right', 'Chuột phải'], ['middle', 'Chuột giữa']];
  var REPEAT = [['once', 'Chạy 1 lần'], ['count', 'Lặp N lần'], ['toggle', 'Lặp đến khi bấm lại phím tắt']];

  var TEMPLATE = [
    '<header class="phead"><div><h1>Macro</h1><p>Ghi hoặc soạn chuỗi phím, gán phím tắt rồi bấm trong game để chạy. Bấm lại phím tắt để dừng.</p></div>',
    '<button id="mNew" type="button" class="btn primary">' + ICON.plus + 'Macro mới</button></header>',
    '<div class="cols"><section id="mList" class="panel mlist" aria-label="Danh sách macro"></section>',
    '<section id="mEdit" class="panel medit" aria-label="Sửa macro"></section></div>',
  ].join('');

  function cur() { return X.list[X.sel]; }
  function newId() { return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function blank(n) {
    return { id: newId(), name: 'Macro ' + n, enabled: true, hotkey: '', repeat: 'once', count: 3, gapMs: 0,
      steps: [{ t: 'tap', key: '1', holdMs: 30 }, { t: 'delay', ms: 200 }, { t: 'tap', key: '2', holdMs: 30 }] };
  }
  function totalMs(m) {
    return (m.steps || []).reduce(function (s, x) { return s + (x.t === 'delay' ? (x.ms || 0) : (x.t === 'tap' || x.t === 'click') ? (x.holdMs || 0) : 0); }, 0);
  }
  function describe(m) {
    var n = (m.steps || []).length, t = (totalMs(m) / 1000).toFixed(1).replace('.', ',');
    var r = m.repeat === 'toggle' ? ' · lặp' : m.repeat === 'count' ? ' · ×' + (m.count || 1) : '';
    return n + ' bước · ~' + t + 's' + r;
  }

  /* ---------- persistence ---------- */
  function saveNow() {
    return API.invoke('save_macros', { macros: X.list }).then(function (r) {
      X.ctx.setState(r.state);
      if (r.errors && r.errors.length) X.ctx.toast('Không gán được phím tắt: ' + r.errors.join(' · '), 'warn');
    }).catch(X.ctx.fail);
  }
  var saveSoon = debounce(saveNow, 400);
  function changed(rerenderEdit) { saveSoon(); renderList(); renderMonitor(); if (rerenderEdit) renderEdit(); }

  /* ---------- run ---------- */
  function play(m, delay) {
    if (X.running === m.id) { API.invoke('stop_macro').catch(X.ctx.fail); return; }
    if (!(m.steps || []).length) { X.ctx.toast('Macro chưa có bước nào.', 'warn'); return; }
    saveNow().then(function () {
      return API.invoke('play_macro', { id: m.id, delayMs: delay || 0 });
    }).then(function () {
      if (delay) X.ctx.toast('“' + m.name + '” sẽ chạy sau ' + delay / 1000 + ' giây — chuyển sang cửa sổ game.', 'info');
      X.ctx.addLog('Chạy macro “' + m.name + '”');
    }).catch(X.ctx.fail);
  }

  /* ---------- recording ---------- */
  function onRecKey(e) {
    var name = keyName(e);
    e.preventDefault(); e.stopPropagation();
    if (!name || e.repeat) return;
    var down = e.type === 'keydown', r = X.rec, now = performance.now();
    if (down && r.down[name]) return;
    if (r.last != null) { var gap = Math.round(now - r.last); if (gap >= 15) r.steps.push({ t: 'delay', ms: gap }); }
    r.last = now;
    if (down) r.down[name] = true; else delete r.down[name];
    r.steps.push({ t: down ? 'down' : 'up', key: name });
    $('#mRecInfo').textContent = 'Đang ghi… ' + r.steps.filter(function (s) { return s.t !== 'delay'; }).length + ' sự kiện phím';
  }
  /** down K, delay ≤ 600 ms, up K  ->  tap K (hold). Keeps the recording readable. */
  function compact(steps) {
    var out = [];
    for (var i = 0; i < steps.length; i++) {
      var a = steps[i], b = steps[i + 1], c = steps[i + 2];
      if (a.t === 'down' && b && b.t === 'up' && b.key === a.key) { out.push({ t: 'tap', key: a.key, holdMs: 30 }); i += 1; continue; }
      if (a.t === 'down' && b && b.t === 'delay' && b.ms <= 600 && c && c.t === 'up' && c.key === a.key) { out.push({ t: 'tap', key: a.key, holdMs: b.ms }); i += 2; continue; }
      out.push(a);
    }
    return out;
  }
  function toggleRec() {
    var m = cur(); if (!m) return;
    if (!X.rec) {
      X.rec = { steps: [], down: {}, last: null };
      window.addEventListener('keydown', onRecKey, true);
      window.addEventListener('keyup', onRecKey, true);
      if (document.activeElement) document.activeElement.blur();
      renderEdit();
      return;
    }
    window.removeEventListener('keydown', onRecKey, true);
    window.removeEventListener('keyup', onRecKey, true);
    var r = X.rec; X.rec = null;
    Object.keys(r.down).forEach(function (k) { r.steps.push({ t: 'up', key: k }); });
    var got = compact(r.steps);
    if (got.length) {
      if ((m.steps || []).length && !confirm('Thay các bước hiện có bằng ' + got.length + ' bước vừa ghi?\n(Bấm Hủy để thêm vào cuối.)')) m.steps = m.steps.concat(got);
      else m.steps = got;
      X.ctx.toast('Đã ghi ' + got.length + ' bước.', 'ok');
      changed(false);
    }
    renderEdit();
  }

  /* ---------- list ---------- */
  function renderList() {
    var box = $('#mList');
    box.innerHTML = '';
    if (!X.list.length) box.appendChild(el('div', { class: 'empty', text: 'Chưa có macro. Bấm “Macro mới”.' }));
    X.list.forEach(function (m, i) {
      var running = X.running === m.id;
      function pick() { if (X.rec) return; X.sel = i; renderList(); renderEdit(); }
      box.appendChild(el('div', { class: 'mrow' + (i === X.sel ? ' sel' : '') + (m.enabled === false ? ' off' : '') + (running ? ' running' : ''),
          role: 'button', tabindex: '0', 'aria-pressed': i === X.sel ? 'true' : 'false', onclick: pick,
          onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
        el('span', { class: 'nm' }, el('b', { text: m.name }), el('small', { text: running ? 'Đang chạy…' : describe(m) })),
        m.hotkey ? el('kbd', { text: m.hotkey }) : el('span', { class: 'muted', text: 'Chưa gán phím' })));
    });
    var c = $('#navMacroCount'); if (c) c.textContent = X.list.length || '';
  }

  /* ---------- editor ---------- */
  function keyField(step, onSet) {
    var inp = el('input', { type: 'text', value: step.key || '', placeholder: 'Bấm 1 phím', 'aria-label': 'Phím', readonly: true, class: 'hk' });
    inp.addEventListener('focus', function () { inp.classList.add('listening'); });
    inp.addEventListener('blur', function () { inp.classList.remove('listening'); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') return;
      e.preventDefault();
      var n = keyName(e);
      if (n) { inp.value = n; onSet(n); }
    });
    return inp;
  }
  function msField(v, label, onSet, max) {
    return el('input', { type: 'number', min: '0', max: String(max || 600000), step: '10', value: String(v || 0), 'aria-label': label, style: 'width:96px',
      onchange: function (e) { var n = clamp(Math.round(parseFloat(e.target.value) || 0), 0, max || 600000); e.target.value = n; onSet(n); } });
  }
  function stepRow(m, s, i) {
    var args = el('div', { class: 'args' });
    function set(k, v) { s[k] = v; changed(false); }
    if (s.t === 'tap') { args.appendChild(keyField(s, function (n) { set('key', n); })); args.appendChild(msField(s.holdMs == null ? 30 : s.holdMs, 'Thời gian giữ', function (n) { set('holdMs', n); }, 60000)); args.appendChild(el('span', { class: 'unit', text: 'ms giữ' })); }
    else if (s.t === 'down' || s.t === 'up') args.appendChild(keyField(s, function (n) { set('key', n); }));
    else if (s.t === 'delay') { args.appendChild(msField(s.ms, 'Thời gian chờ', function (n) { set('ms', n); })); args.appendChild(el('span', { class: 'unit', text: 'ms' })); }
    else if (s.t === 'click') {
      var bs = el('select', { 'aria-label': 'Nút chuột', onchange: function () { set('button', bs.value); } });
      BUTTONS.forEach(function (b) { bs.appendChild(el('option', { value: b[0], text: b[1] })); });
      bs.value = s.button || 'left';
      args.appendChild(bs); args.appendChild(msField(s.holdMs == null ? 30 : s.holdMs, 'Thời gian giữ', function (n) { set('holdMs', n); }, 60000)); args.appendChild(el('span', { class: 'unit', text: 'ms giữ' }));
    }
    var ts = el('select', { 'aria-label': 'Loại bước', onchange: function () {
      var t = ts.value, n = { t: t };
      if (t === 'delay') n.ms = 100; else if (t === 'click') { n.button = 'left'; n.holdMs = 30; } else { n.key = s.key || ''; if (t === 'tap') n.holdMs = 30; }
      m.steps[i] = n; changed(true);
    } });
    TYPES.forEach(function (t) { ts.appendChild(el('option', { value: t[0], text: t[1] })); });
    ts.value = s.t;
    function mv(d) { var j = i + d; if (j < 0 || j >= m.steps.length) return; var x = m.steps[i]; m.steps[i] = m.steps[j]; m.steps[j] = x; changed(true); }
    return el('div', { class: 'step', 'data-t': s.t },
      el('span', { class: 'ix', text: String(i + 1) }), ts, args,
      el('div', { class: 'acts' },
        el('button', { class: 'btn small icon ghost', type: 'button', title: 'Lên', 'aria-label': 'Chuyển bước lên', html: ICON.up, disabled: i === 0, onclick: function () { mv(-1); } }),
        el('button', { class: 'btn small icon ghost', type: 'button', title: 'Xuống', 'aria-label': 'Chuyển bước xuống', html: ICON.down, disabled: i === m.steps.length - 1, onclick: function () { mv(1); } }),
        el('button', { class: 'btn small icon ghost', type: 'button', title: 'Xóa bước', 'aria-label': 'Xóa bước', html: ICON.trash, onclick: function () { m.steps.splice(i, 1); changed(true); } })));
  }
  function renderEdit() {
    var box = $('#mEdit'), m = cur();
    box.innerHTML = '';
    if (!m) { box.appendChild(el('div', { class: 'empty', text: 'Tạo macro đầu tiên để bắt đầu.' })); return; }
    if (!m.steps) m.steps = [];
    var running = X.running === m.id, rec = !!X.rec;

    box.appendChild(el('div', { class: 'row' },
      el('label', { class: 'fld grow' }, el('span', { text: 'Tên macro' }),
        el('input', { type: 'text', value: m.name, onchange: function (e) { m.name = e.target.value.trim() || m.name; e.target.value = m.name; changed(false); } })),
      el('label', { class: 'chk', title: 'Tắt thì phím tắt của macro này không hoạt động' },
        el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: m.enabled !== false, onchange: function (e) { m.enabled = e.target.checked; changed(false); } }), el('span')), 'Bật')));

    var hk = el('input', { type: 'text', value: m.hotkey || '', placeholder: 'Bấm để gán', class: 'grow' });
    bindComboInput(hk, function (c) { m.hotkey = c; hk.value = c; changed(false); });
    var rs = el('select', { onchange: function () { m.repeat = rs.value; changed(true); } });
    REPEAT.forEach(function (r) { rs.appendChild(el('option', { value: r[0], text: r[1] })); });
    rs.value = m.repeat || 'once';
    var cnt = el('input', { type: 'number', min: '1', max: '100000', value: String(m.count || 3), disabled: m.repeat !== 'count',
      onchange: function (e) { m.count = clamp(parseInt(e.target.value, 10) || 1, 1, 100000); e.target.value = m.count; changed(false); } });
    box.appendChild(el('div', { class: 'grid2' },
      el('label', { class: 'fld' }, el('span', { text: 'Phím tắt chạy / dừng' }),
        el('div', { class: 'row' }, hk, el('button', { class: 'btn ghost', type: 'button', text: 'Xóa', onclick: function () { m.hotkey = ''; hk.value = ''; changed(false); } }))),
      el('label', { class: 'fld' }, el('span', { text: 'Chế độ lặp' }), rs)));
    if (m.repeat !== 'once') box.appendChild(el('div', { class: 'grid2' },
      el('label', { class: 'fld' }, el('span', { text: 'Số lần lặp' }), cnt),
      el('label', { class: 'fld' }, el('span', { text: 'Nghỉ giữa các lần (ms)' }), msField(m.gapMs, 'Nghỉ giữa các lần', function (n) { m.gapMs = n; changed(false); }))));

    box.appendChild(el('div', { class: 'phd' },
      el('h2', { text: 'Các bước (' + m.steps.length + ') · ~' + (totalMs(m) / 1000).toFixed(1).replace('.', ',') + ' giây' }),
      el('div', { class: 'row' },
        el('span', { id: 'mRecInfo', class: 'muted', text: rec ? 'Đang ghi… nhấn phím bất kỳ' : '' }),
        el('button', { class: 'btn small recbtn' + (rec ? ' on' : ''), type: 'button', text: rec ? 'Dừng ghi' : 'Ghi phím', onclick: toggleRec }))));
    if (rec) box.appendChild(el('p', { class: 'hint', text: 'Nhấn các phím theo đúng nhịp muốn phát lại (thời gian chờ được ghi luôn). Bấm “Dừng ghi” bằng chuột khi xong. Chỉ ghi được khi cửa sổ này đang được chọn.' }));

    var list = el('div', { class: 'steps' });
    m.steps.forEach(function (s, i) { list.appendChild(stepRow(m, s, i)); });
    if (!m.steps.length) list.appendChild(el('div', { class: 'empty', text: 'Chưa có bước nào. Bấm “Ghi phím” hoặc thêm từng bước bên dưới.' }));
    box.appendChild(list);

    function add(s) { m.steps.push(s); changed(true); var l = $('#mEdit .steps'); if (l) l.scrollTop = l.scrollHeight; }
    box.appendChild(el('div', { class: 'row' },
      el('button', { class: 'btn small', type: 'button', html: ICON.plus + 'Nhấn phím', onclick: function () { add({ t: 'tap', key: '', holdMs: 30 }); } }),
      el('button', { class: 'btn small', type: 'button', html: ICON.plus + 'Chờ', onclick: function () { add({ t: 'delay', ms: 100 }); } }),
      el('button', { class: 'btn small', type: 'button', html: ICON.plus + 'Click chuột', onclick: function () { add({ t: 'click', button: 'left', holdMs: 30 }); } }),
      m.steps.length ? el('button', { class: 'btn small ghost', type: 'button', text: 'Xóa hết', onclick: function () { if (confirm('Xóa tất cả bước của “' + m.name + '”?')) { m.steps = []; changed(true); } } }) : null));

    box.appendChild(el('div', { class: 'foot' },
      el('button', { class: 'btn ' + (running ? 'stop' : 'primary'), type: 'button', html: running ? ICON.stop + 'Dừng' : ICON.play + 'Chạy thử sau 3 giây', disabled: rec, onclick: function () { play(m, 3000); } }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Nhân bản', onclick: function () {
        var c = JSON.parse(JSON.stringify(m)); c.id = newId(); c.name = m.name + ' (bản sao)'; c.hotkey = '';
        X.list.splice(X.sel + 1, 0, c); X.sel += 1; changed(true);
      } }),
      el('button', { class: 'btn danger right', type: 'button', text: 'Xóa macro', onclick: function () {
        if (!confirm('Xóa macro “' + m.name + '”?')) return;
        if (running) API.invoke('stop_macro').catch(function () {});
        X.list.splice(X.sel, 1); X.sel = Math.max(0, X.sel - 1); changed(true);
      } })));
    box.appendChild(el('p', { class: 'hint', text: 'Lưu ý: nếu game chạy bằng quyền Admin, app cũng phải chạy bằng quyền Admin thì phím mới tới được game. Một số game có chống macro — hãy dùng đúng luật của game.' }));
  }

  /* ---------- monitor page quick list ---------- */
  function renderMonitor() {
    var box = $('#monMacros'); if (!box) return;
    box.innerHTML = '';
    var on = X.list.filter(function (m) { return m.enabled !== false; });
    if (!on.length) { box.appendChild(el('p', { class: 'hint', text: 'Chưa có macro nào đang bật.' })); return; }
    on.forEach(function (m) {
      var running = X.running === m.id;
      box.appendChild(el('div', { class: 'row', style: 'flex-wrap:nowrap' },
        el('span', { class: 'grow', style: 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600', text: m.name }),
        m.hotkey ? el('kbd', { text: m.hotkey }) : null,
        el('button', { class: 'btn small icon ' + (running ? 'stop' : ''), type: 'button', title: running ? 'Dừng' : 'Chạy', 'aria-label': (running ? 'Dừng ' : 'Chạy ') + m.name,
          html: running ? ICON.stop : ICON.play, onclick: function () { play(m, 0); } })));
    });
  }

  function render() { renderList(); renderEdit(); renderMonitor(); }

  function init(ctx) {
    X.ctx = ctx;
    var saved = ctx.cfg().macros;
    X.list = Array.isArray(saved) ? saved : [];
    $('#mNew').onclick = function () {
      if (X.rec) return;
      X.list.push(blank(X.list.length + 1)); X.sel = X.list.length - 1; changed(true);
    };
    API.listen('macro-state', function (s) {
      X.running = s.runningId || null;
      renderList(); renderMonitor();
      // keep focus/typing intact: only redraw the editor when the user is not inside it
      if (cur() && !X.rec && !$('#mEdit').contains(document.activeElement)) renderEdit();
    });
    render();
  }

  return { TEMPLATE: TEMPLATE, init: init };
})();
