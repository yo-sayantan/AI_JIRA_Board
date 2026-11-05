/*
 * The one script for every page in help/. Plain JavaScript, no build step, no network needed: the pages
 * work when opened straight from disk (file://), which is exactly when the guide is needed most — the
 * board is not deployed yet, or won't start.
 *
 *  1. In-page navigation (exact landing under the sticky nav, "On this page" highlight).
 *  2. Copy buttons on code blocks; Windows / macOS / Linux tabs.
 *  3. Data tables (local models, GGUF downloads, cloud prices) from help-data.js — a copy of
 *     ai-intern/models.json, cursor-prices.json and cloud-models.json made by every build — and, when
 *     the guide is served by the board, from the live files instead.
 *  4. The developer-doc viewer: renders docs/*.md, from the same bundled copy offline or live when served.
 *
 * Pages call JBAnchors.refresh() after they change their own content.
 */
(function () {
  'use strict';

  document.body.classList.add('js-on');
  var DATA = window.JB_HELP_DATA || {};
  var SERVED = /^https?:$/.test(location.protocol);

  // ── 1. in-page navigation ───────────────────────────────────────────────
  //
  // A plain #hash jump lands short or long, because the sticky nav wraps to two or three rows on narrow
  // windows (no fixed scroll-padding is right at every width), sections fill in after the jump (tables, a
  // rendered doc), and the last sections sit too close to the end of the page to scroll up under the nav.
  // So: measure the nav, scroll to the exact spot, hold the target in place while late content settles
  // (until the reader scrolls on their own), add just enough room after the footer, drive the highlight.
  var GAP = 16; // px between the nav's bottom edge and a target heading
  var SETTLE_MS = 1200; // keep holding the target this long after the last correction
  var HOLD_MAX_MS = 10000;

  var root = document.documentElement;
  var nav = document.querySelector('nav.top');
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var spacer = null;
  var hold = null; // the target being held in place
  var targetId = null; // where the last navigation pointed, even before that element exists
  var readerMoved = false; // the reader scrolled or clicked since that navigation
  var toc = [];
  var lit = null;
  var frame = 0;

  function now() {
    return Date.now();
  }
  function navHeight() {
    return nav ? nav.getBoundingClientRect().height : 0;
  }
  function offset() {
    return navHeight() + GAP;
  }
  function syncNav() {
    root.style.setProperty('--nav-h', Math.round(navHeight()) + 'px');
  }

  // Exact id first, then URI-decoded, then a punctuation-blind match, so GitHub-style anchors
  // ("runtime--files--locks") still find the doc viewer's slugs ("runtime-files-locks").
  function squash(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
  function find(id) {
    if (!id) return null;
    var el = document.getElementById(id);
    if (!el) {
      try {
        el = document.getElementById(decodeURIComponent(id));
      } catch (e) {
        el = null;
      }
    }
    if (el) return el;
    var want = squash(id);
    if (!want) return null;
    var all = document.querySelectorAll('[id]');
    for (var i = 0; i < all.length; i++) if (squash(all[i].id) === want) return all[i];
    return null;
  }

  function pageTop(el) {
    return el.getBoundingClientRect().top + window.pageYOffset;
  }

  // Room after the footer, so `el` can scroll up to the nav even when it is the last section.
  // It only ever grows: shrinking it while the reader is near the end would yank the page.
  function makeRoom(el) {
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.height = '0px';
      document.body.appendChild(spacer);
    }
    var have = spacer.offsetHeight;
    var below = root.scrollHeight - have - pageTop(el);
    var need = Math.ceil(window.innerHeight - offset() - below);
    if (need > have) spacer.style.height = need + 'px';
  }

  function wantY(el) {
    var max = root.scrollHeight - window.innerHeight;
    return Math.max(0, Math.min(Math.round(pageTop(el) - offset()), max));
  }

  // Instant, whatever the page's CSS scroll-behavior says ('instant' is not accepted everywhere).
  function jump(y) {
    var prev = root.style.scrollBehavior;
    root.style.scrollBehavior = 'auto';
    window.scrollTo(window.pageXOffset, y);
    root.style.scrollBehavior = prev;
  }
  function glide(y) {
    try {
      window.scrollTo({ top: y, left: window.pageXOffset, behavior: 'smooth' });
    } catch (e) {
      jump(y);
    }
  }

  function go(id, smooth) {
    targetId = id;
    readerMoved = false;
    var el = find(id);
    if (!el) {
      hold = null;
      return false;
    }
    makeRoom(el);
    var y = wantY(el);
    var t = now();
    var animate = !!smooth && !reduceMotion && Math.abs(y - window.pageYOffset) > 2;
    if (animate) glide(y);
    else jump(y);
    hold = { el: el, want: y, smooth: animate, started: t, movedAt: t, settledAt: t, lastY: window.pageYOffset };
    mark(el);
    schedule();
    return true;
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(step);
  }

  // One frame of holding: follow the target if content above it moved, until things settle.
  function step() {
    frame = 0;
    if (!hold) return;
    var t = now();
    if (!hold.el.isConnected) {
      var again = find(targetId);
      if (!again) {
        hold = null;
        return;
      }
      hold.el = again;
    }
    makeRoom(hold.el);
    var want = wantY(hold.el);
    var y = window.pageYOffset;
    if (Math.abs(y - hold.lastY) > 0.5) {
      hold.movedAt = t;
      hold.lastY = y;
    }
    if (hold.smooth) {
      if (Math.abs(want - hold.want) > 1) {
        glide(want); // the target moved mid-flight: re-aim
        hold.settledAt = t;
      } else if (Math.abs(y - want) <= 1 || (t - hold.movedAt > 200 && t - hold.started > 150)) {
        hold.smooth = false; // arrived, or the glide stopped short
        hold.settledAt = t;
      }
    }
    if (!hold.smooth && Math.abs(y - want) > 1) {
      jump(want);
      hold.settledAt = t;
      hold.lastY = window.pageYOffset;
    }
    hold.want = want;
    var settled = !hold.smooth && t - hold.settledAt > SETTLE_MS && document.readyState === 'complete';
    if (settled || t - hold.started > HOLD_MAX_MS) {
      hold = null;
      return;
    }
    schedule();
  }

  // Any reader input ends the hold — their scroll always wins.
  function readerTookOver() {
    readerMoved = true;
    hold = null;
  }

  // "On this page" highlight: only the in-page links of the sidebar (the "Guide pages" list is static).
  function collect() {
    toc = [];
    var links = document.querySelectorAll('.toc a[href^="#"]');
    for (var i = 0; i < links.length; i++) {
      var el = find(links[i].getAttribute('href').slice(1));
      if (el) toc.push({ a: links[i], el: el });
    }
  }

  function mark(el) {
    var pick = null;
    var i;
    if (el) for (i = 0; i < toc.length; i++) if (toc[i].el === el) pick = toc[i];
    if (!pick && toc.length) {
      var line = offset() + 4;
      for (i = 0; i < toc.length; i++) if (toc[i].el.getBoundingClientRect().top <= line) pick = toc[i];
      if (window.pageYOffset + window.innerHeight >= root.scrollHeight - 2) {
        // At the very end, the last section on screen is the one being read.
        for (i = toc.length - 1; i >= 0; i--) {
          if (toc[i].el.getBoundingClientRect().top < window.innerHeight) {
            pick = toc[i];
            break;
          }
        }
      }
      if (!pick) pick = toc[0];
    }
    var a = pick ? pick.a : null;
    if (a === lit) return;
    if (lit) lit.classList.remove('on');
    lit = a;
    if (a) {
      a.classList.add('on');
      reveal(a);
    }
  }

  // Keep the lit link inside the sidebar's own scroll area (never scrolls the page).
  function reveal(a) {
    var box = a.closest ? a.closest('aside') : null;
    if (!box || box.scrollHeight <= box.clientHeight + 1) return;
    var r = a.getBoundingClientRect();
    var b = box.getBoundingClientRect();
    if (r.top < b.top + 8) box.scrollTop -= b.top + 8 - r.top;
    else if (r.bottom > b.bottom - 8) box.scrollTop += r.bottom - (b.bottom - 8);
  }

  function refresh() {
    syncNav();
    collect();
    if (hold) schedule();
    else if (targetId && !readerMoved) go(targetId, false);
    else mark(null);
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
    if (!a.hash || a.hash === '#') return;
    if (a.protocol !== location.protocol || a.host !== location.host || a.pathname !== location.pathname || a.search !== location.search) return;
    var id = a.hash.slice(1);
    if (!find(id)) return;
    e.preventDefault();
    if (location.hash !== a.hash) {
      try {
        history.pushState(null, '', a.hash);
      } catch (err) {
        /* some browsers refuse pushState on file:// — the jump still happens */
      }
    }
    go(id, true);
  });

  // Typed into the address bar, or Back / Forward between sections.
  window.addEventListener('hashchange', function () {
    if (location.hash.length > 1) go(location.hash.slice(1), false);
  });

  window.addEventListener('wheel', readerTookOver, { passive: true });
  window.addEventListener('touchstart', readerTookOver, { passive: true });
  window.addEventListener('pointerdown', readerTookOver, true);
  window.addEventListener(
    'keydown',
    function (e) {
      if (/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End|Tab| |Spacebar)$/.test(e.key)) readerTookOver();
    },
    true
  );

  var queued = false;
  window.addEventListener(
    'scroll',
    function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        mark(hold ? hold.el : null);
      });
    },
    { passive: true }
  );

  function onResize() {
    syncNav();
    if (hold) schedule();
    else mark(null);
  }
  window.addEventListener('resize', onResize);
  if (window.ResizeObserver && nav) new ResizeObserver(onResize).observe(nav);

  window.JBAnchors = { refresh: refresh, go: go };

  // ── 2. copy buttons & OS tabs ───────────────────────────────────────────
  document.querySelectorAll('pre .copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var clone = btn.parentElement.cloneNode(true);
      clone.querySelector('.copy').remove();
      var text = clone.textContent.trim();
      function done() {
        var prev = btn.textContent;
        btn.textContent = 'Copied ✓';
        setTimeout(function () {
          btn.textContent = prev;
        }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
      else fallback();
      // file:// pages are not always a "secure context": fall back to a hidden textarea.
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          done();
        } catch (e) {
          /* the reader can still select the text by hand */
        }
        ta.remove();
      }
    });
  });

  // OS tabs — default to the visitor's platform, remember the choice (localStorage `jb-guide-os`).
  var tabs = document.querySelectorAll('.tabs button[data-os]');
  var panes = document.querySelectorAll('.os-pane[data-os]');
  function pickOS(os) {
    tabs.forEach(function (t) {
      t.setAttribute('aria-selected', String(t.dataset.os === os));
    });
    panes.forEach(function (p) {
      p.hidden = p.dataset.os !== os;
    });
    try {
      localStorage.setItem('jb-guide-os', os);
    } catch (e) {
      /* ignore */
    }
  }
  function detectOS() {
    try {
      var saved = localStorage.getItem('jb-guide-os');
      if (saved) return saved;
    } catch (e) {
      /* ignore */
    }
    var ua = navigator.userAgent;
    if (/Win/i.test(ua)) return 'win';
    if (/Mac/i.test(ua)) return 'mac';
    return 'linux';
  }
  if (tabs.length) {
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        pickOS(t.dataset.os);
      });
    });
    pickOS(detectOS());
  }

  // ── 3. data tables ──────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function setSource(which, live) {
    var el = document.querySelector('[data-src-for="' + which + '"]');
    if (!el) return;
    el.textContent = live
      ? 'Read live from the board: ' + el.getAttribute('data-file') + '.'
      : 'Read from the copy bundled with this guide (help/help-data.js, refreshed by every build of the board). ' +
        'Edited ' + el.getAttribute('data-file') + ' since? Run npm run build, or open this page from the running board.';
  }

  function fillCatalog(data) {
    var models = (data && data.models) || [];
    var ollama = document.getElementById('ollama-model-rows');
    var gguf = document.getElementById('gguf-model-rows');
    if (ollama) {
      ollama.innerHTML =
        models
          .map(function (m) {
            var href = m.ollama || 'https://ollama.com/library/' + encodeURIComponent(m.pull || m.id);
            return (
              '<tr><td>' + esc(m.label) + '</td><td><code class="inl">' + esc(m.pull || m.id) + '</code></td><td>~' + esc(m.ramGb) +
              ' GB' + (m.fits === 'host' ? ' · host' : '') + '</td><td><a class="dl" href="' + esc(href) + '">ollama.com</a></td></tr>'
            );
          })
          .join('') || '<tr><td colspan="4">No models in the catalog.</td></tr>';
    }
    if (gguf) {
      gguf.innerHTML =
        models
          .map(function (m) {
            var dl = m.gguf ? '<a class="dl" href="' + esc(m.gguf) + '">Download GGUF</a>' : '—';
            var page = m.ggufPage ? '<a href="' + esc(m.ggufPage) + '">repo</a>' : '—';
            return '<tr><td>' + esc(m.label) + '</td><td><code class="inl">' + esc(m.ggufFile || '—') + '</code></td><td>' + dl + '</td><td>' + page + '</td></tr>';
          })
          .join('') || '<tr><td colspan="4">No models in the catalog.</td></tr>';
    }
  }

  function usd(n) {
    if (n == null) return '—';
    if (Math.floor(n) === n) return '$' + n;
    return '$' + n.toFixed(3).replace(/0$/, '');
  }
  var MAKER_RANK = { Cursor: 0, Anthropic: 1, OpenAI: 2, Google: 3, 'Z.ai': 4, Moonshot: 5, Meta: 6 };

  // Cursor's price table + cloud-models.json → the cloud prices tables. Same sources as the worker and Settings.
  function fillPrices(prices, cfg) {
    if (!prices) return;
    var line = cfg && cfg.costlyOutputUsd != null ? cfg.costlyOutputUsd : 10;
    var listed = null;
    if (cfg) {
      listed = {};
      (cfg.models || []).forEach(function (e) {
        if (e.name) listed[String(e.name).toLowerCase()] = e;
      });
    }
    document.querySelectorAll('[data-costly-line]').forEach(function (el) {
      el.textContent = '$' + line;
    });
    var checked = document.getElementById('cursor-checked');
    if (checked) checked.textContent = 'checked ' + (prices.checked || 'recently');
    var all = (prices.models || []).slice().sort(function (a, b) {
      var ra = MAKER_RANK[a.provider] == null ? 9 : MAKER_RANK[a.provider];
      var rb = MAKER_RANK[b.provider] == null ? 9 : MAKER_RANK[b.provider];
      return ra - rb || (a.output || 0) - (b.output || 0) || a.name.localeCompare(b.name);
    });
    var shown = all.filter(function (m) {
      return !listed || listed[m.name.toLowerCase()];
    });
    var rest = all.filter(function (m) {
      return shown.indexOf(m) < 0;
    });
    var dash = '<span title="Cursor lists no cache-write price for this model">—</span>';
    var body = document.getElementById('cursor-price-rows');
    if (body) {
      body.innerHTML =
        shown
          .map(function (m) {
            var note = m.note ? ' <span class="small" title="' + esc(m.note) + '">ⓘ</span>' : '';
            var e = listed && listed[m.name.toLowerCase()];
            var out = e && e.outputUsd != null ? e.outputUsd : m.output;
            var costly = e && typeof e.costly === 'boolean' ? e.costly : out >= line;
            return (
              '<tr><td><b>' + esc(m.name) + '</b>' + note + '</td><td>' + esc(m.provider) + '</td><td>' + usd(m.input) + '</td><td>' +
              (m.cacheWrite == null ? dash : usd(m.cacheWrite)) + '</td><td>' + usd(m.cacheRead) + '</td><td>' + usd(out) +
              (costly ? ' <span class="costly" title="Costly: output at or above $' + line + ' per 1M tokens">⚠</span>' : '') + '</td></tr>'
            );
          })
          .join('') || '<tr><td colspan="6">No Cursor models in cloud-models.json match this table.</td></tr>';
    }
    var direct = document.getElementById('direct-model-rows');
    if (direct && cfg) {
      direct.innerHTML =
        (cfg.models || [])
          .filter(function (e) {
            return e.provider === 'claude' || e.provider === 'gemini';
          })
          .map(function (e) {
            var costly = typeof e.costly === 'boolean' ? e.costly : e.outputUsd != null && e.outputUsd >= line;
            return (
              '<tr><td><b>' + esc(e.name) + '</b></td><td>' + (e.provider === 'claude' ? 'Claude (Anthropic key)' : 'Gemini (Google key)') +
              '</td><td><code class="inl">' + esc(e.id) + '</code></td><td>' + usd(e.outputUsd) + (costly ? ' <span class="costly">⚠</span>' : '') +
              '</td><td>' + esc((e.efforts || []).join(' · ')) + '</td></tr>'
            );
          })
          .join('') || '<tr><td colspan="5">No Claude or Gemini models in cloud-models.json.</td></tr>';
    }
    var over = document.getElementById('cursor-over-rows');
    var count = document.getElementById('cursor-over-count');
    if (count) count.textContent = rest.length + ' models';
    if (over) {
      over.innerHTML = rest
        .map(function (m) {
          return '<tr><td>' + esc(m.name) + (m.fast ? ' <i>(fast)</i>' : '') + '</td><td>' + esc(m.provider) + '</td><td>' + usd(m.input) + '</td><td>' + usd(m.output) + '</td></tr>';
        })
        .join('');
    }
  }

  function fetchJson(path) {
    return fetch(path, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  function loadTables() {
    var hasCatalog = document.getElementById('ollama-model-rows') || document.getElementById('gguf-model-rows');
    var hasPrices = document.getElementById('cursor-price-rows') || document.getElementById('direct-model-rows');
    // The bundled copy first: instant, and all there is when the page was opened from disk.
    if (hasCatalog && DATA.models) {
      fillCatalog(DATA.models);
      setSource('models', false);
    }
    if (hasPrices && DATA.cursorPrices) {
      fillPrices(DATA.cursorPrices, DATA.cloudModels);
      setSource('prices', false);
    }
    if (!DATA.models && hasCatalog) fillCatalog({ models: [] });
    // Served by the board: the live files win (an edit shows without a rebuild).
    if (!SERVED) return;
    if (hasCatalog) {
      fetchJson('/ai-intern/models.json').then(function (d) {
        fillCatalog(d);
        setSource('models', true);
        refresh();
      }, function () {});
    }
    if (hasPrices) {
      Promise.all([fetchJson('/ai-intern/cursor-prices.json'), fetchJson('/ai-intern/cloud-models.json').catch(function () { return null; })]).then(function (r) {
        fillPrices(r[0], r[1] || DATA.cloudModels);
        setSource('prices', true);
        refresh();
      }, function () {});
    }
  }

  // ── 4. developer-doc viewer ─────────────────────────────────────────────
  // The documents it opens: docs/*.md, in this order. Their text is bundled in help-data.js too.
  var DOCS = [
    ['AGENTS.md', '🤖 Agents & onboarding'],
    ['FEATURES.md', '✨ Features'],
    ['DATA-FLOW.md', '🔄 Data flow'],
    ['AI-PIPELINE.md', '🧠 AI pipeline'],
    ['INTEGRATIONS.md', '🔌 Integrations'],
    ['RUNTIME.md', '📦 Runtime'],
    ['ARCHITECTURE.md', '🏗️ Architecture'],
    ['USAGE.md', '🧭 Using the board'],
    ['DEPLOYMENT.md', '🚀 Deployment'],
    ['SETUP.md', '⚙️ Setup'],
    ['CONFIG.md', '🧩 Config'],
    ['INTERN.md', '🐍 Intern'],
    ['OVERVIEW.md', '📖 Overview'],
    ['RUNTIME-FILES.md', '🗂️ Runtime files'],
    ['API.md', '🔗 HTTP API'],
    ['SECURITY.md', '🔒 Security'],
    ['CONTRIBUTING.md', '🛠️ Contributing'],
    ['TESTING.md', '🧪 Testing & SDLC'],
    ['CHANGELOG.md', '📝 Changelog'],
  ];
  var VIEWER = 'developer-doc-viewer.html';
  window.JB_HELP_DOCS = DOCS;

  function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }
  // Inline markdown on an ALREADY-ESCAPED string: code spans first (protected), then bold, italic, links.
  // Relative *.md links are rewritten back into this viewer.
  function inline(s) {
    var slots = [];
    s = s.replace(/`([^`]+)`/g, function (m, c) {
      slots.push('<code>' + c + '</code>');
      return '\u0000' + (slots.length - 1) + '\u0000';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
      var extra = '';
      if (/^https?:\/\//.test(u)) extra = ' target="_blank" rel="noopener noreferrer"';
      else if (/\.md(#[\w-]*)?$/.test(u)) {
        var parts = u.split('#');
        var p = parts[0].replace(/^\.\//, '').replace(/^\.\.\/docs\//, '');
        var known = DOCS.some(function (d) {
          return d[0] === p;
        });
        if (known) u = VIEWER + '?f=' + encodeURIComponent(p) + (parts[1] ? '#' + parts[1] : '');
        else u = '../docs/' + parts[0] + (parts[1] ? '#' + parts[1] : '');
      }
      return '<a href="' + u + '"' + extra + '>' + t + '</a>';
    });
    return s.replace(/\u0000(\d+)\u0000/g, function (m, i) {
      return slots[+i];
    });
  }

  /** Small block-level markdown renderer — headings, fences, tables, lists, blockquotes, hr, paragraphs.
   *  Enough for this repo's docs; no external libraries. */
  function render(src) {
    var lines = src.replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var i = 0;
    var seen = {};
    function heading(level, text) {
      var id = slug(text.replace(/[`*]/g, ''));
      if (seen[id]) id += '-' + ++seen[id];
      else seen[id] = 1;
      out.push('<h' + level + ' id="' + id + '">' + inline(esc(text)) + '</h' + level + '>');
    }
    while (i < lines.length) {
      var line = lines[i];
      if (/^```/.test(line)) {
        var buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      var h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        heading(h[1].length, h[2]);
        i++;
        continue;
      }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
        var cells = function (l) {
          return l
            .replace(/^\s*\||\|\s*$/g, '')
            .split('|')
            .map(function (c) {
              return inline(esc(c.trim()));
            });
        };
        var head = cells(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(
          '<table><thead><tr>' +
            head.map(function (c) { return '<th>' + c + '</th>'; }).join('') +
            '</tr></thead><tbody>' +
            rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>'; }).join('') +
            '</tbody></table>'
        );
        continue;
      }
      if (/^\s*>/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*> ?/, ''));
        out.push('<blockquote>' + render(q.join('\n')) + '</blockquote>');
        continue;
      }
      var li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
      if (li) {
        var ordered = /\d/.test(li[2]);
        var items = [];
        while (i < lines.length) {
          var m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
          if (m) {
            items.push({ depth: m[1].length >= 2 ? 1 : 0, text: m[3] });
            i++;
          } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
            items[items.length - 1].text += ' ' + lines[i].trim();
            i++;
          } else break;
        }
        var html = '';
        var open = false;
        items.forEach(function (it) {
          if (it.depth === 1) {
            if (!open) {
              html = html.replace(/<\/li>$/, '');
              html += '<ul>';
              open = true;
            }
            html += '<li>' + inline(esc(it.text)) + '</li>';
          } else {
            if (open) {
              html += '</ul></li>';
              open = false;
            }
            html += '<li>' + inline(esc(it.text)) + '</li>';
          }
        });
        if (open) html += '</ul></li>';
        out.push((ordered ? '<ol>' : '<ul>') + html + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^\s*$/.test(line)) {
        i++;
        continue;
      }
      var para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4})\s|^```|^\s*\||^\s*>|^(\s*)([-*]|\d+\.)\s|^\s*---+\s*$/.test(lines[i])) {
        para.push(lines[i++]);
      }
      if (para.length) out.push('<p>' + inline(esc(para.join(' '))) + '</p>');
      else i++;
    }
    return out.join('\n');
  }

  function docViewer() {
    var host = document.getElementById('md');
    if (!host) return;
    var param = new URLSearchParams(location.search).get('f') || 'AGENTS.md';
    var entry =
      DOCS.filter(function (d) {
        return d[0] === param;
      })[0] || DOCS[0];
    var file = entry[0];
    var raw = '../docs/' + file;

    var sw = document.getElementById('doc-switch');
    if (sw) {
      DOCS.forEach(function (d) {
        var a = document.createElement('a');
        a.className = d[0] === file ? 'on' : '';
        a.href = VIEWER + '?f=' + encodeURIComponent(d[0]);
        a.textContent = d[1];
        sw.appendChild(a);
      });
    }
    var rawLink = document.getElementById('rawlink');
    if (rawLink) {
      rawLink.href = raw;
      rawLink.textContent = 'docs/' + file;
    }

    function show(text) {
      host.innerHTML = render(text);
      var h1 = host.querySelector('h1');
      document.title = 'Jira Board Help — ' + (h1 ? h1.textContent : file);
      var tocBox = document.getElementById('toc');
      if (tocBox) {
        tocBox.innerHTML = '';
        host.querySelectorAll('h2, h3').forEach(function (hEl) {
          var a = document.createElement('a');
          a.href = '#' + hEl.id;
          a.textContent = hEl.textContent;
          if (hEl.tagName === 'H3') a.className = 'h3';
          tocBox.appendChild(a);
        });
      }
      // The doc just rendered: land the #section from the URL (or a link clicked meanwhile).
      refresh();
    }
    function bundled() {
      var text = DATA.docs && DATA.docs[file];
      if (text != null) show(text);
      else {
        host.innerHTML =
          '<div class="err">Could not load <code>docs/' + esc(file) + '</code>.<br>Open the file itself: <a href="' + raw + '">' +
          esc(raw) + '</a> — or run <code>npm run build</code> to refresh help/help-data.js.</div>';
      }
    }
    if (SERVED) {
      fetch(raw, { cache: 'no-cache' })
        .then(function (r) {
          if (!r.ok) throw new Error(String(r.status));
          return r.text();
        })
        .then(show, bundled);
    } else bundled();
  }

  loadTables();
  docViewer();

  syncNav();
  collect();
  // The browser has already jumped once while parsing; take over so late content cannot shift it.
  if (location.hash.length > 1) go(location.hash.slice(1), false);
  if (!hold) mark(null);
})();
