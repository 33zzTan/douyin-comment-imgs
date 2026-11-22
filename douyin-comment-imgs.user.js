// ==UserScript==
// @name         抖音评论图片直取（绕过"评论不可见"）
// @namespace    local.douyin.comment.imgs
// @version      0.7.1
// @description  拦截抖音网页版的评论接口响应，直接把评论里的图片 URL 抽出来下载；不依赖页面渲染，多图评论即使显示"不可见"也能取到
// @author       local
// @match        https://www.douyin.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  var DBG = function () {
    try { console.log.apply(console, ['[dci]'].concat([].slice.call(arguments))); } catch (e) {}
  };

  var VERSION = '0.7.1';

  var store = new Map();
  var panelEl = null, listEl = null, btnEl = null;
  var previewEl = null, previewImg = null, previewMeta = null;
  var panelOpen = false;
  var closeTimer = null;
  var loggedKeys = 0;
  var currentAwemeId = null;
  var outFmt = 'jpg';   // jpg | png | orig

  // 版本标记，可在 Console 用 document.documentElement.dataset.dci 查看
  try { document.documentElement.setAttribute('data-dci', VERSION); } catch (e) {}

  // ---------- 作品切换检测 ----------
  function extractAwemeId() {
    var u = location.href;
    var m = u.match(/\/(?:video|note)\/(\d{8,})/);
    if (m) return m[1];
    m = u.match(/[?&#]modal_id=(\d{8,})/);
    if (m) return m[1];
    return null;
  }

  function watchAwemeChange() {
    var id = extractAwemeId();
    if (!id) return;
    if (currentAwemeId && id !== currentAwemeId) {
      var n = store.size;
      store.clear();
      hidePreview();
      DBG('切换作品', currentAwemeId, '->', id, '清空', n, '张');
      render();
    }
    currentAwemeId = id;
  }

  // ---------- URL 归一化 ----------
  function normalizeUrl(u) {
    if (typeof u !== 'string') return null;
    u = u.trim();
    if (u.indexOf('//') === 0) u = 'https:' + u;
    if (!/^https?:\/\//i.test(u)) return null;
    return u;
  }

  // 递归收集一个 image_list 元素里所有 http(s) 字符串（不猜字段名）
  function harvest(obj, out, depth) {
    out = out || [];
    if (depth === undefined) depth = 0;
    if (!obj || depth > 6) return out;
    if (typeof obj === 'string') {
      var n = normalizeUrl(obj);
      if (n) out.push(n);
      return out;
    }
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) harvest(obj[i], out, depth + 1);
      return out;
    }
    if (typeof obj === 'object') {
      for (var k in obj) {
        if (k === 'uri') continue;
        try { harvest(obj[k], out, depth + 1); } catch (e) {}
      }
    }
    return out;
  }

  // 打分：越接近原图分越高
  function score(u) {
    var s = 0;
    if (u.indexOf('tos-cn') >= 0) s += 30;
    if (u.indexOf('~tplv') < 0) s += 40;
    var m = u.match(/~tplv[^?]*?:(\d{3,4}):/);
    if (m) s -= parseInt(m[1], 10) / 20;
    if (/\.(jpe?g|png)$/i.test(u.split('?')[0])) s += 5;
    if (u.indexOf('watermark') >= 0) s -= 100;
    if (u.indexOf('aweme-avatar') >= 0) s -= 200;
    return s;
  }

  function keyOf(url) {
    var m = url.match(/tos-cn[^~?]*/);
    return m ? m[0] : url.split('?')[0];
  }

  function addImages(urls, cid) {
    urls.sort(function (a, b) { return score(b) - score(a); });
    var added = 0;
    urls.forEach(function (u, i) {
      var k = keyOf(u);
      if (store.has(k)) return;
      store.set(k, { url: u, fallbacks: urls.slice(i + 1), cid: cid || '' });
      added++;
    });
    if (added) {
      DBG('+images', added, 'total', store.size);
      render();
    }
  }

  // ---------- 遍历 JSON ----------
  function walk(node, depth) {
    if (!node || depth > 14) return;
    if (Array.isArray(node)) {
      for (var a = 0; a < node.length; a++) walk(node[a], depth + 1);
      return;
    }
    if (typeof node !== 'object') return;

    if (Array.isArray(node.image_list) && node.image_list.length) {
      var cid = node.cid || node.comment_id || '';
      if (loggedKeys < 8) {
        loggedKeys++;
        DBG('评论', cid, '图片数', node.image_list.length,
            'image_list[0] 字段:', Object.keys(node.image_list[0] || {}).join(','));
      }
      node.image_list.forEach(function (img) {
        addImages(harvest(img, [], 0), cid);
      });
    }
    for (var k in node) {
      if (k === 'image_list') continue;
      try { walk(node[k], depth + 1); } catch (e) {}
    }
  }

  function scan(text, srcUrl) {
    if (!text || text.indexOf('"image_list"') < 0) return;
    var data;
    try { data = JSON.parse(text); } catch (e) { return; }
    var n = 0;
    try { n = (data.comments || []).length; } catch (e) {}
    DBG('响应', String(srcUrl || '').split('?')[0], '评论数', n, '长度', text.length);
    walk(data, 0);
  }

  // ---------- 挂钩 ----------
  function hookXHR() {
    var X = W.XMLHttpRequest;
    if (!X || X.prototype.__dci_hooked) return;
    var rawOpen = X.prototype.open;
    var rawSend = X.prototype.send;
    X.prototype.open = function (m, u) { this.__dci_url = String(u || ''); return rawOpen.apply(this, arguments); };
    X.prototype.send = function () {
      var self = this;
      try {
        this.addEventListener('load', function () {
          try {
            var rt = self.responseType;
            var t = (rt === '' || rt === 'text') ? self.responseText
                  : (rt === 'json' ? JSON.stringify(self.response) : null);
            if (t) scan(t, self.__dci_url);
          } catch (e) {}
        });
      } catch (e) {}
      return rawSend.apply(this, arguments);
    };
    X.prototype.__dci_hooked = true;
    DBG('XHR 已挂钩');
  }

  function hookFetch() {
    var f = W.fetch;
    if (!f || f.__dci_hooked) return;
    var wrapped = function () {
      var self = this, args = arguments;
      return f.apply(self, args).then(function (res) {
        try {
          var u = (args[0] && args[0].url) || String(args[0] || '');
          var ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct.indexOf('json') >= 0) {
            res.clone().text().then(function (t) { scan(t, u); }).catch(function () {});
          }
        } catch (e) {}
        return res;
      });
    };
    wrapped.__dci_hooked = true;
    W.fetch = wrapped;
    DBG('fetch 已挂钩');
  }

  // ---------- 下载 ----------
  function extOf(url) {
    var m = url.split('?')[0].match(/\.(jpe?g|png|webp|gif|avif)$/i);
    if (m) return m[1].toLowerCase();
    return 'jpg';
  }

  function fileName(rec, i, ext) {
    var cid = String(rec.cid || 'c').slice(-8);
    var n = String(i + 1);
    if (n.length < 2) n = '0' + n;
    return 'dy_' + cid + '_' + n + '.' + (ext || extOf(rec.url));
  }

  // webp -> jpg/png（canvas 重编码，jpg 质量 0.95）
  function convertBlob(blob, fmt) {
    if (fmt === 'orig') return Promise.resolve(blob);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          var ctx = c.getContext('2d');
          if (fmt === 'jpg') {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, c.width, c.height);
          }
          ctx.drawImage(img, 0, 0);
          c.toBlob(function (out) {
            URL.revokeObjectURL(url);
            resolve(out || blob);
          }, fmt === 'png' ? 'image/png' : 'image/jpeg', 0.95);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve(blob);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(blob);
      };
      img.src = url;
    });
  }

  function save(rec, idx, quiet) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      window.open(rec.url, '_blank');
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: rec.url,
      responseType: 'blob',
      headers: { 'Referer': 'https://www.douyin.com/' },
      onload: function (r) {
        if (r.status !== 200 || !r.response) { if (!quiet) window.open(rec.url, '_blank'); return; }
        convertBlob(r.response, outFmt).then(function (blob) {
          var ext = outFmt === 'orig' ? extOf(rec.url) : outFmt;
          var a = document.createElement('a');
          var href = URL.createObjectURL(blob);
          a.href = href;
          a.download = fileName(rec, idx || 0, ext);
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(href); }, 30000);
        });
      },
      onerror: function () { if (!quiet) window.open(rec.url, '_blank'); }
    });
  }

  async function saveAll() {
    var recs = Array.from(store.values());
    for (var i = 0; i < recs.length; i++) {
      save(recs[i], i, true);
      await new Promise(function (r) { setTimeout(r, 700); });
    }
  }

  // ---------- 基础 UI ----------
  function css(el, s) { Object.assign(el.style, s); return el; }

  function makeBtn(text, fn, bg, fg) {
    var b = document.createElement('button');
    b.textContent = text;
    css(b, {
      border: 'none', background: bg || '#eef2f8', color: fg || '#1f3a5f',
      padding: '5px 9px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px'
    });
    b.onclick = fn;
    return b;
  }

  // ---------- 悬停放大预览 ----------
  function buildPreview() {
    if (previewEl) return;
    previewEl = document.createElement('div');
    css(previewEl, {
      position: 'fixed', zIndex: '1000000', display: 'none',
      background: '#fff', border: '1px solid #d8dde5', borderRadius: '8px',
      padding: '6px', boxShadow: '0 10px 30px rgba(0,0,0,.22)', pointerEvents: 'none'
    });

    previewImg = document.createElement('img');
    css(previewImg, {
      display: 'block', objectFit: 'contain',
      borderRadius: '4px', background: '#f4f6f9'
    });

    previewMeta = document.createElement('div');
    css(previewMeta, { font: '12px/1.6 system-ui,sans-serif', color: '#8a97a8', padding: '4px 2px 0' });

    previewEl.append(previewImg, previewMeta);
    document.body.append(previewEl);
  }

  function movePreview(ev) {
    if (!previewEl || previewEl.style.display === 'none') return;
    if (window.innerWidth < 1120) {
      previewEl.style.top = '7vh';
      return;
    }
    var h = previewEl.offsetHeight || 320;
    var top = ev.clientY - h / 2;
    top = Math.max(10, Math.min(top, window.innerHeight - h - 10));
    previewEl.style.top = top + 'px';
  }

  function showPreview(rec, ev) {
    if (!document.body) return;
    buildPreview();

    var narrow = window.innerWidth < 1120;
    var maxW = narrow
      ? window.innerWidth - 40
      : window.innerWidth - 548 - 44;
    maxW = Math.max(320, Math.min(880, maxW));
    var maxH = Math.round(window.innerHeight * 0.86);

    previewImg.style.maxWidth = maxW + 'px';
    previewImg.style.maxHeight = maxH + 'px';
    if (narrow) {
      previewEl.style.left = '16px';
      previewEl.style.right = 'auto';
    } else {
      previewEl.style.right = '548px';
      previewEl.style.left = 'auto';
    }

    previewImg.src = rec.url;
    previewMeta.textContent = '加载中…';
    previewImg.onload = function () {
      previewMeta.textContent = previewImg.naturalWidth + ' × ' + previewImg.naturalHeight;
      movePreview(ev || { clientY: window.innerHeight / 2 });
    };
    previewEl.style.display = 'block';
    movePreview(ev || { clientY: window.innerHeight / 2 });
  }

  function hidePreview() {
    if (previewEl) previewEl.style.display = 'none';
  }

  // ---------- 主界面：按钮先挂，面板后建 ----------
  function buildUI() {
    if (panelEl || !document.body) return;

    // 1) 按钮
    try {
      var btn = document.createElement('div');
      btn.textContent = '评论图 0';
      css(btn, {
        position: 'fixed', right: '16px', bottom: '96px', zIndex: '999999',
        background: '#8a97a8', color: '#fff', font: '13px/1.4 system-ui,sans-serif',
        padding: '9px 13px', borderRadius: '20px', cursor: 'pointer',
        boxShadow: '0 3px 12px rgba(0,0,0,.28)', userSelect: 'none'
      });
      btnEl = btn;
      document.body.appendChild(btn);   // 立刻进页面，后面出错也不影响它
    } catch (e) {
      DBG('按钮创建失败:', e && e.message);
      return;
    }

    // 2) 面板
    var panel = null;
    try {
      panel = document.createElement('div');
      css(panel, {
        position: 'fixed', right: '16px', bottom: '140px', zIndex: '999998',
        width: '520px', maxHeight: '72vh', overflow: 'auto', display: 'none',
        background: '#fff', border: '1px solid #d8dde5', borderRadius: '10px',
        boxShadow: '0 8px 28px rgba(0,0,0,.18)', font: '12px/1.5 system-ui,sans-serif'
      });

      var head = document.createElement('div');
      css(head, {
        display: 'flex', gap: '8px', alignItems: 'center', padding: '9px 11px',
        borderBottom: '1px solid #eef1f5', position: 'sticky', top: '0', background: '#fff'
      });

      var title = document.createElement('span');
      title.textContent = '评论图片';
      css(title, { fontWeight: '600', flex: '1' });

      var fmtBtn = makeBtn('存JPG', function () {}, '#1f3a5f', '#fff');
      fmtBtn.style.minWidth = '58px';
      fmtBtn.title = '点击切换：JPG / PNG / 原图webp';
      fmtBtn.onclick = function () {
        outFmt = outFmt === 'jpg' ? 'png' : (outFmt === 'png' ? 'orig' : 'jpg');
        fmtBtn.textContent = outFmt === 'jpg' ? '存JPG' : (outFmt === 'png' ? '存PNG' : '存原图');
      };

      head.append(
        title,
        fmtBtn,
        makeBtn('全部', saveAll, '#1f3a5f', '#fff'),
        makeBtn('复制', function () {
          var s = Array.from(store.values()).map(function (r) { return r.url; }).join('\n');
          navigator.clipboard.writeText(s);
        }),
        makeBtn('清空', function () { store.clear(); render(); })
      );

      listEl = document.createElement('div');
      css(listEl, {
        padding: '10px', display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px'
      });

      panel.append(head, listEl);
      document.body.appendChild(panel);
      panelEl = panel;
    } catch (e) {
      DBG('面板创建失败:', e && e.message);
      return;
    }

    // 3) 交互
    try {
      function openPanel() {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        if (panelOpen) return;
        panelOpen = true;
        panel.style.display = 'block';
        render();
      }

      function closePanel() {
        if (!panelOpen) return;
        panelOpen = false;
        panel.style.display = 'none';
        hidePreview();
      }

      function scheduleClose() {
        if (closeTimer) clearTimeout(closeTimer);
        closeTimer = setTimeout(function () { closeTimer = null; closePanel(); }, 150);
      }

      btn.addEventListener('mouseenter', openPanel);
      btn.addEventListener('mouseleave', scheduleClose);
      btn.addEventListener('click', function () { panelOpen ? closePanel() : openPanel(); });

      panel.addEventListener('mouseenter', function () {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
      });
      panel.addEventListener('mouseleave', scheduleClose);
    } catch (e) {
      DBG('事件绑定失败:', e && e.message);
    }
  }

  function render() {
    if (!document.body) return;
    buildUI();
    if (!btnEl) return;

    btnEl.textContent = '评论图 ' + store.size;
    btnEl.style.background = store.size ? '#1f3a5f' : '#8a97a8';
    if (!panelOpen || !listEl) return;

    listEl.innerHTML = '';
    if (!store.size) {
      var d = document.createElement('div');
      d.textContent = '还没抓到。把评论区往下滚，让它会加载更多评论。';
      css(d, { color: '#8a97a8', padding: '12px 6px', lineHeight: '1.7' });
      listEl.append(d);
      return;
    }

    var i = 0;
    store.forEach(function (rec) {
      if (i > 300) return;
      var idx = i;

      var cell = document.createElement('div');
      css(cell, {
        position: 'relative', paddingTop: '100%', borderRadius: '6px',
        overflow: 'hidden', background: '#f4f6f9', cursor: 'pointer'
      });

      var t = document.createElement('img');
      t.src = rec.url;
      t.loading = 'lazy';
      css(t, {
        position: 'absolute', top: '0', left: '0', width: '100%', height: '100%',
        objectFit: 'cover', display: 'block'
      });

      var mask = document.createElement('div');
      css(mask, {
        position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,.34)', opacity: '0', transition: 'opacity .15s'
      });
      mask.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" ' +
        'stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 3v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 20.5h15"/></svg>';

      cell.addEventListener('mouseenter', function (e) {
        mask.style.opacity = '1';
        showPreview(rec, e);
      });
      cell.addEventListener('mousemove', function (e) { movePreview(e); });
      cell.addEventListener('mouseleave', function () {
        mask.style.opacity = '0';
        hidePreview();
      });
      cell.addEventListener('click', function () { save(rec, idx); });

      cell.append(t, mask);
      listEl.append(cell);
      i++;
    });
  }

  // ---------- 启动 ----------
  try { hookXHR(); } catch (e) { DBG('XHR 挂钩失败:', e && e.message); }
  try { hookFetch(); } catch (e) { DBG('fetch 挂钩失败:', e && e.message); }
  try { watchAwemeChange(); } catch (e) { DBG('作品检测失败:', e && e.message); }

  if (document.body) {
    try { buildUI(); } catch (e) { DBG('UI 初始化失败:', e && e.message); }
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      try { buildUI(); } catch (e) { DBG('UI 初始化失败:', e && e.message); }
    }, { once: true });
  }

  setInterval(function () {
    try { if (!panelEl) buildUI(); } catch (e) {}
  }, 2000);
  setInterval(function () {
    try { watchAwemeChange(); } catch (e) {}
  }, 800);

  DBG('v' + VERSION + ' 已启动');
})();
