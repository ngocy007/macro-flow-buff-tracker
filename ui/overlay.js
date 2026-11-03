/* Overlay window: one row per buff. Every countdown is computed from absolute timestamps sent by the
   backend (activeUntilUnixMs / expectedAtUnixMs), so each buff uses its own duration and cooldown. */
var Overlay = (function () {
  var state = { mode: 'hidden', buffs: [], editable: false, colorScheme: 'gold', hideUntilSeen: false };
  var appearance = { opacity: 1, fontScale: 1, paddingScale: 1, textColor: null, hideFrame: false };
  var root, rowsBox, hint, lastH = 0;

  var STAGE_LABEL = { unknown: 'Chờ', active: 'Hiệu lực', cooling: 'Hồi chiêu', readySoon: 'Sắp xong', ready: 'Sẵn sàng' };

  function rowView(b, now) {
    var stage = b.stage || 'unknown';
    var ms = null;
    if (stage === 'active') {
      ms = (b.activeUntilUnixMs || 0) - now;
      if (ms < 0) ms = 0;
    } else if (stage === 'cooling' || stage === 'readySoon' || stage === 'ready') {
      if (b.expectedAtUnixMs) {
        ms = b.expectedAtUnixMs - now;
        stage = ms > 5000 ? 'cooling' : ms > 0 ? 'readySoon' : 'ready';
        if (ms < 0) ms = 0;
      }
    }
    // The game's own buff list shows whole seconds rounded DOWN while a buff is active (a 5 s skill shows 4, 3, 2, 1),
    // so the active countdown does the same. Cooldowns are rounded up.
    var text = stage === 'ready' ? 'OK' : stage === 'unknown' || ms === null ? '--'
      : stage === 'active' ? String(Math.max(0, Math.floor(ms / 1000))) : String(Math.ceil(ms / 1000));
    return { stage: stage, text: text, label: STAGE_LABEL[stage] || '' };
  }

  function render() {
    if (!root) return;
    var show = state.mode !== 'hidden';
    var buffs = state.buffs || [];
    var now = Date.now();
    var editing = state.mode === 'editing';
    if (state.mode === 'waiting' && state.hideUntilSeen) show = false;
    root.style.display = show ? '' : 'none';
    root.classList.toggle('editing', editing);
    root.classList.toggle('scheme-bw', state.colorScheme === 'blackWhite');
    root.classList.toggle('noframe', !!appearance.hideFrame && !editing);
    if (!show) { fit(0); return; }

    // sync rows
    while (rowsBox.children.length > buffs.length) rowsBox.removeChild(rowsBox.lastChild);
    while (rowsBox.children.length < buffs.length) {
      rowsBox.appendChild(el('div', { class: 'ov-row' },
        el('span', { class: 'ov-name' }), el('span', { class: 'ov-stage' }), el('strong', { class: 'ov-sec' })));
    }
    var anyWarn = false;
    buffs.forEach(function (b, i) {
      var v = rowView(b, now);
      var r = rowsBox.children[i];
      r.dataset.stage = v.stage;
      r.children[0].textContent = b.name;
      r.children[1].textContent = v.label;
      r.children[2].textContent = v.text;
      if (v.stage === 'readySoon' || v.stage === 'ready') anyWarn = true;
    });
    root.dataset.warn = anyWarn ? '1' : '0';
    hint.style.display = editing ? '' : 'none';
    hint.textContent = 'Giữ chuột và kéo để di chuyển';
    fit(root.scrollHeight);
  }

  /* Keep the native window as tall as its content (logical px). */
  function fit(h) {
    if (!h || Math.abs(h - lastH) < 2) return;
    lastH = h;
    try {
      var w = window.__TAURI__.window.getCurrentWindow();
      w.setSize(new window.__TAURI__.dpi.LogicalSize(window.innerWidth, Math.ceil(h)));
    } catch (e) { /* ignore */ }
  }

  function applyAppearance() {
    var s = document.documentElement.style;
    s.setProperty('--ov-opacity', String(appearance.opacity == null ? 1 : appearance.opacity));
    s.setProperty('--ov-font', String(appearance.fontScale == null ? 1 : appearance.fontScale));
    s.setProperty('--ov-pad', String(appearance.paddingScale == null ? 1 : appearance.paddingScale));
    if (appearance.textColor) s.setProperty('--ov-color', appearance.textColor); else s.removeProperty('--ov-color');
    render();
  }

  function init() {
    var app = document.getElementById('app');
    hint = el('div', { class: 'ov-hint' });
    rowsBox = el('div', { class: 'ov-rows' });
    root = el('div', { class: 'ov' }, rowsBox, hint);
    app.appendChild(root);
    root.addEventListener('pointerdown', function (e) {
      if (state.mode !== 'editing' || e.button !== 0) return;
      try { window.__TAURI__.window.getCurrentWindow().startDragging(); } catch (x) { /* ignore */ }
    });
    API.listen('buff-overlay-state', function (s) { state = Object.assign(state, s); render(); });
    API.listen('buff-overlay-appearance', function (a) { appearance = Object.assign(appearance, a); applyAppearance(); });
    API.invoke('get_buff_overlay_state').then(function (s) { if (s) { state = Object.assign(state, s); render(); } }).catch(function () {});
    API.invoke('get_buff_overlay_appearance').then(function (a) { if (a) { appearance = Object.assign(appearance, a); applyAppearance(); } }).catch(function () {});
    setInterval(render, 100);
  }
  return { init: init };
})();
