/**
 * graph-layout.js — Band-constrained layered layout algorithm.
 *
 * Supports two orientations:
 *   Vertical (default): bands stack top-to-bottom, flow downward.
 *   Horizontal: bands stack left-to-right, flow rightward.
 *
 * Within each band, molecules sit on one sub-row/column and reactions on another.
 * Positions optimized via barycenter heuristic to reduce edge crossings.
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};

  // Layout constants
  var C = SV.LAYOUT = {
    CANVAS_W: 1800,
    CANVAS_H: 1000,
    MARGIN_X: 50,
    MARGIN_Y: 30,
    BAND_GAP: 4,         // gap between bands
    MOL_W: 100,
    MOL_H: 100,
    RXN_W: 120,
    RXN_H: 44,
    MIN_H_GAP: 50,       // minimum gap between nodes
    STARTING_ROW_H: 80,  // height/width for starting molecule row/column
  };

  // Layout orientation: 'vertical' (top-to-bottom) or 'horizontal' (left-to-right)
  SV.layoutDirection = 'vertical';

  function isHorizontal() {
    return SV.layoutDirection === 'horizontal';
  }

  // Band order (top-to-bottom in vertical, left-to-right in horizontal)
  var BANDS = ['Hydrothermal', 'Surface', 'Biochemical'];

  /**
   * Main entry: compute positions for all nodes.
   * Returns Map<nodeId, {x, y, w, h}>
   */
  SV.computeLayout = function(molecules, reactions, edges) {
    var bandOf = assignBands(molecules, reactions);

    // Separate starting molecules into their own row/column
    var startingIds = [];
    var bandNodes = {}; // band → { mols: [], rxns: [] }
    BANDS.forEach(function(b) { bandNodes[b] = { mols: [], rxns: [] }; });

    molecules.forEach(function(mol, id) {
      if (mol.role === 'starting') {
        startingIds.push(id);
      } else {
        var band = bandOf.get(id) || 'Surface';
        bandNodes[band].mols.push(id);
      }
    });

    reactions.forEach(function(rxn, id) {
      var band = bandOf.get(id) || 'Surface';
      bandNodes[band].rxns.push(id);
    });

    // Dynamic canvas sizing based on node counts
    computeDynamicCanvasSize(startingIds, bandNodes);

    // Compute band rects AFTER dynamic sizing so they use updated canvas dimensions
    var bandRects = computeBandRects(molecules, bandOf);

    // Build neighbor map once for connectivity-based ordering
    var neighbors = buildNeighbors(edges);

    var positions = new Map();

    if (isHorizontal()) {
      // --- Horizontal layout: bands as vertical columns, flow left-to-right ---

      // Starting molecules in left column (no upstream, sort by ID)
      startingIds.sort();
      placeColumn(startingIds, C.MARGIN_X, C.MOL_W, C.MOL_H, positions);

      // Place nodes in each band column, ordered by connectivity
      BANDS.forEach(function(band) {
        var br = bandRects[band];
        if (!br) return;

        var rxns = bandNodes[band].rxns;
        var mols = bandNodes[band].mols;

        var molX = br.x + br.w * 0.2;
        var rxnX = br.x + br.w * 0.6;

        // Reactions first (sorted by median of already-placed inputs)
        var sortedRxns = sortByMedianNeighborPos(rxns, positions, neighbors, 'y');
        placeColumn(sortedRxns, rxnX, C.RXN_W, C.RXN_H, positions);

        // Molecules next (sorted by median of already-placed reactions)
        var sortedMols = sortByMedianNeighborPos(mols, positions, neighbors, 'y');
        placeColumn(sortedMols, molX, C.MOL_W, C.MOL_H, positions);
      });

      // Barycenter optimization on Y positions
      for (var pass = 0; pass < 20; pass++) {
        barycenterPassH(positions, molecules, reactions, edges, startingIds, bandNodes);
      }
      resolveOverlapsH(positions, startingIds, bandNodes);

    } else {
      // --- Vertical layout (default): bands as horizontal rows, flow top-to-bottom ---

      // Starting molecules in top row (no upstream, sort by ID)
      startingIds.sort();
      placeRow(startingIds, C.MARGIN_Y, C.MOL_W, C.MOL_H, positions);

      // Place nodes in each band row, ordered by connectivity
      BANDS.forEach(function(band) {
        var br = bandRects[band];
        if (!br) return;

        var rxns = bandNodes[band].rxns;
        var mols = bandNodes[band].mols;

        var molY = br.y + br.h * 0.2;
        var rxnY = br.y + br.h * 0.6;

        // Reactions first (sorted by median X of already-placed inputs)
        var sortedRxns = sortByMedianNeighborPos(rxns, positions, neighbors, 'x');
        placeRow(sortedRxns, rxnY, C.RXN_W, C.RXN_H, positions);

        // Molecules next (sorted by median X of already-placed reactions)
        var sortedMols = sortByMedianNeighborPos(mols, positions, neighbors, 'x');
        placeRow(sortedMols, molY, C.MOL_W, C.MOL_H, positions);
      });

      // Barycenter optimization on X positions
      for (var pass = 0; pass < 20; pass++) {
        barycenterPass(positions, molecules, reactions, edges, startingIds, bandNodes);
      }
      resolveOverlaps(positions, startingIds, bandNodes);
    }

    return positions;
  };

  /**
   * Get band rect definitions for rendering.
   */
  SV.getBandRects = function(molecules, bandOf) {
    return computeBandRects(molecules, bandOf);
  };

  /**
   * Assign each node to a band.
   */
  SV.assignBands = function(molecules, reactions) {
    return assignBands(molecules, reactions);
  };

  function assignBands(molecules, reactions) {
    var bandOf = new Map();

    // Reactions: directly from environment field
    reactions.forEach(function(rxn, id) {
      bandOf.set(id, rxn.environment || 'Surface');
    });

    // Molecules: by role, environment_formed, or inferred from producing reactions
    molecules.forEach(function(mol, id) {
      if (mol.role === 'starting') {
        bandOf.set(id, 'Hydrothermal'); // starting row is above Hydrothermal
      } else if (mol.role === 'target') {
        bandOf.set(id, 'Biochemical');
      } else if (mol.environmentFormed) {
        bandOf.set(id, mol.environmentFormed);
      } else {
        // Infer from producing reactions
        var inferredBand = null;
        reactions.forEach(function(rxn) {
          if (!inferredBand && rxn.outputs.indexOf(id) >= 0) {
            inferredBand = rxn.environment;
          }
        });
        // If consumed by multiple bands, pick the earliest
        if (!inferredBand) {
          reactions.forEach(function(rxn) {
            if (!inferredBand && rxn.inputs.indexOf(id) >= 0) {
              inferredBand = rxn.environment;
            }
          });
        }
        bandOf.set(id, inferredBand || 'Surface');
      }
    });

    return bandOf;
  }

  /**
   * Dynamically size the canvas based on node counts per row.
   */
  function computeDynamicCanvasSize(startingIds, bandNodes) {
    // Collect all group sizes to find the widest/tallest row
    var groups = [startingIds.length];
    BANDS.forEach(function(band) {
      var bn = bandNodes[band];
      groups.push(bn.mols.length);
      groups.push(bn.rxns.length);
    });

    var maxNodesInGroup = Math.max.apply(null, groups);
    var maxNodeW = Math.max(C.MOL_W, C.RXN_W);

    if (isHorizontal()) {
      // Height needs to fit the tallest column
      var neededH = maxNodesInGroup * maxNodeW
                  + (Math.max(0, maxNodesInGroup - 1)) * C.MIN_H_GAP
                  + 2 * C.MARGIN_Y + 100;
      C.CANVAS_H = Math.max(1000, neededH);

      // Width: count active bands
      var activeBands = 0;
      BANDS.forEach(function(band) {
        var bn = bandNodes[band];
        if (bn.mols.length > 0 || bn.rxns.length > 0) activeBands++;
      });
      var neededW = C.MARGIN_X + C.STARTING_ROW_H + 10
                  + activeBands * 350
                  + C.MARGIN_X;
      C.CANVAS_W = Math.max(1800, neededW);
    } else {
      // Width needs to fit the widest row
      var neededW = maxNodesInGroup * maxNodeW
                  + (Math.max(0, maxNodesInGroup - 1)) * C.MIN_H_GAP
                  + 2 * C.MARGIN_X + 100;
      C.CANVAS_W = Math.max(1800, neededW);

      // Height: count active bands
      var activeBands = 0;
      BANDS.forEach(function(band) {
        var bn = bandNodes[band];
        if (bn.mols.length > 0 || bn.rxns.length > 0) activeBands++;
      });
      var neededH = C.MARGIN_Y + C.STARTING_ROW_H + 10
                  + activeBands * 220
                  + C.MARGIN_Y;
      C.CANVAS_H = Math.max(1000, neededH);
    }
  }

  function computeBandRects(molecules, bandOf) {
    // Count nodes per band to size bands
    var counts = { Hydrothermal: 0, Surface: 0, Biochemical: 0 };
    if (bandOf) {
      bandOf.forEach(function(band, id) {
        if (counts[band] !== undefined) counts[band]++;
      });
    }

    var totalNodes = counts.Hydrothermal + counts.Surface + counts.Biochemical;

    if (isHorizontal()) {
      // Bands are vertical columns, left to right
      var leftX = C.MARGIN_X + C.STARTING_ROW_H + 10; // after starting column
      var availW = C.CANVAS_W - leftX - C.MARGIN_X;

      var rects = {};
      var x = leftX;
      BANDS.forEach(function(band) {
        var frac = totalNodes > 0 ? Math.max(0.2, counts[band] / totalNodes) : (1 / 3);
        var w = Math.max(200, availW * frac);
        rects[band] = { band: band, x: x, y: 0, w: w, h: C.CANVAS_H };
        x += w + C.BAND_GAP;
      });

      // Normalize to fit available width
      var totalW = 0;
      BANDS.forEach(function(b) { totalW += rects[b].w; });
      var scale = availW / (totalW + C.BAND_GAP * 2);
      if (scale < 1) {
        x = leftX;
        BANDS.forEach(function(b) {
          rects[b].w *= scale;
          rects[b].x = x;
          x += rects[b].w + C.BAND_GAP;
        });
      }

      return rects;
    }

    // Vertical: bands are horizontal rows, top to bottom
    var topY = C.MARGIN_Y + C.STARTING_ROW_H + 10; // below starting row
    var availH = C.CANVAS_H - topY - C.MARGIN_Y;

    var rects = {};
    var y = topY;
    BANDS.forEach(function(band) {
      // Proportional height based on node count, with minimum
      var frac = totalNodes > 0 ? Math.max(0.2, counts[band] / totalNodes) : (1 / 3);
      var h = Math.max(140, availH * frac);
      rects[band] = { band: band, x: 0, y: y, w: C.CANVAS_W, h: h };
      y += h + C.BAND_GAP;
    });

    // Normalize to fit available height
    var totalH = 0;
    BANDS.forEach(function(b) { totalH += rects[b].h; });
    var scale = availH / (totalH + C.BAND_GAP * 2);
    if (scale < 1) {
      y = topY;
      BANDS.forEach(function(b) {
        rects[b].h *= scale;
        rects[b].y = y;
        y += rects[b].h + C.BAND_GAP;
      });
    }

    return rects;
  }

  // ===== Connectivity-based ordering helpers =====

  /**
   * Sort node IDs by median position of their already-placed neighbors.
   * Nodes with no placed neighbors are pushed to the end, sorted by ID.
   */
  function sortByMedianNeighborPos(ids, positions, neighbors, axis) {
    return ids.slice().sort(function(a, b) {
      var aMedian = medianOfPlacedNeighbors(neighbors.get(a) || [], positions, axis);
      var bMedian = medianOfPlacedNeighbors(neighbors.get(b) || [], positions, axis);

      if (aMedian === null && bMedian === null) return a < b ? -1 : 1;
      if (aMedian === null) return 1;
      if (bMedian === null) return -1;
      return aMedian - bMedian;
    });
  }

  /**
   * Compute the median position (center) of already-placed neighbors.
   * Returns null if no neighbors are placed yet.
   */
  function medianOfPlacedNeighbors(nbrIds, positions, axis) {
    var vals = [];
    for (var i = 0; i < nbrIds.length; i++) {
      var p = positions.get(nbrIds[i]);
      if (p) {
        vals.push(axis === 'x' ? p.x + p.w / 2 : p.y + p.h / 2);
      }
    }
    if (vals.length === 0) return null;
    vals.sort(function(a, b) { return a - b; });
    var mid = Math.floor(vals.length / 2);
    return vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid];
  }

  // ===== Vertical layout helpers =====

  /**
   * Place a row of nodes evenly centered horizontally.
   * Caller is responsible for ordering ids.
   */
  function placeRow(ids, centerY, nodeW, nodeH, positions) {
    if (ids.length === 0) return;
    var n = ids.length;
    var totalW = n * nodeW + (n - 1) * C.MIN_H_GAP;
    var startX = Math.max(C.MARGIN_X + 40, (C.CANVAS_W - totalW) / 2);

    ids.forEach(function(id, i) {
      positions.set(id, {
        x: startX + i * (nodeW + C.MIN_H_GAP),
        y: centerY - nodeH / 2,
        w: nodeW,
        h: nodeH
      });
    });
  }

  /**
   * One pass of barycenter heuristic (vertical: optimizes X).
   * Uses variable spacing — places nodes at ideal X, enforcing minimum gaps.
   */
  function barycenterPass(positions, molecules, reactions, edges, startingIds, bandNodes) {
    var neighbors = buildNeighbors(edges);

    var groups = [];
    groups.push({ ids: startingIds, nodeW: C.MOL_W });
    BANDS.forEach(function(band) {
      var bn = bandNodes[band];
      groups.push({ ids: bn.mols, nodeW: C.MOL_W });
      groups.push({ ids: bn.rxns, nodeW: C.RXN_W });
    });

    groups.forEach(function(group) {
      var ids = group.ids;
      var nodeW = group.nodeW;
      if (ids.length <= 1) return;

      var ideals = ids.map(function(id) {
        var nbrs = neighbors.get(id) || [];
        var pos = positions.get(id);
        if (!pos || nbrs.length === 0) return { id: id, idealX: pos ? pos.x : 0 };

        var sum = 0;
        var count = 0;
        nbrs.forEach(function(nbId) {
          var npos = positions.get(nbId);
          if (npos) {
            sum += npos.x + npos.w / 2;
            count++;
          }
        });
        var avgX = count > 0 ? (sum / count) - nodeW / 2 : pos.x;
        return { id: id, idealX: avgX };
      });

      ideals.sort(function(a, b) { return a.idealX - b.idealX; });

      var n = ideals.length;
      if (n === 0) return;

      // Variable spacing: place at ideal positions, enforce minimum gaps
      var placed = [ideals[0].idealX];
      for (var i = 1; i < n; i++) {
        var minAllowed = placed[i - 1] + nodeW + C.MIN_H_GAP;
        placed.push(Math.max(ideals[i].idealX, minAllowed));
      }

      // Shift group to stay within canvas bounds
      var groupLeft = placed[0];
      var groupRight = placed[n - 1] + nodeW;
      var shift = 0;
      if (groupLeft < C.MARGIN_X + 40) {
        shift = (C.MARGIN_X + 40) - groupLeft;
      } else if (groupRight > C.CANVAS_W - C.MARGIN_X) {
        shift = (C.CANVAS_W - C.MARGIN_X) - groupRight;
      }

      ideals.forEach(function(item, i) {
        var pos = positions.get(item.id);
        if (pos) {
          pos.x = placed[i] + shift;
        }
      });
    });
  }

  /**
   * Resolve overlaps (vertical): ensure minimum gaps between nodes on X axis.
   * Preserves relative order and variable spacing from barycenter.
   */
  function resolveOverlaps(positions, startingIds, bandNodes) {
    var groups = [];
    groups.push({ ids: startingIds, nodeW: C.MOL_W });
    BANDS.forEach(function(band) {
      var bn = bandNodes[band];
      groups.push({ ids: bn.mols, nodeW: C.MOL_W });
      groups.push({ ids: bn.rxns, nodeW: C.RXN_W });
    });

    groups.forEach(function(group) {
      var ids = group.ids;
      var nodeW = group.nodeW;
      if (ids.length <= 1) return;

      var sorted = ids.slice().sort(function(a, b) {
        return (positions.get(a).x || 0) - (positions.get(b).x || 0);
      });

      // Forward pass: push right any node that overlaps its left neighbor
      for (var i = 1; i < sorted.length; i++) {
        var prev = positions.get(sorted[i - 1]);
        var curr = positions.get(sorted[i]);
        var minX = prev.x + nodeW + C.MIN_H_GAP;
        if (curr.x < minX) {
          curr.x = minX;
        }
      }

      // Check if group exceeds canvas right bound
      var lastPos = positions.get(sorted[sorted.length - 1]);
      var overflow = (lastPos.x + nodeW + C.MARGIN_X) - C.CANVAS_W;
      if (overflow > 0) {
        var maxShift = positions.get(sorted[0]).x - (C.MARGIN_X + 40);
        var shiftLeft = Math.min(overflow, Math.max(0, maxShift));
        sorted.forEach(function(id) {
          positions.get(id).x -= shiftLeft;
        });
      }
    });
  }

  // ===== Horizontal layout helpers =====

  /**
   * Place a column of nodes evenly centered vertically.
   * Caller is responsible for ordering ids.
   */
  function placeColumn(ids, centerX, nodeW, nodeH, positions) {
    if (ids.length === 0) return;
    var n = ids.length;
    var totalH = n * nodeH + (n - 1) * C.MIN_H_GAP;
    var startY = Math.max(C.MARGIN_Y + 40, (C.CANVAS_H - totalH) / 2);

    ids.forEach(function(id, i) {
      positions.set(id, {
        x: centerX - nodeW / 2,
        y: startY + i * (nodeH + C.MIN_H_GAP),
        w: nodeW,
        h: nodeH
      });
    });
  }

  /**
   * One pass of barycenter heuristic (horizontal: optimizes Y).
   * Uses variable spacing — places nodes at ideal Y, enforcing minimum gaps.
   */
  function barycenterPassH(positions, molecules, reactions, edges, startingIds, bandNodes) {
    var neighbors = buildNeighbors(edges);

    var groups = [];
    groups.push({ ids: startingIds, nodeH: C.MOL_H });
    BANDS.forEach(function(band) {
      var bn = bandNodes[band];
      groups.push({ ids: bn.mols, nodeH: C.MOL_H });
      groups.push({ ids: bn.rxns, nodeH: C.RXN_H });
    });

    groups.forEach(function(group) {
      var ids = group.ids;
      var nodeH = group.nodeH;
      if (ids.length <= 1) return;

      var ideals = ids.map(function(id) {
        var nbrs = neighbors.get(id) || [];
        var pos = positions.get(id);
        if (!pos || nbrs.length === 0) return { id: id, idealY: pos ? pos.y : 0 };

        var sum = 0;
        var count = 0;
        nbrs.forEach(function(nbId) {
          var npos = positions.get(nbId);
          if (npos) {
            sum += npos.y + npos.h / 2;
            count++;
          }
        });
        var avgY = count > 0 ? (sum / count) - nodeH / 2 : pos.y;
        return { id: id, idealY: avgY };
      });

      ideals.sort(function(a, b) { return a.idealY - b.idealY; });

      var n = ideals.length;
      if (n === 0) return;

      // Variable spacing: place at ideal positions, enforce minimum gaps
      var placed = [ideals[0].idealY];
      for (var i = 1; i < n; i++) {
        var minAllowed = placed[i - 1] + nodeH + C.MIN_H_GAP;
        placed.push(Math.max(ideals[i].idealY, minAllowed));
      }

      // Shift group to stay within canvas bounds
      var groupTop = placed[0];
      var groupBottom = placed[n - 1] + nodeH;
      var shift = 0;
      if (groupTop < C.MARGIN_Y + 40) {
        shift = (C.MARGIN_Y + 40) - groupTop;
      } else if (groupBottom > C.CANVAS_H - C.MARGIN_Y) {
        shift = (C.CANVAS_H - C.MARGIN_Y) - groupBottom;
      }

      ideals.forEach(function(item, i) {
        var pos = positions.get(item.id);
        if (pos) {
          pos.y = placed[i] + shift;
        }
      });
    });
  }

  /**
   * Resolve overlaps (horizontal): ensure minimum gaps between nodes on Y axis.
   * Preserves relative order and variable spacing from barycenter.
   */
  function resolveOverlapsH(positions, startingIds, bandNodes) {
    var groups = [];
    groups.push({ ids: startingIds, nodeH: C.MOL_H });
    BANDS.forEach(function(band) {
      var bn = bandNodes[band];
      groups.push({ ids: bn.mols, nodeH: C.MOL_H });
      groups.push({ ids: bn.rxns, nodeH: C.RXN_H });
    });

    groups.forEach(function(group) {
      var ids = group.ids;
      var nodeH = group.nodeH;
      if (ids.length <= 1) return;

      var sorted = ids.slice().sort(function(a, b) {
        return (positions.get(a).y || 0) - (positions.get(b).y || 0);
      });

      // Forward pass: push down any node that overlaps its upper neighbor
      for (var i = 1; i < sorted.length; i++) {
        var prev = positions.get(sorted[i - 1]);
        var curr = positions.get(sorted[i]);
        var minY = prev.y + nodeH + C.MIN_H_GAP;
        if (curr.y < minY) {
          curr.y = minY;
        }
      }

      // Check if group exceeds canvas bottom bound
      var lastPos = positions.get(sorted[sorted.length - 1]);
      var overflow = (lastPos.y + nodeH + C.MARGIN_Y) - C.CANVAS_H;
      if (overflow > 0) {
        var maxShift = positions.get(sorted[0]).y - (C.MARGIN_Y + 40);
        var shiftUp = Math.min(overflow, Math.max(0, maxShift));
        sorted.forEach(function(id) {
          positions.get(id).y -= shiftUp;
        });
      }
    });
  }

  // ===== Shared helpers =====

  function buildNeighbors(edges) {
    var neighbors = new Map();
    edges.forEach(function(e) {
      if (!neighbors.has(e.sourceId)) neighbors.set(e.sourceId, []);
      if (!neighbors.has(e.targetId)) neighbors.set(e.targetId, []);
      neighbors.get(e.sourceId).push(e.targetId);
      neighbors.get(e.targetId).push(e.sourceId);
    });
    return neighbors;
  }

})();
