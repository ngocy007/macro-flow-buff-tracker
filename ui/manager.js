/* Main window: sidebar + pages (monitor, game setup, buffs, macros, settings). */
var Manager = (function () {
  var M = {
    state: null, windows: [], assets: [], previewImg: null, previewWinId: null,
    mode: 'search', sel: null, logs: [], live: {}, overlayRows: [], editingOverlay: false,
    testing: false, dragging: null, labels: {}, page: 'monitor', selBuff: 0, tileNodes: [], tileOrder: '',
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
  function initials(name) {
    var w = String(name || '?').trim().split(/\s+/);
    return ((w[0] || '?')[0] + (w.length > 1 ? (w[w.length - 1][0] || '') : (w[0][1] || ''))).toUpperCase();
  }
  function thumbEl(ic, cls) {
    return ic.iconTemplate
      ? el('img', { class: 'thumb ' + (cls || ''), alt: '', src: 'data:image/png;base64,' + ic.iconTemplate })
      : el('span', { class: 'thumb none ' + (cls || ''), 'aria-hidden': 'true', text: initials(ic.name) });
  }
  function secs(ms) { var v = ms / 1000; return (Math.round(v * 10) / 10).toString().replace('.', ','); }

  /* ---------- navigation ---------- */
  function go(page) {
    M.page = page;
    $$('.nav button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === page); if (b.dataset.go === page) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $$('.page').forEach(function (p) { p.classList.toggle('on', p.dataset.page === page); });
    if (page === 'setup') requestAnimationFrame(drawPreview);
  }
  function tab(name) {
    $$('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); b.setAttribute('aria-selected', b.dataset.tab === name ? 'true' : 'false'); });
    $$('.tabpane').forEach(function (p) { p.classList.toggle('on', p.dataset.tab === name); });
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
    b.innerHTML = (running ? ICON.stop : ICON.play) + '<span>' + (running ? 'Dừng theo dõi' : 'Bắt đầu theo dõi') + '</span>' + (settings().hotkey ? '<kbd>' + settings().hotkey + '</kbd>' : '');
    b.className = 'btn big ' + (running ? 'stop' : 'primary');
    $('#navDot').className = 'ndot' + (running ? ' on' : '');
    M.testing = a === 'testing';
    $('#btnTest').textContent = M.testing ? 'Dừng kiểm tra' : 'Kiểm tra nhận diện';
    var tg = cfg().target;
    $('#targetInfo').textContent = tg ? ('Đang dùng: ' + (tg.processName || '?') + ' · ' + tg.windowTitle) : 'Chưa chọn cửa sổ game';
    $('#targetSaved').style.display = tg ? '' : 'none';
    $('#sideTarget').textContent = tg ? ((tg.processName || '?') + ' · ' + tg.referenceWidth + '×' + tg.referenceHeight) : 'Chưa chọn';
    $('#sideHotkey').textContent = settings().hotkey || '—';
    var icons = group().icons, on = icons.filter(function (i) { return i.enabled !== false; }).length;
    var sr = cfg().searchRegion, sub = on + '/' + icons.length + ' buff đang bật · sắp xếp theo độ gấp';
    if (sr && tg && sr.width > 0) sub += ' · vùng tìm kiếm ' + Math.round(sr.width * tg.referenceWidth) + '×' + Math.round(sr.height * tg.referenceHeight) + ' px';
    $('#monSub').textContent = sub;
    $('#navBuffCount').textContent = icons.length || '';
    if (M.state.lastError && a !== 'stopped') {
      $('#errLine').textContent = M.state.lastError; $('#errLine').style.display = '';
    } else { $('#errLine').style.display = 'none'; }
  }

  function startStop() {
    if (M.state.isMonitoring) { API.invoke('stop_buff_monitor').then(setState).catch(fail); return; }
    if (!cfg().target) { toast('Hãy chọn cửa sổ game ở trang “Thiết lập game” trước.', 'warn'); go('setup'); return; }
    var usable = group().icons.filter(function (i) { return i.enabled !== false; }).length;
    if (!usable) { toast('Chưa có buff nào được bật. Hãy thêm buff trước.', 'warn'); return; }
    API.invoke('start_buff_monitor').then(function (s) { setState(s); toast('Đã bắt đầu theo dõi.', 'ok'); }).catch(fail);
  }

  function toggleTest() {
    if (M.testing) { API.invoke('stop_buff_template_test').then(setState).catch(fail); return; }
    var id = $('#selWindow').value;
    if (!id) { toast('Chưa có cửa sổ game để kiểm tra.', 'warn'); return; }
    API.invoke('start_buff_template_test', { windowId: id }).then(setState).catch(fail);
  }

  /* ---------- game window ---------- */
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

  /* ---------- capture + selection ---------- */
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
    if (maxW <= 0) return;
    var scale = Math.min(maxW / sw, 460 / sh, 4);
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
    if (sr && M.mode === 'search') box({ x: sr.x, y: sr.y, w: sr.width, h: sr.height }, '#F4B740', true, 2);
    if (M.sel) box(M.sel, M.mode === 'search' ? '#FFD27A' : '#36D39B', false, 2);
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
    $('#btnAddBuff').disabled = !has;
    $('#btnReplace').disabled = !has;
    $('#cropThumb').style.display = has && M.mode === 'add' ? '' : 'none';
    $('#cropEmpty').style.display = has && M.mode === 'add' ? 'none' : '';
    if (M.mode === 'add' && has) renderThumb();
    var px = has ? (Math.round(M.sel.w * M.previewImg.naturalWidth) + '×' + Math.round(M.sel.h * M.previewImg.naturalHeight) + ' px') : '';
    $('#selInfo').textContent = has ? 'Đang khoanh ' + px : '';
    $('#cropSize').textContent = has ? 'Mẫu ' + px : 'Chưa khoanh icon';
    $('#newRegion').textContent = has ? px : '—';
  }
  function setMode(m) {
    M.mode = m; M.sel = null;
    var r = document.querySelector('input[name=mode][value=' + m + ']'); if (r) r.checked = true;
    $$('.modepane').forEach(function (p) { p.classList.toggle('on', p.dataset.mode === m); });
    var hints = {
      search: 'Kéo chuột trên ảnh để khoanh khu vực thanh buff. Vùng càng nhỏ, nhận diện càng nhanh.',
      add: 'Ảnh đã phóng to vào vùng tìm kiếm. Kéo chuột khoanh sát icon buff muốn thêm.',
      replace: 'Chọn buff ở bên phải, rồi kéo chuột khoanh sát icon mới của nó.',
    };
    $('#capHint').textContent = hints[m];
    selectionChanged();
  }
  function capture() {
    var id = $('#selWindow').value;
    if (!id) { toast('Chưa chọn cửa sổ game.', 'warn'); return; }
    var b = $('#btnCapture');
    b.disabled = true; b.textContent = 'Đang chụp…';
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
    }).catch(fail).then(function () { b.disabled = false; b.textContent = M.previewImg ? 'Chụp lại' : 'Chụp game'; });
  }
  function cancelSelection() { M.sel = null; M.dragging = null; selectionChanged(); }
  function discardPreview() {
    M.previewImg = null; M.previewWinId = null; M.sel = null; M.dragging = null;
    $('#capInfo').textContent = '';
    $('#btnCapture').textContent = 'Chụp game';
    selectionChanged(); drawPreview();
    $('#btnDiscardImg').style.display = 'none';
  }
  function needPreview() { if (!M.previewImg) { toast('Hãy bấm “Chụp game” trước.', 'warn'); return true; } return false; }

  function saveRegion() {
    if (needPreview() || !M.sel) return;
    var s = M.sel;
    var region = { x: +s.x.toFixed(4), y: +s.y.toFixed(4), width: +s.w.toFixed(4), height: +s.h.toFixed(4) };
    API.invoke('set_buff_search_region', { searchRegion: region }).then(function (st) {
      setState(st); M.sel = null; selectionChanged(); showRegion(); toast('Đã lưu vùng tìm kiếm.', 'ok');
    }).catch(fail);
  }
  function showRegion() {
    var sr = cfg().searchRegion, tg = cfg().target;
    $('#curRegion').textContent = sr && sr.width > 0 ? (tg ? Math.round(sr.width * tg.referenceWidth) + '×' + Math.round(sr.height * tg.referenceHeight) + ' px' : 'đã lưu') : 'chưa có';
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
    var c = cropB64(M.sel), t = $('#cropThumb'), k = 60 / Math.max(c.w, c.h);
    t.width = Math.round(c.w * k); t.height = Math.round(c.h * k);
    var g = t.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(c.canvas, 0, 0, t.width, t.height);
  }

  function defaultSound() {
    var pref = ['vi-ready', 'vm-xiaohan-jiuxu', 'triggered-1789643004043'];
    for (var i = 0; i < pref.length; i++) if (M.assets.some(function (a) { return a.assetId === pref[i]; })) return pref[i];
    var r = M.assets.filter(function (a) { return !isCountdown(a.assetId); })[0];
    return r ? r.assetId : '';
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
    M.selBuff = group().icons.length - 1;
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
  function openReplace(i) {
    go('setup'); setMode('replace'); $('#selReplace').value = String(i); renderReplaceOld();
  }
  function renderReplaceOld() {
    var ic = group().icons[parseInt($('#selReplace').value, 10)], box = $('#replaceOld');
    box.innerHTML = '';
    if (ic) box.appendChild(thumbEl(ic, 'lg'));
  }

  /* ---------- sounds ---------- */
  function isCountdown(id) { return /^(vi-(five|four|three|two|one)|prewarn-)/.test(id); }
  function playAsset(id) {
    if (!id) { toast('Ô này đang để “không phát”.', 'info'); return; }
    var v = sound().volume;
    API.invoke('play_buff_assistant_sound', { cue: 'test', source: soundObj(id), volume: v == null ? 0.45 : v }).catch(fail);
  }
  /** select + preview button; kind = 'countdown' lists the shared 5..1 sounds, otherwise the "ready" sounds. */
  function soundSelect(value, onchange, kind, label) {
    var list = M.assets.filter(function (a) { return /^custom-/.test(a.assetId) || (kind === 'countdown') === isCountdown(a.assetId); });
    var sel = el('select', { 'aria-label': label || 'Âm thanh', onchange: function () { onchange(sel.value); } });
    sel.appendChild(el('option', { value: '', text: '(không phát)' }));
    list.forEach(function (a) { sel.appendChild(el('option', { value: a.assetId, text: soundLabel(a.assetId) })); });
    if (value && !list.some(function (a) { return a.assetId === value; })) sel.appendChild(el('option', { value: value, text: soundLabel(value) }));
    sel.value = value || '';
    var b = el('button', { class: 'btn icon', type: 'button', title: 'Nghe thử', 'aria-label': 'Nghe thử', html: ICON.play, onclick: function () { playAsset(sel.value); } });
    return el('div', { class: 'sndrow' }, sel, b);
  }
  function fillFormSound(keep) {
    var fs = $('#fSound'); if (!fs) return;
    var cur = keep == null ? fs.value : keep;
    fs.innerHTML = '';
    M.assets.filter(function (a) { return !isCountdown(a.assetId); }).forEach(function (a) { fs.appendChild(el('option', { value: a.assetId, text: soundLabel(a.assetId) })); });
    fs.value = cur || defaultSound();
  }
  function importSound() {
    var btns = $$('.js-import'), olds = btns.map(function (b) { return b.innerHTML; });
    btns.forEach(function (b) { b.disabled = true; b.textContent = 'Đang chờ chọn file…'; });
    return API.invoke('import_buff_assistant_sound', { cue: 'ready' }).then(function (r) {
      if (!r) return;
      M.labels[r.assetId] = r.label;
      M.assets.push({ assetId: r.assetId, fileName: r.fileName });
      fillFormSound(r.assetId);
      renderBuffs(); bindSound();
      toast('Đã thêm nhạc “' + r.label + '”. Chọn nó ở ô “Âm khi sẵn sàng” hoặc ô đếm ngược.', 'ok');
    }).catch(fail).then(function () { btns.forEach(function (b, i) { b.disabled = false; b.innerHTML = olds[i]; }); });
  }

  /* ---------- buffs page ---------- */
  function renderBuffs() {
    var icons = group().icons;
    if (M.selBuff >= icons.length) M.selBuff = Math.max(0, icons.length - 1);
    renderBuffList(); renderDetail(); renderTiles(); renderReplaceSelect(); refreshStatus();
  }
  function renderBuffList() {
    var box = $('#buffList'), icons = group().icons;
    box.innerHTML = '';
    if (!icons.length) box.appendChild(el('div', { class: 'empty', text: 'Chưa có buff nào. Bấm “Thêm buff” để chụp game và khoanh icon.' }));
    icons.forEach(function (ic, i) {
      var live = M.live[ic.name];
      var row = el('div', { class: 'brow' + (i === M.selBuff ? ' sel' : '') + (ic.enabled === false ? ' off' : ''), 'data-name': ic.name, role: 'button', tabindex: '0',
          'aria-pressed': i === M.selBuff ? 'true' : 'false',
          onclick: function () { M.selBuff = i; renderBuffList(); renderDetail(); },
          onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); M.selBuff = i; renderBuffList(); renderDetail(); } } },
        thumbEl(ic),
        el('span', { class: 'nm' }, el('b', { text: ic.name }), el('small', { text: secs(ic.durationMs || 4000) + 's / ' + secs(ic.cycleMs || 20000) + 's' })),
        el('span', { class: 'score' + (live && live.score >= live.threshold ? ' good' : ''), text: live ? (live.hasTemplate ? live.score.toFixed(2) : '—') : '--' }),
        el('i', { class: 'dot' + (live && live.present ? ' on' : '') }));
      box.appendChild(row);
    });
  }
  function renderDetail() {
    var box = $('#buffDetail'), icons = group().icons, i = M.selBuff, ic = icons[i];
    box.innerHTML = '';
    if (!ic) { box.appendChild(el('div', { class: 'empty', text: 'Chọn một buff ở danh sách bên trái.' })); return; }
    box.setAttribute('data-name', ic.name);
    function upd(k, v) { ic[k] = v; saveGroupSoon(); renderBuffList(); renderTiles(); refreshCycle(); }
    var cycle = el('div', { class: 'cycle' });
    function refreshCycle() {
      var d = ic.durationMs || 4000, c = ic.cycleMs || 20000;
      cycle.innerHTML = '';
      cycle.appendChild(el('span', { class: 'a', style: 'width:' + Math.max(8, Math.round(d / c * 100)) + '%', text: 'Hiệu lực ' + secs(d) + 's' }));
      cycle.appendChild(el('span', { class: 'c', text: 'Hồi chiêu' }));
      if (ic.prewarnEnabled !== false) cycle.appendChild(el('span', { class: 'w', text: '5-1' }));
      $('#cycleLen').textContent = secs(c) + 's';
    }
    var sndId = (ic.cdEndSound && ic.cdEndSound.assetId) || (ic.triggerSound && ic.triggerSound.assetId) || '';
    var live = M.live[ic.name];
    box.appendChild(el('div', { class: 'row' },
      thumbEl(ic, 'lg'),
      el('label', { class: 'fld grow' }, el('span', { text: 'Tên buff' }),
        el('input', { type: 'text', value: ic.name, onchange: function (e) {
          var v = e.target.value.trim();
          if (!v || icons.some(function (o, j) { return j !== i && o.name === v; })) { e.target.value = ic.name; toast('Tên trống hoặc bị trùng.', 'warn'); return; }
          ic.name = v; box.setAttribute('data-name', v); saveGroupSoon(); renderBuffList(); renderTiles(); renderReplaceSelect();
        } })),
      el('label', { class: 'chk', title: 'Bật / tắt theo dõi buff này' },
        el('span', { class: 'switch' }, el('input', { type: 'checkbox', checked: ic.enabled !== false, onchange: function (e) { upd('enabled', e.target.checked); refreshStatus(); } }), el('span')),
        'Theo dõi')));
    box.appendChild(el('div', { class: 'fld' }, el('span', {}, 'Một chu kỳ', el('b', { id: 'cycleLen' })), cycle));
    box.appendChild(el('div', { class: 'grid3' },
      field('Hiệu lực (giây)', numInput((ic.durationMs || 4000) / 1000, 0.5, 120, 0.5, function (v) { upd('durationMs', Math.round(v * 1000)); })),
      field('Hồi chiêu (giây)', numInput((ic.cycleMs || 20000) / 1000, 1, 600, 0.5, function (v) { upd('cycleMs', Math.round(v * 1000)); })),
      field('Ngưỡng khớp', numInput(ic.matchThreshold || 0.9, 0.5, 0.99, 0.01, function (v) { upd('matchThreshold', v); }))));
    box.appendChild(el('p', { class: 'obsnote', text: obsText(live) }));
    box.appendChild(el('div', { class: 'row' },
      el('label', { class: 'fld grow' }, el('span', { text: 'Âm khi sẵn sàng' }),
        soundSelect(sndId, function (v) { var o = soundObj(v); ic.triggerSound = o; ic.cdEndSound = o; saveGroupSoon(); }, 'ready', 'Âm khi sẵn sàng')),
      el('label', { class: 'chk', title: 'Tắt thì buff này không đọc 5-4-3-2-1' },
        el('input', { type: 'checkbox', checked: ic.prewarnEnabled !== false, onchange: function (e) { upd('prewarnEnabled', e.target.checked); } }), 'Đếm ngược 5-4-3-2-1')));
    box.appendChild(el('div', { class: 'foot' },
      el('button', { class: 'btn', type: 'button', text: 'Đổi mẫu icon', onclick: function () { openReplace(i); } }),
      el('button', { class: 'btn danger right', type: 'button', text: 'Xóa buff', onclick: function () {
        if (!confirm('Xóa buff “' + ic.name + '”?')) return;
        icons.splice(i, 1); renderBuffs(); saveGroupSoon();
      } })));
    refreshCycle();
  }
  function obsText(live) {
    return live && live.observedMs != null
      ? 'Đo được lần gần nhất: ' + secs(live.observedMs) + ' giây (thường thấp hơn thật 0,3–0,5 giây)'
      : 'Chưa đo được thời gian hiệu lực thực tế.';
  }
  function field(label, input) { return el('label', { class: 'fld' }, el('span', { text: label }), input); }
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
    if (keep && group().icons[+keep]) s.value = keep;
    renderReplaceOld();
  }

  /* ---------- monitor tiles ---------- */
  function renderTiles() {
    var box = $('#tiles'), icons = group().icons;
    box.innerHTML = '';
    M.tileNodes = []; M.tileOrder = '';
    if (!icons.length) { box.appendChild(el('div', { class: 'empty', text: 'Chưa có buff nào để theo dõi. Vào “Thiết lập game” để chụp và thêm buff.' })); return; }
    icons.forEach(function (ic) {
      var n = el('article', { class: 'tile' + (ic.enabled === false ? ' off' : ''), 'data-stage': 'unknown' },
        el('div', { class: 'tile-top' }, thumbEl(ic), el('div', {}, el('span', { class: 'tile-name', text: ic.name }), el('span', { class: 'tile-stage' }))),
        el('div', { class: 'tile-num' }, el('span'), el('small')),
        el('div', { class: 'bar' }, el('i')),
        el('div', { class: 'tile-foot' }, el('span', { text: 'Hiệu lực ' + secs(ic.durationMs || 4000) + 's · Hồi ' + secs(ic.cycleMs || 20000) + 's' }), el('span', { class: 'score', text: '--' })));
      M.tileNodes.push(n); box.appendChild(n);
    });
    updateTiles();
  }
  var RANK = { ready: 0, readySoon: 1, cooling: 2, active: 3, unknown: 4 };
  function updateTiles() {
    if (!M.state) return;
    var now = Date.now(), rows = {}, running = !!M.state.isMonitoring || M.testing;
    (M.overlayRows || []).forEach(function (b) { rows[b.name] = b; });
    var view = group().icons.map(function (ic, i) {
      var b = rows[ic.name], stage = 'unknown', num = '—', unit = '', pct = 0, label = running ? 'Chờ buff' : 'Chưa chạy', ms = Infinity;
      if (ic.enabled === false) label = 'Đã tắt';
      else if (b && running) {
        if (b.stage === 'active') {
          ms = Math.max(0, (b.activeUntilUnixMs || 0) - now);
          stage = 'active'; label = 'Đang hiệu lực'; num = String(Math.floor(ms / 1000)); unit = 's'; pct = ms / (ic.durationMs || 4000);
        } else if (b.expectedAtUnixMs && b.stage !== 'unknown') {
          ms = b.expectedAtUnixMs - now;
          stage = ms > 5000 ? 'cooling' : ms > 0 ? 'readySoon' : 'ready';
          label = { cooling: 'Hồi chiêu', readySoon: 'Sắp xong', ready: 'Sẵn sàng' }[stage];
          num = stage === 'ready' ? 'Dùng ngay' : String(Math.ceil(ms / 1000)); unit = stage === 'ready' ? '' : 's';
          pct = 1 - Math.max(0, ms) / (ic.cycleMs || 20000);
        }
      }
      return { i: i, stage: stage, num: num, unit: unit, pct: clamp(pct, 0, 1), label: label, rank: ic.enabled === false ? 9 : RANK[stage], ms: ms };
    });
    view.forEach(function (v) {
      var n = M.tileNodes[v.i]; if (!n) return;
      n.dataset.stage = v.stage;
      $('.tile-stage', n).textContent = v.label;
      $('.tile-num span', n).textContent = v.num;
      $('.tile-num small', n).textContent = v.unit;
      $('.bar i', n).style.width = Math.round(v.pct * 100) + '%';
    });
    var sorted = view.slice().sort(function (a, b) { return a.rank - b.rank || a.ms - b.ms || a.i - b.i; });
    var order = sorted.map(function (v) { return v.i; }).join(',');
    if (order !== M.tileOrder) {
      M.tileOrder = order;
      var box = $('#tiles');
      sorted.forEach(function (v) { if (M.tileNodes[v.i]) box.appendChild(M.tileNodes[v.i]); });
    }
  }
  function onIcons(list) {
    list.forEach(function (i) { M.live[i.name] = i; });
    group().icons.forEach(function (ic, idx) {
      var i = M.live[ic.name]; if (!i) return;
      var good = i.score >= i.threshold, txt = i.hasTemplate ? i.score.toFixed(2) : '—';
      var t = M.tileNodes[idx];
      if (t) { var s = $('.score', t); s.textContent = txt; s.className = 'score' + (good ? ' good' : ''); }
      var r = $$('.brow')[idx];
      if (r) { $('.score', r).textContent = txt; $('.score', r).className = 'score' + (good ? ' good' : ''); $('.dot', r).className = 'dot' + (i.present ? ' on' : ''); }
      if (idx === M.selBuff) { var ob = $('#buffDetail .obsnote'); if (ob) ob.textContent = obsText(i); }
    });
  }

  /* ---------- settings: sound ---------- */
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
      var ss = soundSelect(cur, function (v) { s[key] = v ? soundObj(v) : null; saveSettingsSoon(); }, 'countdown', 'Âm đọc ở giây ' + p[1]);
      cd.appendChild(el('div', { class: 'cdcell' }, el('span', { class: 'n', text: p[1] }), ss));
    });
    $('#btnOpenSounds').onclick = function () { API.invoke('open_data_folder').catch(fail); };
    $('#btnImportSound').onclick = importSound;
  }

  /* ---------- settings: overlay ---------- */
  function appearance() { var o = ovSet(); if (!o.appearance) o.appearance = { opacity: 1, fontScale: 1, paddingScale: 1, textColor: null, hideFrame: false }; return o.appearance; }
  function renderOvPreview() {
    var o = ovSet(), a = appearance(), st = $('#ovStage'), ov = $('#ovPreview');
    st.style.setProperty('--ov-opacity', String(a.opacity == null ? 1 : a.opacity));
    st.style.setProperty('--ov-font', String(a.fontScale == null ? 1 : a.fontScale));
    ov.classList.toggle('scheme-bw', o.colorScheme === 'blackWhite');
    ov.classList.toggle('noframe', !!a.hideFrame);
    $$('#ovScheme button').forEach(function (b) {
      var on = (o.colorScheme || 'gold') === b.dataset.v;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  function bindOverlay() {
    var o = ovSet(), a = appearance(), dpr = window.devicePixelRatio || 1;
    function pushAppearance() { API.invoke('preview_buff_overlay_appearance', { appearance: a }).catch(function () {}); saveSettingsSoon(); renderOvPreview(); }
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
    $$('#ovScheme button').forEach(function (b) { b.onclick = function () { o.colorScheme = b.dataset.v; saveSettingsSoon(); renderOvPreview(); }; });
    $('#btnEditOv').onclick = function () {
      var next = !M.editingOverlay;
      API.invoke('set_buff_overlay_edit_mode', { enabled: next }).then(function (s) {
        M.editingOverlay = next; setState(s);
        $('#btnEditOv').innerHTML = next ? ICON.check + 'Lưu vị trí cửa sổ nổi' : ICON.move + 'Chỉnh vị trí trên game';
        $('#btnEditOv').className = 'btn ' + (next ? 'primary' : '');
        $('#ovEditNote').style.display = next ? '' : 'none';
        if (!next) toast('Đã lưu vị trí và kích thước cửa sổ nổi.', 'ok');
      }).catch(fail);
    };
    renderOvPreview();
  }

  /* ---------- settings: hotkey ---------- */
  function bindHotkey() {
    var inp = $('#hkInput'), s = settings();
    function show() { inp.value = s.hotkey || ''; inp.placeholder = 'Chưa đặt — bấm vào đây rồi nhấn phím'; refreshStatus(); }
    function apply(combo) {
      return API.invoke('set_buff_hotkey', { hotkey: combo }).then(function (st) {
        setState(st); s = settings(); s.hotkey = combo; show();
        toast(combo ? 'Đã đặt phím tắt: ' + combo : 'Đã xóa phím tắt.', 'ok');
      }).catch(function (e) { show(); fail(e); });
    }
    show();
    bindComboInput(inp, apply);
    $('#btnHkClear').onclick = function () { apply(''); };
  }

  /* ---------- settings: advanced ---------- */
  function bindAdvanced() {
    var s = settings();
    $('#advConfirm').value = s.confirmFrames || 2;
    $('#advMissing').value = s.missingFrames || 3;
    $('#advConfirm').onchange = function (e) { s.confirmFrames = clamp(parseInt(e.target.value, 10) || 2, 1, 10); e.target.value = s.confirmFrames; saveSettingsSoon(); };
    $('#advMissing').onchange = function (e) { s.missingFrames = clamp(parseInt(e.target.value, 10) || 3, 1, 20); e.target.value = s.missingFrames; saveSettingsSoon(); };
  }

  /* ---------- template ---------- */
  function navBtn(id, label, extra) {
    return '<button type="button" data-go="' + id + '">' + ICON[id] + '<span>' + label + '</span>' + (extra || '') + '</button>';
  }
  function sample(name, stage, label, sec) {
    return '<div class="ov-row" data-stage="' + stage + '"><span class="ov-name">' + name + '</span><span class="ov-stage">' + label + '</span><strong class="ov-sec">' + sec + '</strong></div>';
  }
  var TEMPLATE = [
    '<div class="app">',
    '<nav class="side" aria-label="Điều hướng chính">',
    '<div class="brand"><img src="logo.png" alt=""><div><b>Trợ thủ Buff</b><small>Hồi chiêu · hẹn giờ · macro</small></div></div>',
    '<div class="nav">',
    navBtn('monitor', 'Theo dõi', '<i id="navDot" class="ndot"></i>'),
    navBtn('setup', 'Thiết lập game'),
    navBtn('buffs', 'Buff', '<i id="navBuffCount" class="count"></i>'),
    navBtn('timer', 'Hẹn giờ', '<i id="navTimerCount" class="count"></i>'),
    navBtn('macro', 'Macro', '<i id="navMacroCount" class="count"></i>'),
    navBtn('settings', 'Cài đặt'),
    '</div>',
    '<div class="side-foot"><span class="lbl">Cửa sổ game</span><span class="val" id="sideTarget"></span>',
    '<div class="kv"><span class="lbl">Phím bật/tắt</span><kbd id="sideHotkey">—</kbd></div></div>',
    '</nav>',

    '<div class="main">',
    '<div id="banner" class="banner hidden" role="status"></div><div id="errLine" class="errline" style="display:none"></div>',

    /* monitor */
    '<section class="page" data-page="monitor">',
    '<header class="phead"><div><h1>Theo dõi</h1><p id="monSub"></p></div>',
    '<span id="statusPill" class="pill" role="status">Đã dừng</span><button id="btnStart" type="button" class="btn big primary"></button></header>',
    '<div class="cols"><section id="tiles" class="tiles" aria-label="Trạng thái buff"></section>',
    '<aside class="mon-side">',
    '<section class="panel"><div class="phd"><h2>Hẹn giờ</h2><button type="button" class="btn small ghost" data-goto="timer">Quản lý</button></div><div id="monTimers" class="checks"></div></section>',
    '<section class="panel"><div class="phd"><h2>Macro</h2><button type="button" class="btn small ghost" data-goto="macro">Quản lý</button></div><div id="monMacros" class="checks"></div></section>',
    '<section class="panel"><div class="phd"><h2>Nhật ký</h2><button id="btnClearLog" type="button" class="btn small ghost">Xóa</button></div><pre id="logBox" class="log"></pre></section>',
    '</aside></div></section>',

    /* setup */
    '<section class="page" data-page="setup">',
    '<header class="phead"><div><h1>Thiết lập game</h1><p>Chọn cửa sổ, chụp một ảnh lúc buff đang hiện, rồi khoanh vùng trên ảnh. App chụp được cả khi game bị che (trừ khi thu nhỏ).</p></div></header>',
    '<section class="panel winbar" aria-label="Cửa sổ game"><label for="selWindow" class="muted">Cửa sổ</label><select id="selWindow"></select>',
    '<button id="btnRefresh" type="button" class="btn icon" title="Làm mới danh sách" aria-label="Làm mới danh sách cửa sổ">' + ICON.refresh + '</button>',
    '<button id="btnUseWindow" type="button" class="btn">Dùng cửa sổ này</button>',
    '<span id="targetSaved" class="tag" style="display:none">' + ICON.check + 'Đã lưu</span>',
    '<button id="btnCapture" type="button" class="btn primary">Chụp game</button></section>',
    '<p class="muted" id="targetInfo" style="margin-top:-8px"></p>',
    '<div class="cols"><section class="wide" style="display:flex;flex-direction:column;gap:12px">',
    '<div class="seg" role="radiogroup" aria-label="Chế độ khoanh">',
    '<label><input type="radio" name="mode" value="search" checked><span>Vùng tìm kiếm</span></label>',
    '<label><input type="radio" name="mode" value="add"><span>Thêm buff mới</span></label>',
    '<label><input type="radio" name="mode" value="replace"><span>Đổi mẫu icon</span></label></div>',
    '<div class="cvwrap" id="cvWrap"><div id="cvEmpty" class="cvempty">Chưa có ảnh. Bấm “Chụp game”.</div><canvas id="cv" style="display:none"></canvas></div>',
    '<div class="row"><p class="hint grow" id="capHint"></p><span class="muted mono" id="selInfo"></span><span class="muted mono" id="capInfo"></span>',
    '<button id="btnCancelSel" type="button" class="btn small ghost" style="display:none">Hủy vùng chọn <kbd>Esc</kbd></button>',
    '<button id="btnDiscardImg" type="button" class="btn small ghost" style="display:none">Xóa ảnh</button></div>',
    '</section>',
    '<aside class="panel narrow">',
    '<div class="modepane" data-mode="search"><h2>Vùng tìm kiếm</h2><p class="hint">Khoanh khu vực thanh buff trên ảnh. Vùng càng nhỏ, nhận diện càng nhanh.</p>',
    '<div class="grid2"><div class="fld"><span>Hiện tại</span><b id="curRegion">—</b></div><div class="fld"><span>Vùng mới</span><b id="newRegion">—</b></div></div>',
    '<button id="btnSaveRegion" type="button" class="btn big primary" disabled>Lưu vùng tìm kiếm</button></div>',
    '<div class="modepane" data-mode="add"><div class="row"><canvas id="cropThumb" class="cropthumb" style="display:none"></canvas><span id="cropEmpty" class="thumb lg none" aria-hidden="true">?</span>',
    '<div><h2>Thêm buff mới</h2><span class="muted mono" id="cropSize"></span></div></div>',
    '<label class="fld"><span>Tên buff</span><input id="fName" type="text" value="Buff 1"></label>',
    '<div class="grid2"><label class="fld"><span>Hiệu lực (giây)</span><input id="fDur" type="number" min="0.5" step="0.5" value="4"></label>',
    '<label class="fld"><span>Hồi chiêu (giây)</span><input id="fCool" type="number" min="1" step="0.5" value="20"></label></div>',
    '<label class="fld"><span>Âm khi sẵn sàng</span><div class="sndrow"><select id="fSound"></select>',
    '<button type="button" class="btn icon" id="btnFSound" title="Nghe thử" aria-label="Nghe thử">' + ICON.play + '</button>',
    '<button type="button" class="btn icon js-import" id="btnFImport" title="Thêm file nhạc .wav" aria-label="Thêm file nhạc">' + ICON.plus + '</button></div></label>',
    '<label class="chk"><input id="fPre" type="checkbox" checked>Đếm ngược 5-4-3-2-1</label>',
    '<details><summary class="muted">Nâng cao</summary><label class="fld" style="margin-top:8px"><span>Ngưỡng khớp</span><input id="fThr" type="number" min="0.5" max="0.99" step="0.01" value="0.9"></label></details>',
    '<button id="btnAddBuff" type="button" class="btn big primary" disabled>Thêm buff</button></div>',
    '<div class="modepane" data-mode="replace"><h2>Đổi mẫu icon</h2><p class="hint">Dùng khi icon đổi hình hoặc nhận diện kém.</p>',
    '<label class="fld"><span>Buff cần đổi</span><select id="selReplace"></select></label>',
    '<div class="row"><span id="replaceOld"></span><span class="muted">→ khoanh icon mới trên ảnh</span></div>',
    '<button id="btnReplace" type="button" class="btn big primary" disabled>Cập nhật mẫu</button></div>',
    '</aside></div></section>',

    /* buffs */
    '<section class="page" data-page="buffs">',
    '<header class="phead"><div><h1>Buff</h1><p>Hồi chiêu tính từ lúc buff xuất hiện (đã gồm hiệu lực). Sửa xong tự lưu.</p></div>',
    '<button id="btnTest" type="button" class="btn">Kiểm tra nhận diện</button>',
    '<button id="btnNewBuff" type="button" class="btn primary">' + ICON.plus + 'Thêm buff</button></header>',
    '<div class="cols"><section id="buffList" class="panel blist" aria-label="Danh sách buff"></section>',
    '<section id="buffDetail" class="panel bdetail" aria-label="Chi tiết buff"></section></div></section>',

    /* timers */
    '<section class="page" data-page="timer">' + Timers.TEMPLATE + '</section>',

    /* macro */
    '<section class="page" data-page="macro">' + Macros.TEMPLATE + '</section>',

    /* settings */
    '<section class="page" data-page="settings">',
    '<header class="phead"><div><h1>Cài đặt</h1></div></header>',
    '<div class="tabs" role="tablist"><button type="button" role="tab" data-tab="overlay">Cửa sổ nổi</button><button type="button" role="tab" data-tab="sound">Âm thanh</button>',
    '<button type="button" role="tab" data-tab="hotkey">Phím tắt</button><button type="button" role="tab" data-tab="adv">Nâng cao</button></div>',

    '<div class="tabpane cols" data-tab="overlay"><section class="panel wide">',
    '<div class="grid2"><label class="fld"><span>Độ đậm nền <b id="ovOpacityVal"></b></span><input id="ovOpacity" type="range" min="30" max="100"></label>',
    '<label class="fld"><span>Cỡ chữ <b id="ovFontVal"></b></span><input id="ovFont" type="range" min="70" max="200"></label>',
    '<label class="fld"><span>Độ rộng <b id="ovWidthVal"></b></span><input id="ovWidth" type="range" min="200" max="560" step="10"></label>',
    '<div class="fld"><span>Kiểu màu</span><div id="ovScheme" class="seg" role="radiogroup" aria-label="Kiểu màu" style="align-self:stretch">',
    '<button type="button" role="radio" data-v="gold" class="segbtn">Vàng</button><button type="button" role="radio" data-v="blackWhite" class="segbtn">Đen trắng</button></div></div></div>',
    '<div class="checks"><label class="chk"><input id="ovHideSeen" type="checkbox">Ẩn cho tới khi thấy buff lần đầu</label><label class="chk"><input id="ovHideFrame" type="checkbox">Ẩn viền và nền (chỉ giữ chữ)</label></div>',
    '<div class="row"><button id="btnEditOv" type="button" class="btn">' + ICON.move + 'Chỉnh vị trí trên game</button><p class="hint" id="ovEditNote" style="display:none">Kéo cửa sổ nổi tới chỗ mong muốn rồi bấm lại nút để lưu.</p></div>',
    '</section><section class="narrow" style="display:flex;flex-direction:column;gap:10px"><span class="muted">Xem trước</span>',
    '<div id="ovStage" class="ovstage"><div id="ovPreview" class="ov"><div class="ov-rows">',
    sample('Buff 4', 'ready', 'Sẵn sàng', 'OK'), sample('Buff 3', 'readySoon', 'Sắp xong', '4'), sample('Côn Ngô', 'cooling', 'Hồi chiêu', '14'), sample('Chu Thiên Kim', 'active', 'Hiệu lực', '3'),
    '</div></div></div></section></div>',

    '<div class="tabpane panel" data-tab="sound" style="flex-direction:column">',
    '<div class="grid2" style="align-items:center"><label class="fld"><span>Âm lượng <b id="volVal"></b></span><input id="volume" type="range" min="0" max="100"></label>',
    '<div class="checks"><label class="chk"><input id="chkReady" type="checkbox">Báo âm khi buff sẵn sàng</label><label class="chk"><input id="chkPrewarn" type="checkbox">Bật đếm ngược 5-4-3-2-1 (tắt thì không buff nào đếm)</label></div></div>',
    '<h2 style="font-size:14px">Âm đếm ngược <span class="muted" style="font-weight:400">· dùng chung cho mọi buff; từng buff bật/tắt riêng ở trang Buff</span></h2><div class="cdgrid" id="cdSounds"></div>',
    '<div class="row"><button id="btnImportSound" type="button" class="btn primary js-import">' + ICON.plus + 'Thêm nhạc (.wav)</button><button id="btnOpenSounds" type="button" class="btn ghost">Mở thư mục âm thanh</button></div>',
    '<p class="hint">Nhạc thêm vào sẽ có trong mọi ô chọn âm. Hiện chỉ hỗ trợ file .wav.</p></div>',

    '<div class="tabpane panel" data-tab="hotkey" style="flex-direction:column;max-width:600px">',
    '<label class="fld"><span>Bật / tắt theo dõi</span><div class="row"><input id="hkInput" type="text" class="grow" style="height:48px;font-size:18px"><button id="btnHkClear" type="button" class="btn ghost">Xóa</button></div></label>',
    '<p class="hint">Bấm vào ô rồi nhấn tổ hợp phím (ví dụ F8, Ctrl+Alt+B). Dùng được cả khi đang trong game. Nếu game chạy quyền Admin thì app cũng phải chạy quyền Admin. Phím tắt của từng macro đặt ở trang Macro.</p></div>',

    '<div class="tabpane panel" data-tab="adv" style="flex-direction:column;max-width:600px">',
    '<div class="grid2"><label class="fld"><span>Khung xác nhận buff xuất hiện</span><input id="advConfirm" type="number" min="1" max="10"></label>',
    '<label class="fld"><span>Khung xác nhận buff biến mất</span><input id="advMissing" type="number" min="1" max="20"></label></div>',
    '<p class="hint">Nhỏ thì phản ứng nhanh hơn nhưng dễ báo nhầm; mặc định 2 và 3. Mốc hồi chiêu luôn tính từ khung hình đầu tiên thấy buff.</p></div>',
    '</section>',

    '</div></div>',
  ].join('');

  function init() {
    $('#app').innerHTML = TEMPLATE;
    $$('.nav button').forEach(function (b) { b.onclick = function () { go(b.dataset.go); }; });
    $$('[data-goto]').forEach(function (b) { b.onclick = function () { go(b.dataset.goto); }; });
    $$('.tabs button').forEach(function (b) { b.onclick = function () { tab(b.dataset.tab); }; });
    go('monitor'); tab('overlay');
    $('#btnStart').onclick = startStop;
    $('#btnRefresh').onclick = function () { loadWindows(true); };
    $('#btnUseWindow').onclick = useWindow;
    $('#btnCapture').onclick = capture;
    $('#btnTest').onclick = toggleTest;
    $('#btnSaveRegion').onclick = saveRegion;
    $('#btnCancelSel').onclick = cancelSelection;
    $('#btnDiscardImg').onclick = discardPreview;
    $('#btnClearLog').onclick = function () { M.logs = []; $('#logBox').textContent = ''; };
    $('#btnNewBuff').onclick = function () { go('setup'); setMode('add'); };
    $('#selReplace').onchange = renderReplaceOld;
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
      renderBuffs(); bindSound(); bindOverlay(); bindAdvanced(); bindHotkey(); setMode('search'); showRegion(); refreshStatus();
      Timers.init({ cfg: cfg, setState: setState, toast: toast, fail: fail, addLog: addLog, soundSelect: soundSelect });
      Macros.init({ cfg: cfg, setState: setState, toast: toast, fail: fail, addLog: addLog, go: go });
      return loadWindows(false);
    }).catch(fail);
    setInterval(updateTiles, 250);
  }
  return { init: init };
})();
