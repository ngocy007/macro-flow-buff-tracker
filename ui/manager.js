/* Main window: set up the game window, pick the search region, add / edit buffs, sound, overlay, log. */
var Manager = (function () {
  var M = {
    state: null, windows: [], assets: [], previewImg: null, previewWinId: null,
    mode: 'search', sel: null, logs: [], scores: {}, overlayRows: [], editingOverlay: false,
    testing: false, dragging: null, pending: null, labels: {},
  };

  var ACTIVITY = {
    stopped: ['Đã dừng', ''], testing: ['Đang kiểm tra', 'busy'], monitoring: ['Đang theo dõi', 'ok'],
    targetUnavailable: ['Chờ cửa sổ game', 'warn'], error: ['Lỗi', 'err'],
  };

  var VOICE = { xiaohan: 'Hiểu Hàm', xiaoyan: 'Hiểu Nhan', xiaozhen: 'Hiểu Chân' };
  var KEY = { jiuxu: 'sẵn sàng xuất chiêu', haole: 'đã sẵn sàng', meile: 'hết rồi', beichi: 'bị ăn mất', lengque: 'hồi chiêu xong' };
  function soundLabel(id) {
    var NUM = { 'vi-five': 'Năm', 'vi-four': 'Bốn', 'vi-three': 'Ba', 'vi-two': 'Hai', 'vi-one': 'Một' };
    if (NUM[id]) return 'Giọng Việt · Đếm ' + NUM[id];
    if (id === 'vi-ready') return 'Giọng Việt · Sẵn sàng';
    if (id === 'vi-ready-chuthienkim') return 'Giọng Việt · Chu Thiên Kim sẵn sàng';
    if (id === 'vi-ready-conngo') return 'Giọng Việt · Côn Ngô sẵn sàng';
    var m = /^vm-(\w+)-(\w+)$/.exec(id);
    if (m) return 'Giọng ' + (VOICE[m[1]] || m[1]) + ' · ' + (KEY[m[2]] || m[2]);
    if (/^prewarn-/.test(id)) return 'Đếm ngược ' + ({ five: '5', four: '4', three: '3', two: '2', one: '1' }[id.split('-')[1]] || '') + ' giây';
    if (/^triggered/.test(id)) return 'Âm kích hoạt';
    if (/^custom-/.test(id)) return 'Nhạc của bạn · ' + (M.labels[id] || id.slice(7));
    return id;
  }

  function cfg() { return M.state.config; }
  function group() { var c = cfg(); if (!c.buffGroup) c.buffGroup = { icons: [], useColorDetection: true }; if (!c.buffGroup.icons) c.buffGroup.icons = []; return c.buffGroup; }
  function settings() { return cfg().settings; }
  function sound() { var s = settings(); if (!s.sound) s.sound = {}; return s.sound; }
  function ovSet() { var s = settings(); if (!s.overlay) s.overlay = {}; return s.overlay; }

  function toast(msg, kind) {
    var b = $('#banner');
    b.className = 'banner ' + (kind || 'info');
    b.textContent = msg;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { b.className = 'banner hidden'; }, kind === 'err' ? 9000 : 4500);
  }
  function fail(e) { toast(errText(e), 'err'); }
  function addLog(msg) {
    var t = new Date();
    var ts = [t.getHours(), t.getMinutes(), t.getSeconds()].map(function (n) { return String(n).padStart(2, '0'); }).join(':');
    M.logs.push(ts + '  ' + msg);
    if (M.logs.length > 300) M.logs.shift();
    var box = $('#logBox');
    if (box) { box.textContent = M.logs.join('\n'); box.scrollTop = box.scrollHeight; }
  }

  /* ---------- persistence ---------- */
  function setState(s) { if (s && s.config) M.state = s; refreshStatus(); }
  var saveGroupSoon = debounce(function () {
    API.invoke('set_buff_group_config', { buffGroup: group() }).then(setState).catch(fail);
  }, 350);
  var saveSettingsSoon = debounce(function () {
    API.invoke('update_buff_assistant_settings', { settings: settings() }).then(setState).catch(fail);
  }, 350);

  /* ---------- status / start-stop ---------- */
  function refreshStatus() {
    if (!M.state) return;
    var a = M.state.activity || 'stopped';
    var info = ACTIVITY[a] || [a, ''];
    var pill = $('#statusPill');
    pill.textContent = info[0];
    pill.className = 'pill ' + info[1];
    var running = !!M.state.isMonitoring;
    var b = $('#btnStart');
    b.textContent = running ? '■ Dừng theo dõi' : '▶ Bắt đầu theo dõi';
    b.className = 'btn ' + (running ? 'danger' : 'primary');
    M.testing = a === 'testing';
    var t = $('#btnTest');
    if (t) t.textContent = M.testing ? 'Dừng kiểm tra' : 'Kiểm tra nhận diện';
    var tg = cfg().target;
    $('#targetInfo').textContent = tg ? ('Đã lưu: ' + (tg.processName || '?') + ' · ' + tg.windowTitle + ' (' + tg.referenceWidth + '×' + tg.referenceHeight + ')') : 'Chưa chọn cửa sổ game';
    if (M.state.lastError && a !== 'stopped') {
      $('#errLine').textContent = M.state.lastError; $('#errLine').style.display = '';
    } else { $('#errLine').style.display = 'none'; }
  }

  function startStop() {
    if (M.state.isMonitoring) { API.invoke('stop_buff_monitor').then(setState).catch(fail); return; }
    if (!cfg().target) { toast('Hãy chọn cửa sổ game và bấm “Dùng cửa sổ này” trước.', 'warn'); return; }
    var usable = group().icons.filter(function (i) { return i.enabled !== false; }).length;
    if (!usable) { toast('Chưa có buff nào được bật. Hãy thêm buff ở bước 3.', 'warn'); return; }
    API.invoke('start_buff_monitor').then(function (s) { setState(s); toast('Đã bắt đầu theo dõi.', 'ok'); }).catch(fail);
  }

  function toggleTest() {
    if (M.testing) { API.invoke('stop_buff_template_test').then(setState).catch(fail); return; }
    var id = $('#selWindow').value;
    if (!id) { toast('Chưa có cửa sổ game để kiểm tra.', 'warn'); return; }
    API.invoke('start_buff_template_test', { windowId: id }).then(setState).catch(fail);
  }

  /* ---------- 1. game window ---------- */
  function loadWindows(keep) {
    return API.invoke('list_buff_capture_windows').then(function (list) {
      M.windows = list;
      var sel = $('#selWindow');
      var prev = keep ? sel.value : '';
      sel.innerHTML = '';
      if (!list.length) sel.appendChild(el('option', { value: '', text: 'Không có cửa sổ nào chụp được' }));
      var tg = M.state && cfg().target;
      var pick = '';
      list.forEach(function (w) {
        sel.appendChild(el('option', { value: w.id, text: w.processName + ' · ' + w.windowTitle + ' · ' + w.width + '×' + w.height }));
        if (tg && w.windowTitle === tg.windowTitle && (w.processName || '').toLowerCase() === (tg.processName || '').toLowerCase()) pick = w.id;
      });
      sel.value = prev && list.some(function (w) { return w.id === prev; }) ? prev : (pick || (list[0] && list[0].id) || '');
    }).catch(fail);
  }
  function useWindow() {
    var id = $('#selWindow').value;
    if (!id) { toast('Chưa chọn cửa sổ.', 'warn'); return; }
    API.invoke('save_buff_target', { windowId: id }).then(function (s) { setState(s); toast('Đã lưu cửa sổ game.', 'ok'); }).catch(fail);
  }

  /* ---------- 2. capture + selection ---------- */
  function viewRect() {
    var r = cfg().searchRegion;
    if (M.mode !== 'search' && r && r.width > 0.02 && r.height > 0.02) return { x: r.x, y: r.y, w: r.width, h: r.height };
    return { x: 0, y: 0, w: 1, h: 1 };
  }
  function drawPreview() {
    var cv = $('#cv');
    var img = M.previewImg;
    $('#cvEmpty').style.display = img ? 'none' : '';
    cv.style.display = img ? '' : 'none';
    if (!img) return;
    var v = viewRect();
    var sw = v.w * img.naturalWidth, sh = v.h * img.naturalHeight;
    var maxW = $('#cvWrap').clientWidth - 2;
    var scale = Math.min(maxW / sw, 560 / sh, 4);
    cv.width = Math.max(1, Math.round(sw * scale));
    cv.height = Math.max(1, Math.round(sh * scale));
    var g = cv.getContext('2d');
    g.imageSmoothingEnabled = scale < 1;
    g.drawImage(img, v.x * img.naturalWidth, v.y * img.naturalHeight, sw, sh, 0, 0, cv.width, cv.height);
    function box(r, color, dash, lw) {
      g.save(); g.strokeStyle = color; g.lineWidth = lw || 2; if (dash) g.setLineDash([6, 4]);
      g.strokeRect((r.x - v.x) / v.w * cv.width, (r.y - v.y) / v.h * cv.height, r.w / v.w * cv.width, r.h / v.h * cv.height);
      g.restore();
    }
    var sr = cfg().searchRegion;
    if (sr && M.mode === 'search') box({ x: sr.x, y: sr.y, w: sr.width, h: sr.height }, '#e8b730', true, 2);
    if (M.sel) {
      box(M.sel, M.mode === 'search' ? '#ffd34d' : '#4cd4a0', false, 2);
    }
  }
  function ptNorm(e) {
    var cv = $('#cv'), r = cv.getBoundingClientRect(), v = viewRect();
    var px = clamp((e.clientX - r.left) / r.width, 0, 1), py = clamp((e.clientY - r.top) / r.height, 0, 1);
    return { x: v.x + px * v.w, y: v.y + py * v.h };
  }
  function bindCanvas() {
    var cv = $('#cv');
    cv.addEventListener('pointerdown', function (e) {
      if (!M.previewImg || e.button !== 0) return;
      cv.setPointerCapture(e.pointerId);
      M.dragging = ptNorm(e);
      M.sel = { x: M.dragging.x, y: M.dragging.y, w: 0, h: 0 };
      drawPreview();
    });
    cv.addEventListener('pointermove', function (e) {
      if (!M.dragging) return;
      var p = ptNorm(e), s = M.dragging;
      M.sel = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
      drawPreview();
    });
    cv.addEventListener('pointerup', function () {
      if (!M.dragging) return;
      M.dragging = null;
      var im = M.previewImg;
      if (M.sel && (M.sel.w * im.naturalWidth < 6 || M.sel.h * im.naturalHeight < 6)) M.sel = null;
      selectionChanged();
    });
  }
  function selectionChanged() {
    drawPreview();
    var has = !!M.sel;
    $('#btnCancelSel').style.display = has ? '' : 'none';
    $('#btnSaveRegion').disabled = !has;
    $('#addForm').style.display = (M.mode === 'add' && has) ? '' : 'none';
    $('#replaceBox').style.display = (M.mode === 'replace' && has) ? '' : 'none';
    if (M.mode === 'add' && has) renderThumb();
    $('#selInfo').textContent = has ? (Math.round(M.sel.w * M.previewImg.naturalWidth) + '×' + Math.round(M.sel.h * M.previewImg.naturalHeight) + ' px') : '';
  }
  function setMode(m) {
    M.mode = m; M.sel = null;
    $('#regionBox').style.display = m === 'search' ? '' : 'none';
    $('#modeAddNote').style.display = m === 'add' ? '' : 'none';
    $('#modeReplaceNote').style.display = m === 'replace' ? '' : 'none';
    $('#selReplace').style.display = m === 'replace' ? '' : 'none';
    var hints = {
      search: 'Kéo chuột trên hình để khoanh khu vực danh sách buff (vùng tìm kiếm). Vùng càng nhỏ, nhận diện càng nhanh.',
      add: 'Hình đã phóng to vào vùng tìm kiếm. Kéo chuột khoanh sát icon của buff muốn thêm.',
      replace: 'Chọn buff cần đổi mẫu, rồi kéo chuột khoanh sát icon của nó.',
    };
    $('#capHint').textContent = hints[m];
    selectionChanged();
  }
  function capture() {
    var id = $('#selWindow').value;
    if (!id) { toast('Chưa chọn cửa sổ game.', 'warn'); return; }
    $('#btnCapture').disabled = true; $('#btnCapture').textContent = 'Đang chụp…';
    API.invoke('capture_buff_preview', { windowId: id }).then(function (p) {
      var img = new Image();
      img.onload = function () {
        M.previewImg = img; M.previewWinId = id; M.sel = null;
        $('#btnDiscardImg').style.display = '';
        $('#capInfo').textContent = 'Ảnh ' + img.naturalWidth + '×' + img.naturalHeight;
        setMode(M.mode);
        drawPreview();
      };
      img.src = p.dataUrl;
    }).catch(fail).then(function () { $('#btnCapture').disabled = false; $('#btnCapture').textContent = 'Chụp game'; });
  }
  function cancelSelection() {
    M.sel = null; M.dragging = null; selectionChanged();
  }
  function discardPreview() {
    M.previewImg = null; M.previewWinId = null; M.sel = null; M.dragging = null;
    $('#capInfo').textContent = '';
    selectionChanged(); drawPreview();
    $('#btnCancelSel').style.display = 'none'; $('#btnDiscardImg').style.display = 'none';
  }
  function needPreview() { if (!M.previewImg) { toast('Hãy bấm “Chụp game” trước.', 'warn'); return true; } return false; }

  function saveRegion() {
    if (needPreview() || !M.sel) return;
    var s = M.sel;
    var region = { x: +s.x.toFixed(4), y: +s.y.toFixed(4), width: +s.w.toFixed(4), height: +s.h.toFixed(4) };
    API.invoke('set_buff_search_region', { searchRegion: region }).then(function (st) {
      setState(st); M.sel = null; selectionChanged(); toast('Đã lưu vùng tìm kiếm.', 'ok');
    }).catch(fail);
  }

  function cropB64(sel) {
    var img = M.previewImg;
    var x = Math.round(sel.x * img.naturalWidth), y = Math.round(sel.y * img.naturalHeight);
    var w = Math.max(4, Math.round(sel.w * img.naturalWidth)), h = Math.max(4, Math.round(sel.h * img.naturalHeight));
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    return { b64: c.toDataURL('image/png').split(',')[1], w: w, h: h, canvas: c };
  }
  function renderThumb() {
    var c = cropB64(M.sel), t = $('#cropThumb'), k = Math.min(4, 96 / Math.max(c.w, c.h));
    t.width = Math.round(c.w * k); t.height = Math.round(c.h * k);
    var g = t.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(c.canvas, 0, 0, t.width, t.height);
  }

  function defaultSound() {
    var pref = ['vm-xiaohan-jiuxu', 'triggered-1789643004043'];
    for (var i = 0; i < pref.length; i++) if (M.assets.some(function (a) { return a.assetId === pref[i]; })) return pref[i];
    return M.assets[0] ? M.assets[0].assetId : '';
  }
  function soundObj(id) { return id ? { type: 'custom', assetId: id, fileName: id + '.wav' } : null; }

  function addBuff() {
    if (needPreview() || !M.sel) return;
    var name = $('#fName').value.trim();
    if (!name) { toast('Hãy đặt tên cho buff.', 'warn'); return; }
    if (group().icons.some(function (i) { return i.name === name; })) { toast('Đã có buff tên “' + name + '”, hãy đặt tên khác.', 'warn'); return; }
    var dur = parseFloat($('#fDur').value), cool = parseFloat($('#fCool').value), thr = parseFloat($('#fThr').value);
    if (!(dur > 0) || !(cool > 0)) { toast('Hiệu lực và hồi chiêu phải lớn hơn 0.', 'warn'); return; }
    if (dur > cool) { toast('Hiệu lực không được dài hơn hồi chiêu (hồi chiêu tính từ lúc buff xuất hiện).', 'warn'); return; }
    var c = cropB64(M.sel), snd = soundObj($('#fSound').value);
    var icon = {
      name: name, enabled: true, iconTemplate: c.b64, iconTemplateSize: Math.max(c.w, c.h), templateRefHeight: M.previewImg.naturalHeight,
      matchThreshold: thr > 0 && thr < 1 ? thr : 0.9,
      iconRect: [+M.sel.x.toFixed(4), +M.sel.y.toFixed(4), +M.sel.w.toFixed(4), +M.sel.h.toFixed(4)], searchRect: null,
      cycleMs: Math.round(cool * 1000), durationMs: Math.round(dur * 1000),
      hueMin: 30, hueMax: 55, saturationMin: 0.3, valueMin: 0.5, goldRatioThreshold: 0.15,
      prewarnEnabled: $('#fPre').checked, triggerSound: snd, cdEndSound: snd, sharedCdGroup: null, chaoguangOnly: false,
    };
    group().icons.push(icon);
    group().useColorDetection = true;
    M.sel = null; selectionChanged();
    renderBuffs();
    API.invoke('set_buff_group_config', { buffGroup: group() }).then(function (s) { setState(s); toast('Đã thêm buff “' + name + '”.', 'ok'); }).catch(fail);
    $('#fName').value = 'Buff ' + (group().icons.length + 1);
  }
  function replaceTemplate() {
    if (needPreview() || !M.sel) return;
    var i = parseInt($('#selReplace').value, 10);
    var ic = group().icons[i];
    if (!ic) { toast('Chưa chọn buff cần đổi mẫu.', 'warn'); return; }
    var c = cropB64(M.sel);
    ic.iconTemplate = c.b64; ic.iconTemplateSize = Math.max(c.w, c.h); ic.templateRefHeight = M.previewImg.naturalHeight;
    ic.iconRect = [+M.sel.x.toFixed(4), +M.sel.y.toFixed(4), +M.sel.w.toFixed(4), +M.sel.h.toFixed(4)];
    M.sel = null; selectionChanged(); renderBuffs();
    API.invoke('set_buff_group_config', { buffGroup: group() }).then(function (s) { setState(s); toast('Đã đổi mẫu cho “' + ic.name + '”.', 'ok'); }).catch(fail);
  }

  /* ---------- 3. buff list ---------- */
  function isCountdown(id) { return /^(vi-(five|four|three|two|one)|prewarn-)/.test(id); }
  function playAsset(id) {
    if (!id) { toast('Ô này đang để “không phát”.', 'info'); return; }
    var v = sound().volume;
    API.invoke('play_buff_assistant_sound', { cue: 'test', source: soundObj(id), volume: v == null ? 0.45 : v }).catch(fail);
  }
  /** select + preview button; kind = 'countdown' lists the shared 5..1 sounds, otherwise the "ready" sounds. */
  function soundSelect(value, onchange, kind) {
    var list = M.assets.filter(function (a) { return /^custom-/.test(a.assetId) || (kind === 'countdown') === isCountdown(a.assetId); });
    var sel = el('select', { onchange: function () { onchange(sel.value); } });
    sel.appendChild(el('option', { value: '', text: '(không phát)' }));
    list.forEach(function (a) { sel.appendChild(el('option', { value: a.assetId, text: soundLabel(a.assetId) })); });
    if (value && !list.some(function (a) { return a.assetId === value; })) sel.appendChild(el('option', { value: value, text: soundLabel(value) }));
    sel.value = value || '';
    return el('div', { class: 'sndrow' }, sel, el('button', { class: 'btn small', type: 'button', title: 'Nghe thử âm đang chọn', text: '▶ Nghe thử', onclick: function () { playAsset(sel.value); } }));
  }
  function fillFormSound(keep) {
    var fs = $('#fSound'); if (!fs) return;
    var cur = keep == null ? fs.value : keep;
    fs.innerHTML = '';
    M.assets.filter(function (a) { return !isCountdown(a.assetId); }).forEach(function (a) { fs.appendChild(el('option', { value: a.assetId, text: soundLabel(a.assetId) })); });
    fs.value = cur || defaultSound();
  }
  function importSound() {
    var btns = $$('.js-import'), olds = btns.map(function (b) { return b.textContent; });
    btns.forEach(function (b) { b.disabled = true; b.textContent = 'Đang chờ chọn file…'; });
    return API.invoke('import_buff_assistant_sound', { cue: 'ready' }).then(function (r) {
      if (!r) return;
      M.labels[r.assetId] = r.label;
      M.assets.push({ assetId: r.assetId, fileName: r.fileName });
      fillFormSound(r.assetId);
      renderBuffs(); bindSound();
      toast('Đã thêm nhạc “' + r.label + '”. Chọn nó ở ô “Âm khi sẵn sàng” hoặc ô đếm ngược.', 'ok');
    }).catch(fail).then(function () { btns.forEach(function (b, i) { b.disabled = false; b.textContent = olds[i]; }); });
  }
  function renderBuffs() {
    var box = $('#buffList');
    box.innerHTML = '';
    var icons = group().icons;
    $('#buffCount').textContent = icons.length ? '(' + icons.length + ')' : '';
    if (!icons.length) box.appendChild(el('div', { class: 'empty', text: 'Chưa có buff nào. Chụp game ở bước 2, chọn “Thêm buff mới” rồi khoanh icon.' }));
    icons.forEach(function (ic, i) {
      function upd(k, v) { ic[k] = v; saveGroupSoon(); }
      var thumb = ic.iconTemplate ? el('img', { class: 'thumb', src: 'data:image/png;base64,' + ic.iconTemplate }) : el('div', { class: 'thumb none', text: 'Không có mẫu' });
      var sndId = (ic.cdEndSound && ic.cdEndSound.assetId) || (ic.triggerSound && ic.triggerSound.assetId) || '';
      var row = el('div', { class: 'buff' + (ic.enabled === false ? ' off' : ''), 'data-name': ic.name },
        el('div', { class: 'buff-head' },
          el('label', { class: 'switch', title: 'Bật / tắt theo dõi buff này' },
            el('input', { type: 'checkbox', checked: ic.enabled !== false, onchange: function (e) { ic.enabled = e.target.checked; row.classList.toggle('off', !ic.enabled); saveGroupSoon(); } }),
            el('span')),
          thumb,
          el('input', { class: 'name', type: 'text', value: ic.name, onchange: function (e) {
            var v = e.target.value.trim();
            if (!v || group().icons.some(function (o, j) { return j !== i && o.name === v; })) { e.target.value = ic.name; toast('Tên trống hoặc bị trùng.', 'warn'); return; }
            ic.name = v; row.setAttribute('data-name', v); saveGroupSoon(); renderReplaceSelect();
          } }),
          el('span', { class: 'live', title: 'Điểm khớp mẫu (cần ≥ ngưỡng để tính là có buff)' }, el('i', { class: 'dot' }), el('b', { class: 'score', text: '--' })),
          el('span', { class: 'badge', 'data-badge': '1', text: '' }),
          el('button', { class: 'btn ghost small', text: 'Đổi mẫu', title: 'Chụp lại mẫu icon cho buff này', onclick: function () {
            $('#selReplace').value = String(i); document.querySelector('input[name=mode][value=replace]').click(); $('#sec-capture').scrollIntoView({ behavior: 'smooth' });
          } }),
          el('button', { class: 'btn ghost small danger', text: 'Xóa', onclick: function () {
            if (!confirm('Xóa buff “' + ic.name + '”?')) return;
            icons.splice(i, 1); renderBuffs(); renderReplaceSelect(); saveGroupSoon();
          } })),
        el('div', { class: 'fields' },
          field('Hiệu lực (giây)', numInput((ic.durationMs || 4000) / 1000, 0.5, 120, 0.5, function (v) { upd('durationMs', Math.round(v * 1000)); }), 'obs'),
          field('Hồi chiêu (giây)', numInput((ic.cycleMs || 20000) / 1000, 1, 600, 0.5, function (v) { upd('cycleMs', Math.round(v * 1000)); })),
          field('Ngưỡng khớp', numInput(ic.matchThreshold || 0.9, 0.5, 0.99, 0.01, function (v) { upd('matchThreshold', v); })),
          el('label', { class: 'chk', title: 'Tắt thì chiêu này không đọc 5-4-3-2-1' }, el('input', { type: 'checkbox', checked: ic.prewarnEnabled !== false, onchange: function (e) { upd('prewarnEnabled', e.target.checked); } }), 'Có đếm ngược 5-4-3-2-1'),
          field('Âm khi sẵn sàng', soundSelect(sndId, function (v) { var o = soundObj(v); ic.triggerSound = o; ic.cdEndSound = o; saveGroupSoon(); }, 'ready'))));
      box.appendChild(row);
    });
    renderReplaceSelect();
  }
  function field(label, input, obsClass) { return el('label', { class: 'fld' }, el('span', { text: label }), input, obsClass ? el('small', { class: 'obsnote', text: '' }) : null); }
  function numInput(v, min, max, step, cb) {
    return el('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(v), onchange: function (e) {
      var n = parseFloat(e.target.value);
      if (!isFinite(n)) return;
      n = clamp(n, min, max); e.target.value = String(n); cb(n);
    } });
  }
  function renderReplaceSelect() {
    var s = $('#selReplace'), keep = s.value;
    s.innerHTML = '';
    group().icons.forEach(function (ic, i) { s.appendChild(el('option', { value: String(i), text: ic.name })); });
    if (keep) s.value = keep;
  }

  function tickStages() {
    var now = Date.now();
    var rows = {};
    (M.overlayRows || []).forEach(function (b) { rows[b.name] = b; });
    $$('.buff').forEach(function (n) {
      var b = rows[n.getAttribute('data-name')];
      var badge = $('[data-badge]', n);
      if (!b || !M.state.isMonitoring) { badge.textContent = ''; badge.className = 'badge'; return; }
      var stage = b.stage, txt = '';
      if (stage === 'active') { txt = 'Hiệu lực ' + Math.max(0, Math.floor(((b.activeUntilUnixMs || 0) - now) / 1000)) + 's'; }
      else if (b.expectedAtUnixMs && stage !== 'unknown') {
        var ms = b.expectedAtUnixMs - now;
        stage = ms > 5000 ? 'cooling' : ms > 0 ? 'readySoon' : 'ready';
        txt = stage === 'ready' ? 'Sẵn sàng' : (stage === 'readySoon' ? 'Sắp xong ' : 'Hồi chiêu ') + Math.ceil(ms / 1000) + 's';
      } else txt = 'Chờ buff';
      badge.textContent = txt; badge.className = 'badge ' + stage;
    });
  }
  function onIcons(list) {
    list.forEach(function (i) {
      var n = $('.buff[data-name="' + (window.CSS && CSS.escape ? CSS.escape(i.name) : i.name) + '"]');
      if (!n) return;
      $('.score', n).textContent = i.hasTemplate ? i.score.toFixed(2) : '—';
      $('.dot', n).className = 'dot' + (i.present ? ' on' : '');
      $('.score', n).className = 'score' + (i.score >= i.threshold ? ' good' : '');
      var ob = $('.obsnote', n);
      if (ob) ob.textContent = i.observedMs != null ? 'Đo được lần gần nhất: ' + (i.observedMs / 1000).toFixed(1) + ' giây (thường thấp hơn thật 0,3–0,5 giây)' : '';
    });
  }

  /* ---------- 4. sound ---------- */
  function bindSound() {
    var s = sound();
    var vol = $('#volume');
    vol.value = String(Math.round((s.volume == null ? 0.45 : s.volume) * 100));
    $('#volVal').textContent = vol.value + '%';
    vol.oninput = function () { $('#volVal').textContent = vol.value + '%'; s.volume = +vol.value / 100; saveSettingsSoon(); };
    $('#chkReady').checked = s.triggerEnabled !== false;
    $('#chkReady').onchange = function (e) { s.triggerEnabled = e.target.checked; saveSettingsSoon(); };
    var on = s.prewarnMode !== 'off' && s.prewarnFiveEnabled !== false;
    $('#chkPrewarn').checked = on;
    $('#chkPrewarn').onchange = function (e) {
      var v = e.target.checked;
      s.prewarnMode = v ? 'countdown' : 'off';
      ['Five', 'Four', 'Three', 'Two', 'One'].forEach(function (k) { s['prewarn' + k + 'Enabled'] = v; });
      saveSettingsSoon();
    };
    var cd = $('#cdSounds');
    cd.innerHTML = '';
    [['Five', '5'], ['Four', '4'], ['Three', '3'], ['Two', '2'], ['One', '1']].forEach(function (p) {
      var key = 'prewarn' + p[0] + 'Source';
      var cur = (s[key] && s[key].assetId) || '';
      cd.appendChild(el('label', { class: 'fld' }, el('span', { text: 'Đọc ở giây ' + p[1] }),
        soundSelect(cur, function (v) { s[key] = v ? soundObj(v) : null; saveSettingsSoon(); }, 'countdown')));
    });
    $('#btnOpenSounds').onclick = function () { API.invoke('open_data_folder').catch(fail); };
    $('#btnImportSound').onclick = importSound;
  }

  /* ---------- 5. overlay ---------- */
  function appearance() { var o = ovSet(); if (!o.appearance) o.appearance = { opacity: 1, fontScale: 1, paddingScale: 1, textColor: null, hideFrame: false }; return o.appearance; }
  function bindOverlay() {
    var o = ovSet(), a = appearance(), dpr = window.devicePixelRatio || 1;
    function pushAppearance() { API.invoke('preview_buff_overlay_appearance', { appearance: a }).catch(function () {}); saveSettingsSoon(); }
    var op = $('#ovOpacity'); op.value = String(Math.round((a.opacity == null ? 1 : a.opacity) * 100));
    op.oninput = function () { a.opacity = +op.value / 100; $('#ovOpacityVal').textContent = op.value + '%'; pushAppearance(); };
    $('#ovOpacityVal').textContent = op.value + '%';
    var fs = $('#ovFont'); fs.value = String(Math.round((a.fontScale == null ? 1 : a.fontScale) * 100));
    fs.oninput = function () { a.fontScale = +fs.value / 100; $('#ovFontVal').textContent = fs.value + '%'; pushAppearance(); };
    $('#ovFontVal').textContent = fs.value + '%';
    var w = $('#ovWidth'); w.value = String(Math.round((o.width || 330) / dpr));
    w.oninput = function () { $('#ovWidthVal').textContent = w.value + ' px'; o.width = Math.round(+w.value * dpr); saveSettingsSoon(); };
    $('#ovWidthVal').textContent = w.value + ' px';
    $('#ovHideSeen').checked = !!o.hideUntilSeen;
    $('#ovHideSeen').onchange = function (e) { o.hideUntilSeen = e.target.checked; saveSettingsSoon(); };
    $('#ovHideFrame').checked = !!a.hideFrame;
    $('#ovHideFrame').onchange = function (e) { a.hideFrame = e.target.checked; pushAppearance(); };
    $('#ovScheme').value = o.colorScheme || 'gold';
    $('#ovScheme').onchange = function (e) { o.colorScheme = e.target.value; saveSettingsSoon(); };
    $('#btnEditOv').onclick = function () {
      var next = !M.editingOverlay;
      API.invoke('set_buff_overlay_edit_mode', { enabled: next }).then(function (s) {
        M.editingOverlay = next; setState(s);
        $('#btnEditOv').textContent = next ? 'Lưu vị trí cửa sổ nổi' : 'Chỉnh vị trí cửa sổ nổi';
        $('#btnEditOv').className = 'btn ' + (next ? 'primary' : '');
        $('#ovEditNote').style.display = next ? '' : 'none';
        if (!next) toast('Đã lưu vị trí và kích thước cửa sổ nổi.', 'ok');
      }).catch(fail);
    };
  }

  /* ---------- hotkey ---------- */
  var CODE_NAME = { Space: 'Space', Tab: 'Tab', Enter: 'Enter', Backspace: 'Backspace', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
  function comboFromEvent(e) {
    var c = e.code, k = null;
    if (/^Key[A-Z]$/.test(c)) k = c.slice(3);
    else if (/^Digit\d$/.test(c)) k = c.slice(5);
    else if (/^F\d{1,2}$/.test(c)) k = c;
    else if (/^Numpad\d$/.test(c)) k = 'Num' + c.slice(6);
    else k = CODE_NAME[c] || null;
    if (!k) return null;
    var parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');
    parts.push(k);
    return parts.join('+');
  }
  function bindHotkey() {
    var inp = $('#hkInput'), s = settings();
    function show() { inp.value = s.hotkey || ''; inp.placeholder = 'Chưa đặt — bấm vào đây rồi nhấn phím'; $('#btnStart').title = s.hotkey ? 'Phím tắt: ' + s.hotkey : ''; }
    function apply(combo) {
      return API.invoke('set_buff_hotkey', { hotkey: combo }).then(function (st) {
        setState(st); s.hotkey = combo; show();
        toast(combo ? 'Đã đặt phím tắt: ' + combo : 'Đã xóa phím tắt.', 'ok');
      }).catch(function (e) { show(); fail(e); });
    }
    show();
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') return;
      e.preventDefault();
      if (e.key === 'Escape') { inp.blur(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { apply(''); return; }
      var combo = comboFromEvent(e);
      if (combo) apply(combo);
    });
    $('#btnHkClear').onclick = function () { apply(''); };
  }

  /* ---------- 6. advanced ---------- */
  function bindAdvanced() {
    var s = settings();
    $('#advConfirm').value = s.confirmFrames || 2;
    $('#advMissing').value = s.missingFrames || 3;
    $('#advConfirm').onchange = function (e) { s.confirmFrames = clamp(parseInt(e.target.value, 10) || 2, 1, 10); e.target.value = s.confirmFrames; saveSettingsSoon(); };
    $('#advMissing').onchange = function (e) { s.missingFrames = clamp(parseInt(e.target.value, 10) || 3, 1, 20); e.target.value = s.missingFrames; saveSettingsSoon(); };
  }

  /* ---------- boot ---------- */
  var TEMPLATE = [
    '<div class="shell">',
    '<header class="topbar"><div class="brand"><img class="logo" src="logo.png" alt=""><div><h1>Trợ thủ Buff</h1><p>Theo dõi buff trên màn hình · đếm ngược hồi chiêu · cảnh báo bằng âm thanh</p></div></div>',
    '<div class="top-actions"><span id="statusPill" class="pill">Đã dừng</span><button id="btnStart" class="btn primary">▶ Bắt đầu theo dõi</button></div></header>',
    '<div id="banner" class="banner hidden"></div><div id="errLine" class="errline" style="display:none"></div>',
    '<main class="content">',

    '<section class="card" id="sec-game"><header><span class="step">1</span><div><h2>Cửa sổ game</h2><p>Chọn cửa sổ game rồi lưu. App chụp được cả khi game bị cửa sổ khác che (trừ khi thu nhỏ xuống thanh taskbar).</p></div></header>',
    '<div class="row"><select id="selWindow" class="grow"></select><button id="btnRefresh" class="btn">Làm mới</button><button id="btnUseWindow" class="btn primary">Dùng cửa sổ này</button></div>',
    '<div class="muted" id="targetInfo"></div></section>',

    '<section class="card" id="sec-capture"><header><span class="step">2</span><div><h2>Chụp game &amp; khoanh vùng</h2><p>Chụp một ảnh game khi buff đang hiện. Dùng ảnh này để khoanh vùng tìm kiếm và để lấy mẫu icon cho từng buff.</p></div></header>',
    '<div class="row"><button id="btnCapture" class="btn primary">Chụp game</button><button id="btnCancelSel" class="btn" style="display:none" title="Bỏ vùng đang khoanh (phím Esc)">Hủy vùng chọn</button><button id="btnDiscardImg" class="btn ghost" style="display:none" title="Xóa ảnh đã chụp">Xóa ảnh</button><span class="muted" id="capInfo"></span><div class="seg">',
    '<label><input type="radio" name="mode" value="search" checked><span>Vùng tìm kiếm</span></label>',
    '<label><input type="radio" name="mode" value="add"><span>Thêm buff mới</span></label>',
    '<label><input type="radio" name="mode" value="replace"><span>Đổi mẫu buff</span></label></div>',
    '<select id="selReplace" style="display:none"></select></div>',
    '<p class="hint" id="capHint"></p>',
    '<div class="cvwrap" id="cvWrap"><div id="cvEmpty" class="cvempty">Chưa có ảnh. Bấm “Chụp game”.</div><canvas id="cv" style="display:none"></canvas></div>',
    '<div class="row" id="regionBox"><button id="btnSaveRegion" class="btn primary" disabled>Lưu làm vùng tìm kiếm</button><span class="muted" id="selInfo"></span></div>',
    '<p class="hint" id="modeAddNote" style="display:none">Mỗi buff chỉ cần khoanh icon một lần. Sau khi khoanh, điền tên, hiệu lực và hồi chiêu rồi bấm “Thêm buff”.</p>',
    '<p class="hint" id="modeReplaceNote" style="display:none">Dùng khi icon đổi hình hoặc nhận diện kém: khoanh lại icon rồi bấm “Cập nhật mẫu”.</p>',
    '<div class="form" id="addForm" style="display:none"><canvas id="cropThumb" class="cropthumb"></canvas><div class="formgrid">',
    '<label class="fld"><span>Tên buff</span><input id="fName" type="text" value="Buff 2"></label>',
    '<label class="fld"><span>Hiệu lực (giây)</span><input id="fDur" type="number" min="0.5" step="0.5" value="4"></label>',
    '<label class="fld"><span>Hồi chiêu (giây)</span><input id="fCool" type="number" min="1" step="0.5" value="20"></label>',
    '<label class="fld"><span>Ngưỡng khớp</span><input id="fThr" type="number" min="0.5" max="0.99" step="0.01" value="0.9"></label>',
    '<label class="fld"><span>Âm khi sẵn sàng</span><div class="sndrow"><select id="fSound"></select><button type="button" class="btn small" id="btnFSound">▶ Nghe thử</button><button type="button" class="btn small js-import" id="btnFImport" title="Thêm file nhạc .wav của bạn">+ Thêm nhạc</button></div></label>',
    '<label class="chk"><input id="fPre" type="checkbox" checked>Có đếm ngược 5-4-3-2-1</label>',
    '</div><button id="btnAddBuff" class="btn primary">Thêm buff</button></div>',
    '<div class="row" id="replaceBox" style="display:none"><button id="btnReplace" class="btn primary">Cập nhật mẫu</button></div>',
    '</section>',

    '<section class="card" id="sec-buffs"><header><span class="step">3</span><div><h2>Danh sách buff <span id="buffCount" class="muted"></span></h2><p>Mỗi buff có hiệu lực và hồi chiêu riêng. Hồi chiêu tính từ lúc buff xuất hiện (đã gồm thời gian hiệu lực). Sửa xong tự lưu.</p></div>',
    '<button id="btnTest" class="btn">Kiểm tra nhận diện</button></header>',
    '<div id="buffList"></div></section>',

    '<section class="card" id="sec-sound"><header><span class="step">4</span><div><h2>Âm thanh</h2><p>Âm báo lấy từ thư mục âm thanh của app (file .wav).</p></div></header>',
    '<div class="grid2"><label class="fld"><span>Âm lượng <b id="volVal"></b></span><input id="volume" type="range" min="0" max="100"></label>',
    '<div class="checks"><label class="chk"><input id="chkReady" type="checkbox">Báo âm khi buff sẵn sàng</label><label class="chk"><input id="chkPrewarn" type="checkbox">Bật tính năng đếm ngược 5-4-3-2-1 (tắt thì không chiêu nào đếm)</label></div></div>',
    '<h3 class="sub">Âm đếm ngược 5-4-3-2-1 <span class="muted">(dùng chung cho mọi chiêu; từng chiêu bật/tắt riêng ở bước 3)</span></h3><div class="cdgrid" id="cdSounds"></div>',
    '<div class="row"><button id="btnImportSound" class="btn primary js-import">+ Thêm nhạc (.wav)</button><button id="btnOpenSounds" class="btn ghost">Mở thư mục âm thanh</button></div>',
    '<p class="hint">Nhạc thêm vào sẽ xuất hiện trong mọi ô chọn âm (sẵn sàng và đếm ngược). Hiện chỉ hỗ trợ file .wav.</p></section>',

    '<section class="card" id="sec-overlay"><header><span class="step">5</span><div><h2>Cửa sổ nổi</h2><p>Hiện trên game: mỗi buff một dòng, có hiệu lực và hồi chiêu đếm ngược.</p></div>',
    '<button id="btnEditOv" class="btn">Chỉnh vị trí cửa sổ nổi</button></header>',
    '<p class="hint" id="ovEditNote" style="display:none">Kéo cửa sổ nổi tới chỗ mong muốn rồi bấm lại nút để lưu.</p>',
    '<div class="grid2"><label class="fld"><span>Độ trong suốt <b id="ovOpacityVal"></b></span><input id="ovOpacity" type="range" min="30" max="100"></label>',
    '<label class="fld"><span>Cỡ chữ <b id="ovFontVal"></b></span><input id="ovFont" type="range" min="70" max="200"></label>',
    '<label class="fld"><span>Độ rộng <b id="ovWidthVal"></b></span><input id="ovWidth" type="range" min="200" max="560" step="10"></label>',
    '<label class="fld"><span>Kiểu màu</span><select id="ovScheme"><option value="gold">Vàng</option><option value="blackWhite">Đen trắng</option></select></label></div>',
    '<div class="checks"><label class="chk"><input id="ovHideSeen" type="checkbox">Ẩn cho tới khi thấy buff lần đầu</label><label class="chk"><input id="ovHideFrame" type="checkbox">Ẩn viền và nền (chỉ giữ chữ)</label></div></section>',

    '<section class="card" id="sec-hotkey"><header><span class="step">6</span><div><h2>Phím tắt</h2><p>Bật / tắt theo dõi ngay cả khi đang ở trong game, không cần Alt+Tab ra app. Nếu game chạy bằng quyền Admin thì cũng phải mở app này bằng quyền Admin.</p></div></header>',
    '<div class="row"><label class="fld grow"><span>Bật / tắt theo dõi</span><input id="hkInput" type="text" readonly style="cursor:pointer"></label><button id="btnHkClear" class="btn ghost">Xóa phím tắt</button></div>',
    '<p class="hint">Bấm vào ô, rồi nhấn tổ hợp phím (ví dụ F8 hoặc Ctrl+Alt+B). Backspace để xóa.</p></section>',

    '<section class="card" id="sec-adv"><details><summary><span class="step dim">7</span><b>Nâng cao</b><span class="muted"> · số khung hình xác nhận</span></summary>',
    '<div class="grid2"><label class="fld"><span>Số khung xác nhận buff xuất hiện</span><input id="advConfirm" type="number" min="1" max="10"></label>',
    '<label class="fld"><span>Số khung xác nhận buff biến mất</span><input id="advMissing" type="number" min="1" max="20"></label></div>',
    '<p class="hint">Giá trị nhỏ thì phản ứng nhanh hơn nhưng dễ báo nhầm; mặc định 2 và 3. Thời điểm tính hồi chiêu luôn lấy từ khung hình đầu tiên thấy buff.</p></details></section>',

    '<section class="card" id="sec-log"><header><div><h2>Nhật ký</h2></div></header><pre id="logBox" class="log"></pre></section>',
    '</main></div>',
  ].join('');

  function init() {
    $('#app').innerHTML = TEMPLATE;
    $('#btnStart').onclick = startStop;
    $('#btnRefresh').onclick = function () { loadWindows(true); };
    $('#btnUseWindow').onclick = useWindow;
    $('#btnCapture').onclick = capture;
    $('#btnTest').onclick = toggleTest;
    $('#btnSaveRegion').onclick = saveRegion;
    $('#btnCancelSel').onclick = cancelSelection;
    $('#btnDiscardImg').onclick = discardPreview;
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && (M.sel || M.dragging)) cancelSelection(); });
    $('#btnAddBuff').onclick = addBuff;
    $('#btnReplace').onclick = replaceTemplate;
    $$('input[name=mode]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) setMode(r.value); }); });
    bindCanvas();
    window.addEventListener('resize', debounce(drawPreview, 150));

    API.listen('buff-assistant-state', function (s) { if (M.state) { ['activity', 'isMonitoring', 'lastError', 'expectedAtUnixMs'].forEach(function (k) { M.state[k] = s[k]; }); refreshStatus(); } });
    API.listen('buff-assistant-execution-log', addLog);
    API.listen('buff-assistant-hotkey', function (m) { toast(m, 'info'); addLog(m); });
    API.listen('buff-assistant-icons', onIcons);
    API.listen('buff-overlay-state', function (s) { M.overlayRows = s.buffs || []; });

    Promise.all([API.invoke('get_buff_assistant_state'), API.invoke('list_buff_sound_assets')]).then(function (r) {
      M.state = r[0];
      // Hide the previous team's voice clips for other features (fm-* / vm-*, named in Chinese pinyin),
      // unless a buff is still using one of them.
      var used = {};
      (r[0].config.buffGroup && r[0].config.buffGroup.icons || []).forEach(function (ic) {
        [ic.triggerSound, ic.cdEndSound].forEach(function (o) { if (o && o.assetId) used[o.assetId] = true; });
      });
      M.assets = (r[1] || []).filter(function (x) { return !/^(fm|vm|prewarn)-/.test(x.assetId) || used[x.assetId]; });
      var ORDER = ['vi-five', 'vi-four', 'vi-three', 'vi-two', 'vi-one', 'vi-ready', 'vi-ready-chuthienkim', 'vi-ready-conngo'];
      M.assets.sort(function (x, y) {
        var ix = ORDER.indexOf(x.assetId), iy = ORDER.indexOf(y.assetId);
        if (ix < 0 && iy < 0) return x.assetId < y.assetId ? -1 : 1;
        return (ix < 0 ? 99 : ix) - (iy < 0 ? 99 : iy);
      });
      fillFormSound('');
      $('#btnFSound').onclick = function () { playAsset($('#fSound').value); };
      $('#btnFImport').onclick = importSound;
      $('#fName').value = 'Buff ' + (group().icons.length + 1);
      renderBuffs(); bindSound(); bindOverlay(); bindAdvanced(); bindHotkey(); setMode('search'); refreshStatus();
      return loadWindows(false);
    }).catch(fail);
    setInterval(tickStages, 250);
  }
  return { init: init };
})();
