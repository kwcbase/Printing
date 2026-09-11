/* =============================================================================
 * Staffbase News Article -> PDF button  (loads vendored libraries from YOUR host)
 * -----------------------------------------------------------------------------
 * This small file goes in Studio -> Look & Feel / Advanced -> Custom JavaScript.
 * The heavy libraries (html2canvas + jsPDF) live in a separate file,
 * `staffbase-print-libs.js`, which YOU host internally. This script loads that
 * file once, on the first Print click, and the browser caches it thereafter —
 * nothing is fetched from a public CDN.
 *
 * ---------------------------------------------------------------------------
 * SETUP (required):
 *   1. Host `staffbase-print-libs.js` somewhere your users' browsers can reach
 *      (Staffbase asset hosting, or an internal CDN/host you control).
 *   2. Put its URL in LIB_URL below.
 *   3. (Recommended) keep LIB_INTEGRITY set to the hash generated for that exact
 *      file so the browser rejects it if it is ever tampered with. If you REBUILD
 *      or update the libs file, regenerate the hash (see note by LIB_INTEGRITY)
 *      or the script will refuse to load it.
 *      - Integrity requires the response to be readable cross-origin. If the libs
 *        file is on the SAME origin as the app, this just works. If it is on a
 *        DIFFERENT origin, that host must send `Access-Control-Allow-Origin`, and
 *        LIB_CROSSORIGIN below must stay 'anonymous'. If you cannot meet that,
 *        set LIB_INTEGRITY = '' to disable the check (weaker, but still no CDN).
 * ---------------------------------------------------------------------------
 *
 * BODY SOURCE: contents[locale].content -> contents[locale].teaser -> rendered DOM
 *
 * KNOWN BREAK POINTS (unsupported DOM injection / internal API)
 *   - Article anchor:  article.feed-post-detail.feed-post-type-articles
 *   - Action bar:      .news-feed-post-social-actions
 *   - DOM body:        .news-detail-post-teaser (fallback source)
 *   - Content API:     GET /api/posts/{id}  (falls back to /api/content/{id})
 * ============================================================================= */
(function () {
  'use strict';

  if (window.__sbPrintArticleButton) return;
  window.__sbPrintArticleButton = true;

  /* ============================ CONFIG ==================================== */
  // REQUIRED: absolute URL of the hosted staffbase-print-libs.js file.
  var LIB_URL = 'https://cdn.jsdelivr.net/gh/kwcbase/Printing@e8fdecafe24bb0dfdaf92e11f08c21e51fb084f4/staffbase-print-libs.js';

  // RECOMMENDED: Subresource Integrity hash of the hosted libs file.
  // This value matches the staffbase-print-libs.js generated alongside this script.
  // To regenerate after changing that file:
  //   openssl dgst -sha384 -binary staffbase-print-libs.js | openssl base64 -A
  // then prefix with "sha384-". Set to '' to disable integrity checking.
  var LIB_INTEGRITY = 'sha384-cnDfDWXtgRXsXWybvJOUix2OmpOOXqU39b5D904aUnOOKzpmiHQjl1cYDMQ/QimX';

  // Leave as 'anonymous' when using LIB_INTEGRITY. Set to '' only if the libs file
  // is same-origin AND you have disabled integrity.
  var LIB_CROSSORIGIN = 'anonymous';
  /* ======================================================================== */

  var SELECTORS = {
    article: 'article.feed-post-detail.feed-post-type-articles',
    actionBar: '.news-feed-post-social-actions',
    socialFooter: '.news-feed-post-social-footer'
  };

  // DOM fallback body sources, in priority order: a full rendered body first,
  // then preview/teaser text (covers reposts, which have no content/teaser in
  // the API and only render the shared post's teaser in .news-feed-post-teaser).
  var DOM_BODY_SELECTORS = [
    '.news-detail-post-content',
    '[class*="post-content"]',
    '.news-detail-post-teaser',
    '.news-feed-post-teaser'
  ];
  var API = { primary: '/api/posts/', fallback: '/api/content/' };

  var MARK = 'sb-print-pdf-btn';
  var LABEL = 'Print';          // change to localise, e.g. 'Drucken'
  var busy = false;
  var libsPromise = null;

  function libsReady() {
    return typeof window.html2canvas === 'function' &&
           ((window.jspdf && window.jspdf.jsPDF) || typeof window.jsPDF === 'function');
  }

  // Load the vendored libraries from LIB_URL exactly once.
  function loadLibs() {
    if (libsReady()) return Promise.resolve();
    if (libsPromise) return libsPromise;
    if (!LIB_URL || LIB_URL.indexOf('REPLACE-ME') > -1) {
      return Promise.reject(new Error('LIB_URL is not set — point it at your hosted staffbase-print-libs.js'));
    }
    libsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = LIB_URL;
      s.async = true;
      if (LIB_INTEGRITY) { s.integrity = LIB_INTEGRITY; s.crossOrigin = LIB_CROSSORIGIN || 'anonymous'; }
      s.onload = function () {
        libsReady() ? resolve() : reject(new Error('Libraries file loaded but globals are missing.'));
      };
      s.onerror = function () {
        libsPromise = null; // allow a retry on next click
        reject(new Error('Failed to load libraries from ' + LIB_URL + ' (check URL, CORS, and integrity hash).'));
      };
      document.head.appendChild(s);
    });
    return libsPromise;
  }

  /* ---------- helpers ------------------------------------------------------ */
  function getContentId() {
    var segs = location.pathname.split('/').filter(Boolean);
    for (var i = segs.length - 1; i >= 0; i--) {
      var m = segs[i].match(/[a-f0-9]{24}/i);
      if (m) return m[0];
    }
    return null;
  }

  function pickLocale(contents) {
    if (!contents) return null;
    var docLang = (document.documentElement.lang || '').replace('-', '_');
    if (docLang && contents[docLang]) return docLang;
    if (contents.en_US) return 'en_US';
    var keys = Object.keys(contents);
    return keys.length ? keys[0] : null;
  }

  function fetchArticle(id) {
    var opts = { credentials: 'include', headers: { Accept: 'application/json' } };
    return fetch(API.primary + id, opts).then(function (r) {
      if (r.ok) return r.json();
      return fetch(API.fallback + id, opts).then(function (r2) {
        if (!r2.ok) throw new Error('Article fetch failed (' + r.status + '/' + r2.status + ')');
        return r2.json();
      });
    });
  }

  function resolveBody(c) {
    var raw = (c && (c.content || c.teaser)) || '';
    if (!raw) raw = domBodyHtml();
    return sanitize(raw);
  }

  function domBodyHtml() {
    var article = document.querySelector(SELECTORS.article);
    if (!article) return '';
    for (var i = 0; i < DOM_BODY_SELECTORS.length; i++) {
      var el = article.querySelector(DOM_BODY_SELECTORS[i]);
      if (el && el.textContent.trim()) return el.innerHTML;
    }
    return '';
  }

  function fetchImageBlob(url) {
    return fetch(url, { credentials: 'include' })
      .then(function (r) { return r.ok ? r.blob() : null; })
      .then(function (b) { return b ? URL.createObjectURL(b) : null; })
      .catch(function () { return null; });
  }

  function blobifyImages(node) {
    var created = [];
    var imgs = [].slice.call(node.querySelectorAll('img'));
    return Promise.all(imgs.map(function (img) {
      var src = img.getAttribute('src');
      if (!src || src.indexOf('blob:') === 0 || src.indexOf('data:') === 0) return null;
      var abs = new URL(src, location.href).href;
      if (new URL(abs).origin !== location.origin) return null;
      return fetchImageBlob(abs).then(function (blobUrl) {
        if (blobUrl) { img.src = blobUrl; created.push(blobUrl); }
      });
    })).then(function () { return created; });
  }

  function sanitize(html) {
    var tmp = document.createElement('div');
    tmp.innerHTML = html || '';
    tmp.querySelectorAll('script,style').forEach(function (n) { n.remove(); });
    tmp.querySelectorAll('*').forEach(function (n) {
      [].slice.call(n.attributes).forEach(function (a) {
        if (/^on/i.test(a.name)) n.removeAttribute(a.name);
      });
      if (n.tagName.indexOf('-') > -1) n.remove();
    });
    // drop trailing "Read more" affordances that come with teaser/preview captures
    tmp.querySelectorAll('[class*="read-more"]').forEach(function (n) { n.remove(); });
    tmp.querySelectorAll('a').forEach(function (a) {
      if (/^\s*read more\b/i.test(a.textContent)) a.remove();
    });
    return tmp.innerHTML;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function slugify(s) {
    return String(s || 'article').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'article';
  }

  /* ---------- build the off-screen print card ------------------------------ */
  function buildPrintNode(data, heroSrc) {
    var wrap = document.createElement('div');
    wrap.id = 'sb-print-article';
    wrap.style.cssText = [
      'position:fixed', 'left:-10000px', 'top:0', 'width:752px', 'box-sizing:border-box',
      'background:#fff', 'border:1px solid #e2e6ea', 'border-radius:14px', 'overflow:hidden',
      'font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif', 'color:#0d1b2a'
    ].join(';');

    var hero = heroSrc
      ? '<img src="' + heroSrc + '" style="display:block;width:100%;height:auto;">'
      : '';

    var dateStr = data.published
      ? new Date(data.published).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
      : '';

    var pill = data.channel
      ? '<span style="display:inline-block;background:#e8f1fe;color:#1a73e8;font-size:11px;font-weight:700;'
        + 'letter-spacing:.6px;text-transform:uppercase;padding:4px 10px;border-radius:6px;">'
        + esc(data.channel) + '</span>'
      : '';

    var meta = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">'
      + pill
      + (dateStr ? '<span style="color:#5b6b7b;font-size:14px;">' + esc(dateStr) + '</span>' : '')
      + '</div>';

    var title = '<h1 style="font-size:34px;line-height:1.15;font-weight:800;margin:0 0 22px;color:#0d1b2a;">'
      + esc(data.title) + '</h1>';

    var rule = '<hr style="border:none;border-top:1px solid #e6ebf0;margin:20px 0;">';

    var author = data.author
      ? '<div style="font-size:15px;color:#0d1b2a;">Published by <strong>' + esc(data.author) + '</strong></div>'
      : '';

    var body = data.bodyHtml
      ? '<div style="font-family:Merriweather,Georgia,serif;font-size:15px;line-height:1.75;color:#1b2b3a;'
        + 'margin-top:18px;word-wrap:break-word;">' + data.bodyHtml + '</div>'
      : '';

    var footer = '<div style="display:flex;justify-content:space-between;gap:20px;margin-top:24px;'
      + 'font-size:12px;color:#8a97a4;">'
      + '<span>Source: ' + esc(location.href) + '</span>'
      + '<span style="white-space:nowrap;">Printed: ' + esc(new Date().toLocaleString()) + '</span>'
      + '</div>';

    wrap.innerHTML = hero
      + '<div style="padding:28px 32px 26px;">' + meta + title + rule + author + body + rule + footer + '</div>';
    return wrap;
  }

  /* ---------- html2canvas -> jsPDF : ONE continuous page (no page breaks) --- */
  // Renders the whole article onto a single PDF page whose height matches the
  // content, so the document scrolls as one long sheet instead of A4 pages.
  function canvasToPdf(canvas, filename) {
    var JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    var margin = 8;                                       // mm
    var pageW = 210;                                      // keep the familiar text column width
    var contentW = pageW - margin * 2;                    // 194mm image width
    var imgH = contentW * canvas.height / canvas.width;   // full height, aspect preserved
    var pageH = imgH + margin * 2;

    // A PDF page is capped at 14400 pt (~5080mm). Guard very long articles so the
    // output isn't silently clipped; warn if we hit the ceiling.
    var MAX_MM = 5000;
    if (pageH > MAX_MM) {
      console.warn('[sb-print] article taller than one PDF page allows (' +
        Math.round(pageH) + 'mm) — capping at ' + MAX_MM + 'mm.');
      pageH = MAX_MM;
      imgH = pageH - margin * 2;
    }

    var pdf = new JsPDF({ orientation: 'portrait', unit: 'mm', format: [pageW, pageH] });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', margin, margin, contentW, imgH);
    pdf.save(filename);
  }

  /* ---------- orchestration ------------------------------------------------ */
  function generate(btn) {
    var id = getContentId();
    if (!id) { alert('Could not read the article ID from the URL.'); return; }

    var restore = btn.innerHTML;
    var labelEl = btn.querySelector('.description');
    btn.disabled = true;
    if (labelEl) labelEl.textContent = 'Preparing…';

    loadLibs()
      .then(function () { return fetchArticle(id); })
      .then(function (json) {
        var loc = pickLocale(json.contents);
        var c = (loc && json.contents[loc]) || {};
        var heroUrl = c.image && (c.image.wide || c.image.original || c.image.thumb);
        heroUrl = heroUrl && heroUrl.url;
        var data = {
          title: c.title || document.title,
          bodyHtml: resolveBody(c),
          author: json.author ? [json.author.firstName, json.author.lastName].filter(Boolean).join(' ') : '',
          published: json.published,
          channel: (function () {
            try {
              var l = json.channel.config.localization;
              return (l[loc] || l[Object.keys(l)[0]]).title;
            } catch (e) { return ''; }
          })()
        };
        var pdfName = slugify(data.title) + '.pdf';

        return (heroUrl ? fetchImageBlob(heroUrl) : Promise.resolve(null))
          .then(function (heroSrc) {
            var pnode = buildPrintNode(data, heroSrc);
            document.body.appendChild(pnode);
            var created = heroSrc ? [heroSrc] : [];
            return blobifyImages(pnode).then(function (inlineUrls) {
              created = created.concat(inlineUrls);
              var imgs = pnode.querySelectorAll('img');
              var ready = [].map.call(imgs, function (im) {
                return im.complete ? Promise.resolve() : new Promise(function (r) { im.onload = im.onerror = r; });
              });
              return Promise.all(ready);
            }).then(function () {
              return window.html2canvas(pnode, { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false });
            }).then(function (canvas) {
              canvasToPdf(canvas, pdfName);
            }).then(function () {
              pnode.remove();
              created.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
            });
          });
      })
      .catch(function (err) {
        console.error('[sb-print] ', err);
        alert('Could not generate the PDF: ' + err.message);
      })
      .then(function () {
        btn.disabled = false;
        btn.innerHTML = restore;
      });
  }

  /* ---------- button injection (article-scoped, SPA-safe) ------------------ */
  function makeButton(reference) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = reference.className;
    ['action-comment', 'action-like', 'action-reaction', 'action-bookmark']
      .forEach(function (c) { btn.classList.remove(c); });
    btn.classList.add(MARK, 'action-print-pdf');
    btn.setAttribute('aria-label', 'Save this article as a PDF');
    btn.setAttribute('title', 'Save as PDF');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="6 9 6 2 18 2 18 9"></polyline>' +
      '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>' +
      '<rect x="6" y="14" width="12" height="8"></rect>' +
      '</svg>' +
      '<span class="description">' + LABEL + '</span>';
    return btn;
  }

  function inject() {
    var article = document.querySelector(SELECTORS.article);
    if (!article) return;
    var bar = article.querySelector(SELECTORS.actionBar);
    if (!bar) return;
    var ref = bar.querySelector('button:not(.' + MARK + ')');
    if (!ref) return;

    var existing = bar.querySelector('.' + MARK);
    if (existing && existing === bar.lastElementChild) return;

    busy = true;
    var btn = existing || makeButton(ref);
    if (!existing) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        generate(btn);
      });
    }
    bar.appendChild(btn);
    busy = false;
  }

  var scheduled = false;
  function schedule() {
    if (busy || scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () { scheduled = false; inject(); });
  }

  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  inject();
})();
