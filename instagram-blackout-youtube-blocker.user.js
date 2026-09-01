// ==UserScript==
// @name         Instagram Blackout (Feed/Explore/Reels) + YouTube Shorts & Comments Blocker
// @namespace    https://tampermonkey.net/
// @version      4.0
// @description  Instantly blacks out Instagram's home feed, Explore grid, and Reels tab on load (no flash of content). Only accounts on your allow-list show. Search results, profile pages, and DMs are untouched. Also blocks all YouTube Shorts and comments, with its own on/off toggle. Join my discord : https://discord.gg/TKT66C7Gu7
// @author       Lvens
// @match        https://www.instagram.com/*
// @match        https://www.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const isIG = location.hostname.includes('instagram.com');
  const isYT = location.hostname.includes('youtube.com');

  /* ===========================================================
     INSTAGRAM
  =========================================================== */
  if (isIG) {
    const LIST_KEY = 'ff_allowlist';
    const ENABLED_KEY = 'ff_enabled';

    let allowList = new Set(GM_getValue(LIST_KEY, []));
    let enabled = GM_getValue(ENABLED_KEY, true);

    function saveList() { GM_setValue(LIST_KEY, [...allowList]); }
    function saveEnabled() { GM_setValue(ENABLED_KEY, enabled); }

    function isBlackoutPage() {
      const p = location.pathname;
      if (p === '/' || p === '') return true;
      if (/^\/explore(\/|$)/.test(p)) return true;
      if (/^\/reels(\/|$)/.test(p)) return true;
      return false;
    }

    // Styles injected immediately (document-start), before any content paints.
    GM_addStyle(`
      html.ff-preblock body::before {
        content: '';
        position: fixed;
        inset: 0;
        background: #000;
        z-index: 2147483000;
      }
      .ff-blocked {
        position: relative !important;
        background: #000 !important;
        border-radius: 8px;
        overflow: hidden;
        min-height: 60px;
      }
      .ff-blocked > *:not(.ff-overlay) {
        visibility: hidden !important;
      }
      .ff-comment-hidden {
        display: none !important;
      }
      .ff-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        color: #aaa;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 12px;
        text-align: center;
        z-index: 999;
        padding: 8px;
      }
      .ff-overlay button {
        background: #262626;
        color: #fff;
        border: 1px solid #444;
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 11px;
        cursor: pointer;
      }
      .ff-overlay button:hover { background: #3a3a3a; }

      #ff-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483001;
        background: #111;
        color: #fff;
        border-radius: 20px;
        padding: 8px 14px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 12px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,.5);
        user-select: none;
        border: 1px solid #333;
      }
      #ff-panel.off { background: #333; }
    `);

    // Cover the page immediately if we're loading straight into a blackout page.
    if (enabled && isBlackoutPage()) {
      document.documentElement.classList.add('ff-preblock');
    }

    function extractUsername(node) {
      const links = node.querySelectorAll('a[href^="/"]');
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
        if (m && !['explore', 'reels', 'direct', 'p', 'reel', 'stories', 'accounts'].includes(m[1])) {
          return m[1].toLowerCase();
        }
      }
      return null;
    }

    function blockNode(node, username) {
      if (node.classList.contains('ff-blocked')) return;
      node.classList.add('ff-blocked');
      const overlay = document.createElement('div');
      overlay.className = 'ff-overlay';
      overlay.innerHTML = `<div>\u{1F6AB} Blocked${username ? ' \u2014 @' + username : ''}</div>`;
      if (username) {
        const btn = document.createElement('button');
        btn.textContent = 'Always show this account';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          allowList.add(username);
          saveList();
          updatePanel();
          unblockNode(node);
        });
        overlay.appendChild(btn);
      }
      node.appendChild(overlay);
    }

    function unblockNode(node) {
      node.classList.remove('ff-blocked');
      const overlay = node.querySelector('.ff-overlay');
      if (overlay) overlay.remove();
    }

    function processNode(node) {
      const username = extractUsername(node);
      if (username && allowList.has(username)) {
        unblockNode(node);
      } else {
        blockNode(node, username);
      }
      node.dataset.ffChecked = '1';
    }

    // Walk up from a <video> to find the container that also holds the
    // account's profile link (this is what actually covers a reel slide).
    function findMediaContainer(video) {
      let el = video;
      for (let i = 0; i < 10 && el; i++) {
        if (el !== video) {
          const links = el.querySelectorAll('a[href^="/"]');
          const hasProfileLink = [...links].some(a => {
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
            return m && !['explore', 'reels', 'direct', 'p', 'reel', 'stories', 'accounts'].includes(m[1]);
          });
          if (hasProfileLink && el.offsetHeight > 150) return el;
        }
        el = el.parentElement;
      }
      return video.parentElement || video;
    }

    function processVideo(video) {
      if (video.dataset.ffMediaChecked) return;
      video.dataset.ffMediaChecked = '1';
      const container = findMediaContainer(video);
      processNode(container);
    }

    function scan() {
      if (!enabled || !isBlackoutPage()) {
        document.querySelectorAll('.ff-blocked').forEach(unblockNode);
      } else {
        document.querySelectorAll('article').forEach(processNode);
        document.querySelectorAll('a[href^="/reel/"], a[href^="/p/"]').forEach(a => {
          const wrap = a.closest('div[role="presentation"]')
            || a.parentElement?.parentElement
            || a.parentElement
            || a;
          processNode(wrap);
        });
        document.querySelectorAll('video').forEach(processVideo);
      }
      hideComments();
    }

    // Comments show up on post pages, the post modal, and permalink pages —
    // not just the feed/explore/reels blackout pages — so this runs on every
    // IG page and is gated only by the same master `enabled` toggle.
    const COMMENT_LIST_SELECTOR = 'ul._a9ym';
    const LOAD_MORE_COMMENTS_SELECTOR = '._abl-';
    const VIEW_REPLIES_SELECTOR = '._aswp';

    function hideComments() {
      if (!enabled) {
        document.querySelectorAll('.ff-comment-hidden').forEach(el => el.classList.remove('ff-comment-hidden'));
        return;
      }
      document.querySelectorAll(COMMENT_LIST_SELECTOR).forEach(el => el.classList.add('ff-comment-hidden'));
      document.querySelectorAll(LOAD_MORE_COMMENTS_SELECTOR).forEach(btn => {
        const li = btn.closest('li') || btn;
        li.classList.add('ff-comment-hidden');
      });
      document.querySelectorAll(VIEW_REPLIES_SELECTOR).forEach(btn => {
        const li = btn.closest('li') || btn;
        li.classList.add('ff-comment-hidden');
      });
    }

    function reprocessAll() {
      document.querySelectorAll('[data-ff-checked]').forEach(n => {
        delete n.dataset.ffChecked;
        unblockNode(n);
      });
      document.querySelectorAll('[data-ff-media-checked]').forEach(n => {
        delete n.dataset.ffMediaChecked;
      });
      scan();
    }

    function revealSoon() {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.documentElement.classList.remove('ff-preblock');
      }));
    }

    let panel, observer;
    let timer;

    function updatePanel() {
      if (!panel) return;
      panel.textContent = enabled
        ? `\u{1F6AB} Blackout: ON (${allowList.size} allowed)`
        : '\u23F8 Blackout: OFF';
      panel.classList.toggle('off', !enabled);
    }

    function whenBodyReady(cb) {
      if (document.body) return cb();
      new MutationObserver((_, obs) => {
        if (document.body) { obs.disconnect(); cb(); }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }

    whenBodyReady(function init() {
      panel = document.createElement('div');
      panel.id = 'ff-panel';
      panel.addEventListener('click', () => {
        enabled = !enabled;
        saveEnabled();
        updatePanel();
        if (enabled && isBlackoutPage()) document.documentElement.classList.add('ff-preblock');
        reprocessAll();
        revealSoon();
      });
      panel.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const name = prompt('Username to always allow (no @):');
        if (name) {
          allowList.add(name.trim().toLowerCase());
          saveList();
          updatePanel();
          reprocessAll();
        }
      });
      document.body.appendChild(panel);
      updatePanel();

      observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(scan, 100);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      scan();
      revealSoon();

      let lastPath = location.pathname;
      setInterval(() => {
        if (location.pathname !== lastPath) {
          lastPath = location.pathname;
          if (enabled && isBlackoutPage()) document.documentElement.classList.add('ff-preblock');
          reprocessAll();
          revealSoon();
        }
      }, 300);
    });
  }

  /* ===========================================================
     YOUTUBE — block all Shorts + all comments, with its own toggle
  =========================================================== */
  if (isYT) {
    const YT_ENABLED_KEY = 'yt_blocker_enabled';
    let ytEnabled = GM_getValue(YT_ENABLED_KEY, true);
    function saveYTEnabled() { GM_setValue(YT_ENABLED_KEY, ytEnabled); }

    GM_addStyle(`
      .yt-shorts-hidden, .yt-comments-hidden {
        display: none !important;
      }

      #yt-blocker-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483001;
        background: #111;
        color: #fff;
        border-radius: 20px;
        padding: 8px 14px;
        font-family: -apple-system, BlinkMacSystemFont, "Roboto", sans-serif;
        font-size: 12px;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,.5);
        user-select: none;
        border: 1px solid #333;
      }
      #yt-blocker-panel.off { background: #333; }
    `);

    function checkRedirect() {
      if (ytEnabled && location.pathname.startsWith('/shorts/')) {
        location.replace('https://www.youtube.com/');
      }
    }
    checkRedirect();
    window.addEventListener('yt-navigate-finish', checkRedirect);

    const SHORTS_SHELF_SELECTORS = [
      'ytd-reel-shelf-renderer',
      'ytd-rich-shelf-renderer[is-shorts]',
      'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
      'ytd-reel-item-renderer',
      'ytd-shorts',
      'ytm-shorts-lockup-view-model',
      'ytd-video-renderer:has(a[href^="/shorts/"])',
      'ytd-grid-video-renderer:has(a[href^="/shorts/"])',
      'ytd-compact-video-renderer:has(a[href^="/shorts/"])',
    ];

    const COMMENT_SELECTORS = [
      'ytd-comments',
      '#comments',
      'ytd-comments-header-renderer',
      'ytd-item-section-renderer#sections ytd-comments',
      // Comments engagement panel used on the watch page and in the Shorts player
      'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]',
      'ytd-engagement-panel-section-list-renderer[target-id*="comment"]',
      // Shorts player's comment button/sheet
      'ytd-reel-video-renderer #comments-button',
      'ytd-shorts #comments-button',
      // Mobile web comment section + button
      'ytm-comments-entry-point-header-renderer',
      'ytm-comment-section-renderer',
      // Comment count under the video (mweb "1.2K Comments" row)
      'ytm-comments-entry-point-teaser-renderer',
      // "X Comments" chip/button row under the player on desktop
      '#comments-button',
    ];

    function hideElement(el, cls) {
      if (el && !el.classList.contains(cls)) {
        el.classList.add(cls);
      }
    }

    function showAll() {
      document.querySelectorAll('.yt-shorts-hidden').forEach(el => el.classList.remove('yt-shorts-hidden'));
      document.querySelectorAll('.yt-comments-hidden').forEach(el => el.classList.remove('yt-comments-hidden'));
    }

    function scanShorts() {
      SHORTS_SHELF_SELECTORS.forEach(sel => {
        try {
          document.querySelectorAll(sel).forEach(el => hideElement(el, 'yt-shorts-hidden'));
        } catch (e) {
          // :has() unsupported fallback — ignore, the anchor-based pass below covers it
        }
      });

      // New (2026) "Shorts" shelf header component — find the header, then
      // walk up to whatever shelf/section wraps it and hide that.
      document.querySelectorAll('yt-section-header-view-model, .ytShelfHeaderLayoutHost').forEach(header => {
        const label = header.querySelector('h2, .ytShelfHeaderLayoutTitle') || header;
        const text = (label.textContent || '').trim();
        if (/^shorts$/i.test(text)) {
          const shelf = header.closest(
            'ytd-rich-shelf-renderer, ytd-shelf-renderer, ytd-rich-section-renderer, ytd-item-section-renderer, grid-shelf-view-model, yt-rich-shelf-renderer'
          ) || header.parentElement?.parentElement || header.parentElement || header;
          hideElement(shelf, 'yt-shorts-hidden');
        }
      });

      document.querySelectorAll('a[href^="/shorts/"]').forEach(a => {
        const tile = a.closest(
          'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-reel-item-renderer'
        );
        hideElement(tile || a, 'yt-shorts-hidden');
      });

      // Sidebar / mini-guide "Shorts" entry
      document.querySelectorAll('ytd-mini-guide-entry-renderer, ytd-guide-entry-renderer').forEach(entry => {
        const title = (entry.getAttribute('title') || entry.innerText || '').trim();
        if (/^shorts$/i.test(title)) hideElement(entry, 'yt-shorts-hidden');
      });

      // Topbar "Shorts" pivot button on some layouts
      document.querySelectorAll('a[title="Shorts"], tp-yt-paper-tab a[href="/shorts"]').forEach(el => {
        hideElement(el.closest('ytd-mini-guide-entry-renderer, tp-yt-paper-tab') || el, 'yt-shorts-hidden');
      });
    }

    function scanComments() {
      COMMENT_SELECTORS.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => hideElement(el, 'yt-comments-hidden'));
      });
    }

    function scanYT() {
      if (!ytEnabled) {
        showAll();
        return;
      }
      scanShorts();
      scanComments();
    }

    let panel;
    function updatePanel() {
      if (!panel) return;
      panel.textContent = ytEnabled
        ? '\u{1F6AB} Shorts+Comments: ON'
        : '\u23F8 Shorts+Comments: OFF';
      panel.classList.toggle('off', !ytEnabled);
    }

    function initPanel() {
      if (document.getElementById('yt-blocker-panel')) return;
      panel = document.createElement('div');
      panel.id = 'yt-blocker-panel';
      panel.addEventListener('click', () => {
        ytEnabled = !ytEnabled;
        saveYTEnabled();
        updatePanel();
        checkRedirect();
        scanYT();
      });
      document.body.appendChild(panel);
      updatePanel();
    }

    let ytTimer;
    function startYTObserver() {
      const target = document.documentElement;
      const ytObserver = new MutationObserver(() => {
        clearTimeout(ytTimer);
        ytTimer = setTimeout(scanYT, 150);
      });
      ytObserver.observe(target, { childList: true, subtree: true });
      scanYT();
    }

    function whenBodyReadyYT(cb) {
      if (document.body) return cb();
      new MutationObserver((_, obs) => {
        if (document.body) { obs.disconnect(); cb(); }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }

    whenBodyReadyYT(() => {
      initPanel();
      startYTObserver();
    });
  }
})();