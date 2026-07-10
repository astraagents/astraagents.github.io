/**
 * cytoscape-bridge.js — Cytoscape.js integration layer.
 *
 * Replaces renderer.js, edge-canvas.js, and drag.js with a single
 * Cytoscape instance. Provides the API surface consumed by main.js.
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};

  // Cytoscape instance (set by initCytoscape)
  SV.cy = null;

  // Track whether last interaction was a drag (for click vs drag distinction)
  var lastInteractionWasDrag = false;

  // Multi-drag state
  var multiDragOffsets = null;   // { nodeId: {dx, dy} } offsets relative to grabbed node
  var multiDragGrabbedId = null;

  // Callbacks set by main.js
  SV._onNodeTap = null;
  SV._onNodeCxttap = null;
  SV._onBackgroundTap = null;

  /**
   * Cytoscape visual stylesheet.
   */
  var cyStyle = [
    // === Molecule nodes (circles) ===
    {
      selector: 'node.molecule',
      style: {
        'shape': 'ellipse',
        'width': 100,
        'height': 100,
        'label': 'data(label)',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 8,
        'font-family': 'Helvetica, Arial, sans-serif',
        'font-size': 11,
        'font-weight': 700,
        'color': 'data(strokeColor)',
        'text-wrap': 'wrap',
        'text-max-width': 80,
        'border-width': 3,
        'background-color': '#ffffff',
        'background-opacity': 1,
        'text-outline-width': 0,
      }
    },
    // Role colors (hollow circles with colored borders)
    {
      selector: 'node.starting',
      style: {
        'border-color': '#2c3e50',
      }
    },
    {
      selector: 'node.intermediate, node.hub_intermediate',
      style: {
        'border-color': '#2980b9',
      }
    },
    {
      selector: 'node.target',
      style: {
        'border-color': '#c0392b',
        'border-width': 4,
      }
    },

    // === Reaction nodes (rounded rectangles) ===
    {
      selector: 'node.reaction',
      style: {
        'shape': 'round-rectangle',
        'width': 120,
        'height': 44,
        'label': 'data(label)',
        'text-valign': 'center',
        'text-halign': 'center',
        'font-family': 'Helvetica, Arial, sans-serif',
        'font-size': 13,
        'font-weight': 700,
        'color': '#000000',
        'border-width': 1,
      }
    },
    // Environment colors
    {
      selector: 'node.hydrothermal',
      style: {
        'background-color': '#c692dd',
        'border-color': '#a86bc2',
      }
    },
    {
      selector: 'node.surface',
      style: {
        'background-color': '#ce9576',
        'border-color': '#b07a5e',
      }
    },
    {
      selector: 'node.biochemical',
      style: {
        'background-color': '#1abc9c',
        'border-color': '#16a085',
      }
    },
    // High-coverage reactions (>75%): white rectangle with border
    {
      selector: 'node.high-coverage',
      style: {
        'background-color': '#ffffff',
        'background-opacity': 1,
        'border-width': 3,
      }
    },

    // === Molecule nodes with PubChem images ===
    {
      selector: 'node.has-image',
      style: {
        'background-color': '#ffffff',
        'background-opacity': 1,
        'background-image': 'data(imageUrl)',
        'background-fit': 'contain',
        'background-clip': 'node',
        'background-width': '170%',
        'background-height': '170%',
        'text-valign': 'bottom',
        'text-margin-y': 13,
        'color': 'data(strokeColor)',
        'label': 'data(label)',
        'text-outline-width': 0,
      }
    },

    // === Label on top (toggled via right-click on multi-selected molecules) ===
    {
      selector: 'node.molecule.label-top',
      style: {
        'text-valign': 'top',
        'text-margin-y': -8,
      }
    },
    {
      selector: 'node.molecule.has-image.label-top',
      style: {
        'text-valign': 'top',
        'text-margin-y': -13,
      }
    },

    // === Hide images (toggle) ===
    {
      selector: 'node.images-hidden',
      style: {
        'background-image': 'none',
        'background-opacity': 1,
        'background-color': '#ffffff',
      }
    },

    // === Names-only mode: hide image, center label inside circle ===
    {
      selector: 'node.names-only',
      style: {
        'background-image': 'none',
        'background-opacity': 1,
        'background-color': '#ffffff',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-margin-y': 0,
        'text-wrap': 'wrap',
        'text-max-width': 'data(namesMaxWidth)',
        'text-overflow-wrap': 'anywhere',
        'font-size': 10,
      }
    },

    // === Edges ===
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 1.0,
        'line-color': '#555566',
        'target-arrow-color': '#555566',
        'width': 1.5,
      }
    },
    {
      selector: 'edge.to-molecule',
      style: {
        'line-style': 'dashed',
        'line-dash-pattern': [6, 4],
      }
    },

    // === Labels hidden ===
    {
      selector: 'node.labels-hidden',
      style: {
        'label': '',
      }
    },

    // === States ===
    {
      selector: '.dimmed',
      style: {
        'opacity': 0.15,
      }
    },
    {
      selector: ':selected',
      style: {
        'border-color': '#6366f1',
        'border-width': 3,
        'overlay-opacity': 0,
      }
    },
    {
      selector: '.hover',
      style: {
        'border-width': 2.5,
      }
    },
  ];

  /**
   * Initialize the Cytoscape instance.
   */
  SV.initCytoscape = function(containerEl) {
    SV.cy = cytoscape({
      container: containerEl,
      style: cyStyle,
      layout: { name: 'preset' },
      // Interaction settings
      zoomingEnabled: true,
      userZoomingEnabled: true,
      panningEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      selectionType: 'additive',
      autoungrabify: false,
      minZoom: 0.1,
      maxZoom: 4.0,
    });

    // Event handlers
    var cy = SV.cy;

    // Label-drag state: track Alt key and previous position
    var labelDragActive = false;
    var labelDragPrevPos = null;

    // Listen for Alt key on the container
    containerEl.addEventListener('keydown', function(e) {
      if (e.key === 'Alt') labelDragActive = true;
    });
    containerEl.addEventListener('keyup', function(e) {
      if (e.key === 'Alt') labelDragActive = false;
    });
    // Also track via window for reliability
    window.addEventListener('keydown', function(e) {
      if (e.key === 'Alt') labelDragActive = true;
    });
    window.addEventListener('keyup', function(e) {
      if (e.key === 'Alt') labelDragActive = false;
    });

    // Track drag state + snap-align + label-drag
    cy.on('drag', 'node', function(evt) {
      lastInteractionWasDrag = true;
      var node = evt.target;
      var pos = node.position();

      // --- Label drag mode: Alt+drag moves just the label ---
      if (SV._labelDragEnabled && labelDragActive && node.hasClass('molecule')) {
        if (labelDragPrevPos) {
          var dx = pos.x - labelDragPrevPos.x;
          var dy = pos.y - labelDragPrevPos.y;
          var curMx = parseFloat(node.data('labelOffsetX')) || 0;
          var curMy = parseFloat(node.data('labelOffsetY')) || 0;
          node.data('labelOffsetX', curMx + dx);
          node.data('labelOffsetY', curMy + dy);
          node.style({
            'text-margin-x': curMx + dx,
            'text-margin-y': (curMy + dy) + 8
          });
          // Move node back to original position
          node.position(labelDragPrevPos);
        }
        labelDragPrevPos = { x: node.position().x, y: node.position().y };
        return;
      }
      labelDragPrevPos = { x: pos.x, y: pos.y };

      // --- Multi-drag: move all selected nodes together ---
      if (multiDragOffsets && multiDragGrabbedId === node.id()) {
        Object.keys(multiDragOffsets).forEach(function(otherId) {
          var offset = multiDragOffsets[otherId];
          var otherNode = cy.getElementById(otherId);
          if (otherNode.length) {
            otherNode.position({
              x: pos.x + offset.dx,
              y: pos.y + offset.dy
            });
          }
        });
      }

      // --- Snap-align logic ---
      if (!SV._snapAlign) {
        hideSnapGuides();
        return;
      }

      var guideH = document.getElementById('snap-guide-h');
      var guideV = document.getElementById('snap-guide-v');
      var threshold = SNAP_THRESHOLD / cy.zoom();
      var snappedX = false, snappedY = false;

      cy.nodes().not(node).forEach(function(other) {
        var oPos = other.position();
        if (!snappedX && Math.abs(pos.x - oPos.x) < threshold) {
          pos.x = oPos.x;
          snappedX = true;
        }
        if (!snappedY && Math.abs(pos.y - oPos.y) < threshold) {
          pos.y = oPos.y;
          snappedY = true;
        }
      });

      if (snappedX || snappedY) {
        node.position(pos);
      }

      // Show/hide guide lines
      if (snappedX && guideV) {
        var rp = cy.modelToRenderedPosition({ x: pos.x, y: 0 });
        guideV.style.display = 'block';
        guideV.style.left = rp.x + 'px';
      } else if (guideV) {
        guideV.style.display = 'none';
      }
      if (snappedY && guideH) {
        var rp2 = cy.modelToRenderedPosition({ x: 0, y: pos.y });
        guideH.style.display = 'block';
        guideH.style.top = rp2.y + 'px';
      } else if (guideH) {
        guideH.style.display = 'none';
      }
    });

    // Multi-drag: record offsets on grab
    cy.on('grab', 'node', function(evt) {
      var node = evt.target;
      if (!node.selected()) {
        multiDragOffsets = null;
        multiDragGrabbedId = null;
        return;
      }
      var selected = cy.nodes(':selected');
      if (selected.length <= 1) {
        multiDragOffsets = null;
        multiDragGrabbedId = null;
        return;
      }
      var grabPos = node.position();
      multiDragGrabbedId = node.id();
      multiDragOffsets = {};
      selected.forEach(function(other) {
        if (other.id() === node.id()) return;
        var oPos = other.position();
        multiDragOffsets[other.id()] = {
          dx: oPos.x - grabPos.x,
          dy: oPos.y - grabPos.y
        };
      });
    });

    // Track selection state before Cytoscape's internal selection fires
    var preClickSelected = {};  // nodeId -> true for nodes selected before this click
    cy.on('vmousedown', 'node', function(evt) {
      preClickSelected = {};
      cy.nodes(':selected').forEach(function(n) {
        preClickSelected[n.id()] = true;
      });
    });

    // Node tap (click) — Alt+click toggles multi-select, normal click = single select
    cy.on('tap', 'node', function(evt) {
      if (lastInteractionWasDrag) {
        lastInteractionWasDrag = false;
        return;
      }

      var originalEvent = evt.originalEvent;
      var node = evt.target;

      if (originalEvent && originalEvent.altKey) {
        // Alt+click: toggle selection
        // Cytoscape (additive) already selected this node. Check if it was
        // selected BEFORE the click — if so, the user wants to deselect it.
        if (preClickSelected[node.id()]) {
          node.unselect();
        }
        // Otherwise Cytoscape already selected it — keep it.
        // Do NOT open sidebar for Alt+clicks
        return;
      }

      // Normal click: enforce single-select, deselect all others
      cy.nodes().not(node).unselect();
      node.select();

      if (SV._onNodeTap) {
        SV._onNodeTap(node.id(), evt);
      }
    });

    // Background tap — clear all selection
    cy.on('tap', function(evt) {
      if (evt.target === cy) {
        lastInteractionWasDrag = false;
        cy.nodes().unselect();
        if (SV._onBackgroundTap) {
          SV._onBackgroundTap();
        }
      }
    });

    // Right-click on node
    cy.on('cxttap', 'node', function(evt) {
      var tgt = evt.target;
      // If right-clicking a molecule that's part of a multi-selection of molecules,
      // toggle label position (top/bottom) for all selected molecules instead of
      // opening the context menu.
      if (tgt.hasClass('molecule') && tgt.selected()) {
        var selectedMols = cy.nodes('node.molecule:selected');
        if (selectedMols.length >= 2) {
          var makeTop = !tgt.hasClass('label-top');
          selectedMols.forEach(function(n) {
            if (makeTop) n.addClass('label-top');
            else n.removeClass('label-top');
          });
          return;
        }
      }
      if (SV._onNodeCxttap) {
        var containerRect = containerEl.getBoundingClientRect();
        var renderedPos = evt.renderedPosition;
        SV._onNodeCxttap(evt.target.id(), {
          x: containerRect.left + renderedPos.x,
          y: containerRect.top + renderedPos.y
        });
      }
    });

    // Hover effects
    cy.on('mouseover', 'node', function(evt) {
      evt.target.addClass('hover');
      containerEl.style.cursor = 'pointer';
    });

    cy.on('mouseout', 'node', function(evt) {
      evt.target.removeClass('hover');
      containerEl.style.cursor = 'default';
    });

    function hideSnapGuides() {
      var gh = document.getElementById('snap-guide-h');
      var gv = document.getElementById('snap-guide-v');
      if (gh) gh.style.display = 'none';
      if (gv) gv.style.display = 'none';
    }

    // Sync model positions after drag (and clamp if canvas limit active)
    cy.on('dragfree', 'node', function(evt) {
      labelDragPrevPos = null;
      hideSnapGuides();

      // Collect all nodes that need model sync (grabbed + multi-drag companions)
      var nodesToSync = [evt.target];
      if (multiDragOffsets && multiDragGrabbedId === evt.target.id()) {
        Object.keys(multiDragOffsets).forEach(function(otherId) {
          var otherNode = cy.getElementById(otherId);
          if (otherNode.length) nodesToSync.push(otherNode);
        });
      }
      multiDragOffsets = null;
      multiDragGrabbedId = null;

      nodesToSync.forEach(function(cyNode) {
        var nodeId = cyNode.id();
        var pos = cyNode.position();

        // Clamp to bounding box if active
        if (SV._canvasBBox) {
          var bb = SV._canvasBBox;
          var clamped = false;
          if (pos.x < bb.x1) { pos.x = bb.x1; clamped = true; }
          if (pos.x > bb.x2) { pos.x = bb.x2; clamped = true; }
          if (pos.y < bb.y1) { pos.y = bb.y1; clamped = true; }
          if (pos.y > bb.y2) { pos.y = bb.y2; clamped = true; }
          if (clamped) cyNode.position(pos);
        }

        var w = cyNode.data('nodeW') || 100;
        var h = cyNode.data('nodeH') || 100;
        // Update model (top-left coordinates)
        if (SV._currentGraph) {
          var modelNode = SV._currentGraph.molecules.get(nodeId) || SV._currentGraph.reactions.get(nodeId);
          if (modelNode) {
            modelNode.x = pos.x - w / 2;
            modelNode.y = pos.y - h / 2;
          }
        }
      });
    });
  };

  /**
   * Build Cytoscape elements array from graph model and computed positions.
   */
  SV.buildCytoscapeElements = function(graph, positions) {
    var elements = [];

    // Molecule nodes
    graph.molecules.forEach(function(mol, id) {
      var pos = positions.get(id);
      if (!pos) return;

      var roleColors = SV.ROLE_COLORS[mol.role] || SV.ROLE_COLORS.intermediate;
      var classes = ['molecule', mol.role];

      elements.push({
        group: 'nodes',
        data: {
          id: id,
          type: 'molecule',
          label: mol.commonName || mol.formula,
          shortLabel: SV.truncate(mol.commonName || mol.formula, 16),
          role: mol.role,
          environment: mol.environmentFormed,
          fillColor: roleColors.fill,
          strokeColor: roleColors.stroke,
          nodeW: pos.w,
          nodeH: pos.h,
          namesMaxWidth: Math.round(100 * 0.7),
        },
        position: { x: pos.x + pos.w / 2, y: pos.y + pos.h / 2 },
        classes: classes.join(' '),
      });
    });

    // Reaction nodes
    graph.reactions.forEach(function(rxn, id) {
      var pos = positions.get(id);
      if (!pos) return;

      var classes = ['reaction', (rxn.environment || 'surface').toLowerCase()];
      if (rxn.isHighCoverage) classes.push('high-coverage');

      elements.push({
        group: 'nodes',
        data: {
          id: id,
          type: 'reaction',
          label: rxn.shortId,
          environment: rxn.environment,
          nodeW: pos.w,
          nodeH: pos.h,
        },
        position: { x: pos.x + pos.w / 2, y: pos.y + pos.h / 2 },
        classes: classes.join(' '),
      });
    });

    // Edges
    graph.edges.forEach(function(edge) {
      var classes = [];
      if (graph.reactions.has(edge.sourceId)) classes.push('to-molecule');

      elements.push({
        group: 'edges',
        data: {
          id: edge.id,
          source: edge.sourceId,
          target: edge.targetId,
        },
        classes: classes.join(' '),
      });
    });

    return elements;
  };

  /**
   * Load PubChem images for all molecule nodes asynchronously.
   */
  SV.loadPubChemImages = function(graph) {
    if (!SV.cy || !SV.fetchMoleculeImage) return;

    graph.molecules.forEach(function(mol) {
      SV.fetchMoleculeImage(mol, function(imageUrl) {
        if (!imageUrl) return;
        var cyNode = SV.cy.getElementById(mol.id);
        if (cyNode.length) {
          cyNode.data('imageUrl', imageUrl);
          cyNode.addClass('has-image');
        }
      });
    });
  };

  // === View controls ===

  SV.resetView = function() {
    if (SV.cy) SV.cy.fit(undefined, 30);
  };

  SV.zoomIn = function() {
    if (!SV.cy) return;
    var cy = SV.cy;
    var center = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: center });
  };

  SV.zoomOut = function() {
    if (!SV.cy) return;
    var cy = SV.cy;
    var center = { x: cy.width() / 2, y: cy.height() / 2 };
    cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: center });
  };

  /**
   * Check if the last interaction was a drag (for click vs drag distinction).
   */
  SV.wasDrag = function() {
    return lastInteractionWasDrag;
  };

  /**
   * Update font size for all node labels on the canvas.
   */
  SV.setFontSize = function(size) {
    if (!SV.cy) return;
    SV.cy.style()
      .selector('node.molecule').style('font-size', size)
      .selector('node.reaction').style('font-size', size + 2)
      .update();
  };

  /**
   * Resize molecule nodes (default 100).
   */
  SV.setMoleculeSize = function(size) {
    if (!SV.cy) return;
    SV.cy.style()
      .selector('node.molecule').style({ 'width': size, 'height': size })
      .update();
    // Update text-max-width data for names-only mode (~70% of node diameter)
    var maxW = Math.round(size * 0.7);
    SV.cy.nodes('.molecule').data('namesMaxWidth', maxW);
  };

  /**
   * Set molecule label wrap width (text-max-width) for the default
   * (image / no-image) modes. Names-only mode keeps its own data-driven width.
   */
  SV.setMoleculeLabelWidth = function(width) {
    if (!SV.cy) return;
    SV.cy.style()
      .selector('node.molecule').style('text-max-width', width)
      .update();
  };

  /**
   * Set molecule node border width.
   */
  SV.setMoleculeBorderWidth = function(width) {
    if (!SV.cy) return;
    SV.cy.style()
      .selector('node.molecule').style('border-width', width)
      .selector('node.target').style('border-width', Math.max(width, width + 1))
      .update();
  };

  /**
   * Set reaction node border width (non-high-coverage).
   */
  SV.setReactionBorderWidth = function(width) {
    if (!SV.cy) return;
    SV.cy.style()
      .selector('node.reaction').style('border-width', width)
      .update();
  };

  /**
   * Set high-coverage reaction node border width.
   */
  SV.setHighCoverageBorderWidth = function(width) {
    if (!SV.cy) return;
    SV.cy.style()
      .selector('node.high-coverage').style('border-width', width)
      .update();
  };

  /**
   * Show or hide molecule labels.
   */
  SV.setMoleculeLabelsVisible = function(visible) {
    if (!SV.cy) return;
    var molNodes = SV.cy.nodes('.molecule');
    if (visible) {
      molNodes.removeClass('labels-hidden');
    } else {
      molNodes.addClass('labels-hidden');
    }
  };

  /**
   * Set edge line width.
   */
  SV.setEdgeWidth = function(width) {
    if (!SV.cy) return;
    var arrowScale = width / 1.5;
    SV.cy.style()
      .selector('edge').style({ 'width': width, 'arrow-scale': arrowScale })
      .update();
  };

  // Label dragging state
  SV._labelDragEnabled = false;

  /**
   * Enable or disable Alt+drag to reposition molecule labels.
   */
  SV.setLabelDragging = function(enabled) {
    SV._labelDragEnabled = enabled;
  };

  // Snap-align state
  SV._snapAlign = false;
  var SNAP_THRESHOLD = 8;

  /**
   * Resize reaction nodes (default width 120, height 44).
   */
  SV.setReactionSize = function(scale) {
    if (!SV.cy) return;
    var w = Math.round(120 * scale / 100);
    var h = Math.round(44 * scale / 100);
    SV.cy.style()
      .selector('node.reaction').style({ 'width': w, 'height': h })
      .update();
  };

  // Canvas bounding box state
  SV._canvasBBox = null;     // { x1, y1, x2, y2 } in model coords
  SV._canvasLimitW = null;   // width in mm for SVG export
  SV._canvasLimitH = null;   // height in mm for SVG export

  /**
   * Set or clear a rectangular canvas bounding box limit.
   * Relocates nodes to fit within the box proportionally.
   * @param {number|null} widthMm - width in mm, or null to clear
   * @param {number|null} heightMm - height in mm, or null to clear
   */
  SV.setCanvasLimit = function(widthMm, heightMm) {
    if (!SV.cy) return;

    var overlayEl = document.getElementById('canvas-bbox-overlay');

    if (!widthMm || !heightMm) {
      // Clear limit
      SV._canvasBBox = null;
      SV._canvasLimitW = null;
      SV._canvasLimitH = null;
      if (overlayEl) overlayEl.style.display = 'none';
      return;
    }

    var PX_PER_MM = 3.7795275591;
    var targetW = widthMm * PX_PER_MM;
    var targetH = heightMm * PX_PER_MM;
    SV._canvasLimitW = widthMm;
    SV._canvasLimitH = heightMm;

    // Get current bounding box of all nodes
    var nodes = SV.cy.nodes();
    if (nodes.length === 0) return;

    var nbb = nodes.boundingBox();
    var currentW = nbb.w || 1;
    var currentH = nbb.h || 1;
    var currentCx = (nbb.x1 + nbb.x2) / 2;
    var currentCy = (nbb.y1 + nbb.y2) / 2;

    // Add padding so nodes don't sit right on the edge
    var pad = 40;
    var fitW = targetW - pad * 2;
    var fitH = targetH - pad * 2;
    if (fitW < 10) fitW = 10;
    if (fitH < 10) fitH = 10;

    // Scale factor to fit nodes within the target box (uniform)
    var sx = fitW / currentW;
    var sy = fitH / currentH;
    var scale = Math.min(sx, sy); // scale to fit (up or down)

    // Center the bounding box on the current graph center
    var halfW = targetW / 2;
    var halfH = targetH / 2;

    SV._canvasBBox = {
      x1: currentCx - halfW,
      y1: currentCy - halfH,
      x2: currentCx + halfW,
      y2: currentCy + halfH
    };

    // Relocate nodes: scale relative to center, then clamp
    nodes.forEach(function(node) {
      var pos = node.position();
      pos.x = currentCx + (pos.x - currentCx) * scale;
      pos.y = currentCy + (pos.y - currentCy) * scale;

      // Clamp to bounding box
      var bb = SV._canvasBBox;
      if (pos.x < bb.x1) pos.x = bb.x1;
      if (pos.x > bb.x2) pos.x = bb.x2;
      if (pos.y < bb.y1) pos.y = bb.y1;
      if (pos.y > bb.y2) pos.y = bb.y2;
      node.position(pos);
    });

    // Show the bounding box overlay
    SV._updateBBoxOverlay();
    // Re-update on pan/zoom
    SV.cy.off('pan zoom', SV._updateBBoxOverlay);
    SV.cy.on('pan zoom', SV._updateBBoxOverlay);
  };

  /**
   * Update the visual bounding box overlay to match current pan/zoom.
   */
  SV._updateBBoxOverlay = function() {
    if (!SV._canvasBBox || !SV.cy) return;
    var overlayEl = document.getElementById('canvas-bbox-overlay');
    if (!overlayEl) return;

    var bb = SV._canvasBBox;
    var topLeft = SV.cy.modelToRenderedPosition({ x: bb.x1, y: bb.y1 });
    var botRight = SV.cy.modelToRenderedPosition({ x: bb.x2, y: bb.y2 });

    overlayEl.style.display = 'block';
    overlayEl.style.left = topLeft.x + 'px';
    overlayEl.style.top = topLeft.y + 'px';
    overlayEl.style.width = (botRight.x - topLeft.x) + 'px';
    overlayEl.style.height = (botRight.y - topLeft.y) + 'px';
  };

  /**
   * Set a custom image URL on a molecule node.
   */
  SV.setNodeImage = function(nodeId, imageUrl) {
    if (!SV.cy) return;
    var cyNode = SV.cy.getElementById(nodeId);
    if (!cyNode.length) return;
    cyNode.data('imageUrl', imageUrl);
    cyNode.addClass('has-image');
  };

  /**
   * Toggle molecule node display mode.
   * @param {string} mode - 'show' (images), 'hide' (no images), or 'names' (centered names)
   */
  SV.toggleImages = function(mode) {
    if (!SV.cy) return;
    var molNodes = SV.cy.nodes('.molecule');

    // Clear both classes first
    molNodes.removeClass('images-hidden names-only');

    if (mode === 'hide') {
      molNodes.filter('.has-image').addClass('images-hidden');
    } else if (mode === 'names') {
      molNodes.addClass('names-only');
    }
    // 'show' — default styles apply, nothing extra needed
  };

  // === Multi-select alignment ===

  function syncNodeModel(cyNode) {
    var nodeId = cyNode.id();
    var w = cyNode.data('nodeW') || 100;
    var h = cyNode.data('nodeH') || 100;
    if (SV._currentGraph) {
      var modelNode = SV._currentGraph.molecules.get(nodeId) || SV._currentGraph.reactions.get(nodeId);
      if (modelNode) {
        modelNode.x = cyNode.position('x') - w / 2;
        modelNode.y = cyNode.position('y') - h / 2;
      }
    }
  }

  /**
   * Align selected nodes horizontally (all get same X = average X).
   */
  SV.alignSelectedHorizontal = function() {
    if (!SV.cy) return;
    var selected = SV.cy.nodes(':selected');
    if (selected.length < 2) return;

    var sumX = 0;
    selected.forEach(function(node) { sumX += node.position('x'); });
    var avgX = sumX / selected.length;

    selected.forEach(function(node) {
      node.position('x', avgX);
      syncNodeModel(node);
    });
  };

  /**
   * Align selected nodes vertically (all get same Y = average Y).
   */
  SV.alignSelectedVertical = function() {
    if (!SV.cy) return;
    var selected = SV.cy.nodes(':selected');
    if (selected.length < 2) return;

    var sumY = 0;
    selected.forEach(function(node) { sumY += node.position('y'); });
    var avgY = sumY / selected.length;

    selected.forEach(function(node) {
      node.position('y', avgY);
      syncNodeModel(node);
    });
  };

  // Stubs for removed APIs (prevent errors if called elsewhere)
  SV.redrawEdgeCanvas = function() {};
  SV.invalidateEdgeGeometry = function() {};
  SV.scheduleEdgeRedraw = function() {};
  SV.setEdgeCanvasTransform = function() {};
  SV.setupDefs = function() {};

})();
