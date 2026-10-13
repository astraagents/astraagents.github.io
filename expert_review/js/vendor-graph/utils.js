/**
 * utils.js — Pure utility functions shared across all modules.
 * Adds to window.SynthVis namespace.
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * Create an SVG element with attributes.
   */
  SV.svgEl = function(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function(k) {
        el.setAttribute(k, attrs[k]);
      });
    }
    return el;
  };

  /**
   * Split a chemical formula into parts for SVG rendering.
   * Returns array of {text, isSub} objects.
   * "H2O" → [{text:"H",isSub:false},{text:"2",isSub:true},{text:"O",isSub:false}]
   */
  SV.formulaParts = function(formula) {
    var parts = [];
    var regex = /([A-Za-z()]+)|(\d+)/g;
    var m;
    while ((m = regex.exec(formula)) !== null) {
      if (m[1]) parts.push({ text: m[1], isSub: false });
      if (m[2]) parts.push({ text: m[2], isSub: true });
    }
    return parts;
  };

  /**
   * Append <tspan> children to an SVG <text> element for formula subscripts.
   */
  SV.appendFormulaTspans = function(textEl, formula) {
    var parts = SV.formulaParts(formula);
    parts.forEach(function(part) {
      var tspan = SV.svgEl('tspan');
      tspan.textContent = part.text;
      if (part.isSub) {
        tspan.setAttribute('baseline-shift', 'sub');
        tspan.setAttribute('font-size', '0.75em');
      }
      textEl.appendChild(tspan);
    });
  };

  /**
   * Truncate a string to maxLen characters, adding ellipsis.
   */
  SV.truncate = function(str, maxLen) {
    if (!str || str.length <= maxLen) return str || '';
    return str.slice(0, maxLen - 1) + '\u2026';
  };

  /**
   * Clamp a value between min and max.
   */
  SV.clamp = function(val, min, max) {
    return Math.max(min, Math.min(max, val));
  };

  /**
   * Convert screen coordinates to SVG user-space coordinates.
   */
  SV.screenToSVG = function(svgEl, clientX, clientY) {
    var pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    var ctm = svgEl.getScreenCTM();
    if (!ctm) return { x: clientX, y: clientY };
    return pt.matrixTransform(ctm.inverse());
  };

  /**
   * Debounce a function call.
   */
  SV.debounce = function(fn, delay) {
    var timer;
    return function() {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function() { fn.apply(ctx, args); }, delay);
    };
  };

  /**
   * Color lookup tables for inline SVG attributes (PDF-safe).
   */
  SV.ROLE_COLORS = {
    starting:          { fill: '#34495e', stroke: '#2c3e50' },
    intermediate:      { fill: '#3498db', stroke: '#2980b9' },
    hub_intermediate:  { fill: '#3498db', stroke: '#2980b9' },
    target:            { fill: '#e74c3c', stroke: '#c0392b' }
  };

  SV.ENV_COLORS = {
    Hydrothermal: { fill: '#c692dd', stroke: '#a86bc2' },
    Surface:      { fill: '#ce9576', stroke: '#b07a5e' },
    Biochemical:  { fill: '#1abc9c', stroke: '#16a085' }
  };

  SV.BAND_COLORS = {
    Hydrothermal: { bg: 'rgba(196,149,106,0.12)', border: 'rgba(196,149,106,0.35)', label: '#8b6914' },
    Surface:      { bg: 'rgba(90,158,111,0.10)',   border: 'rgba(90,158,111,0.30)',  label: '#2d6a3e' },
    Biochemical:  { bg: 'rgba(139,92,246,0.08)',   border: 'rgba(139,92,246,0.25)',  label: '#5b21b6' }
  };

  /**
   * Score color: green if >= 0.5, red if < 0.5, gray if null.
   */
  SV.scoreColor = function(score) {
    if (score == null) return '#888';
    return score >= 0.5 ? '#16a34a' : '#dc2626';
  };

})();
