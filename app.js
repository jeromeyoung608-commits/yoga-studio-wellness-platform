/* ============================================================
   App Runtime — shared core
   (apiRequest, dataAdapter, showLoading, showError, mount, debounce, throttle)
   ============================================================ */

/* =============================================================================
   app-runtime.js  ·  shared delivery layer for this template pack
   -----------------------------------------------------------------------------
   Every page in this pack loads this ONE file. It gives each template the same
   production-shaped plumbing:

     • apiRequest(url, options)      typed fetch wrapper (timeout / token / errors)
     • dataAdapter.request()        the swappable seam between UI and data
     • showLoading / hideLoading     skeleton state
     • showError(container, msg, retry)   recoverable error state
     • mount()                      skeleton -> request -> render / retry
     • debounce / throttle          search + resize guards
     • store                        localStorage with a safe fallback

   There is NO backend in this pack. `mock` mode fakes latency and failures so
   the loading and retry states are actually demonstrable. Flip `mode` to
   `remote` (or call Pack.setDataMode('remote')) and the very same code path
   runs a real fetch through apiRequest. The UI does not change.
   ========================================================================== */
(function (global) {
  'use strict';

  var CFG_KEY = 'pack.runtime.v1';
  var DEFAULTS = { mode: 'mock', latency: 480, failMode: 'none',
                   baseURL: '/api', timeout: 8000, forceFail: false, failNext: false };
  var cfg = readCfg();

  function readCfg() {
    try {
      var raw = JSON.parse(localStorage.getItem(CFG_KEY) || '{}');
      var out = {}, k;
      for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k))
        out[k] = raw[k] === undefined ? DEFAULTS[k] : raw[k];
      return out;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------------------------------------------------------------------
     1 · Typed errors. A string is not an error contract.
     ------------------------------------------------------------------------- */
  function ApiError(kind, message, status, url, retryable, meta) {
    this.name = 'ApiError'; this.kind = kind; this.message = message;
    this.status = status || 0; this.url = url || '';
    this.retryable = retryable !== false; this.meta = meta || {};
    this.code = kind + (status ? ' · HTTP ' + status : '') + (url ? ' · ' + url : '');
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var HTTP_MSG = {
    400: 'The server could not read that request.',
    401: 'Your session expired. Please sign in again.',
    403: 'This workspace does not have access to that resource.',
    404: 'We could not find that endpoint.',
    408: 'The server gave up waiting. Try again.',
    409: 'That record changed while you were editing it.',
    422: 'Some fields did not validate.',
    429: 'Too many requests. Give it a moment.',
    500: 'The server hit an unexpected error.',
    502: 'An upstream service is unavailable.',
    503: 'The service is briefly down for maintenance.'
  };

  /* ---------------------------------------------------------------------------
     2 · apiRequest — an Axios-shaped fetch wrapper with zero dependencies.
     ------------------------------------------------------------------------- */
  function apiRequest(url, options) {
    options = options || {};
    var timeout = options.timeout == null ? cfg.timeout : options.timeout;
    var method = String(options.method || 'GET').toUpperCase();
    var headers = new Headers(options.headers || {});
    var token = options.token === undefined ? store.get('token') : options.token;

    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');

    var body = options.body;
    var isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    var isBlob = typeof Blob !== 'undefined' && body instanceof Blob;
    var isParams = typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams;
    if (body != null && typeof body !== 'string' && !isForm && !isBlob && !isParams) {
      body = JSON.stringify(body);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }

    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false, cancelled = false;
    function onAbort() { cancelled = true; if (ctrl) ctrl.abort(); }
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    var timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, timeout);

    var init = { method: method, headers: headers,
                 credentials: options.credentials || 'same-origin',
                 cache: options.cache || 'no-store' };
    if (ctrl) init.signal = ctrl.signal;
    if (body != null && method !== 'GET' && method !== 'HEAD') init.body = body;

    return fetch(url, init).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) {
        var kind = res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' :
                   res.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
        if (res.status === 401) store.remove('token');
        return Promise.reject(new ApiError(kind,
          HTTP_MSG[res.status] || ('Request failed with HTTP ' + res.status + '.'),
          res.status, url,
          res.status >= 500 || res.status === 408 || res.status === 429,
          { statusText: res.statusText }));
      }
      var parse = options.parse || 'auto';
      var ct = res.headers.get('content-type') || '';
      var payload;
      if (res.status === 204 || method === 'HEAD') payload = Promise.resolve(null);
      else if (parse === 'text' || (parse === 'auto' && ct.indexOf('application/json') < 0)) payload = res.text();
      else payload = res.json().catch(function () {
        return Promise.reject(new ApiError('PARSE', 'The response was not valid JSON.', res.status, url, true, {}));
      });
      return payload.then(function (data) {
        return { data: data, status: res.status, headers: res.headers, url: url };
      });
    }).catch(function (err) {
      clearTimeout(timer);
      if (err instanceof ApiError) return Promise.reject(err);
      if (timedOut) return Promise.reject(new ApiError('TIMEOUT',
        'Request timed out after ' + timeout + 'ms. Check the connection and try again.', 0, url, true, {}));
      if (cancelled || err.name === 'AbortError')
        return Promise.reject(new ApiError('ABORTED', 'Request was cancelled.', 0, url, false, {}));
      return Promise.reject(new ApiError('NETWORK',
        'Network unreachable — you appear to be offline, or the server refused the connection.',
        0, url, true, { cause: String(err && err.message || err) }));
    }).finally(function () {
      clearTimeout(timer);
      if (options.signal && options.signal.removeEventListener)
        options.signal.removeEventListener('abort', onAbort);
    });
  }

  /* ---------------------------------------------------------------------------
     3 · dataAdapter — the one seam a backend developer has to replace.
     ------------------------------------------------------------------------- */
  var FAILS = {
    '401': { kind: 'UNAUTHORIZED', status: 401, msg: HTTP_MSG[401] },
    '403': { kind: 'FORBIDDEN', status: 403, msg: HTTP_MSG[403] },
    '500': { kind: 'SERVER_ERROR', status: 500, msg: HTTP_MSG[500] },
    'timeout': { kind: 'TIMEOUT', status: 0, msg: 'Request timed out after ' + cfg.timeout + 'ms. Check the connection and try again.' },
    'network': { kind: 'NETWORK', status: 0, msg: 'Network unreachable — you appear to be offline, or the server refused the connection.' },
    'parse': { kind: 'PARSE', status: 200, msg: 'The response was not valid JSON.' }
  };

  function failure() {
    var mode = cfg.failMode;
    if (cfg.failNext) { cfg.failNext = false; saveCfg(); mode = cfg.forceFail ? mode : (mode === 'none' ? '500' : mode); }
    if (!cfg.forceFail && mode === 'none') return null;
    var f = FAILS[mode] || FAILS['500'];
    return new ApiError(f.kind, f.msg, f.status, cfg.baseURL + '/bootstrap', f.kind !== 'PARSE', {});
  }

  var dataAdapter = {
    /* Return the config so a developer can inspect it in DevTools. */
    get config() { return cfg; },

    /* MOCK: simulate a real round trip, including a recoverable failure. */
    fetchMockData: function (endpoint, payload) {
      var latency = Number(cfg.latency) || 0;
      if (cfg.failMode === 'timeout' && (cfg.forceFail || cfg.failNext)) latency = Math.min(latency, 220);
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          var err = failure();
          if (err) return reject(err);
          resolve({ data: { ok: true, endpoint: endpoint, payload: payload || null,
                            generatedAt: new Date().toISOString(),
                            latencyMs: latency },
                    status: 200, url: cfg.baseURL + endpoint });
        }, latency);
      });
    },

    /* REMOTE: the exact same contract, backed by a real HTTP request. */
    fetchRemoteData: function (endpoint, options) {
      return apiRequest(cfg.baseURL + endpoint, options || {});
    },

    request: function (endpoint, options) {
      options = options || {};
      if (cfg.mode === 'remote') return dataAdapter.fetchRemoteData(endpoint, options);
      return dataAdapter.fetchMockData(endpoint, options.payload);
    },

    /* One-line switch used by the built-in demo panel. */
    setMode: function (mode) { cfg.mode = mode === 'remote' ? 'remote' : 'mock'; saveCfg(); return cfg.mode; }
  };

  /* ---------------------------------------------------------------------------
     4 · UI state feedback — injected styles, no extra stylesheet to ship.
     ------------------------------------------------------------------------- */
  var cssDone = false;
  function injectCSS() {
    if (cssDone) return; cssDone = true;
    var css = [
      '.pack-layer{position:absolute;inset:0;z-index:900;display:flex;align-items:flex-start;',
      'justify-content:center;padding:28px 18px;overflow:hidden;',
      'background:rgba(13,16,20,.94);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);}',
      'body.pack-light .pack-layer{background:rgba(250,247,241,.96);}',
      '.pack-box{width:100%;max-width:620px;margin:0 auto;}',
      '.pack-cap{display:flex;align-items:center;gap:9px;font:600 12px/1.2 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'letter-spacing:.06em;text-transform:uppercase;color:#8b97a5;margin:0 0 18px;}',
      '.pack-spin{width:13px;height:13px;border-radius:50%;border:2px solid rgba(120,140,160,.28);border-top-color:#5ac8b0;',
      'animation:pack-spin .7s linear infinite;}',
      '@keyframes pack-spin{to{transform:rotate(360deg)}}',
      '.pack-bone{height:13px;border-radius:5px;margin-bottom:11px;position:relative;overflow:hidden;background:rgba(140,155,170,.13);}',
      '.pack-bone:after{content:"";position:absolute;inset:0;transform:translateX(-100%);',
      'background:linear-gradient(90deg,transparent,rgba(255,255,255,.13),transparent);animation:pack-sh 1.35s infinite;}',
      '@keyframes pack-sh{to{transform:translateX(100%)}}',
      '.pack-bone.w40{width:40%}.pack-bone.w62{width:62%}.pack-bone.w85{width:85%}.pack-bone.h34{height:34px}',
      '.pack-bone.h92{height:92px}.pack-bone.h140{height:140px}',
      '.pack-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px;margin:16px 0 22px;}',
      '.pack-grid .pack-bone{margin:0;height:64px}',
      '.pack-err{max-width:480px;margin:6vh auto 0;padding:24px;border-radius:14px;',
      'background:rgba(120,32,38,.16);border:1px solid rgba(226,96,104,.45);',
      'color:#f3e7e7;font:14px/1.55 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
      'body.pack-light .pack-err{background:#fff4f3;border-color:#e2b1ad;color:#5a2224;}',
      '.pack-err h4{margin:0 0 8px;font-size:16px;letter-spacing:-.01em;color:#ff9ba0}',
      'body.pack-light .pack-err h4{color:#a02c31}',
      '.pack-err .pack-code{margin:12px 0 18px;padding:9px 11px;border-radius:7px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;',
      'word-break:break-all;background:rgba(0,0,0,.24);color:#d3a5a8}',
      'body.pack-light .pack-err .pack-code{background:#f5e4e2;color:#8b4b4b}',
      '.pack-err .pack-acts{display:flex;gap:9px;flex-wrap:wrap}',
      '.pack-err button{font:600 13px system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;cursor:pointer;',
      'border-radius:8px;padding:9px 16px;border:1px solid transparent}',
      '.pack-retry{background:#d9534f;color:#fff}.pack-retry:hover{background:#c64541}',
      '.pack-dismiss{background:transparent;border-color:rgba(226,96,104,.45)!important;color:inherit}',
      '.pack-pill{position:fixed;right:14px;bottom:14px;z-index:950;display:flex;align-items:center;gap:7px;',
      'padding:7px 11px;border-radius:999px;cursor:pointer;opacity:.5;transition:opacity .2s;',
      'background:#1b2026;color:#d5dde4;border:1px solid rgba(255,255,255,.13);',
      'font:600 11px system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
      'box-shadow:0 6px 22px rgba(0,0,0,.28)}',
      '.pack-pill:hover,.pack-pill.open{opacity:1}',
      '.pack-pill i{width:6px;height:6px;border-radius:50%;background:#5ac8b0;display:block}',
      '.pack-panel{position:fixed;right:14px;bottom:52px;z-index:951;width:262px;padding:16px;border-radius:14px;',
      'background:#1b2026;color:#e6edf3;border:1px solid rgba(255,255,255,.13);display:none;',
      'box-shadow:0 18px 50px rgba(0,0,0,.42);font:12px/1.5 system-ui,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
      '.pack-panel.open{display:block}',
      '.pack-panel h5{margin:0 0 4px;font-size:13px}.pack-panel p{margin:0 0 13px;color:#93a0ad;font-size:11px}',
      '.pack-panel label{display:block;margin:9px 0 4px;color:#9aa8b5;font-size:10.5px;letter-spacing:.05em;text-transform:uppercase}',
      '.pack-panel select,.pack-panel input{width:100%;padding:7px 9px;border-radius:7px;background:#10151a;',
      'color:#e6edf3;border:1px solid rgba(255,255,255,.14);font:inherit}',
      '.pack-panel .pack-btns{display:flex;gap:7px;margin-top:13px;flex-wrap:wrap}',
      '.pack-panel button{flex:1;min-width:88px;padding:8px;border-radius:7px;cursor:pointer;font:inherit;font-weight:600;',
      'background:#2a333c;color:#e6edf3;border:1px solid rgba(255,255,255,.1)}',
      '.pack-panel button.pri{background:#5ac8b0;color:#0e1a18;border:0}',
      '.pack-panel .pack-chk{display:flex;align-items:center;gap:7px;margin-top:11px;color:#c3ced8}',
      '.pack-panel .pack-chk input{width:auto}',
      '@media(max-width:520px){.pack-grid{grid-template-columns:repeat(2,1fr)}',
      '.pack-panel{width:calc(100vw - 28px);bottom:120px}.pack-pill{bottom:78px;right:10px}}'
    ].join('');
    var st = document.createElement('style'); st.id = 'pack-runtime-css';
    st.textContent = css; document.head.appendChild(st);
  }

  function layer(container, inner, cls) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) host = document.body;
    injectCSS();
    clearState(host);
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var d = document.createElement('div');
    d.className = 'pack-layer ' + (cls || '');
    d.innerHTML = '<div class="pack-box">' + inner + '</div>';
    host.appendChild(d);
    return d;
  }
  function clearState(host) {
    var old = host.querySelector(':scope > .pack-layer');
    if (old) old.parentNode.removeChild(old);
  }

  function showLoading(container, label) {
    var bars = '<div class="pack-bone w40 h34"></div>' +
      '<div class="pack-bone w85"></div><div class="pack-bone w62"></div>' +
      '<div class="pack-grid"><div class="pack-bone"></div><div class="pack-bone"></div>' +
      '<div class="pack-bone"></div><div class="pack-bone"></div></div>' +
      '<div class="pack-bone h140"></div><div class="pack-bone w85"></div><div class="pack-bone w62"></div>';
    return layer(container,
      '<div class="pack-cap"><span class="pack-spin"></span><span>' + esc(label || 'Loading content…') + '</span></div>' + bars);
  }
  function hideLoading(container) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (host) clearState(host);
  }
  function showError(container, errorMsg, retryCallback, err) {
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    var code = err && err.code ? err.code : 'UNKNOWN · ' + (cfg.baseURL + '/bootstrap');
    var html = '<div class="pack-err"><h4>That request did not come back</h4>' +
      '<div>' + esc(errorMsg) + '</div>' +
      '<div class="pack-code">' + esc(code) + '</div>' +
      '<div class="pack-acts"><button class="pack-retry" type="button">Retry request</button>' +
      '<button class="pack-dismiss" type="button">Dismiss</button></div></div>';
    var d = layer(container, html);
    d.querySelector('.pack-retry').addEventListener('click', function () {
      hideLoading(host);
      if (typeof retryCallback === 'function') retryCallback();
    });
    d.querySelector('.pack-dismiss').addEventListener('click', function () { hideLoading(host); });
    return d;
  }

  /* ---------------------------------------------------------------------------
     5 · mount — the standard lifecycle every page in this pack boots through.
     ------------------------------------------------------------------------- */
  function mount(container, boot, opts) {
    opts = opts || {};
    var host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) host = document.body;
    var seq = 0;
    function run() {
      var mine = ++seq;
      showLoading(host, opts.label || 'Loading workspace data…');
      return dataAdapter.request(opts.endpoint || '/bootstrap', { payload: opts.payload })
        .then(function (res) {
          if (mine !== seq) return;                  // discard a stale request
          hideLoading(host);
          try { if (typeof boot === 'function') boot(res.data, res); }
          catch (e) { showError(host, 'The page could not render: ' + e.message, run, e); }
        })
        .catch(function (err) {
          if (mine !== seq) return;
          hideLoading(host);
          showError(host, err.message || 'Something went wrong.', run, err);
        });
    }
    global.Pack.reload = run;
    return run();
  }

  /* ---------------------------------------------------------------------------
     6 · Small utilities
     ------------------------------------------------------------------------- */
  function debounce(fn, delay) {
    var t = null, lastArgs = null;
    function wrapped() {
      lastArgs = arguments;
      clearTimeout(t);
      wrapped.pending = true;
      t = setTimeout(function () { wrapped.pending = false; fn.apply(null, lastArgs); }, delay || 300);
    }
    wrapped.pending = false;
    wrapped.cancel = function () { clearTimeout(t); wrapped.pending = false; };
    wrapped.flush = function () { clearTimeout(t); wrapped.pending = false; if (lastArgs) fn.apply(null, lastArgs); };
    return wrapped;
  }
  function throttle(fn, interval) {
    var last = 0, timer = null, lastArgs = null;
    return function () {
      lastArgs = arguments;
      var now = Date.now(), wait = (interval || 200) - (now - last);
      if (wait <= 0) { clearTimeout(timer); timer = null; last = now; fn.apply(null, lastArgs); }
      else if (!timer) timer = setTimeout(function () {
        last = Date.now(); timer = null; fn.apply(null, lastArgs);
      }, wait);
    };
  }
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    remove: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
    json: function (k, fallback) {
      try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; }
    }
  };

  /* ---------------------------------------------------------------------------
     7 · Demo controls. Deliberately opt-in so the shipped pages stay clean:
        add ?demo=1 to the URL, or call Pack.showDemo() from the console.
        The panel proves the adapter is live: inject a failure, then hit Retry.
     ------------------------------------------------------------------------- */
  function demoPanel() {
    injectCSS();
    document.body.classList.toggle('pack-light', !!document.querySelector('body.light'));
    if (!/[?&]demo=1/.test(location.search) && store.get('pack.demo.visible') !== '1') return;
    var pill = document.createElement('button');
    pill.type = 'button'; pill.className = 'pack-pill';
    pill.innerHTML = '<i></i><span>Demo data</span>';
    var panel = document.createElement('div'); panel.className = 'pack-panel';
    panel.innerHTML =
      '<h5>Data source</h5><p>Same UI, swappable backend. Try a failure, then hit Retry.</p>' +
      '<label>Mode</label><select data-k="mode"><option value="mock">Mock adapter</option><option value="remote">Remote API (real fetch)</option></select>' +
      '<label>Failure to inject</label><select data-k="fail">' +
        '<option value="none">None — request succeeds</option><option value="401">401 Unauthorized</option>' +
        '<option value="403">403 Forbidden</option><option value="500">500 Server error</option>' +
        '<option value="timeout">Timeout</option><option value="network">Network offline</option>' +
        '<option value="parse">Invalid JSON</option></select>' +
      '<label>Latency (ms)</label><input type="number" data-k="latency" min="0" max="15000" step="100">' +
      '<label>Base URL (remote mode)</label><input type="text" data-k="base" placeholder="/api">' +
      '<label class="pack-chk"><input type="checkbox" data-k="force"> Force this failure on every load</label>' +
      '<div class="pack-btns"><button class="pri" data-k="reload">Reload page data</button>' +
      '<button data-k="next">Fail next only</button></div>';
    document.body.appendChild(pill); document.body.appendChild(panel);

    function sync() {
      panel.querySelector('[data-k="mode"]').value = cfg.mode;
      panel.querySelector('[data-k="fail"]').value = cfg.failMode;
      panel.querySelector('[data-k="latency"]').value = cfg.latency;
      panel.querySelector('[data-k="base"]').value = cfg.baseURL;
      panel.querySelector('[data-k="force"]').checked = !!cfg.forceFail;
    }
    sync();
    pill.addEventListener('click', function () {
      panel.classList.toggle('open'); pill.classList.toggle('open'); sync();
    });
    panel.addEventListener('change', function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      if (k === 'mode') cfg.mode = e.target.value;
      if (k === 'fail') cfg.failMode = e.target.value;
      if (k === 'latency') cfg.latency = Math.max(0, Math.min(15000, Number(e.target.value) || 0));
      if (k === 'base') cfg.baseURL = e.target.value || '/api';
      if (k === 'force') cfg.forceFail = e.target.checked;
      saveCfg();
    });
    panel.addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-k'); if (!k) return;
      if (k === 'next') { cfg.failNext = true; saveCfg(); }
      if (global.Pack.reload) global.Pack.reload();
    });
    if (/[?&]demo=1/.test(location.search)) { panel.classList.add('open'); pill.classList.add('open'); sync(); }
  }

  /* A single throttled resize channel for every page. Charts subscribe to
     'pack:resize' instead of each attaching their own unthrottled listener. */
  window.addEventListener('resize', throttle(function () {
    window.dispatchEvent(new CustomEvent('pack:resize', { detail: { w: innerWidth, h: innerHeight } }));
  }, 200));

  global.Pack = {
    version: '1.0.0', ApiError: ApiError, apiRequest: apiRequest,
    dataAdapter: dataAdapter, showLoading: showLoading, hideLoading: hideLoading,
    showError: showError, mount: mount, debounce: debounce, throttle: throttle,
    store: store, esc: esc, saveCfg: saveCfg,
    setDataMode: function (m) { return dataAdapter.setMode(m); },
    get config() { return cfg; },
    demoPanel: demoPanel,
    showDemo: function () {
      store.set('pack.demo.visible', '1');
      var existing = document.querySelector('.pack-pill');
      if (existing) { var p = document.querySelector('.pack-panel'); if (p) p.classList.add('open'); return; }
      demoPanel();
      var fresh = document.querySelector('.pack-panel');
      if (fresh) fresh.classList.add('open');
      var freshPill = document.querySelector('.pack-pill');
      if (freshPill) freshPill.classList.add('open');
    },
    hideDemo: function () { store.remove('pack.demo.visible'); location.reload(); },
    reload: function () {}
  };

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', demoPanel);
  else demoPanel();
})(window);

/* ===================== ICONS (inline SVG, unique linear set) ===================== */
const ICONS={
  yoga:'<path d="M12 4a2 2 0 1 0 0-.01M5 20c2-3 5-4 7-4s5 1 7 4M7 9c2 2 3 4 5 4s3-2 5-4M9 6l3 3 3-3"/>',
  pilates:'<circle cx="12" cy="6" r="2.4"/><path d="M12 8.4V14m0 0-4 6m4-6 4 6M7 11h10"/>',
  spin:'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>',
  hiit:'<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  star:'<path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 17l-5.3 2.6 1.1-6L3.4 9.4l6-.8z"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  pin:'<path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
  fire:'<path d="M12 3c1 3-2 4-2 7a2 2 0 0 0 4 0c0-1 0-1 .5-2 1.5 2 2.5 4 2.5 6a5 5 0 0 1-10 0c0-4 4-6 5-11Z"/>',
  leaf:'<path d="M5 19c0-9 7-14 14-14 0 9-5 14-14 14Z"/><path d="M5 19c4-5 7-7 10-9"/>',
  fish:'<path d="M3 12c4-5 9-5 13 0-4 5-9 5-13 0Z"/><path d="M16 12l4-3v6z"/><circle cx="8" cy="11" r="1"/>',
  wheat:'<path d="M12 22V8M12 8c-2-2-2-4 0-6 2 2 2 4 0 6Zm0 4c-2-2-2-4 0-6 2 2 2 4 0 6Zm0 4c-2-2-2-4 0-6 2 2 2 4 0 6Z"/>',
  meat:'<path d="M6 11a5 5 0 0 1 9-3c3 0 5 2 5 5s-3 6-7 6c-4 0-7-3-7-8Z"/><circle cx="9" cy="11" r="1.6"/>',
  egg:'<path d="M12 3c-4 0-7 5-7 9a7 7 0 0 0 14 0c0-4-3-9-7-9Z"/>',
  nut:'<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/>',
  dairy:'<path d="M8 3h8l-1 4v12a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2V7z"/><path d="M8 9h8"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  back:'<path d="M15 18l-6-6 6-6"/>',
  arrow:'<path d="M9 6l6 6-6 6"/>',
  check:'<path d="M5 12l5 5 9-11"/>',
  bolt:'<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>',
  shield:'<path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/><path d="M9 12l2 2 4-4"/>'
};
function svg(name,extra=''){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ${extra}>${ICONS[name]||''}</svg>`;}

/* ===================== MOCK DATA ===================== */
const TYPES=[
  {id:'all',name:'All',icon:null},
  {id:'yoga',name:'Yoga',icon:'yoga',c1:'#2C5240',c2:'#163025'},
  {id:'pilates',name:'Pilates',icon:'pilates',c1:'#B8975A',c2:'#8a6f3c'},
  {id:'spin',name:'Spin',icon:'spin',c1:'#C2603A',c2:'#8f3f22'},
  {id:'hiit',name:'HIIT',icon:'hiit',c1:'#1C3A2E',c2:'#0f201a'}
];
const COACHES=[
  {id:'c1',name:'Maya Lindqvist',role:'Lead Vinyasa & Yin',rating:4.9,classes:312,av:'#2C5240',pic:'images/avatar-dana.jpg',bio:'15 yrs teaching. Breath-led, slow-powerful flows.'},
  {id:'c2',name:'Daniel Osei',role:'Pilates & Mobility',rating:4.8,classes:240,av:'#B8975A',pic:'images/avatar-owen.jpg',bio:'Former dancer. Precision, control, core.'},
  {id:'c3',name:'Sofia Reyes',role:'Spin & HIIT',rating:4.9,classes:401,av:'#C2603A',pic:'images/avatar-ines.jpg',bio:'High-energy cardio that flies by.'},
  {id:'c4',name:'Theo Nakamura',role:'Strength & HIIT',rating:4.7,classes:188,av:'#1C3A2E',pic:'images/avatar-theo.jpg',bio:'Build real strength, feel it for days.'}
];
const ROOMS={yoga:'Studio 1 · Garden level',pilates:'Reformer Room',spin:'Cycle Studio',hiit:'Functional Floor'};
const LEADER_PICS=['images/avatar-dana.jpg','images/avatar-owen.jpg','images/avatar-ines.jpg',
  'images/avatar-kenji.jpg','images/avatar-priya.jpg','images/avatar-theo.jpg'];
function leaderPic(rk){return LEADER_PICS[(Number(rk)||1)%LEADER_PICS.length];}
const CLASS_PICS={yoga:'images/yoga-sunlit.jpg',pilates:'images/yoga-still.jpg',
  spin:'images/gym-floor.jpg',hiit:'images/strength-session.jpg'};
const FOOD_PICS=['images/meal-bowl-green.jpg','images/meal-bowl-grain.jpg',
  'images/meal-table.jpg','images/meal-at-table.jpg'];
function classPic(t){return CLASS_PICS[t]||'images/yoga-class.jpg';}
function foodPic(id){const n=parseInt(String(id).replace(/\D/g,''),10);
  return FOOD_PICS[n%FOOD_PICS.length]||FOOD_PICS[0];}
const CLASSES=[
  {id:1,title:'Vinyasa Flow',type:'yoga',coach:'Maya Lindqvist',cid:'c1',clock:'MON',time:'07:00',dur:60,inten:'All levels',spots:3,cred:1,price:'$28'},
  {id:2,title:'Reformer Pilates',type:'pilates',coach:'Daniel Osei',cid:'c2',clock:'MON',time:'12:30',dur:50,inten:'Intermediate',spots:5,cred:1,price:'$32'},
  {id:3,title:'Power Spin',type:'spin',coach:'Sofia Reyes',cid:'c3',clock:'TUE',time:'18:00',dur:45,inten:'Advanced',spots:8,cred:1,price:'$26'},
  {id:4,title:'HIIT Ignite',type:'hiit',coach:'Theo Nakamura',cid:'c4',clock:'WED',time:'07:30',dur:40,inten:'High',spots:2,cred:1,price:'$24'},
  {id:5,title:'Yin & Restore',type:'yoga',coach:'Maya Lindqvist',cid:'c1',clock:'THU',time:'20:00',dur:75,inten:'Gentle',spots:6,cred:1,price:'$28'},
  {id:6,title:'Mat Pilates',type:'pilates',coach:'Daniel Osei',cid:'c2',clock:'FRI',time:'09:00',dur:50,inten:'All levels',spots:4,cred:1,price:'$32'},
  {id:7,title:'Sunrise Spin',type:'spin',coach:'Sofia Reyes',cid:'c3',clock:'SAT',time:'08:00',dur:45,inten:'Intermediate',spots:7,cred:1,price:'$26'},
  {id:8,title:'Strength HIIT',type:'hiit',coach:'Theo Nakamura',cid:'c4',clock:'SUN',time:'10:00',dur:50,inten:'High',spots:3,cred:1,price:'$24'}
];
const PAST=[
  {date:'Nov 2',title:'Vinyasa Flow',type:'yoga',coach:'Maya Lindqvist',dur:60,rating:5},
  {date:'Oct 30',title:'Power Spin',type:'spin',coach:'Sofia Reyes',dur:45,rating:5},
  {date:'Oct 27',title:'Reformer Pilates',type:'pilates',coach:'Daniel Osei',dur:50,rating:4},
  {date:'Oct 24',title:'HIIT Ignite',type:'hiit',coach:'Theo Nakamura',dur:40,rating:5},
  {date:'Oct 21',title:'Yin & Restore',type:'yoga',coach:'Maya Lindqvist',dur:75,rating:5},
  {date:'Oct 18',title:'Sunrise Spin',type:'spin',coach:'Sofia Reyes',dur:45,rating:4}
];
const DIETS=[
  {id:'balanced',name:'Balanced',icon:'leaf'},
  {id:'vegan',name:'Vegan',icon:'leaf'},
  {id:'vegetarian',name:'Vegetarian',icon:'leaf'},
  {id:'keto',name:'Keto',icon:'meat'},
  {id:'high-protein',name:'High-protein',icon:'meat'},
  {id:'pescatarian',name:'Pescatarian',icon:'fish'}
];
const ALLERGIES=[
  {id:'nuts',name:'Nuts',icon:'nut'},
  {id:'dairy',name:'Dairy',icon:'dairy'},
  {id:'gluten',name:'Gluten',icon:'wheat'},
  {id:'shellfish',name:'Shellfish',icon:'fish'},
  {id:'eggs',name:'Eggs',icon:'egg'}
];
const RECIPES=[
  {id:'r1',name:'Avocado Toast & Eggs',meal:'breakfast',diets:['vegetarian','balanced','high-protein'],al:[],cal:420,p:22,c:34,f:22,ing:['2 slices sourdough','1/2 avocado','2 eggs','Chili flakes, salt'],steps:['Toast bread.','Mash avocado, spread.','Fry eggs, top, season.']},
  {id:'r2',name:'Greek Yogurt Bowl',meal:'breakfast',diets:['vegetarian','high-protein'],al:['dairy'],cal:360,p:30,c:38,f:10,ing:['1 cup Greek yogurt','Berries','Granola','Honey'],steps:['Layer yogurt, berries, granola.','Drizzle honey.']},
  {id:'r3',name:'Grilled Chicken Salad',meal:'lunch',diets:['balanced','high-protein'],al:[],cal:480,p:42,c:18,f:26,ing:['150g chicken breast','Mixed greens','Cherry tomatoes','Olive oil'],steps:['Grill chicken.','Toss with greens & tomato.','Dress with olive oil.']},
  {id:'r4',name:'Salmon & Quinoa',meal:'dinner',diets:['balanced','pescatarian','high-protein'],al:['shellfish'],cal:560,p:40,c:45,f:22,ing:['140g salmon','1/2 cup quinoa','Asparagus','Lemon'],steps:['Bake salmon 12 min.','Cook quinoa.','Steam asparagus, serve with lemon.']},
  {id:'r5',name:'Tofu Stir-Fry',meal:'dinner',diets:['vegan','vegetarian'],al:['soy'],cal:430,p:24,c:40,f:18,ing:['200g tofu','Broccoli, pepper','Soy sauce','Ginger'],steps:['Press & cube tofu.','Stir-fry veg.','Add tofu & sauce.']},
  {id:'r6',name:'Berry Smoothie',meal:'snack',diets:['vegetarian','vegan'],al:[],cal:220,p:8,c:38,f:5,ing:['1 banana','1 cup berries','Almond milk','Spinach'],steps:['Blend all until smooth.']},
  {id:'r7',name:'Oatmeal & Banana',meal:'breakfast',diets:['vegan','vegetarian'],al:[],cal:340,p:10,c:62,f:7,ing:['1/2 cup oats','1 banana','Cinnamon','Plant milk'],steps:['Cook oats in milk.','Top banana & cinnamon.']},
  {id:'r8',name:'Turkey Wrap',meal:'lunch',diets:['balanced','high-protein'],al:[],cal:450,p:35,c:40,f:16,ing:['Wrap','100g turkey','Lettuce','Hummus'],steps:['Spread hummus.','Add turkey & lettuce.','Roll.']},
  {id:'r9',name:'Veggie Buddha Bowl',meal:'lunch',diets:['vegan','vegetarian'],al:[],cal:470,p:16,c:62,f:18,ing:['Chickpeas','Brown rice','Kale','Tahini'],steps:['Roast chickpeas.','Assemble bowl.','Drizzle tahini.']},
  {id:'r10',name:'Shrimp Zoodles',meal:'dinner',diets:['pescatarian','high-protein','keto'],al:['shellfish'],cal:380,p:34,c:12,f:20,ing:['200g shrimp','Zucchini noodles','Garlic','Olive oil'],steps:['Sauté shrimp in garlic.','Toss with zoodles.']},
  {id:'r11',name:'Egg & Veg Muffins',meal:'breakfast',diets:['vegetarian','high-protein','keto'],al:['eggs'],cal:300,p:24,c:6,f:20,ing:['4 eggs','Spinach','Bell pepper','Feta'],steps:['Whisk eggs.','Add veg, pour in tray.','Bake 18 min.']},
  {id:'r12',name:'Beef Lettuce Wraps',meal:'dinner',diets:['balanced','high-protein'],al:[],cal:420,p:36,c:14,f:24,ing:['150g lean beef','Lettuce cups','Hoisin','Scallion'],steps:['Brown beef.','Add hoisin.','Serve in lettuce.']},
  {id:'r13',name:'Caprese Skewers',meal:'snack',diets:['vegetarian'],al:['dairy'],cal:200,p:12,c:8,f:14,ing:['Cherry tomato','Mozzarella','Basil','Balsamic'],steps:['Skewer tomato, cheese, basil.','Drizzle balsamic.']},
  {id:'r14',name:'Chickpea Curry',meal:'dinner',diets:['vegan','vegetarian'],al:[],cal:500,p:18,c:64,f:16,ing:['Chickpeas','Coconut milk','Curry spice','Spinach'],steps:['Simmer chickpeas in coconut.','Add spice & spinach.']},
  {id:'r15',name:'Almond Butter Toast',meal:'snack',diets:['vegan','vegetarian'],al:['nuts'],cal:260,p:9,c:28,f:14,ing:['1 slice toast','Almond butter','Banana'],steps:['Spread butter.','Top banana.']},
  {id:'r16',name:'Quinoa Power Bowl',meal:'lunch',diets:['vegan','vegetarian','high-protein'],al:[],cal:520,p:20,c:66,f:18,ing:['Quinoa','Black beans','Corn','Avocado'],steps:['Cook quinoa.','Mix beans & corn.','Top avocado.']},
  {id:'r17',name:'Shakshuka',meal:'breakfast',diets:['vegetarian','balanced'],al:['eggs'],cal:340,p:18,c:22,f:20,ing:['3 eggs','Tomato sauce','Onion','Feta'],steps:['Simmer sauce.','Crack eggs in.','Bake until set.']},
  {id:'r18',name:'Chicken Caesar Wrap',meal:'lunch',diets:['balanced','high-protein'],al:['dairy','gluten'],cal:470,p:38,c:34,f:20,ing:['Wrap','Chicken','Romaine','Caesar dressing'],steps:['Toss chicken & greens.','Wrap.']},
  {id:'r19',name:'Veggie Curry',meal:'dinner',diets:['vegan','vegetarian'],al:[],cal:460,p:14,c:60,f:16,ing:['Cauliflower','Lentils','Coconut','Spice'],steps:['Simmer lentils & veg.','Add coconut & spice.']},
  {id:'r20',name:'Cottage Cheese & Peach',meal:'snack',diets:['vegetarian','high-protein'],al:['dairy'],cal:180,p:20,c:18,f:4,ing:['1 cup cottage cheese','Peach','Cinnamon'],steps:['Top cheese with peach.']},
  {id:'r21',name:'Tuna Avocado Salad',meal:'lunch',diets:['pescatarian','high-protein'],al:[],cal:440,p:38,c:16,f:26,ing:['1 can tuna','Avocado','Lemon','Greens'],steps:['Mix tuna & avocado.','Serve on greens.']},
  {id:'r22',name:'Pancakes (protein)',meal:'breakfast',diets:['vegetarian','high-protein'],al:['eggs','gluten','dairy'],cal:420,p:26,c:48,f:12,ing:['Protein flour','Egg','Milk','Berries'],steps:['Mix batter.','Griddle.','Top berries.']},
  {id:'r23',name:'Lentil Soup',meal:'dinner',diets:['vegan','vegetarian'],al:[],cal:320,p:18,c:48,f:4,ing:['Red lentils','Carrot','Cumin','Veggie stock'],steps:['Simmer lentils & veg.','Blend half for creaminess.']},
  {id:'r24',name:'Edamame Snack',meal:'snack',diets:['vegan','vegetarian','high-protein'],al:['soy'],cal:160,p:14,c:12,f:7,ing:['1 cup edamame','Sea salt'],steps:['Steam edamame.','Sprinkle salt.']},
  {id:'r25',name:'Steak & Greens',meal:'dinner',diets:['balanced','high-protein','keto'],al:[],cal:580,p:46,c:8,f:38,ing:['180g steak','Broccoli','Butter','Pepper'],steps:['Sear steak.','Steam broccoli.','Season.']},
  {id:'r26',name:'Overnight Oats',meal:'breakfast',diets:['vegetarian','vegan'],al:['gluten'],cal:360,p:12,c:58,f:9,ing:['Oats','Chia','Plant milk','Berries'],steps:['Mix, refrigerate overnight.','Top berries.']}
];
const PROGRESS={startWeight:68.5,goalWeight:62,unit:'kg',weights:[{date:'W1',w:68.5},{date:'W2',w:67.4},{date:'W3',w:66.6},{date:'W4',w:65.5},{date:'W5',w:64.2}]};
const LEADERBOARD=[
  {rk:1,nm:'A. Berg',pts:'4,210',c:'#2C5240'},
  {rk:2,nm:'J. Okafor',pts:'3,980',c:'#C2603A'},
  {rk:3,nm:'L. Moreau',pts:'3,640',c:'#B8975A'},
  {rk:4,nm:'Emma Cole',pts:'3,512',c:'#1C3A2E',you:true},
  {rk:5,nm:'R. Tan',pts:'3,300',c:'#2C5240'},
  {rk:6,nm:'M. Silva',pts:'3,090',c:'#C2603A'}
];

/* ===================== STATE ===================== */
const state={tab:'home',filter:'all',search:'',bookings:[],goal:'cut',diet:'balanced',allergies:[],plan:null,planDay:null};
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];

/* ===================== HOME ===================== */
function typeMeta(t){return TYPES.find(x=>x.id===t);}
function renderChips(){
  $('#chips').innerHTML=TYPES.map(t=>`<div class="chip ${t.id===state.filter?'active':''}" data-type="${t.id}">
    ${t.icon?svg(t.icon):''}${t.name}</div>`).join('');
  $$('#chips .chip').forEach(c=>c.onclick=()=>{state.filter=c.dataset.type;renderChips();renderClasses();});
}
function renderClasses(){
  const q=state.search.toLowerCase();
  let list=CLASSES.filter(c=>state.filter==='all'||c.type===state.filter);
  if(q) list=list.filter(c=>c.title.toLowerCase().includes(q)||c.coach.toLowerCase().includes(q));
  if(!list.length){$('#classList').innerHTML=`<div class="empty"><div class="e" style="font-size:14px;letter-spacing:.08em">NO MATCHES</div>No classes match yet.</div>`;return;}
  $('#classList').innerHTML=list.map(c=>{
    const t=typeMeta(c.type);
    return `<div class="cls" data-class="${c.id}">
      <div class="thumb photo" style="background-image:url('${classPic(c.type)}')"></div>
      <div class="info"><div class="t">${c.title}</div>
        <div class="meta"><span>${c.clock} ${c.time}</span><span>${c.dur} min</span><span><b>${c.inten}</b></span></div></div>
      <div class="price">${c.price}<small>${c.spots} spots</small></div>
    </div>`;
  }).join('');
  $$('#classList .cls').forEach(el=>el.onclick=()=>openClass(+el.dataset.class));
}
function renderFeatured(){
  $('#featureRow').innerHTML=CLASSES.slice(0,4).map(c=>{
    const t=typeMeta(c.type);
    return `<div class="feature" data-class="${c.id}" style="background-image:url('${classPic(c.type)}')">
      <span class="ftag">${t.name}</span>
      <h3>${c.title}</h3><small>${c.coach.split(' ')[0]} · ${c.time}</small></div>`;
  }).join('');
  $$('#featureRow .feature').forEach(el=>el.onclick=()=>openClass(+el.dataset.class));
}
function renderCoaches(){
  $('#coachList').innerHTML=COACHES.map(c=>`
    <div class="coach"><div class="av photo" style="background-image:url('${c.pic}')"></div>
      <div><div class="nm">${c.name}</div><div class="rl">${c.role}</div></div>
      <div class="st">${svg('star')}${c.rating}</div></div>`).join('');
}

/* ===================== CLASS DETAIL SHEET ===================== */
function openClass(id){
  const c=CLASSES.find(x=>x.id===id), t=typeMeta(c.type), co=COACHES.find(x=>x.cid===c.cid);
  state._openId=id;
  const booked=state.bookings.some(b=>b.id===id);
  $('#sheet').innerHTML=`
    <div class="grab"></div>
    <div class="shead">
      <div class="thumb photo" style="background-image:url('${classPic(c.type)}')"></div>
      <div><h2>${c.title}</h2><div class="sub">${t.name} · ${ROOMS[c.type]}</div></div>
    </div>
    <div class="detail-row"><span class="k">Coach</span><span class="v">${c.coach} ${svg('star')} ${co.rating}</span></div>
    <div class="detail-row"><span class="k">When</span><span class="v">${c.clock} · ${c.time}</span></div>
    <div class="detail-row"><span class="k">Duration</span><span class="v">${c.dur} min</span></div>
    <div class="detail-row"><span class="k">Intensity</span><span class="v">${c.inten}</span></div>
    <div class="detail-row"><span class="k">Spots left</span><span class="v">${c.spots} of 12</span></div>
    <div class="detail-row"><span class="k">Bring</span><span class="v">Mat, water, towel</span></div>
    <div class="detail-row"><span class="k">Price</span><span class="v">${c.price} · 1 credit</span></div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button class="btn ${booked?'btn-ghost':'btn-primary'}" id="bookBtn" style="flex:1;">${booked?'Cancel booking':'Book class'}</button>
    </div>`;
  $('#bookBtn').onclick=()=>{
    if(state.bookings.some(b=>b.id===id)){
      state.bookings=state.bookings.filter(b=>b.id!==id);toast('Booking cancelled');
    }else{
      state.bookings.push({...c});toast('Booked! See you there.');
    }
    closeSheet();renderSchedule();
  };
  showSheet();
}

/* ===================== SCHEDULE ===================== */
function renderSchedule(){
  const showUp=$('#schedChips .on').dataset.s==='up';
  const list=showUp?state.bookings.slice().sort((a,b)=>a.clock<b.clock?-1:1):PAST;
  if(!list.length){
    $('#schedList').innerHTML=`<div class="empty"><div class="e" style="font-size:14px;letter-spacing:.08em">NOTHING YET</div>${showUp?'No upcoming sessions.\nBook a class to begin.':'No past sessions yet.'}</div>`;return;
  }
  $('#schedList').innerHTML=list.map(c=>{
    if(showUp){
      return `<div class="booking">
        <div class="bd"><b>${c.clock}</b><span>${c.time}</span></div>
        <div class="bm"><b>${c.title}</b><small>${c.type} · ${c.coach} · ${c.dur} min</small></div>
        <div class="acts">
          <button class="btn btn-primary" style="height:34px;font-size:12px;padding:0 12px;" data-check="${c.id}">Check in</button>
          <button class="btn btn-ghost" style="height:28px;font-size:11px;padding:0 12px;" data-cancel="${c.id}">Cancel</button>
        </div></div>`;
    }
    return `<div class="booking">
      <div class="bd"><b>${c.date.split(' ')[1]||c.date}</b><span>${c.date.split(' ')[0]}</span></div>
      <div class="bm"><b>${c.title}</b><small>${c.type} · ${c.coach} · ${c.dur} min</small>
        <small style="color:var(--gold);display:flex;align-items:center;gap:3px;margin-top:3px;">${svg('star')} ${c.rating} · Attended</small></div>
      <div class="acts"><span class="muted" style="font-size:11px;">Done</span></div></div>`;
  }).join('');
  $$('#schedList [data-check]').forEach(b=>b.onclick=()=>openQR(+b.dataset.check));
  $$('#schedList [data-cancel]').forEach(b=>b.onclick=()=>{state.bookings=state.bookings.filter(x=>x.id!=b.dataset.cancel);toast('Cancelled');renderSchedule();});
}

/* ===================== CHECK-IN QR ===================== */
function openQR(id){
  const c=state.bookings.find(x=>x.id===id)||CLASSES.find(x=>x.id===id);
  let total=180;
  $('#qrModal').innerHTML=`
    <span class="eyebrow">Studio Check-in</span>
    <h2 style="margin-top:8px;">${c.title}</h2>
    <div class="sub">${c.clock} ${c.time} · ${ROOMS[c.type]}</div>
    <div class="qr-box">${fakeQR()}</div>
    <div class="qr-timer"><span class="pulse"></span>Valid for <span id="qrSec">${total}</span>s · show at front desk</div>
    <button class="btn btn-ghost" style="margin-top:22px;" id="qrClose">Close</button>`;
  $('#qrModal').classList.add('show');
  clearInterval(state._qr);
  state._qr=setInterval(()=>{total--;$('#qrSec').textContent=total;if(total<=0){clearInterval(state._qr);toast('Code refreshed');total=180;}},1000);
  $('#qrClose').onclick=()=>{$('#qrModal').classList.remove('show');clearInterval(state._qr);};
}
function fakeQR(){
  let cells='';const n=11;
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
    if(Math.random()>0.5)cells+=`<rect x="${x*16}" y="${y*16}" width="16" height="16" fill="#1A2B22"/>`;
  }
  // finder corners
  const corner=(x,y)=>`<rect x="${x}" y="${y}" width="48" height="48" fill="none" stroke="#1A2B22" stroke-width="8"/><rect x="${x+12}" y="${y+12}" width="24" height="24" fill="#1A2B22"/>`;
  return `<svg viewBox="0 0 176 176" xmlns="http://www.w3.org/2000/svg" style="background:#fff;border-radius:14px;">${cells}${corner(0,0)}${corner(128,0)}${corner(0,128)}</svg>`;
}

/* ===================== MEALS ===================== */
function renderMealOpts(){
  $('#dietOpts').innerHTML=DIETS.map(d=>`<div class="opt ${d.id===state.diet?'on':''}" data-diet="${d.id}">${svg(d.icon)}${d.name}</div>`).join('');
  $$('#dietOpts .opt').forEach(o=>o.onclick=()=>{state.diet=o.dataset.diet;renderMealOpts();});
  $('#allergyOpts').innerHTML=ALLERGIES.map(a=>`<div class="opt ${state.allergies.includes(a.id)?'on':''}" data-al="${a.id}">${svg(a.icon)}${a.name}</div>`).join('');
  $$('#allergyOpts .opt').forEach(o=>o.onclick=()=>{
    const id=o.dataset.al;
    state.allergies.includes(id)?state.allergies=state.allergies.filter(x=>x!==id):state.allergies.push(id);
    renderMealOpts();
  });
}
function generatePlan(){
  const goalCal={cut:1650,maintain:2000,bulk:2400}[state.goal];
  const map={breakfast:.25,lunch:.35,dinner:.30,snack:.10};
  const pool=RECIPES.filter(r=>{
    if(state.diet==='balanced')return true;
    if(r.diets.includes(state.diet))return true;
    return false;
  }).filter(r=>!r.al.some(a=>state.allergies.includes(a)));
  const safe=pool.length?pool:RECIPES;
  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const plan=days.map((d,i)=>{
    const isTraining=i%2===0; // training days slightly higher
    const factor=isTraining?1.08:0.92;
    const meals=['breakfast','lunch','dinner','snack'].map(m=>{
      const pick=safe.filter(r=>r.meal===m);
      const r=pick[Math.floor(Math.random()*pick.length)]||safe[0];
      const kcal=Math.round(goalCal*map[m]*factor);
      return {...r,kcal};
    });
    const total=meals.reduce((s,m)=>s+m.kcal,0);
    return {day:d,training:isTraining,meals,total};
  });
  state.plan=plan;
  renderPlan();
}
function renderPlan(){
  const p=state.plan;if(!p){return;}
  const allIng=[...new Set(p.flatMap(d=>d.meals.flatMap(m=>m.ing)))];
  state._shop=allIng.map(i=>({name:i,done:false}));
  $('#planResult').innerHTML=`
    <div class="sec-title" style="margin-top:6px;"><h2>Your week</h2><span class="muted" style="font-size:12px;">tap a day →</span></div>
    <div class="week" id="weekList">
      ${p.map((d,i)=>`<div class="wday" data-day="${i}">
        <div class="wd">${d.day}${d.training?' •':''}</div>
        <div class="meals">${d.meals.map(m=>`<span>${m.name}</span>`).join('')}</div>
        <div class="kcal">${d.total}</div></div>`).join('')}
    </div>
    <div class="field-label">Shopping list · ${allIng.length} items</div>
    <div id="shopList"></div>
    <div class="gen-wrap" style="background:linear-gradient(150deg,var(--terra),#9c4a2a);">
      <h3>Not right?</h3><p>Regenerate with a different goal or diet.</p>
      <button class="btn btn-gold" id="regenBtn" style="width:100%;">↻ Regenerate</button></div>`;
  $$('#weekList .wday').forEach(el=>el.onclick=()=>openDay(+el.dataset.day));
  renderShop();
  $('#regenBtn').onclick=generatePlan;
}
function openDay(i){
  const d=state.plan[i];
  $('#sheet').innerHTML=`<div class="grab"></div>
    <div class="back" id="dayBack">${svg('back')} Back to week</div>
    <span class="eyebrow">${d.day}${d.training?' · Training day':''}</span>
    <h2 style="font-size:22px;margin:6px 0 12px;">${d.total} kcal</h2>
    ${d.meals.map(m=>`<div class="recipe" data-rec="${m.id}">
      <div class="ico photo" style="background-image:url('${foodPic(m.id)}')"></div>
      <div><div class="nm">${m.name}</div><div class="mx">${m.kcal} kcal · ${m.meal}</div></div>
      ${svg('arrow')}</div>`).join('')}`;
  $$('#sheet [data-rec]').forEach(el=>el.onclick=()=>openRecipe(el.dataset.rec));
  $('#dayBack').onclick=()=>{renderPlan();showSheet();};
  showSheet();
}
function openRecipe(id){
  const r=RECIPES.find(x=>x.id===id);
  $('#sheet').innerHTML=`<div class="grab"></div>
    <div class="back" id="recBack">${svg('back')} Back</div>
    <span class="eyebrow">${r.meal}</span>
    <h2 style="font-size:24px;margin:6px 0 4px;">${r.name}</h2>
    <div class="macro">
      <div><b>${r.cal}</b><small>kcal</small></div><div><b>${r.p}g</b><small>protein</small></div>
      <div><b>${r.c}g</b><small>carbs</small></div><div><b>${r.f}g</b><small>fat</small></div></div>
    <div class="field-label">Ingredients</div>
    <ul class="ing">${r.ing.map(i=>`<li>${i}</li>`).join('')}</ul>
    <div class="field-label">Steps</div>
    <ol class="steps">${r.steps.map(s=>`<li>${s}</li>`).join('')}</ol>`;
  $('#recBack').onclick=()=>{if(state.planDay!=null){openDay(state.planDay);}else{showSheet();}};
  showSheet();
}
function renderShop(){
  $('#shopList').innerHTML=state._shop.map((s,i)=>`<div class="shop-item ${s.done?'done':''}" data-shop="${i}">
    <div class="box">${s.done?svg('check'):''}</div><span>${s.name}</span></div>`).join('');
  $$('#shopList [data-shop]').forEach(el=>el.onclick=()=>{
    const i=+el.dataset.shop;state._shop[i].done=!state._shop[i].done;renderShop();
  });
}

/* ===================== PROFILE ===================== */
function renderWeight(){
  const w=PROGRESS,wmax=Math.max(...w.weights.map(e=>e.w)),wmin=Math.min(...w.weights.map(e=>e.w));
  $('#weightTrend').innerHTML=w.weights.map(e=>{
    const pct=Math.round(((e.w-wmin)/(wmax-wmin||1))*70+15);
    return `<div class="wt"><span class="d">${e.date}</span><div class="track"><i style="width:${pct}%"></i></div><span class="w">${e.w} ${w.unit}</span></div>`;
  }).join('');
}
function renderLeaderboard(){
  $('#leaderboard').innerHTML=LEADERBOARD.map(l=>`
    <div class="lb"><span class="rk">${l.rk}</span>
      <div class="av2 photo" style="background-image:url('${leaderPic(l.rk)}')"></div>
      <span class="nm ${l.you?'you':''}">${l.nm}${l.you?' (You)':''}</span>
      <span class="pts">${l.pts}</span></div>`).join('');
}

/* ===================== UI HELPERS ===================== */
function showSheet(){$('#overlay').classList.add('show');$('#sheet').classList.add('show');}
function closeSheet(){$('#overlay').classList.remove('show');$('#sheet').classList.remove('show');}
$('#overlay').onclick=closeSheet;
let toastT;
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('show'),2200);}

/* ===================== TABS ===================== */
$$('#tabbar .tab').forEach(t=>t.onclick=()=>{
  state.tab=t.dataset.tab;
  $$('#tabbar .tab').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  $$('.screen').forEach(s=>s.classList.remove('active'));
  $('#'+state.tab).classList.add('active');
});
$$('[data-go]').forEach(a=>a.onclick=()=>{
  const t=a.dataset.go;$$('#tabbar .tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===t));
  $$('.screen').forEach(s=>s.classList.toggle('active',s.id===t));state.tab=t;
});

/* ===================== INIT ===================== */
function bootApp(){renderChips();renderClasses();renderFeatured();renderCoaches();}
Pack.mount('body', bootApp, {endpoint:'/studio',label:'Opening the studio schedule…',payload:{}});
renderMealOpts();renderWeight();renderLeaderboard();
const searchLater=Pack.debounce(v=>{state.search=v;renderClasses();},500);
$('#searchInput').oninput=e=>searchLater(e.target.value);
$('#genBtn').onclick=generatePlan;
$$('#schedChips button').forEach(b=>b.onclick=()=>{$$('#schedChips button').forEach(x=>x.classList.remove('on'));b.classList.add('on');renderSchedule();});
renderSchedule();
$$('#goalCtrl button').forEach(b=>b.onclick=()=>{$$('#goalCtrl button').forEach(x=>x.classList.remove('on'));b.classList.add('on');state.goal=b.dataset.goal;});
