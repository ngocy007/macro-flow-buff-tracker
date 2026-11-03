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
  window.errText = function (e) { return (e && e.message) ? e.message : String(e); };
  window.clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  window.debounce = function (fn, ms) { var t; return function () { var a = arguments, s = this; clearTimeout(t); t = setTimeout(function () { fn.apply(s, a); }, ms); }; };
})();
