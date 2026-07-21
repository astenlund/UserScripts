// ==UserScript==
// @name         Trakt Web: kill swimlane vertical scrollbars
// @namespace    fork-scripts
// @version      1.0
// @description  Removes the spurious vertical scrollbars on each horizontal row/swimlane in the new Trakt Web design and reserves a bottom gutter so the classic (Windows) horizontal scrollbar no longer covers lane content.
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

  const FIXED_ATTR = 'data-vsb-fixed';

  function isHorizontalScroller(el, cs) {
    const ox = cs.overflowX;
    return (ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 1;
  }

  // Height of the rendered horizontal scrollbar (0 with overlay scrollbars).
  function hScrollbarHeight(el, cs) {
    return el.offsetHeight - el.clientHeight - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth);
  }

  // Measurements for an artifact lane, or null if el is not one. The
  // artifact's signature: the horizontal scrollbar consumes part of the
  // lane's height, so vertical overflow is at most the scrollbar's own
  // height. Real content overflow always exceeds it. (+1 for px rounding)
  function measureArtifactLane(el) {
    if (el.hasAttribute(FIXED_ATTR)) return null;

    const cs = getComputedStyle(el);
    const oy = cs.overflowY;
    if (oy !== 'auto' && oy !== 'scroll') return null;
    if (!isHorizontalScroller(el, cs)) return null;

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

  // A fixed element that has since gained REAL vertical content (or whose
  // node was reused for a different component) and needs scrollability back.
  // The +4 hysteresis margin keeps px rounding jitter from flapping fix/unfix.
  function isStaleFix(el) {
    const vOverflow = el.scrollHeight - el.clientHeight;
    return vOverflow > hScrollbarHeight(el, getComputedStyle(el)) + 4;
  }

  // Hide the phantom vertical scrollbar and reserve a bottom gutter equal to
  // the horizontal scrollbar's height, so the scrollbar rides in the gutter
  // instead of covering the lane's bottom row of content.
  function fix({ el, gutterPx }) {
    el.style.setProperty('overflow-y', 'hidden', 'important');
    el.style.setProperty('padding-bottom', gutterPx + 'px', 'important');
    el.setAttribute(FIXED_ATTR, '1');
  }

  function unfix(el) {
    el.style.removeProperty('overflow-y');
    el.style.removeProperty('padding-bottom');
    el.removeAttribute(FIXED_ATTR);
  }

  function staleFixes() {
    return [...document.querySelectorAll(`[${FIXED_ATTR}]`)].filter(isStaleFix);
  }

  // Two-phase scan: all layout reads happen before any style writes, so a
  // scan costs one reflow instead of one per fixed lane. The tag list limits
  // candidates to element types that can host swimlanes; measureArtifactLane's
  // cheap overflow-y check filters out the rest before any layout reads.
  function scan() {
    const stale = staleFixes();
    const lanes = [...document.querySelectorAll('div, ul, section, main')]
      .map(measureArtifactLane)
      .filter(Boolean);
    stale.forEach(unfix);
    lanes.forEach(fix);
    // The gutter cannot work on a border-box element with a fixed height,
    // where padding shrinks the content area instead of growing the box and
    // would flap the un-fix guard; verify it took effect and drop it if not
    // (the scrollbar stays hidden either way).
    lanes.forEach(({ el, expectedClientH }) => {
      if (el.clientHeight < expectedClientH) {
        el.style.removeProperty('padding-bottom');
      }
    });
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
  // cheap insurance).
  setInterval(() => staleFixes().forEach(unfix), 5000);
})();
