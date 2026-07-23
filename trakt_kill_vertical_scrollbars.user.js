// ==UserScript==
// @name         Trakt Web: kill swimlane vertical scrollbars
// @namespace    fork-scripts
// @version      1.1
// @description  Removes spurious scrollbars on horizontal rows/swimlanes in the new Trakt Web design: hides the phantom horizontal scrollbar on exactly-full lanes (card widths derive from 100dvw, which includes the classic Windows scrollbar width) and reserves a bottom gutter on truly scrollable lanes so the horizontal scrollbar no longer covers lane content.
// @author       Andreas Stenlund <a.stenlund@gmail.com>
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/trakt_kill_vertical_scrollbars.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/trakt_kill_vertical_scrollbars.user.js
// @match        https://app.trakt.tv/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // The SPA's re-renders strip unknown attributes from lane nodes (observed
  // live) but leave inline styles alone, so fixes are identified by their own
  // inline !important styles rather than by marker attributes. The app never
  // uses !important on inline overflow styles, so the priority is a reliable
  // signature. Reading el.style parses only the style attribute: no layout.
  function isVFixed(el) {
    return el.style.getPropertyPriority('overflow-y') === 'important';
  }

  function isXFixed(el) {
    return el.style.getPropertyPriority('overflow-x') === 'important';
  }

  function fixedEls(isFixed) {
    return [...document.querySelectorAll('[style]')].filter(isFixed);
  }

  // Width of the page's classic vertical scrollbar (0 with overlay scrollbars
  // or when the page does not scroll).
  function pageScrollbarWidth() {
    return window.innerWidth - document.documentElement.clientWidth;
  }

  function isHorizontalScroller(el, cs) {
    const ox = cs.overflowX;
    return (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1;
  }

  // Height of the rendered horizontal scrollbar (0 with overlay scrollbars).
  function hScrollbarHeight(el, cs) {
    return el.offsetHeight - el.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
  }

  // Trakt sizes lane cards with CSS formulas based on 100dvw, which includes
  // the page's classic vertical scrollbar width, so an exactly-full lane
  // overflows horizontally by a few px (scrollbar width minus the formula's
  // one-gap slack) with no real content to scroll into view. The signature:
  // horizontal overflow no larger than the page scrollbar width. (+1 for px
  // rounding) Assumes the caller's isHorizontalScroller gate supplies the
  // lower bound; unguarded, zero overflow would classify as phantom.
  function isPhantomOverflow(el, sbW) {
    return sbW > 0 && el.scrollWidth - el.clientWidth <= sbW + 1;
  }

  // Measurements for an artifact lane, or null if el is not one. The
  // artifact's signature: the horizontal scrollbar consumes part of the
  // lane's height, so vertical overflow is at most the scrollbar's own
  // height. Real content overflow always exceeds it. (+1 for px rounding)
  function measureArtifactLane(el, cs) {
    const oy = cs.overflowY;
    if (oy !== 'auto' && oy !== 'scroll') return null;

    const sbH = hScrollbarHeight(el, cs);
    if (sbH <= 0) return null;

    const vOverflow = el.scrollHeight - el.clientHeight;
    if (!(vOverflow > 0 && vOverflow <= sbH + 1)) return null;

    return {
      el,
      gutterPx: parseFloat(cs.paddingBottom) + sbH,
      expectedClientH: el.clientHeight + sbH - 2,
    };
  }

  // A fixed element that has since gained REAL overflow (or whose node was
  // reused for a different component) and needs scrollability back. The +4
  // hysteresis margin keeps px rounding jitter from flapping fix/unfix.
  function isStaleVFix(el) {
    const vOverflow = el.scrollHeight - el.clientHeight;
    return vOverflow > hScrollbarHeight(el, getComputedStyle(el)) + 4;
  }

  function isStaleXFix(el, sbW) {
    return el.scrollWidth - el.clientWidth > sbW + 4;
  }

  // Hide the phantom vertical scrollbar and reserve a bottom gutter equal to
  // the horizontal scrollbar's height, so the scrollbar rides in the gutter
  // instead of covering the lane's bottom row of content.
  function fixV({ el, gutterPx }) {
    el.style.setProperty('overflow-y', 'hidden', 'important');
    el.style.setProperty('padding-bottom', gutterPx + 'px', 'important');
  }

  function unfixV(el) {
    el.style.removeProperty('overflow-y');
    el.style.removeProperty('padding-bottom');
  }

  // Hide the phantom horizontal scrollbar outright. With no horizontal
  // scrollbar consuming lane height, the vertical artifact disappears too,
  // so any vertical fix (and its gutter) on the same node is dropped.
  function fixX(el) {
    unfixV(el);
    el.style.setProperty('overflow-x', 'hidden', 'important');
  }

  function unfixX(el) {
    el.style.removeProperty('overflow-x');
  }

  function staleVFixes() {
    return fixedEls(isVFixed).filter(isStaleVFix);
  }

  function staleXFixes(sbW) {
    return fixedEls(isXFixed).filter((el) => isStaleXFix(el, sbW));
  }

  // Two-phase scan: all layout reads happen before any style writes, so a
  // scan costs one reflow instead of one per fixed lane. The tag list limits
  // candidates to element types that can host swimlanes; the cheap overflow
  // style checks filter out the rest before any layout reads. Phantom
  // detection supersedes the artifact-lane fix: a phantom lane also shows the
  // vertical artifact, but hiding its horizontal scrollbar cures both.
  function scan() {
    const sbW = pageScrollbarWidth();
    const staleV = staleVFixes();
    const staleX = staleXFixes(sbW);
    const phantoms = [];
    const lanes = [];
    for (const el of document.querySelectorAll('div, ul, section, main')) {
      if (isXFixed(el)) continue;
      const cs = getComputedStyle(el);
      if (!isHorizontalScroller(el, cs)) continue;
      if (isPhantomOverflow(el, sbW)) {
        phantoms.push(el);
        continue;
      }
      if (isVFixed(el)) continue;
      const lane = measureArtifactLane(el, cs);
      if (lane) lanes.push(lane);
    }
    staleV.forEach(unfixV);
    staleX.forEach(unfixX);
    phantoms.forEach(fixX);
    lanes.forEach(fixV);
    // The gutter cannot work on a border-box element with a fixed height,
    // where padding shrinks the content area instead of growing the box and
    // would flap the un-fix guard; verify it took effect and drop it if not
    // (the scrollbar stays hidden either way).
    lanes.forEach(({ el, expectedClientH }) => {
      if (el.clientHeight < expectedClientH) {
        el.style.removeProperty('padding-bottom');
      }
    });
    // An X-unfix re-exposes the horizontal scrollbar and with it the vertical
    // artifact, but the read phase already skipped the element as X-fixed and
    // style writes fire no observed mutation, so follow up with another scan
    // to apply the fix the lane now needs. (A V-unfix restores the natural
    // state and needs none.)
    if (staleX.length > 0) {
      queueScan();
    }
  }

  let scanQueued = false;
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scan();
    });
  }

  // Initial pass + re-run as the SPA lazily renders rows.
  queueScan();

  const mo = new MutationObserver(queueScan);
  mo.observe(document.body, { childList: true, subtree: true });

  // Layout changes (window resize, zoom) can re-introduce the artifact
  // on elements not yet fixed.
  window.addEventListener('resize', queueScan, { passive: true });

  // Backstop for layout changes that fire no observed event (unlikely, but
  // cheap insurance). An X-unfix needs a follow-up scan, same as in scan().
  setInterval(() => {
    staleVFixes().forEach(unfixV);
    const staleX = staleXFixes(pageScrollbarWidth());
    staleX.forEach(unfixX);
    if (staleX.length > 0) {
      queueScan();
    }
  }, 5000);
})();
