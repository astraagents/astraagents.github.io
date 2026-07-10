/**
 * export.js — SVG export using cytoscape-svg extension.
 *
 * Produces a vector-editable SVG file from the current graph.
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};

  /**
   * Export the current graph as SVG.
   */
  SV.exportPDF = function(graph, targetMolecule) {
    if (!SV.cy) return;

    var filename = generateFilename(targetMolecule);

    if (typeof SV.cy.svg !== 'function') {
      console.error('cytoscape-svg extension not loaded');
      // Fallback to PNG download
      var pngData = SV.cy.png({ output: 'base64uri', bg: '#ffffff', scale: 2, full: true });
      downloadDataUri(pngData, filename + '.png');
      return;
    }

    var svgContent = SV.cy.svg({ scale: 1, full: true, bg: '#ffffff' });

    // Read mm dimensions from the canvas size inputs as a fallback,
    // in case the user typed values without firing a change event.
    var wInput = document.getElementById('canvas-width-mm');
    var hInput = document.getElementById('canvas-height-mm');
    var wMm = SV._canvasLimitW || (wInput && parseFloat(wInput.value)) || null;
    var hMm = SV._canvasLimitH || (hInput && parseFloat(hInput.value)) || null;

    // Apply physical mm size for export if a canvas limit is set.
    // Does NOT overwrite the viewBox — relies on preserveAspectRatio
    // to letterbox the true rendered content inside the mm box.
    if (wMm && hMm) {
      svgContent = applyCanvasLimit(svgContent, wMm, hMm);
    }

    var blob = new Blob([svgContent], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    downloadDataUri(url, filename + '.svg');
    URL.revokeObjectURL(url);
  };

  /**
   * Apply canvas mm limit to SVG dimensions. Leaves the viewBox untouched
   * and relies on preserveAspectRatio to letterbox content inside the box.
   */
  function applyCanvasLimit(svgStr, wMm, hMm) {
    // cytoscape-svg does not always emit a viewBox. If missing, synthesize
    // one from the existing px width/height so the content scales into the
    // mm box correctly.
    if (!/viewBox="/.test(svgStr)) {
      var wPxMatch = svgStr.match(/<svg[^>]*\swidth="([^"]+)"/);
      var hPxMatch = svgStr.match(/<svg[^>]*\sheight="([^"]+)"/);
      if (wPxMatch && hPxMatch) {
        var wPx = parseFloat(wPxMatch[1]);
        var hPx = parseFloat(hPxMatch[1]);
        if (wPx && hPx) {
          svgStr = svgStr.replace('<svg ', '<svg viewBox="0 0 ' + wPx + ' ' + hPx + '" ');
        }
      }
    }

    svgStr = svgStr.replace(/width="[^"]*"/, 'width="' + wMm.toFixed(3) + 'mm"');
    svgStr = svgStr.replace(/height="[^"]*"/, 'height="' + hMm.toFixed(3) + 'mm"');

    // Ensure preserveAspectRatio is set on the root svg.
    if (/preserveAspectRatio="/.test(svgStr)) {
      svgStr = svgStr.replace(/preserveAspectRatio="[^"]*"/, 'preserveAspectRatio="xMidYMid meet"');
    } else {
      svgStr = svgStr.replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" ');
    }

    return svgStr;
  }

  function downloadDataUri(uri, filename) {
    var a = document.createElement('a');
    a.href = uri;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function generateFilename(targetMolecule) {
    var safe = (targetMolecule || 'synthesis').replace(/[^a-zA-Z0-9_-]/g, '_');
    var date = new Date().toISOString().slice(0, 10);
    return 'synthesis_network_' + safe + '_' + date;
  }

})();
