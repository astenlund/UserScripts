// ==UserScript==
// @name         AskGolfNut Sidebar Fix
// @namespace    fork-scripts
// @version      0.1
// @description  Re-enables sidebar buttons after refresh when logged in and fixes login/register toggle issues
// @author       Andreas Stenlund <a.stenlund@gmail.com>
// @match        https://askgolfnut.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://github.com/astenlund/UserScripts/raw/master/askgolfnut_sidebar_fix.user.js
// @updateURL    https://github.com/astenlund/UserScripts/raw/master/askgolfnut_sidebar_fix.user.js
// ==/UserScript==

(function () {
  "use strict";

  // Debug mode - set to true for verbose logging
  const DEBUG = false;

  // Logging utility
  const log = (msg, ...args) => {
    if (DEBUG || args[0] === 'error') {
      console.log(`[AGN-Fixer] ${msg}`, ...args.slice(args[0] === 'error' ? 1 : 0));
    }
  };

  const targetButtonIds = [
    "ironOverlayBtn","driverOverlayBtn",
    "advancedDataBtn","DriverDataBtn","radarBtn",
    "selfFitBtn","driverFitBtn","gridBtn","trjBtn","impactPositionBtn",
  ];

  const ATTRS_TO_WATCH = ["disabled","class","style"];
  let pendingFix = false;

  // Store observers for cleanup
  const observers = {
    attribute: null,
    tree: null,
    loginRegister: []
  };

  function injectStyles() {
    if (document.getElementById("agn-fixer-styles")) return;
    log("Injecting AGN-Fixer styles");
    const css = `
      body.agn-logged-out #registerButton { display: none !important; }
      body.agn-logged-out #loginButton { display: block !important; }
      body.agn-logged-in #loginButton { display: none !important; }
      body.agn-logged-in #sidebar .btn[data-agn-enabled="1"] { pointer-events: auto !important; opacity: 1 !important; }
    `;
    const style = document.createElement("style");
    style.id = "agn-fixer-styles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function setBodyState(state) {
    const b = document.body;
    if (!b) return;
    b.classList.toggle("agn-logged-in", state === "in");
    b.classList.toggle("agn-logged-out", state === "out");
  }

  const getSidebar = () => document.querySelector("#sidebar");
  const isLoggedIn = (sidebar) => {
    const logout = sidebar?.querySelector("#logoutButton");
    return !!(logout && logout.style.display !== "none");
  };

  function enableBtn(btn) {
    if (!btn) return;
    btn.removeAttribute("disabled");

    if (btn.id === "impactPositionBtn") {
      btn.className = "btn btn-sm btn-warning";
    } else {
      // ensure bronze/silver/gold buttons always get primary style
      btn.classList.remove("btn-secondary","btn-warning");
      btn.classList.add("btn","btn-sm","btn-primary");
    }

    if (!btn.getAttribute("type")) btn.setAttribute("type","button");
    btn.style.pointerEvents = "auto";
    btn.style.opacity = "";
    btn.style.display = "block";
    btn.dataset.agnEnabled = "1";
  }

  function applyLoggedInFixes(sidebar) {
    log("Applying logged-in fixes");
    setBodyState("in");
    for (const id of targetButtonIds) enableBtn(sidebar.querySelector(`#${CSS.escape(id)}`));
    const manage = sidebar.querySelector("#manageAccountBtn");
    if (manage) manage.style.display = "block";
    const logout = sidebar.querySelector("#logoutButton");
    if (logout) {
      logout.removeAttribute("disabled");
      if (!logout.getAttribute("type")) logout.setAttribute("type","button");
    }
  }

  function applyLoggedOutFixes(sidebar) {
    log("Applying logged-out fixes");
    setBodyState("out");
    const registerBtn = sidebar.querySelector("#registerButton");
    const loginBtn = sidebar.querySelector("#loginButton");
    if (registerBtn) registerBtn.style.display = "none";
    if (loginBtn) loginBtn.style.display = "block";
  }

  function scheduleFix() {
    if (pendingFix) return;
    pendingFix = true;
    log("Scheduling fix");
    setTimeout(() => {
      const sidebar = getSidebar();
      if (!sidebar) { pendingFix = false; return; }
      const loggedIn = isLoggedIn(sidebar);
      log(`User state: ${loggedIn ? 'logged in' : 'logged out'}`);
      if (loggedIn) applyLoggedInFixes(sidebar);
      else applyLoggedOutFixes(sidebar);
      pendingFix = false;
    }, 0);
  }

  function observeConflicts() {
    const sidebar = getSidebar();
    if (!sidebar) return;

    // Clean up existing attribute observer
    if (observers.attribute) {
      log("Disconnecting existing attribute observer");
      observers.attribute.disconnect();
    }

    const buttons = targetButtonIds.map(id => sidebar.querySelector(`#${CSS.escape(id)}`)).filter(Boolean);
    const attrObserver = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === "attributes" && ATTRS_TO_WATCH.includes(m.attributeName)) {
          log(`Attribute changed on button: ${m.target.id}, attr: ${m.attributeName}`);
          scheduleFix();
          break;
        }
      }
    });

    observers.attribute = attrObserver;
    for (const b of buttons) attrObserver.observe(b, { attributes: true, attributeFilter: ATTRS_TO_WATCH });

    // Clean up existing tree observer if needed
    if (observers.tree) {
      log("Disconnecting existing tree observer");
      observers.tree.disconnect();
    }

    const treeObserver = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n instanceof HTMLElement && (n.id === "sidebar" || n.querySelector?.("#sidebar"))) {
            log("Sidebar replaced or added, re-observing");
            scheduleFix();
            observeConflicts();
            return;
          }
        }
      }
    });

    observers.tree = treeObserver;
    treeObserver.observe(document.body, { childList: true, subtree: true });
  }

  // --- override site evaluateLoginControls to stop flip-flopping ---
  function overrideEvaluateLoginControls() {
    if (typeof window.evaluateLoginControls !== "function") return;
    log("Overriding site's evaluateLoginControls function");
    const original = window.evaluateLoginControls;
    window.evaluateLoginControls = function agnEvaluateLoginControls() {
      try {
        const sidebar = getSidebar();
        if (sidebar && isLoggedIn(sidebar)) {
          return original.apply(this, arguments);
        }
        const loginBtn = document.querySelector("#loginButton");
        const registerBtn = document.querySelector("#registerButton");
        if (loginBtn) { loginBtn.style.display = "block"; loginBtn.disabled = false; }
        if (registerBtn) { registerBtn.style.display = "none"; }
      } catch (e) {
        log("Error in evaluateLoginControls override:", "error", e);
      }
    };
  }

  function guardLoginRegisterStyles() {
    const loginBtn = document.querySelector("#loginButton");
    const registerBtn = document.querySelector("#registerButton");
    if (!loginBtn || !registerBtn) return;

    // Clean up existing login/register observers
    observers.loginRegister.forEach(obs => obs.disconnect());
    observers.loginRegister = [];

    log("Setting up login/register button guards");
    const mo = new MutationObserver(() => {
      const sidebar = getSidebar();
      if (sidebar && isLoggedIn(sidebar)) return;
      log("Login/register button mutation detected, reapplying fixes");
      loginBtn.style.display = "block";
      loginBtn.disabled = false;
      registerBtn.style.display = "none";
    });

    mo.observe(loginBtn, { attributes: true, attributeFilter: ["style","class","disabled"] });
    mo.observe(registerBtn, { attributes: true, attributeFilter: ["style","class","disabled"] });
    observers.loginRegister.push(mo);
  }

  function boot() {
    log("AGN-Fixer initializing");
    injectStyles();
    overrideEvaluateLoginControls();
    const sidebar = getSidebar();
    if (!sidebar) {
      log("Sidebar not found during boot");
      return;
    }
    scheduleFix();
    setTimeout(scheduleFix, 50);
    setTimeout(scheduleFix, 300);
    setTimeout(scheduleFix, 1200);
    observeConflicts();
    guardLoginRegisterStyles();
    log("AGN-Fixer initialization complete");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
