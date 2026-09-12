/**
 * The bar's two live facts: which issuer, and which network.
 *
 * Shared by every page, for the same reason bar.css is: six copies of one
 * fetch is six chances for one of them to fall behind.
 *
 * BEST-EFFORT IN EVERY SENSE. The bar is served complete and useful without
 * this file running at all — the two spans start hidden and simply stay that
 * way. Nothing on any page depends on it, so every failure path here is a
 * silent return rather than an error.
 *
 * A page that has no bar (none yet, but there will be one) is also fine: every
 * lookup is null-guarded.
 */
(function () {
  "use strict";


  function paint(h) {
    if (!h || typeof h !== "object") return;


    var netEl = document.getElementById("nav-net");
    var netT = document.getElementById("nav-net-t");
    if (netEl && netT && typeof h.network === "string" && h.network) {
      netT.textContent = h.network.charAt(0).toUpperCase() + h.network.slice(1);
      netEl.setAttribute("data-net", h.network);
      netEl.hidden = false;
    }
  }

  try {
    fetch("/health", { headers: { accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(paint)
      .catch(function () { /* the bar works without them */ });
  } catch (e) {
    /* no fetch, no bar facts, no problem */
  }
})();
