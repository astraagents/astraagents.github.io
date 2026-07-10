/**
 * figure-mode.js — Toggleable "Figure mode" that re-renders the synthesis
 * network into a paper-figure-friendly form (~183 x 170 mm).
 *
 * Non-destructive: snapshots cytoscape display state on enable, restores on
 * disable. Does NOT modify graph-layout.js or cytoscape-bridge.js.
 *
 * Transformations:
 *   1. Inline common species (H2O, CO2, NH3, H2, NH2OH) as edge labels
 *      ("+ H2O" on input edges, "- H2O" on output edges); hide their nodes
 *      and incident edges.
 *   2. Replace pbr-/rxn- reaction labels with sequential numbers 1..N and
 *      shrink the reaction nodes to small circles.
 *   3. Switch to horizontal (LR) layout with tighter spacing, then fit.
 *   4. Shorten long IUPAC molecule names via a small lookup map.
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};

  // "Utility" species inlined as edge labels. Match against formula,
  // commonName, and iupacName (lowercased, trimmed). Value = display symbol.
  var COMMON_SPECIES = {
    // 'h2o':              'H\u2082O',
    // 'water':            'H\u2082O',
    // 'co2':              'CO\u2082',
    // 'carbon dioxide':   'CO\u2082',
    // 'co':               'CO',
    // 'carbon monoxide':  'CO',
    // 'nh3':              'NH\u2083',
    // 'ammonia':          'NH\u2083',
    // 'azane':            'NH\u2083',
    // 'h2':               'H\u2082',
    // 'hydrogen':         'H\u2082',
    // 'hydrogen gas':     'H\u2082',
    // 'molecular hydrogen': 'H\u2082',
    // 'h2s':              'H\u2082S',
    // 'hydrogen sulfide': 'H\u2082S',
    // 'nh2oh':            'NH\u2082OH',
    // 'hydroxylamine':    'NH\u2082OH',
    // 'hcoo-':            'HCOO\u207B',
    // 'cho2-':            'HCOO\u207B',
    // 'formate':          'HCOO\u207B',
    // 'formic acid':      'HCOOH',
    // 'hconh2':           'HCONH\u2082',
    // 'ch3no':            'HCONH\u2082',
    // 'formamide':        'HCONH\u2082',
    // 'o2':               'O\u2082',
    // 'oxygen':           'O\u2082'
  };

  function commonSymbolFor(node) {
    if (!node || !node.isNode() || !node.hasClass('molecule')) return null;
    var keys = [node.data('formula'), node.data('commonName'), node.data('iupacName')];
    for (var i = 0; i < keys.length; i++) {
      var k = (keys[i] || '').toString().trim().toLowerCase();
      if (k && Object.prototype.hasOwnProperty.call(COMMON_SPECIES, k)) {
        return COMMON_SPECIES[k];
      }
    }
    return null;
  }

  // Long IUPAC / common names → compact label for figure mode.
  var LABEL_SHORTCUTS = {
    // '4-hydroxy-2-oxoglutaric acid': '4-OH-2-OG',
    // '2-oxopentanedioic acid':       '\u03B1-KG',
    // '\u03B1-ketoglutaric acid':     '\u03B1-KG',
    // '2-oxoglutarate':               '\u03B1-KG',
    // '2-aminopentanedioic acid':     'L-Glu',
    // 'glutamic acid':                'L-Glu',
    // 'L-Glutamate':                  'L-Glu',
    // '2-amino-4-hydroxy-4-methylpentanedioic acid': '2-A-4-OH-4-Me-PDA',
    // '4-oxopent-2-enedioic acid':    '4-oxo-pent-2-enedioate',
    // '2-hydroxyglutaric acid':       '2-OH-Glu',
    // '2-hydroxypentanedinitrile':    '2-OH-PDN',
    // '2-aminopentanedinitrile':      '2-A-PDN'
  };

  var snapshot = null;
  var active = false;

  function getCy() { return SV.cy; }

  function isCommonSpeciesNode(node) {
    return commonSymbolFor(node) !== null;
  }

  function shortLabelFor(node) {
    var orig = node.data('label') || '';
    var iupac = node.data('iupacName') || '';
    var common = node.data('commonName') || '';
    if (LABEL_SHORTCUTS[orig]) return LABEL_SHORTCUTS[orig];
    if (LABEL_SHORTCUTS[iupac]) return LABEL_SHORTCUTS[iupac];
    if (LABEL_SHORTCUTS[common]) return LABEL_SHORTCUTS[common];
    // Heuristic: if very long, prefer commonName, else truncate.
    if (orig.length > 22) {
      if (common && common.length < orig.length) return common;
      return orig.slice(0, 20) + '\u2026';
    }
    return orig;
  }

  /**
   * Capture state we'll mutate so we can restore on disable.
   */
  // Target paper size (mm) for figure mode.
  var FIGURE_W_MM = 183;
  var FIGURE_H_MM = 170;
  var PX_PER_MM = 3.7795275591;
  var FIGURE_PAD_MM = 4;

  /**
   * Uniformly scale visible node positions so that the true rendered
   * bounding box (including labels and node extents) fits inside the
   * target mm box. Run after layout, before setCanvasLimit.
   */
  function fitVisibleToBox(cy) {
    var visible = cy.elements().not('.fm-hidden');
    if (visible.length === 0) return;
    var bb = visible.boundingBox({ includeLabels: true, includeOverlays: false });
    var bbW = bb.w || 1;
    var bbH = bb.h || 1;
    var targetW = (FIGURE_W_MM - 2 * FIGURE_PAD_MM) * PX_PER_MM;
    var targetH = (FIGURE_H_MM - 2 * FIGURE_PAD_MM) * PX_PER_MM;
    var scale = Math.min(targetW / bbW, targetH / bbH);
    if (!isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 0.001) return;
    var cx = (bb.x1 + bb.x2) / 2;
    var cy0 = (bb.y1 + bb.y2) / 2;
    visible.nodes().forEach(function(n) {
      var p = n.position();
      n.position({
        x: cx + (p.x - cx) * scale,
        y: cy0 + (p.y - cy0) * scale
      });
    });
  }

  function takeSnapshot(cy) {
    var snap = {
      layoutDirection: SV.layoutDirection,
      canvasLimitW: SV._canvasLimitW,
      canvasLimitH: SV._canvasLimitH,
      nodes: {},
      edges: {},
      pan: cy.pan(),
      zoom: cy.zoom()
    };
    cy.nodes().forEach(function(n) {
      snap.nodes[n.id()] = {
        label: n.data('label'),
        position: { x: n.position('x'), y: n.position('y') },
        hidden: n.hidden(),
        classes: n.classes().slice()
      };
    });
    cy.edges().forEach(function(e) {
      snap.edges[e.id()] = {
        label: e.data('label'),
        hidden: e.hidden(),
        classes: e.classes().slice()
      };
    });
    return snap;
  }

  function restoreSnapshot(cy, snap) {
    cy.batch(function() {
      cy.nodes().forEach(function(n) {
        var s = snap.nodes[n.id()];
        if (!s) return;
        n.data('label', s.label);
        n.position(s.position);
        if (s.hidden) n.hide(); else n.show();
        // Reset figure-mode-only classes
        n.removeClass('fm-hidden fm-rxn fm-mol');
      });
      cy.edges().forEach(function(e) {
        var s = snap.edges[e.id()];
        if (!s) return;
        e.data('label', s.label || '');
        if (s.hidden) e.hide(); else e.show();
        e.removeClass('fm-edge fm-hidden');
      });
    });
    if (snap.layoutDirection) SV.layoutDirection = snap.layoutDirection;
    cy.zoom(snap.zoom);
    cy.pan(snap.pan);
  }

  /**
   * Inject figure-mode-specific cytoscape styles once.
   */
  function ensureStyles(cy) {
    if (cy.scratch('_fmStylesInstalled')) return;
    cy.scratch('_fmStylesInstalled', true);
    var extra = [
      {
        selector: 'node.fm-rxn',
        style: {
          'shape': 'round-rectangle',
          'width': 36,
          'height': 24,
          'font-size': 11,
          'font-weight': 700,
          'border-width': 1,
          'text-valign': 'center',
          'text-halign': 'center',
          'text-margin-y': 0,
          'color': '#000000'
        }
      },
      {
        // Sizing/font only — leave background, text-valign etc. to the
        // existing image-mode classes (has-image / images-hidden / names-only)
        // so the user's image-mode toggle still works in figure mode.
        selector: 'node.fm-mol',
        style: {
          'width': 60,
          'height': 60,
          'border-width': 1.5,
          'font-size': 8,
          'font-weight': 600,
          'text-wrap': 'wrap',
          'text-max-width': 52,
          'text-overflow-wrap': 'anywhere'
        }
      },
      {
        selector: '.fm-hidden',
        style: { 'display': 'none' }
      },
      {
        selector: 'edge.fm-edge',
        style: {
          'label': 'data(label)',
          'font-size': 9,
          'font-style': 'italic',
          'color': '#444',
          'text-background-color': '#ffffff',
          'text-background-opacity': 0.85,
          'text-background-padding': 1,
          'text-rotation': 'autorotate'
        }
      }
    ];
    cy.style().fromJson(cy.style().json().concat(extra)).update();
  }

  /**
   * Topologically order reaction nodes (by current y then x in standard
   * layout) and assign sequential numbers.
   */
  function numberReactions(cy) {
    var rxns = cy.nodes('.reaction').filter(function(n) { return !n.hasClass('fm-hidden'); });
    var arr = rxns.toArray().slice();
    arr.sort(function(a, b) {
      var pa = a.position(), pb = b.position();
      if (Math.abs(pa.y - pb.y) > 4) return pa.y - pb.y;
      return pa.x - pb.x;
    });
    var mapping = {};
    arr.forEach(function(n, i) {
      var num = i + 1;
      mapping[n.id()] = num;
      n.data('label', String(num));
      n.addClass('fm-rxn');
    });
    return mapping;
  }

  /**
   * Hide common-species molecules and inline them as edge labels on the
   * reactions they participate in.
   */
  function inlineCommonSpecies(cy) {
    var hiddenCount = 0;
    cy.nodes('.molecule').forEach(function(mol) {
      var sym = commonSymbolFor(mol);
      if (!sym) return;

      // For each reaction this molecule touches, append the symbol to a
      // *surviving* edge from/to that reaction so it remains visible.
      mol.connectedEdges().forEach(function(e) {
        // The other endpoint is a reaction.
        var other = (e.source().id() === mol.id()) ? e.target() : e.source();
        if (!other.hasClass('reaction')) return;
        var asInput = (e.source().id() === mol.id()); // mol -> rxn
        var sign = asInput ? '+ ' : '\u2212 ';

        // Find a surviving edge connected to that reaction (not touching a
        // hidden common-species node) to carry the label.
        var carrier = null;
        other.connectedEdges().some(function(ce) {
          if (ce.id() === e.id()) return false;
          var otherEnd = (ce.source().id() === other.id()) ? ce.target() : ce.source();
          if (isCommonSpeciesNode(otherEnd)) return false;
          // Prefer matching direction (input edge for input species).
          var ceIsInput = (ce.target().id() === other.id());
          if (ceIsInput === asInput) { carrier = ce; return true; }
          if (!carrier) carrier = ce;
          return false;
        });

        if (carrier) {
          var existing = carrier.data('label') || '';
          var addition = sign + sym;
          carrier.data('label', existing ? existing + '  ' + addition : addition);
          carrier.addClass('fm-edge');
        }

        e.addClass('fm-hidden');
      });

      mol.addClass('fm-hidden');
      hiddenCount++;
    });
    return hiddenCount;
  }

  /**
   * Re-run the standard layout in horizontal mode and apply positions.
   */
  function relayoutDagre(cy) {
    // Run cytoscape-dagre on the *visible* elements only (skip the
    // common-species nodes/edges we just hid via .fm-hidden).
    var eles = cy.elements().not('.fm-hidden');
    var layout = eles.layout({
      name: 'dagre',
      rankDir: 'LR',
      // nodeSep: 130,
      edgeSep: 100,
      // rankSep: 130,
      animate: false,
      fit: true,
      padding: 10,
      acyclicer: 'greedy',
      ranker: 'tight-tree'
    });
    layout.run();
  }

  function shortenMoleculeLabels(cy) {
    cy.nodes('.molecule').forEach(function(mol) {
      if (mol.hasClass('fm-hidden')) return;
      var s = shortLabelFor(mol);
      if (s !== mol.data('label')) mol.data('label', s);
      mol.addClass('fm-mol');
    });
  }

  function fitToFigure(cy) {
    // 183x170 mm aspect — Cytoscape works in pixels, so just fit with margin.
    cy.fit(undefined, 24);
  }

  // ---- Public API ----

  SV.figureMode = {
    get isActive() { return active; },

    enable: function(_graph) {
      var cy = getCy();
      if (!cy || active) return;
      ensureStyles(cy);
      snapshot = takeSnapshot(cy);
      cy.batch(function() {
        inlineCommonSpecies(cy);
        shortenMoleculeLabels(cy);
      });
      // Dagre must run outside cy.batch so it sees finalized classes/sizes.
      relayoutDagre(cy);
      numberReactions(cy);
      // Scale visible nodes so node+label extents fit the mm box.
      fitVisibleToBox(cy);
      // Constrain to 183 x 170 mm so SVG export uses the right physical size.
      if (typeof SV.setCanvasLimit === 'function') {
        SV.setCanvasLimit(FIGURE_W_MM, FIGURE_H_MM);
      }
      fitToFigure(cy);
      active = true;
    },

    disable: function() {
      var cy = getCy();
      if (!cy || !active || !snapshot) return;
      // Restore previous canvas limit (or clear it).
      if (typeof SV.setCanvasLimit === 'function') {
        if (snapshot.canvasLimitW && snapshot.canvasLimitH) {
          SV.setCanvasLimit(snapshot.canvasLimitW, snapshot.canvasLimitH);
        } else {
          SV.setCanvasLimit(null, null);
        }
      }
      restoreSnapshot(cy, snapshot);
      snapshot = null;
      active = false;
      cy.fit(undefined, 30);
    },

    toggle: function(graph) {
      if (active) this.disable();
      else this.enable(graph);
      return active;
    }
  };

})();
