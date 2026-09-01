// ==UserScript==
// @name         Instagram Blackout (Feed/Explore/Reels) + YouTube Shorts & Comments Blocker
// @namespace    https://tampermonkey.net/
// @version      6.0
// @description  Instantly blacks out Instagram's home feed, Explore grid, and Reels tab on load (no flash of content). Only accounts on your allow-list show. Search results, profile pages, and DMs are untouched. Also blocks all YouTube Shorts and comments, with its own on/off toggle. A settings panel lets you choose to block everything, comments only, YouTube Shorts only, or Instagram only. Join my discord : https://discord.gg/TKT66C7Gu7
// @author       Lvens
// @match        https://www.instagram.com/*
// @match        https://www.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @run-at       document-start
// ==/UserScript==

// v6.0 — merged from two branches, plus fixes:
// - Kept the whole-article blackout approach (blocks the entire <article>,
//   not just the media element) since it sidesteps the "grabbed the avatar
//   instead of the post" class of bug entirely, and CSS visibility
//   inheritance means it correctly darkens content at any nesting depth.
// - FIX: processVideo() used to run on every <video> on the page, including
//   ones already inside an <article> that the article-level scan had
//   already blacked out — producing a second, nested .ff-blocked box with
//   its own overlay inside the first (visible glitch on video/Reel posts
//   in the feed). It now skips videos already covered by an <article>.
// - FIX: .ff-overlay's z-index was only 999, low enough that some of
//   Instagram's own UI layers (hover controls, play buttons) could still
//   render on top of it. Bumped to the same very-high z-index used
//   elsewhere in this script so the overlay always wins.
// - Restored "Block Reels in DMs" (present in an earlier version of this
//   script, missing here).
// - Comment hiding now also uses a structural fallback (a <ul> whose <li>
//   rows each contain a username link + a <time datetime>) in addition to
//   the known obfuscated class hooks, so it keeps working if Instagram
//   rotates those class names again.

(function () {
  'use strict';

  const isIG = location.hostname.includes('instagram.com');
  const isYT = location.hostname.includes('youtube.com');

  // Simple debounce with a max wait, so continuous mutations (infinite
  // scroll, etc.) can't starve the scan indefinitely.
  function makeDebouncer(fn, wait, maxWait) {
    let timer = null;
    let firstCallAt = null;
    return function debounced() {
      const now = Date.now();
      if (firstCallAt === null) firstCallAt = now;
      clearTimeout(timer);
      if (now - firstCallAt >= maxWait) {
        firstCallAt = null;
        fn();
        return;
      }
      timer = setTimeout(() => {
        firstCallAt = null;
        fn();
      }, wait);
    };
  }

  /* ===========================================================
     SHARED: what-to-block mode
     (Storage is shared by the script across both matched domains,
     so the mode you pick on one site is remembered on the other.)
  =========================================================== */
  const MODE_KEY = 'ff_block_mode'; // 'all' | 'comments' | 'yt_shorts' | 'instagram'
  const IG_DM_REELS_KEY = 'ff_dm_reels_enabled';

  const BLOCK_MODES = [
    { id: 'all', label: 'Block all', hint: 'Feed/Explore/Reels, Shorts, and comments everywhere' },
    { id: 'comments', label: 'Comments only', hint: 'Hide comments on Instagram and YouTube; leave feeds/Shorts alone' },
    { id: 'yt_shorts', label: 'YouTube Shorts only', hint: 'Instagram and YouTube comments stay visible' },
    { id: 'instagram', label: 'Instagram only', hint: 'Feed/Explore/Reels + IG comments; YouTube untouched' },
  ];

  function computeModeFlags(mode) {
    switch (mode) {
      case 'comments':
        return { igFeed: false, igComments: true, ytShorts: false, ytComments: true };
      case 'yt_shorts':
        return { igFeed: false, igComments: false, ytShorts: true, ytComments: false };
      case 'instagram':
        return { igFeed: true, igComments: true, ytShorts: false, ytComments: false };
      case 'all':
      default:
        return { igFeed: true, igComments: true, ytShorts: true, ytComments: true };
    }
  }

  GM_addStyle(`
    #ff-gear, #yt-gear {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #111;
      color: #fff;
      border: 1px solid #333;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 13px;
      box-shadow: 0 2px 8px rgba(0,0,0,.5);
      flex-shrink: 0;
    }
    #global-settings-panel {
      position: fixed;
      bottom: 60px;
      right: 20px;
      z-index: 2147483001;
      background: #111;
      color: #fff;
      border-radius: 12px;
      padding: 12px 14px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
      box-shadow: 0 2px 8px rgba(0,0,0,.5);
      border: 1px solid #333;
      min-width: 230px;
    }
    #global-settings-panel .gs-title {
      font-weight: 600;
      margin-bottom: 8px;
    }
    #global-settings-panel .gs-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 0;
      cursor: pointer;
    }
    #global-settings-panel .gs-row input {
      margin-top: 3px;
      flex-shrink: 0;
    }
    #global-settings-panel .gs-label {
      font-weight: 600;
    }
    #global-settings-panel .gs-hint {
      opacity: .6;
      font-size: 10px;
      margin-top: 1px;
      line-height: 1.35;
    }
    #global-settings-panel .gs-sep {
      height: 1px;
      background: #2a2a2a;
      margin: 7px 0;
    }
    #global-settings-panel .gs-section {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .06em;
      opacity: .5;
      margin: 5px 0 2px;
    }
  `);

  // Generic mode-picker panel, shared by both the Instagram and YouTube
  // gear buttons (only one of which exists on any given page).
  // `showInstagramExtras` adds the IG-only "Block Reels in DMs" toggle.
  function buildSettingsPanel({ currentMode, onChange, showInstagramExtras = false }) {
    const existing = document.getElementById('global-settings-panel');
    if (existing) { existing.remove(); return; }

    const panelEl = document.createElement('div');
    panelEl.id = 'global-settings-panel';

    const title = document.createElement('div');
    title.className = 'gs-title';
    title.textContent = 'What should I block?';
    panelEl.appendChild(title);

    BLOCK_MODES.forEach(({ id, label, hint }) => {
      const row = document.createElement('label');
      row.className = 'gs-row';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'ff-block-mode';
      radio.value = id;
      radio.checked = currentMode === id;
      radio.addEventListener('change', () => {
        if (radio.checked) {
          onChange(id);
          panelEl.remove();
        }
      });

      const textWrap = document.createElement('div');
      const strong = document.createElement('div');
      strong.className = 'gs-label';
      strong.textContent = label;
      const small = document.createElement('div');
      small.className = 'gs-hint';
      small.textContent = hint;
      textWrap.appendChild(strong);
      textWrap.appendChild(small);

      row.appendChild(radio);
      row.appendChild(textWrap);
      panelEl.appendChild(row);
    });

    if (showInstagramExtras) {
      const sep = document.createElement('div');
      sep.className = 'gs-sep';
      panelEl.appendChild(sep);

      const section = document.createElement('div');
      section.className = 'gs-section';
      section.textContent = 'Instagram Direct Messages';
      panelEl.appendChild(section);

      const dmRow = document.createElement('label');
      dmRow.className = 'gs-row';
      const dmToggle = document.createElement('input');
      dmToggle.type = 'checkbox';
      dmToggle.checked = GM_getValue(IG_DM_REELS_KEY, false);
      dmToggle.addEventListener('change', () => GM_setValue(IG_DM_REELS_KEY, dmToggle.checked));
      const dmTextWrap = document.createElement('div');
      const dmStrong = document.createElement('div');
      dmStrong.className = 'gs-label';
      dmStrong.textContent = 'Block Reels in DMs';
      const dmHint = document.createElement('div');
      dmHint.className = 'gs-hint';
      dmHint.textContent = 'Hide Reel media shared inside conversations. Off by default.';
      dmTextWrap.appendChild(dmStrong);
      dmTextWrap.appendChild(dmHint);
      dmRow.appendChild(dmToggle);
      dmRow.appendChild(dmTextWrap);
      panelEl.appendChild(dmRow);
    }

    document.body.appendChild(panelEl);

    setTimeout(() => {
      document.addEventListener('click', function onDocClick(e) {
        if (!panelEl.contains(e.target) && !e.target.closest('#ff-gear, #yt-gear')) {
          panelEl.remove();
          document.removeEventListener('click', onDocClick);
        }
      });
    }, 0);
  }

  /* ===========================================================
     INSTAGRAM
  =========================================================== */
  if (isIG) {
    const LIST_KEY = 'ff_allowlist';
    const ENABLED_KEY = 'ff_enabled';

    let allowList = new Set(GM_getValue(LIST_KEY, []));
    let enabled = GM_getValue(ENABLED_KEY, true);
    let blockMode = GM_getValue(MODE_KEY, 'all');
    let modeFlags = computeModeFlags(blockMode);
    let dmReelsEnabled = GM_getValue(IG_DM_REELS_KEY, false);

    function saveList() { GM_setValue(LIST_KEY, [...allowList]); }
    function saveEnabled() { GM_setValue(ENABLED_KEY, enabled); }
    function feedActive() { return enabled && modeFlags.igFeed; }
    function commentsActive() { return enabled && modeFlags.igComments; }

    function isBlackoutPage() {
      const p = location.pathname;
      if (p === '/' || p === '') return true;
      if (/^\/explore(\/|$)/.test(p)) return true;
      if (/^\/reels(\/|$)/.test(p)) return true;
      return false;
    }

    function isDMPage() {
      return /^\/direct(\/|$)/.test(location.pathname);
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
      .ff-dm-reel-hidden {
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
        /* Very high z-index so this always wins over Instagram's own
           in-post UI layers (hover controls, play buttons, etc.) — a
           low value like 999 could still get covered by those. */
        z-index: 2147482999;
        padding: 8px;
        visibility: visible !important;
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

      #ff-manage-panel {
        position: fixed;
        bottom: 60px;
        right: 20px;
        z-index: 2147483001;
        background: #111;
        color: #fff;
        border-radius: 12px;
        padding: 12px 14px;
        font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 12px;
        box-shadow: 0 2px 8px rgba(0,0,0,.5);
        border: 1px solid #333;
        max-height: 300px;
        overflow-y: auto;
        min-width: 180px;
      }
      .ff-manage-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 4px 0;
        border-bottom: 1px solid #222;
      }
      .ff-manage-row:last-child { border-bottom: none; }
      .ff-manage-row button {
        background: none;
        border: none;
        color: #999;
        cursor: pointer;
        font-size: 12px;
      }
      .ff-manage-row button:hover { color: #f55; }
      #ff-manage-hint {
        opacity: .55;
        margin-top: 6px;
        font-size: 10px;
      }
    `);

    // Cover the page immediately if we're loading straight into a blackout page.
    if (feedActive() && isBlackoutPage()) {
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

    function pauseMediaIn(node) {
      node.querySelectorAll('video').forEach((v) => {
        try {
          if (!v.paused) v.pause();
          v.muted = true;
        } catch (e) { /* ignore */ }
      });
    }

    function blockNode(node, username) {
      if (!node.classList.contains('ff-blocked')) {
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
      // Always re-pause: new video elements can appear inside an
      // already-blocked container (e.g. as reels lazy-load).
      pauseMediaIn(node);
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
      // FIX: feed videos are already inside an <article>, and the
      // article-level scan below already blacks that whole article out.
      // Without this check, this function would ALSO find a smaller
      // container around just the video and block that separately,
      // producing a second nested overlay box inside the first — a
      // visible glitch on video/Reel posts in the feed. Only handle
      // videos that live outside any <article> (Explore grid tiles, the
      // standalone Reels tab), which the article scan can't see.
      if (video.closest('article')) return;
      const container = findMediaContainer(video);
      processNode(container);
    }

    function scan() {
      if (!feedActive() || !isBlackoutPage()) {
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
        // Catch any video that snuck into an already-blocked container.
        document.querySelectorAll('.ff-blocked').forEach(pauseMediaIn);
      }
      hideComments();
      processDMReels();
    }
    const debouncedScan = makeDebouncer(scan, 100, 600);

    // Comments show up on post pages, the post modal, and permalink pages —
    // not just the feed/explore/reels blackout pages — so this runs on every
    // IG page and is gated only by the same master `enabled` toggle.
    const COMMENT_LIST_SELECTOR = 'ul._a9ym';
    const LOAD_MORE_COMMENTS_SELECTOR = '._abl-';
    const VIEW_REPLIES_SELECTOR = '._aswp';

    // Structural fallback: a comment list is a <ul> whose <li> rows each
    // contain a username link plus a <time datetime> timestamp. That
    // pattern survives Instagram rotating its obfuscated class names,
    // unlike the fixed selectors above.
    function looksLikeCommentList(ul) {
      if (!ul || ul.tagName !== 'UL') return false;
      const items = ul.querySelectorAll(':scope > li');
      if (!items.length) return false;
      let hits = 0;
      items.forEach(li => {
        if (li.querySelector('time[datetime]') && li.querySelector('a[href^="/"]')) hits++;
      });
      return hits / items.length >= 0.5;
    }

    function hideComments() {
      if (!commentsActive()) {
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
      document.querySelectorAll('ul').forEach(ul => {
        if (looksLikeCommentList(ul)) ul.classList.add('ff-comment-hidden');
      });
    }

    function processDMReels() {
      if (!dmReelsEnabled || !isDMPage()) {
        document.querySelectorAll('.ff-dm-reel-hidden').forEach(el => el.classList.remove('ff-dm-reel-hidden'));
        return;
      }
      document.querySelectorAll('a[href^="/reel/"], video').forEach(el => {
        const wrap = el.closest('article, div[role="presentation"], div[role="button"]') || el.parentElement || el;
        wrap.classList.add('ff-dm-reel-hidden');
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

    function modeLabel() {
      return BLOCK_MODES.find(m => m.id === blockMode)?.label || 'Block all';
    }

    function updatePanel() {
      if (!panel) return;
      panel.textContent = enabled
        ? `\u{1F6AB} ${modeLabel()} (${allowList.size} allowed)`
        : '\u23F8 Blackout: OFF';
      panel.classList.toggle('off', !enabled);
    }

    function closeManagePanel() {
      const mgr = document.getElementById('ff-manage-panel');
      if (mgr) mgr.remove();
    }

    function showManagePanel() {
      const existing = document.getElementById('ff-manage-panel');
      if (existing) { existing.remove(); return; }

      const mgr = document.createElement('div');
      mgr.id = 'ff-manage-panel';

      const title = document.createElement('div');
      title.style.fontWeight = '600';
      title.style.marginBottom = '6px';
      title.textContent = `Allowed accounts (${allowList.size})`;
      mgr.appendChild(title);

      if (allowList.size === 0) {
        const empty = document.createElement('div');
        empty.style.opacity = '.6';
        empty.textContent = 'None yet.';
        mgr.appendChild(empty);
      } else {
        [...allowList].sort().forEach((name) => {
          const row = document.createElement('div');
          row.className = 'ff-manage-row';
          const label = document.createElement('span');
          label.textContent = `@${name}`;
          const rm = document.createElement('button');
          rm.textContent = '\u2715';
          rm.title = 'Remove';
          rm.addEventListener('click', (e) => {
            e.stopPropagation();
            allowList.delete(name);
            saveList();
            updatePanel();
            reprocessAll();
            showManagePanel(); // refresh contents
          });
          row.appendChild(label);
          row.appendChild(rm);
          mgr.appendChild(row);
        });
      }

      const hint = document.createElement('div');
      hint.id = 'ff-manage-hint';
      hint.textContent = 'Double-click the panel to add someone.';
      mgr.appendChild(hint);

      document.body.appendChild(mgr);

      // Close when clicking elsewhere.
      setTimeout(() => {
        document.addEventListener('click', function onDocClick(e) {
          if (!mgr.contains(e.target) && e.target !== panel) {
            mgr.remove();
            document.removeEventListener('click', onDocClick);
          }
        });
      }, 0);
    }

    function whenBodyReady(cb) {
      if (document.body) return cb();
      new MutationObserver((_, obs) => {
        if (document.body) { obs.disconnect(); cb(); }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }

    // Sync toggle, mode, allow-list, and DM-reels setting instantly across tabs.
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(ENABLED_KEY, (_name, _old, newVal) => {
        enabled = newVal;
        updatePanel();
        if (feedActive() && isBlackoutPage()) document.documentElement.classList.add('ff-preblock');
        reprocessAll();
        revealSoon();
      });
      GM_addValueChangeListener(LIST_KEY, (_name, _old, newVal) => {
        allowList = new Set(newVal);
        updatePanel();
        reprocessAll();
      });
      GM_addValueChangeListener(MODE_KEY, (_name, _old, newVal) => {
        blockMode = newVal;
        modeFlags = computeModeFlags(newVal);
        updatePanel();
        if (feedActive() && isBlackoutPage()) document.documentElement.classList.add('ff-preblock');
        reprocessAll();
        revealSoon();
      });
      GM_addValueChangeListener(IG_DM_REELS_KEY, (_name, _old, newVal) => {
        dmReelsEnabled = !!newVal;
        processDMReels();
      });
    }

    whenBodyReady(function init() {
      const controls = document.createElement('div');
      controls.id = 'ff-controls';
      controls.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483001;display:flex;gap:8px;align-items:center;';

      panel = document.createElement('div');
      panel.id = 'ff-panel';
      panel.title = 'Click: toggle \u00b7 Double-click: add account \u00b7 Right-click: manage list';
      panel.addEventListener('click', () => {
        enabled = !enabled;
        saveEnabled();
        updatePanel();
        if (feedActive() && isBlackoutPage()) document.documentElement.classList.add('ff-preblock');
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
      panel.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showManagePanel();
      });

      const gear = document.createElement('div');
      gear.id = 'ff-gear';
      gear.textContent = '\u2699';
      gear.title = 'Choose what to block';
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        buildSettingsPanel({
          currentMode: blockMode,
          showInstagramExtras: true,
          onChange: (newMode) => {
            blockMode = newMode;
            GM_setValue(MODE_KEY, newMode);
            modeFlags = computeModeFlags(newMode);
            updatePanel();
            if (feedActive() && isBlackoutPage()) document.documentElement.classList.add('ff-preblock');
            reprocessAll();
            revealSoon();
          },
        });
      });

      controls.appendChild(panel);
      controls.appendChild(gear);
      document.body.appendChild(controls);
      updatePanel();

      observer = new MutationObserver(debouncedScan);
      observer.observe(document.body, { childList: true, subtree: true });

      scan();
      revealSoon();

      // Instant SPA-navigation detection via history hooks, instead of
      // relying solely on a poll interval.
      let lastPath = location.pathname;
      function onLocationChange() {
        if (location.pathname === lastPath) return;
        lastPath = location.pathname;
        closeManagePanel();
        if (feedActive() && isBlackoutPage()) document.documentElement.classList.add('ff-preblock');
        reprocessAll();
        revealSoon();
      }
      const _pushState = history.pushState;
      const _replaceState = history.replaceState;
      history.pushState = function (...args) {
        const ret = _pushState.apply(this, args);
        onLocationChange();
        return ret;
      };
      history.replaceState = function (...args) {
        const ret = _replaceState.apply(this, args);
        onLocationChange();
        return ret;
      };
      window.addEventListener('popstate', onLocationChange);
      // Low-frequency safety net in case something navigates without
      // going through history.pushState/replaceState.
      setInterval(onLocationChange, 1000);
    });
  }

  /* ===========================================================
     YOUTUBE — block all Shorts + all comments, with its own toggle
  =========================================================== */
  if (isYT) {
    const YT_ENABLED_KEY = 'yt_blocker_enabled';
    let ytEnabled = GM_getValue(YT_ENABLED_KEY, true);
    let blockMode = GM_getValue(MODE_KEY, 'all');
    let modeFlags = computeModeFlags(blockMode);
    function saveYTEnabled() { GM_setValue(YT_ENABLED_KEY, ytEnabled); }
    function shortsActive() { return ytEnabled && modeFlags.ytShorts; }
    function ytCommentsActive() { return ytEnabled && modeFlags.ytComments; }

    GM_addStyle(`
      .yt-shorts-hidden, .yt-comments-hidden {
        display: none !important;
      }

      #yt-blocker-panel {
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
      if (shortsActive() && location.pathname.startsWith('/shorts/')) {
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

    function showShorts() {
      document.querySelectorAll('.yt-shorts-hidden').forEach(el => el.classList.remove('yt-shorts-hidden'));
    }
    function showComments() {
      document.querySelectorAll('.yt-comments-hidden').forEach(el => el.classList.remove('yt-comments-hidden'));
    }
    function showAll() {
      showShorts();
      showComments();
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
      if (shortsActive()) scanShorts(); else showShorts();
      if (ytCommentsActive()) scanComments(); else showComments();
    }
    const debouncedScanYT = makeDebouncer(scanYT, 150, 800);

    let panel;
    function modeLabel() {
      return BLOCK_MODES.find(m => m.id === blockMode)?.label || 'Block all';
    }
    function updatePanel() {
      if (!panel) return;
      panel.textContent = ytEnabled
        ? `\u{1F6AB} ${modeLabel()}`
        : '\u23F8 Shorts+Comments: OFF';
      panel.classList.toggle('off', !ytEnabled);
    }

    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(YT_ENABLED_KEY, (_name, _old, newVal) => {
        ytEnabled = newVal;
        updatePanel();
        checkRedirect();
        scanYT();
      });
      GM_addValueChangeListener(MODE_KEY, (_name, _old, newVal) => {
        blockMode = newVal;
        modeFlags = computeModeFlags(newVal);
        updatePanel();
        checkRedirect();
        scanYT();
      });
    }

    function initPanel() {
      if (document.getElementById('yt-blocker-panel')) return;

      const controls = document.createElement('div');
      controls.id = 'yt-controls';
      controls.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483001;display:flex;gap:8px;align-items:center;';

      panel = document.createElement('div');
      panel.id = 'yt-blocker-panel';
      panel.title = 'Click: toggle \u00b7 Gear: choose what to block';
      panel.addEventListener('click', () => {
        ytEnabled = !ytEnabled;
        saveYTEnabled();
        updatePanel();
        checkRedirect();
        scanYT();
      });

      const gear = document.createElement('div');
      gear.id = 'yt-gear';
      gear.textContent = '\u2699';
      gear.title = 'Choose what to block';
      gear.addEventListener('click', (e) => {
        e.stopPropagation();
        buildSettingsPanel({
          currentMode: blockMode,
          onChange: (newMode) => {
            blockMode = newMode;
            GM_setValue(MODE_KEY, newMode);
            modeFlags = computeModeFlags(newMode);
            updatePanel();
            checkRedirect();
            scanYT();
          },
        });
      });

      controls.appendChild(panel);
      controls.appendChild(gear);
      document.body.appendChild(controls);
      updatePanel();
    }

    function startYTObserver() {
      const target = document.documentElement;
      const ytObserver = new MutationObserver(debouncedScanYT);
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