/**
 * data-loader.js — JSON loading and graph model construction.
 *
 * Graph model:
 * {
 *   molecules: Map<id, MolNode>,
 *   reactions: Map<id, RxnNode>,
 *   edges: Edge[],
 *   pathways: Pathway[],
 *   validationMap: Map<rxnId, ValidationEntry>,
 *   meta: { targetMolecule, overallAlignmentScore, overallStrategy }
 * }
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};

  /**
   * Load from File objects (file input).
   */
  SV.loadFromFiles = function(synthFile, validFile) {
    return Promise.all([
      readJSON(synthFile),
      validFile ? readJSON(validFile) : Promise.resolve(null)
    ]).then(function(results) {
      return buildGraphModel(results[0], results[1]);
    });
  };

  /**
   * Load from URL paths (default auto-load).
   */
  SV.loadFromPaths = function(synthPath, validPath, chemoriginsPath) {
    return Promise.all([
      fetch(synthPath).then(function(r) { return r.json(); }),
      validPath
        ? fetch(validPath).then(function(r) { return r.json(); }).catch(function() { return null; })
        : Promise.resolve(null),
      chemoriginsPath
        ? fetch(chemoriginsPath).then(function(r) { return r.json(); }).catch(function() { return null; })
        : Promise.resolve(null)
    ]).then(function(results) {
      return buildGraphModel(results[0], results[1], results[2]);
    });
  };

  function readJSON(file) {
    return new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function(e) {
        try { resolve(JSON.parse(e.target.result)); }
        catch (err) { reject(err); }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  /**
   * Map validation step (1-indexed) to reaction ID.
   * step 1 → "rxn_001", step 12 → "rxn_012"
   */
  function buildValidationMap(validData) {
    var map = new Map();
    if (!validData || !validData.reaction_validations) return map;
    validData.reaction_validations.forEach(function(rv) {
      var rxnId = 'rxn_' + String(rv.step).padStart(3, '0');
      map.set(rxnId, rv);
    });
    return map;
  }

  function buildChemoriginsMap(chemoriginsData) {
    var map = new Map();
    if (!chemoriginsData || !chemoriginsData.reactions) return map;
    chemoriginsData.reactions.forEach(function(r) {
      if (r.reaction && r.reaction.key) {
        map.set(r.reaction.key, r);
      }
    });
    return map;
  }

  function buildGraphModel(synthData, validData, chemoriginsData) {
    var network = synthData.network || synthData;
    var validationMap = buildValidationMap(validData);
    var chemoriginsMap = buildChemoriginsMap(chemoriginsData);

    // Build molecules map
    var molecules = new Map();
    (network.molecules || []).forEach(function(m) {
      // Treat hub_intermediate as intermediate
      var role = m.role || 'intermediate';

      molecules.set(m.id, {
        id: m.id,
        type: 'molecule',
        formula: m.formula || '',
        commonName: m.common_name || m.formula || '',
        iupacName: m.iupac_name || '',
        inchi: m.inchi || '',
        role: role,
        environmentFormed: m.environment_formed || null,
        x: 0, y: 0, w: 0, h: 0,
        svgEl: null
      });
    });

    // Build reactions map and edges
    var reactions = new Map();
    var edges = [];

    (network.reactions || []).forEach(function(r) {
      var validation = validationMap.get(r.id) || null;
      var coverageScore = null;
      if (validation) {
        var bm = validation.pathway_match && validation.pathway_match.best_match;
        if (bm && bm.product_similarity != null && bm.reactant_similarity != null) {
          coverageScore = (bm.product_similarity + bm.reactant_similarity) / 2;
        } else {
          coverageScore = validation.weighted_score;
        }
      }
      var isHighCoverage = coverageScore != null && coverageScore >= 0.75;
      var num = parseInt(r.id.replace('rxn_', ''), 10);

      reactions.set(r.id, {
        id: r.id,
        type: 'reaction',
        shortId: 'rxn ' + num,
        name: r.name || r.id,
        environment: r.environment || 'Surface',
        inputs: r.inputs || [],
        outputs: r.outputs || [],
        agents: r.agents || [],
        conditions: r.conditions || {},
        mechanism: r.mechanism || '',
        reasoning: r.reasoning || '',
        validation: validation,
        isHighCoverage: isHighCoverage,
        x: 0, y: 0, w: 0, h: 0,
        svgEl: null
      });

      // Create edges: molecule → reaction (inputs)
      (r.inputs || []).forEach(function(inputId) {
        edges.push({
          id: inputId + '>' + r.id,
          sourceId: inputId,
          targetId: r.id,
          svgEl: null
        });
      });

      // Create edges: reaction → molecule (outputs)
      (r.outputs || []).forEach(function(outputId) {
        edges.push({
          id: r.id + '>' + outputId,
          sourceId: r.id,
          targetId: outputId,
          svgEl: null
        });
      });
    });

    var pathways = (network.pathways || []).map(function(p) {
      return {
        id: p.pathway_id || p.id || '',
        name: p.name || '',
        description: p.description || '',
        reactionSequence: p.reaction_sequence || p.reactions || [],
        keyIntermediates: p.key_intermediates || []
      };
    });

    var meta = {
      targetMolecule: network.target_molecule || synthData.target_molecule || 'Unknown',
      overallAlignmentScore: validData ? validData.overall_alignment_score : null,
      overallStrategy: network.overall_strategy || ''
    };

    // Extract evaluation data (network_feedback, pathway_evaluations, etc.)
    var evaluation = synthData.evaluation || null;
    var pathwayEvalMap = new Map();
    if (evaluation && evaluation.pathway_evaluations) {
      evaluation.pathway_evaluations.forEach(function(pe) {
        pathwayEvalMap.set(pe.pathway_id, pe);
      });
    }

    return {
      molecules: molecules,
      reactions: reactions,
      edges: edges,
      pathways: pathways,
      validationMap: validationMap,
      chemoriginsMap: chemoriginsMap,
      meta: meta,
      evaluation: evaluation,
      pathwayEvalMap: pathwayEvalMap
    };
  }

})();
