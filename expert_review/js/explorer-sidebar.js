/**
 * Loaded by explorer.html after the Pathway Explorer's own scripts.
 *
 * The explorer's reaction sidebar renders a fixed schema (environment, a
 * conditions object, agents, mechanism, reasoning) from the normalized model,
 * which drops fields it does not know and defaults the ones it expects. Networks
 * under review do not share one schema -- e.g. the Naive networks have
 * `conditions` as a plain string (rendered one character per row), no
 * `environment` (shown as a made-up "Surface"), and extra `description` /
 * `catalyst` fields that never appear.
 *
 * So after the explorer opens a reaction, we keep its header and validation
 * sections and replace the rest with whatever fields that reaction actually has
 * in the raw network JSON, in file order.
 */
(function () {
  "use strict";

  var SV = window.SynthVis;
  var file = new URLSearchParams(location.search).get("f");
  var rawReactions = new Map();   // reaction id -> raw JSON object

  // Rendered by the explorer's own header section, or structural.
  var SKIP = { id: 1, name: 1, inputs: 1, outputs: 1 };
  // Keep the explorer's headings where they already exist.
  var LABELS = { agents: "Catalysts / Agents", reasoning: "Scientific Reasoning" };
  var KEEP_SECTIONS = { Reaction: 1, Validation: 1 };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function label(key) {
    if (LABELS[key]) return LABELS[key];
    var s = key.replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function isEmpty(v) {
    if (v == null || v === "") return true;
    if (Array.isArray(v)) return v.every(isEmpty);
    if (typeof v === "object") return Object.keys(v).every(function (k) { return isEmpty(v[k]); });
    return false;
  }

  function scalar(v) {
    if (typeof v === "boolean") return v ? "Yes" : "No";
    if (Array.isArray(v)) return v.filter(function (x) { return !isEmpty(x); }).map(scalar).join(", ");
    if (v && typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function section(key, value) {
    var html = '<div class="sidebar-section"><h4>' + esc(label(key)) + "</h4>";
    if (key === "environment" && typeof value === "string") {
      html += '<span class="badge badge-env badge-' + esc(value) + '">' + esc(value) + "</span>";
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.keys(value).forEach(function (k) {
        if (isEmpty(value[k])) return;
        html += '<div class="sidebar-kv"><span class="kv-key">' + esc(k) +
                '</span><span class="kv-val">' + esc(scalar(value[k])) + "</span></div>";
      });
    } else {
      html += '<p style="font-size:11px;">' + esc(scalar(value)) + "</p>";
    }
    return html + "</div>";
  }

  function rewrite(nodeId) {
    var raw = rawReactions.get(nodeId);
    if (!raw) return;   // a molecule, or the network has not loaded yet
    var content = document.getElementById("sidebar-content");

    Array.prototype.slice.call(content.querySelectorAll(":scope > .sidebar-section"))
      .forEach(function (sec) {
        var h = sec.querySelector("h4");
        if (!h || !KEEP_SECTIONS[h.textContent.trim()]) sec.remove();
      });

    var html = "";
    Object.keys(raw).forEach(function (key) {
      if (SKIP[key] || isEmpty(raw[key])) return;
      html += section(key, raw[key]);
    });
    content.insertAdjacentHTML("beforeend", html);
  }

  // The review page asks for one reaction: ?focus=<id> on first load, then
  // postMessage({type: "astra-focus", id}) while the sheet stays loaded. Open
  // its details and centre on it, dimming all but its inputs and outputs.
  var undimWired = false;
  function focus(id, tries) {
    var cy = SV.cy;
    var node = cy && cy.getElementById(id);
    if (!node || node.empty()) {
      // The graph is still loading or laying out.
      if ((tries || 0) < 80) setTimeout(function () { focus(id, (tries || 0) + 1); }, 150);
      return;
    }
    if (!undimWired) {
      undimWired = true;
      cy.on("tap", function (evt) { if (evt.target === cy) cy.elements().removeClass("dimmed"); });
    }
    cy.elements().addClass("dimmed");
    node.closedNeighborhood().removeClass("dimmed");
    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 450 });
    if (SV._onNodeTap) SV._onNodeTap(id);
  }

  window.addEventListener("message", function (ev) {
    if (ev.origin !== location.origin || !ev.data || ev.data.type !== "astra-focus") return;
    focus(String(ev.data.id));
  });

  // main.js sets SV._onNodeTap in its DOMContentLoaded init, which was
  // registered before this listener, so it exists by the time we wrap it.
  document.addEventListener("DOMContentLoaded", function () {
    if (!file) return;
    fetch(file).then(function (r) { return r.json(); }).then(function (data) {
      ((data.network || {}).reactions || []).forEach(function (r) { rawReactions.set(r.id, r); });
    });

    var original = SV._onNodeTap;
    SV._onNodeTap = function (nodeId, evt) {
      if (original) original(nodeId, evt);
      rewrite(nodeId);
    };

    var initial = new URLSearchParams(location.search).get("focus");
    // A beat after the node appears, so the layout has settled before centring.
    if (initial) setTimeout(function () { focus(initial); }, 400);
  });
})();
