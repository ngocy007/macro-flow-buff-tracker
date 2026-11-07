/* Shared helpers: Tauri bridge + tiny DOM builder. */
(function () {
  var T = function () { return window.__TAURI__; };
  window.API = {
    invoke: function (cmd, args) { return T().core.invoke(cmd, args || {}); },
    listen: function (ev, cb) { return T().event.listen(ev, function (e) { cb(e.payload); }); },
  };
  window.$ = function (sel, root) { return (root || document).querySelector(sel); };
  window.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  /** el('div', {class:'x', onclick:fn, text:'..'}, child, child...) */
  window.el = function (tag, attrs) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = !!v;
      else if (k === 'disabled') n.disabled = !!v;
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };
  /* Key names shared by the hotkey inputs and the macro recorder; the Rust side parses the same names. */
  var CODE_NAME = { Space: 'Space', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Escape: 'Esc', CapsLock: 'CapsLock',
    Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' };
  var MOD_NAME = { ControlLeft: 'Ctrl', ControlRight: 'Ctrl', ShiftLeft: 'Shift', ShiftRight: 'Shift', AltLeft: 'Alt', AltRight: 'Alt', MetaLeft: 'Win', MetaRight: 'Win' };
  /** One physical key -> name ("A", "F8", "Num1", "Ctrl"...), or null if unsupported. */
  window.keyName = function (e) {
    var c = e.code;
    if (/^Key[A-Z]$/.test(c)) return c.slice(3);
    if (/^Digit\d$/.test(c)) return c.slice(5);
    if (/^F\d{1,2}$/.test(c)) return c;
    if (/^Numpad\d$/.test(c)) return 'Num' + c.slice(6);
    return CODE_NAME[c] || MOD_NAME[c] || null;
  };
  /** Hotkey combo "Ctrl+Alt+B" from a keydown, or null when only modifiers are down. */
  window.comboFromEvent = function (e) {
    if (MOD_NAME[e.code]) return null;
    var k = keyName(e);
    if (!k || k === 'Esc') return null;
    var parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');
    parts.push(k);
    return parts.join('+');
  };
  /** Turn a readonly <input> into a "press a key combo" field. apply(combo) gets '' to clear. */
  window.bindComboInput = function (inp, apply) {
    inp.readOnly = true;
    inp.classList.add('hk');
    inp.addEventListener('focus', function () { inp.classList.add('listening'); });
    inp.addEventListener('blur', function () { inp.classList.remove('listening'); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') return;
      e.preventDefault();
      if (e.key === 'Escape') { inp.blur(); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { apply(''); return; }
      var combo = comboFromEvent(e);
      if (combo) apply(combo);
    });
  };
  window.ICON = (function () {
    function s(d, fill) { return '<svg width="18" height="18" viewBox="0 0 24 24" ' + (fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"') + ' aria-hidden="true">' + d + '</svg>'; }
    return {
      monitor: s('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
      setup: s('<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>'),
      buffs: s('<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/>'),
      macro: s('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
      settings: s('<path d="M4 6h10M18 6h2M4 18h4M12 18h8"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="18" r="2"/>'),
      refresh: s('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
      play: s('<path d="M7 4.5v15l12.5-7.5z"/>', true),
      stop: s('<rect x="5" y="5" width="14" height="14" rx="2"/>', true),
      plus: s('<path d="M12 5v14M5 12h14"/>'),
      trash: s('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
      up: s('<path d="M12 19V5M6 11l6-6 6 6"/>'),
      down: s('<path d="M12 5v14M6 13l6 6 6-6"/>'),
      timer: s('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/>'),
      check: s('<path d="M5 12l5 5 9-10"/>'),
      move: s('<path d="M12 2v20M2 12h20"/>'),
    };
  })();
  window.errText =function (e) { return (e && e.message) ? e.message : String(e); };
  window.clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  window.debounce = function (fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; };
})();
