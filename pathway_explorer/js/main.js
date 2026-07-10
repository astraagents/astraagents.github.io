/**
 * main.js — Application entry point.
 * Wires together all modules and handles UI events.
 */
(function() {
  'use strict';

  var SV = window.SynthVis;

  var fullGraph = null;      // always holds the complete graph
  var currentGraph = null;   // currently rendered graph (full or filtered)

  // Parsed file index rows from file_index.csv
  var fileIndex = [];

  function init() {
    var cyContainer = document.getElementById('cy');
    if (!cyContainer) return;

    SV.initCytoscape(cyContainer);
    setupUIHandlers();
    setupCytoscapeCallbacks();

    // Load file index, then populate dropdowns and auto-load default
    loadFileIndex().then(function() {
      // Molecule-first: populate all molecules, then cascade to model/config/attempt
      populateMoleculeDropdownAll();
      var molSelect = document.getElementById('select-molecule');
      if (molSelect.querySelector('option[value="L_Alanine"]')) {
        molSelect.value = 'L_Alanine';
      }
      onMoleculeChange(false);
      var modelSelect = document.getElementById('select-model');
      if (modelSelect.querySelector('option[value="claude_opus4.6"]')) {
        modelSelect.value = 'claude_opus4.6';
      }
      onModelChange(false);
      var cfgSelect = document.getElementById('select-config');
      if (cfgSelect.querySelector('option[value="deep_research_claude"]')) {
        cfgSelect.value = 'deep_research_claude';
      }
      onConfigChange(false);
      var lastAtt = getLastAttempt(modelSelect.value, molSelect.value, cfgSelect.value);
      document.getElementById('select-attempt').value = lastAtt;
      loadSelectedDataset();
    }).catch(function(err) {
      console.error('Failed to load file_index.csv:', err);
      showStatus('Error loading file index.');
    });
  }

  // ===== File Index =====

  function loadFileIndex() {
    return fetch('file_index.csv')
      .then(function(r) { return r.text(); })
      .then(function(text) {
        var lines = text.trim().split('\n');
        var headers = lines[0].split(',');
        fileIndex = [];
        for (var i = 1; i < lines.length; i++) {
          var cols = lines[i].split(',');
          if (cols.length < headers.length) continue;
          var row = {};
          for (var j = 0; j < headers.length; j++) {
            row[headers[j].trim()] = cols[j].trim();
          }
          fileIndex.push(row);
        }
      });
  }

  // ===== Dataset Selectors =====

  var MODEL_LABELS = {
    'claude_opus4.6': 'Claude Opus 4.6 Extended Thinking',
    'gpt41': 'GPT 4.1',
    'gpt5.4': 'GPT 5.4 High Reasoning'
  };

  var CONFIG_LABELS = {
    'deep_research_claude': 'Deep Research (Claude)',
    'deep_research_gemini': 'Deep Research (Gemini)',
    'deep_research_gpt5.4': 'Deep Research (GPT 5.4)',
    'perfect_rag': 'Perfect RAG',
    'no_research': 'No Research'
  };

  function populateMoleculeDropdownAll() {
    var select = document.getElementById('select-molecule');
    var seen = {};
    select.innerHTML = '';
    fileIndex.forEach(function(row) {
      if (!seen[row.molecule]) {
        seen[row.molecule] = true;
        var opt = document.createElement('option');
        opt.value = row.molecule;
        opt.textContent = row.molecule.replace(/_/g, ' ');
        select.appendChild(opt);
      }
    });
  }

  function populateModelDropdown(molecule) {
    var select = document.getElementById('select-model');
    var seen = {};
    select.innerHTML = '';
    fileIndex.forEach(function(row) {
      if (row.molecule === molecule && !seen[row.model]) {
        seen[row.model] = true;
        var opt = document.createElement('option');
        opt.value = row.model;
        opt.textContent = MODEL_LABELS[row.model] || row.model;
        select.appendChild(opt);
      }
    });
  }

  function populateConfigDropdown(model, molecule) {
    var select = document.getElementById('select-config');
    var seen = {};
    select.innerHTML = '';
    fileIndex.forEach(function(row) {
      if (row.model === model && row.molecule === molecule && !seen[row.config]) {
        seen[row.config] = true;
        var opt = document.createElement('option');
        opt.value = row.config;
        opt.textContent = CONFIG_LABELS[row.config] || row.config;
        select.appendChild(opt);
      }
    });
  }

  function populateAttemptDropdown(model, molecule, config) {
    var select = document.getElementById('select-attempt');
    select.innerHTML = '';
    var attempts = [];
    fileIndex.forEach(function(row) {
      if (row.model === model && row.molecule === molecule && row.config === config && row.attempt !== '') {
        attempts.push(row.attempt);
      }
    });
    attempts.forEach(function(att) {
      var opt = document.createElement('option');
      opt.value = att;
      opt.textContent = 'Attempt ' + att;
      select.appendChild(opt);
    });
  }

  function getLastAttempt(model, molecule, config) {
    var last = '1';
    fileIndex.forEach(function(row) {
      if (row.model === model && row.molecule === molecule && row.config === config && row.attempt !== '') {
        if (row.attempt > last) {
          last = row.attempt;
        }
      }
    });
    return last;
  }

  function onMoleculeChange(autoLoad) {
    var molecule = document.getElementById('select-molecule').value;
    populateModelDropdown(molecule);
    onModelChange(false);
    if (autoLoad !== false) loadSelectedDataset();
  }

  function onModelChange(autoLoad) {
    var molecule = document.getElementById('select-molecule').value;
    var model = document.getElementById('select-model').value;
    populateConfigDropdown(model, molecule);
    var config = document.getElementById('select-config').value;
    populateAttemptDropdown(model, molecule, config);
    var lastAtt = getLastAttempt(model, molecule, config);
    document.getElementById('select-attempt').value = lastAtt;
    if (autoLoad !== false) loadSelectedDataset();
  }

  function onConfigChange(autoLoad) {
    var model = document.getElementById('select-model').value;
    var molecule = document.getElementById('select-molecule').value;
    var config = document.getElementById('select-config').value;
    populateAttemptDropdown(model, molecule, config);
    var lastAtt = getLastAttempt(model, molecule, config);
    document.getElementById('select-attempt').value = lastAtt;
    if (autoLoad !== false) loadSelectedDataset();
  }

  function onAttemptChange() {
    loadSelectedDataset();
  }

  function findSelectedRow() {
    var model = document.getElementById('select-model').value;
    var molecule = document.getElementById('select-molecule').value;
    var config = document.getElementById('select-config').value;
    var attempt = document.getElementById('select-attempt').value;
    for (var i = 0; i < fileIndex.length; i++) {
      var row = fileIndex[i];
      if (row.model === model && row.molecule === molecule && row.config === config && row.attempt === attempt) {
        return row;
      }
    }
    return null;
  }

  // ---- Canvas state save/load ----

  var SLIDER_IDS = [
    'font-size-slider', 'mol-size-slider', 'mol-width-slider', 'mol-border-slider',
    'rxn-border-slider', 'rxn-hc-border-slider', 'rxn-size-slider',
    'edge-width-slider'
  ];
  var TOGGLE_IDS = ['mol-labels-toggle', 'label-drag-toggle', 'snap-align-toggle'];
  var RADIO_NAMES = ['layout-dir', 'pw-mode', 'image-mode'];

  function collectSettings() {
    var s = { sliders: {}, toggles: {}, radios: {} };
    SLIDER_IDS.forEach(function(id) { s.sliders[id] = document.getElementById(id).value; });
    TOGGLE_IDS.forEach(function(id) { s.toggles[id] = document.getElementById(id).checked; });
    RADIO_NAMES.forEach(function(name) {
      var el = document.querySelector('input[name="' + name + '"]:checked');
      if (el) s.radios[name] = el.value;
    });
    s.canvasWidthMm = document.getElementById('canvas-width-mm').value;
    s.canvasHeightMm = document.getElementById('canvas-height-mm').value;
    return s;
  }

  function applySettings(s) {
    if (!s) return;
    if (s.sliders) {
      SLIDER_IDS.forEach(function(id) {
        if (s.sliders[id] != null) {
          var el = document.getElementById(id);
          el.value = s.sliders[id];
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    }
    if (s.toggles) {
      TOGGLE_IDS.forEach(function(id) {
        if (s.toggles[id] != null) {
          var el = document.getElementById(id);
          el.checked = !!s.toggles[id];
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }
    if (s.radios) {
      RADIO_NAMES.forEach(function(name) {
        var val = s.radios[name];
        if (val == null) return;
        var el = document.querySelector('input[name="' + name + '"][value="' + val + '"]');
        if (el) {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    }
    if (s.canvasWidthMm != null) document.getElementById('canvas-width-mm').value = s.canvasWidthMm;
    if (s.canvasHeightMm != null) document.getElementById('canvas-height-mm').value = s.canvasHeightMm;
    // Note: do NOT dispatch change on canvas inputs — that would re-scale node positions.
    // The bbox is restored separately below in applyCanvasState().
  }

  function saveCanvasState() {
    if (!SV.cy) { showStatus('Nothing to save.'); return; }
    var nodes = [];
    SV.cy.nodes().forEach(function(n) {
      var p = n.position();
      nodes.push({
        id: n.id(),
        x: p.x,
        y: p.y,
        labelOffsetX: parseFloat(n.data('labelOffsetX')) || 0,
        labelOffsetY: parseFloat(n.data('labelOffsetY')) || 0,
        labelTop: n.hasClass('label-top')
      });
    });
    var state = {
      version: 1,
      savedAt: new Date().toISOString(),
      dataset: {
        model: document.getElementById('select-model').value,
        molecule: document.getElementById('select-molecule').value,
        config: document.getElementById('select-config').value,
        attempt: document.getElementById('select-attempt').value
      },
      settings: collectSettings(),
      viewport: { zoom: SV.cy.zoom(), pan: SV.cy.pan() },
      pathway: (document.getElementById('pathway-select') ? document.getElementById('pathway-select').value : '__all__'),
      figureMode: !!((SV.figureMode && SV.figureMode.isActive) || (function() {
        var b = document.getElementById('btn-figure-mode');
        if (b && /disable/i.test((b.textContent || '').trim())) return true;
        if (SV.cy && SV.cy.nodes('.fm-rxn, .fm-mol').length > 0) return true;
        return false;
      })()),
      figureModeBtnText: (function() {
        var b = document.getElementById('btn-figure-mode');
        return b ? b.textContent : null;
      })(),
      nodes: nodes,
      canvasBBox: SV._canvasBBox,
      canvasLimitW: SV._canvasLimitW,
      canvasLimitH: SV._canvasLimitH
    };
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var mol = (currentGraph && currentGraph.meta && currentGraph.meta.targetMolecule) || state.dataset.molecule || 'canvas';
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = 'canvas_state_' + mol + '_' + ts + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus('Canvas state saved.');
  }

  function applyCanvasState(state) {
    applySettings(state.settings);
    if (state.pathway && state.pathway !== '__all__') {
      var psel = document.getElementById('pathway-select');
      if (psel) {
        var hasOption = false;
        for (var i = 0; i < psel.options.length; i++) {
          if (psel.options[i].value === state.pathway) { hasOption = true; break; }
        }
        if (hasOption) {
          psel.value = state.pathway;
          psel.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          showStatus('Saved pathway "' + state.pathway + '" not found; loading whole network.');
        }
      }
    }
    if (SV.cy && Array.isArray(state.nodes)) {
      state.nodes.forEach(function(n) {
        var node = SV.cy.getElementById(n.id);
        if (node && node.length) {
          node.position({ x: n.x, y: n.y });
          if (n.labelOffsetX) node.data('labelOffsetX', n.labelOffsetX);
          if (n.labelOffsetY) node.data('labelOffsetY', n.labelOffsetY);
          if (n.labelTop) node.addClass('label-top');
        }
      });
    }
    if (SV.cy && state.viewport) {
      if (state.viewport.zoom != null) SV.cy.zoom(state.viewport.zoom);
      if (state.viewport.pan) SV.cy.pan(state.viewport.pan);
    }
    if (state.canvasLimitW && state.canvasLimitH && typeof SV.setCanvasLimit === 'function') {
      SV.setCanvasLimit(state.canvasLimitW, state.canvasLimitH);
    }
    if (state.canvasBBox) {
      SV._canvasBBox = state.canvasBBox;
      SV._canvasLimitW = state.canvasLimitW || null;
      SV._canvasLimitH = state.canvasLimitH || null;
      if (SV._updateBBoxOverlay) {
        SV._updateBBoxOverlay();
        SV.cy.off('pan zoom', SV._updateBBoxOverlay);
        SV.cy.on('pan zoom', SV._updateBBoxOverlay);
      }
    }
    showStatus('Canvas state loaded.');
  }

  function loadCanvasState(file) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var state;
      try {
        state = JSON.parse(e.target.result);
      } catch (err) {
        showStatus('Invalid state file: ' + err.message);
        return;
      }
      var ds = state.dataset || {};
      var cur = {
        model: document.getElementById('select-model').value,
        molecule: document.getElementById('select-molecule').value,
        config: document.getElementById('select-config').value,
        attempt: document.getElementById('select-attempt').value
      };
      var sameDataset = ds.model === cur.model && ds.molecule === cur.molecule &&
                        ds.config === cur.config && ds.attempt === cur.attempt;
      if (!sameDataset && ds.model) {
        // Set selectors and reload (molecule first, then repopulate model dropdown)
        if (ds.molecule) {
          document.getElementById('select-molecule').value = ds.molecule;
          populateModelDropdown(ds.molecule);
        }
        if (ds.model) document.getElementById('select-model').value = ds.model;
        if (ds.config) document.getElementById('select-config').value = ds.config;
        if (ds.attempt) document.getElementById('select-attempt').value = ds.attempt;
        var row = findSelectedRow();
        if (!row) {
          showStatus('No matching dataset found for saved state.');
          return;
        }
        showStatus('Loading dataset...');
        var chemoriginsPath = 'chemorigins/' + row.molecule + '.json';
        SV.loadFromPaths(row.synthesis_network_path, row.validation_path, chemoriginsPath)
          .then(function(graph) {
            fullGraph = graph;
            currentGraph = graph;
            renderAll(graph);
            // Defer until after render completes
            setTimeout(function() { applyCanvasState(state); }, 50);
          })
          .catch(function(err) {
            showStatus('Error: ' + err.message);
            console.error(err);
          });
      } else {
        applyCanvasState(state);
      }
    };
    reader.readAsText(file);
  }

  function loadSelectedDataset() {
    var row = findSelectedRow();
    if (!row) {
      showStatus('No matching dataset found.');
      return;
    }
    showStatus('Loading...');
    var chemoriginsPath = 'chemorigins/' + row.molecule + '.json';
    SV.loadFromPaths(row.synthesis_network_path, row.validation_path, chemoriginsPath)
      .then(function(graph) {
        fullGraph = graph;
        currentGraph = graph;
        renderAll(graph);
      })
      .catch(function(err) {
        showStatus('Error: ' + err.message);
        console.error(err);
      });
  }

  function renderAll(graph, skipPathwayPopulate) {
    currentGraph = graph;
    SV._currentGraph = graph;

    var positions = SV.computeLayout(graph.molecules, graph.reactions, graph.edges);

    // Store positions on model nodes
    positions.forEach(function(pos, id) {
      var node = graph.molecules.get(id) || graph.reactions.get(id);
      if (node) { node.x = pos.x; node.y = pos.y; node.w = pos.w; node.h = pos.h; }
    });

    // Build and render Cytoscape elements
    var elements = SV.buildCytoscapeElements(graph, positions);
    SV.cy.json({ elements: elements });
    SV.cy.layout({ name: 'preset' }).run();
    SV.cy.fit(undefined, 30);

    // Async-load PubChem images
    SV.loadPubChemImages(graph);

    // Update UI
    document.title = 'Synthesis Network: ' + graph.meta.targetMolecule;

    if (!skipPathwayPopulate) {
      populatePathwayFilter(fullGraph || graph);
    }
    renderLegend();
    updateEvalPanel(graph);

    // Re-apply canvas limit if set
    if (SV._canvasLimitW && SV._canvasLimitH) {
      SV.setCanvasLimit(SV._canvasLimitW, SV._canvasLimitH);
    }

    var nMol = graph.molecules.size;
    var nRxn = graph.reactions.size;
    var nEdge = graph.edges.length;
    showStatus(nMol + ' molecules, ' + nRxn + ' reactions, ' + nEdge + ' edges');
  }

  // ===== UI Event Handlers =====

  function setupUIHandlers() {
    // Dataset selectors
    document.getElementById('select-model').addEventListener('change', function() { onModelChange(); });
    document.getElementById('select-molecule').addEventListener('change', function() { onMoleculeChange(); });
    document.getElementById('select-config').addEventListener('change', function() { onConfigChange(); });
    document.getElementById('select-attempt').addEventListener('change', onAttemptChange);

    // Buttons
    document.getElementById('btn-export').addEventListener('click', function() {
      if (!currentGraph) return;
      SV.exportPDF(currentGraph, currentGraph.meta.targetMolecule);
    });

    document.getElementById('btn-reset').addEventListener('click', function() {
      if (!fullGraph) {
        SV.resetView();
        return;
      }
      document.getElementById('pathway-select').value = '__all__';
      renderAll(fullGraph);
    });

    document.getElementById('btn-fit').addEventListener('click', function() {
      SV.resetView();
    });

    // Re-layout button (in settings popup)
    document.getElementById('btn-relayout').addEventListener('click', function() {
      if (currentGraph) {
        renderAll(currentGraph, true);
      }
    });

    // Figure mode toggle (in settings popup)
    document.getElementById('btn-figure-mode').addEventListener('click', function() {
      var btn = this;
      if (!SV.figureMode) return;
      if (SV.figureMode.isActive) {
        SV.figureMode.disable();
        btn.textContent = 'Enable';
      } else {
        if (!currentGraph) return;
        SV.figureMode.enable(currentGraph);
        btn.textContent = 'Disable';
      }
    });

    // Zoom controls
    document.getElementById('btn-zoom-in').addEventListener('click', function() {
      SV.zoomIn();
    });
    document.getElementById('btn-zoom-out').addEventListener('click', function() {
      SV.zoomOut();
    });

    // Settings button toggle
    var settingsBtn = document.getElementById('btn-settings');
    var settingsPopup = document.getElementById('settings-popup');
    settingsBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var isOpen = settingsPopup.classList.toggle('open');
      settingsBtn.classList.toggle('active', isOpen);
    });
    // Close popup when clicking outside
    document.addEventListener('click', function(e) {
      if (!settingsPopup.contains(e.target) && e.target !== settingsBtn) {
        settingsPopup.classList.remove('open');
        settingsBtn.classList.remove('active');
      }
    });

    // Font size slider
    var fontSlider = document.getElementById('font-size-slider');
    var fontValue = document.getElementById('font-size-value');
    fontSlider.addEventListener('input', function() {
      var size = parseInt(fontSlider.value, 10);
      fontValue.textContent = size;
      SV.setFontSize(size);
    });

    // Molecule size slider
    var molSlider = document.getElementById('mol-size-slider');
    var molValue = document.getElementById('mol-size-value');
    molSlider.addEventListener('input', function() {
      var size = parseInt(molSlider.value, 10);
      molValue.textContent = size;
      SV.setMoleculeSize(size);
    });

    // Molecule width slider (independent width override)
    var molWidthSlider = document.getElementById('mol-width-slider');
    var molWidthValue = document.getElementById('mol-width-value');
    molWidthSlider.addEventListener('input', function() {
      var w = parseInt(molWidthSlider.value, 10);
      molWidthValue.textContent = w;
      SV.setMoleculeLabelWidth(w);
    });

    // Molecule border width slider
    var borderSlider = document.getElementById('mol-border-slider');
    var borderValue = document.getElementById('mol-border-value');
    borderSlider.addEventListener('input', function() {
      var w = parseInt(borderSlider.value, 10);
      borderValue.textContent = w;
      SV.setMoleculeBorderWidth(w);
    });

    // Reaction border width slider
    var rxnBorderSlider = document.getElementById('rxn-border-slider');
    var rxnBorderValue = document.getElementById('rxn-border-value');
    rxnBorderSlider.addEventListener('input', function() {
      var w = parseInt(rxnBorderSlider.value, 10);
      rxnBorderValue.textContent = w;
      SV.setReactionBorderWidth(w);
    });

    // High-coverage reaction border width slider
    var rxnHcBorderSlider = document.getElementById('rxn-hc-border-slider');
    var rxnHcBorderValue = document.getElementById('rxn-hc-border-value');
    rxnHcBorderSlider.addEventListener('input', function() {
      var w = parseInt(rxnHcBorderSlider.value, 10);
      rxnHcBorderValue.textContent = w;
      SV.setHighCoverageBorderWidth(w);
    });

    // Reaction size slider
    var rxnSlider = document.getElementById('rxn-size-slider');
    var rxnValue = document.getElementById('rxn-size-value');
    rxnSlider.addEventListener('input', function() {
      var scale = parseInt(rxnSlider.value, 10);
      rxnValue.textContent = scale;
      SV.setReactionSize(scale);
    });

    // Edge width slider
    var edgeSlider = document.getElementById('edge-width-slider');
    var edgeValue = document.getElementById('edge-width-value');
    edgeSlider.addEventListener('input', function() {
      var w = parseFloat(edgeSlider.value);
      edgeValue.textContent = w;
      SV.setEdgeWidth(w);
    });

    // Molecule labels toggle
    document.getElementById('mol-labels-toggle').addEventListener('change', function() {
      SV.setMoleculeLabelsVisible(this.checked);
    });

    // Label drag toggle
    document.getElementById('label-drag-toggle').addEventListener('change', function() {
      SV.setLabelDragging(this.checked);
    });

    // Snap align toggle
    document.getElementById('snap-align-toggle').addEventListener('change', function() {
      SV._snapAlign = this.checked;
    });

    // Canvas size limit (width x height)
    var canvasWidthInput = document.getElementById('canvas-width-mm');
    var canvasHeightInput = document.getElementById('canvas-height-mm');
    function onCanvasSizeChange() {
      var w = canvasWidthInput.value ? parseFloat(canvasWidthInput.value) : null;
      var h = canvasHeightInput.value ? parseFloat(canvasHeightInput.value) : null;
      SV.setCanvasLimit(w, h);
    }
    canvasWidthInput.addEventListener('change', onCanvasSizeChange);
    canvasHeightInput.addEventListener('change', onCanvasSizeChange);

    // Save / Load canvas state
    document.getElementById('btn-save-state').addEventListener('click', saveCanvasState);
    document.getElementById('btn-load-state').addEventListener('click', function() {
      document.getElementById('state-file-input').click();
    });
    document.getElementById('state-file-input').addEventListener('change', function(e) {
      var file = e.target.files && e.target.files[0];
      if (file) loadCanvasState(file);
      e.target.value = '';
    });

    // Image toggle
    document.querySelectorAll('input[name="image-mode"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        radio.closest('.mode-toggle-group').querySelectorAll('.mode-toggle').forEach(function(label) {
          label.classList.toggle('active', label.querySelector('input').checked);
        });
        var mode = document.querySelector('input[name="image-mode"]:checked').value;
        SV.toggleImages(mode);
      });
    });

    // Pathway filter
    document.getElementById('pathway-select').addEventListener('change', onPathwayFilter);

    // Mode toggle (Highlight / Isolate) — scoped to its own toggle group
    document.querySelectorAll('input[name="pw-mode"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        radio.closest('.mode-toggle-group').querySelectorAll('.mode-toggle').forEach(function(label) {
          label.classList.toggle('active', label.querySelector('input').checked);
        });
        // Re-apply current pathway filter with new mode
        onPathwayFilter({ target: document.getElementById('pathway-select') });
      });
    });

    // Layout direction toggle (Vertical / Horizontal)
    document.querySelectorAll('input[name="layout-dir"]').forEach(function(radio) {
      radio.addEventListener('change', function() {
        radio.closest('.mode-toggle-group').querySelectorAll('.mode-toggle').forEach(function(label) {
          label.classList.toggle('active', label.querySelector('input').checked);
        });
        SV.layoutDirection = document.querySelector('input[name="layout-dir"]:checked').value;
        if (currentGraph) {
          renderAll(currentGraph, true);
        }
      });
    });

    // Evaluation panel minimize/maximize toggle
    document.getElementById('eval-panel-toggle').addEventListener('click', function() {
      var panel = document.getElementById('eval-panel');
      var btn = document.getElementById('eval-panel-toggle');
      panel.classList.toggle('minimized');
      btn.innerHTML = panel.classList.contains('minimized') ? '&#x002B;' : '&#x2212;';
      btn.title = panel.classList.contains('minimized') ? 'Expand' : 'Minimize';
    });

    // Reports dropdown
    document.getElementById('btn-reports').addEventListener('click', function(e) {
      e.stopPropagation();
      document.getElementById('view-dropdown').classList.remove('open');
      document.getElementById('reports-dropdown').classList.toggle('open');
    });

    // View dropdown (ChemOrigins / Fit / Reset)
    document.getElementById('btn-view').addEventListener('click', function(e) {
      e.stopPropagation();
      document.getElementById('reports-dropdown').classList.remove('open');
      document.getElementById('view-dropdown').classList.toggle('open');
    });

    document.addEventListener('click', function() {
      document.getElementById('reports-dropdown').classList.remove('open');
      document.getElementById('view-dropdown').classList.remove('open');
    });

    document.getElementById('reports-dropdown').addEventListener('click', function(e) {
      var btn = e.target.closest('[data-report]');
      if (!btn) return;
      var molecule = document.getElementById('select-molecule').value;
      if (!molecule) return;
      var report = btn.getAttribute('data-report');
      var title, url;
      if (report === 'deep-research-claude') {
        title = 'Deep Research (Claude) — ' + molecule.replace(/_/g, ' ');
        url = 'deep_research_claude/' + molecule.replace(/_/g, '-') + '-Run1.txt';
      } else if (report === 'deep-research-gemini') {
        title = 'Deep Research (Gemini) — ' + molecule.replace(/_/g, ' ');
        url = 'deep_research_gemini/' + molecule.replace(/_/g, '-') + '-Run1.txt';
      } else if (report === 'deep-research-gpt') {
        title = 'Deep Research (GPT 5.4) — ' + molecule.replace(/_/g, ' ');
        url = 'deep_research_gpt5.4/' + molecule.replace(/_/g, '-') + '-Run1.txt';
      } else if (report === 'perfect-rag') {
        title = 'Perfect RAG — ' + molecule.replace(/_/g, ' ');
        url = 'perfect_rag/' + molecule + '.md';
      }
      if (title && url) loadMarkdownReport(title, url, 'raw');
      document.getElementById('reports-dropdown').classList.remove('open');
    });

    // Meta Evaluation modal
    var META_EVAL_MODELS = [
      { dir: 'claude_opus4.6', label: 'Claude Opus 4.6' },
      { dir: 'gpt41', label: 'GPT 4.1' },
      { dir: 'gpt5.4', label: 'GPT 5.4' }
    ];

    var SYNTH_TO_META_MODEL = {
      'claude_opus4.6': 'claude_opus4.6',
      'gpt4.1': 'gpt41'
    };

    function openMetaEval() {
      var molecule = document.getElementById('select-molecule').value;
      if (!molecule) return;
      var synthModel = document.getElementById('select-model').value;
      var metaModel = SYNTH_TO_META_MODEL[synthModel] || META_EVAL_MODELS[0].dir;

      // Populate model dropdown
      var modelSelect = document.getElementById('meta-eval-model');
      modelSelect.innerHTML = '';
      META_EVAL_MODELS.forEach(function(m) {
        var opt = document.createElement('option');
        opt.value = m.dir;
        opt.textContent = m.label;
        if (m.dir === metaModel) opt.selected = true;
        modelSelect.appendChild(opt);
      });

      // Populate run buttons
      var runsContainer = document.getElementById('meta-eval-runs');
      runsContainer.innerHTML = '';
      for (var i = 1; i <= 5; i++) {
        var btn = document.createElement('button');
        btn.className = 'run-btn' + (i === 1 ? ' active' : '');
        btn.setAttribute('data-run', i);
        btn.textContent = 'Run ' + i;
        runsContainer.appendChild(btn);
      }

      // Update title
      document.getElementById('meta-eval-title').textContent =
        'Meta Evaluation — ' + molecule.replace(/_/g, ' ');

      document.getElementById('meta-eval-backdrop').classList.add('open');
      loadMetaEvalContent(metaModel, molecule, 1);
    }

    function loadMetaEvalContent(modelDir, molecule, run) {
      var molName = molecule.replace(/_/g, '-');
      var mdUrl = 'meta_evaluations/' + modelDir + '/' + molName + '-Run' + run + '.md';
      var radarUrl = 'meta_evaluations/' + modelDir + '/' + modelDir + '_criterion_radar.png';

      // Update radar image
      document.getElementById('meta-eval-radar-img').src = radarUrl;

      // Load and render markdown
      var contentEl = document.getElementById('meta-eval-content');
      contentEl.innerHTML = '<div class="md-modal-empty">Loading...</div>';
      fetch(mdUrl).then(function(resp) {
        if (!resp.ok) throw new Error('not found');
        return resp.text();
      }).then(function(text) {
        contentEl.innerHTML = marked.parse(text);
      }).catch(function() {
        contentEl.innerHTML = '<div class="md-modal-empty">No evaluation found for this combination.</div>';
      });
    }

    function closeMetaEval() {
      document.getElementById('meta-eval-backdrop').classList.remove('open');
    }

    document.getElementById('btn-meta-eval').addEventListener('click', openMetaEval);

    document.getElementById('meta-eval-close').addEventListener('click', closeMetaEval);
    document.getElementById('meta-eval-backdrop').addEventListener('click', function(e) {
      if (e.target === this) closeMetaEval();
    });

    document.getElementById('meta-eval-model').addEventListener('change', function() {
      var molecule = document.getElementById('select-molecule').value;
      if (!molecule) return;
      var activeRun = document.querySelector('#meta-eval-runs .run-btn.active');
      var run = activeRun ? parseInt(activeRun.getAttribute('data-run')) : 1;
      loadMetaEvalContent(this.value, molecule, run);
    });

    document.getElementById('meta-eval-runs').addEventListener('click', function(e) {
      var btn = e.target.closest('.run-btn');
      if (!btn) return;
      this.querySelectorAll('.run-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      var molecule = document.getElementById('select-molecule').value;
      if (!molecule) return;
      var modelDir = document.getElementById('meta-eval-model').value;
      loadMetaEvalContent(modelDir, molecule, parseInt(btn.getAttribute('data-run')));
    });

    // Modal close handlers
    document.getElementById('md-modal-close').addEventListener('click', closeMarkdownModal);
    document.getElementById('md-modal-backdrop').addEventListener('click', function(e) {
      if (e.target === this) closeMarkdownModal();
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (document.getElementById('meta-eval-backdrop').classList.contains('open')) {
          closeMetaEval();
        } else if (document.getElementById('md-modal-backdrop').classList.contains('open')) {
          closeMarkdownModal();
        }
      }
      // Ctrl/Cmd+A: Horizontal align center (same X)
      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        SV.alignSelectedHorizontal();
      }
      // Ctrl/Cmd+S: Vertical align center (same Y)
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        SV.alignSelectedVertical();
      }
    });

    // ChemOrigins side panel
    document.getElementById('btn-chemorigins').addEventListener('click', function() {
      var panel = document.getElementById('chemorigins-panel');
      if (panel.classList.contains('open')) {
        panel.classList.remove('open');
        return;
      }
      var molecule = document.getElementById('select-molecule').value;
      if (!molecule) return;
      document.getElementById('chemorigins-panel-img').src = 'chemorigins/' + molecule + '.png';
      panel.classList.add('open');
    });

    document.getElementById('chemorigins-panel-close').addEventListener('click', function() {
      document.getElementById('chemorigins-panel').classList.remove('open');
    });

    // Sidebar close
    document.getElementById('sidebar-close').addEventListener('click', closeSidebar);
  }

  // ===== Cytoscape Event Callbacks =====

  function setupCytoscapeCallbacks() {
    SV._onNodeTap = function(nodeId) {
      if (!currentGraph) return;
      openSidebar(nodeId, currentGraph);
    };

    SV._onBackgroundTap = function() {
      closeSidebar();
    };

    SV._onNodeCxttap = function(nodeId, screenPos) {
      if (SV.showContextMenu) {
        SV.showContextMenu(nodeId, screenPos.x, screenPos.y);
      }
    };
  }

  // ===== Pathway Filter =====

  function populatePathwayFilter(graph) {
    var select = document.getElementById('pathway-select');
    select.innerHTML = '<option value="__all__">Whole Network</option>';
    (graph.pathways || []).forEach(function(pw) {
      var opt = document.createElement('option');
      opt.value = pw.id;
      opt.textContent = pw.id + ': ' + SV.truncate(pw.name, 35);
      select.appendChild(opt);
    });
  }

  function getViewMode() {
    var checked = document.querySelector('input[name="pw-mode"]:checked');
    return checked ? checked.value : 'highlight';
  }

  function onPathwayFilter(e) {
    var val = e.target.value;
    if (!fullGraph) return;

    var mode = getViewMode();

    if (val === '__all__') {
      // Restore full graph
      renderAll(fullGraph, true);
      updateEvalPanel(fullGraph);
      return;
    }

    var pathway = fullGraph.pathways.find(function(p) { return p.id === val; });
    if (!pathway) return;

    if (mode === 'isolate') {
      // Build sub-graph and re-render with fresh layout
      var subgraph = buildPathwaySubgraph(fullGraph, pathway);
      renderAll(subgraph, true);
      updateEvalPanelForPathway(fullGraph, val);
    } else {
      // Highlight mode: render full graph, dim non-pathway nodes
      if (currentGraph !== fullGraph) {
        renderAll(fullGraph, true);
      }

      var rxnSet = new Set(pathway.reactionSequence);
      var molSet = new Set();

      rxnSet.forEach(function(rxnId) {
        var rxn = fullGraph.reactions.get(rxnId);
        if (rxn) {
          rxn.inputs.forEach(function(id) { molSet.add(id); });
          rxn.outputs.forEach(function(id) { molSet.add(id); });
        }
      });

      // Dim all elements, then undim pathway members
      SV.cy.elements().addClass('dimmed');

      molSet.forEach(function(id) {
        SV.cy.getElementById(id).removeClass('dimmed');
      });
      rxnSet.forEach(function(id) {
        var cyNode = SV.cy.getElementById(id);
        cyNode.removeClass('dimmed');
        // Also undim edges connected to pathway reactions
        cyNode.connectedEdges().forEach(function(edge) {
          var otherId = edge.source().id() === id ? edge.target().id() : edge.source().id();
          if (molSet.has(otherId) || rxnSet.has(otherId)) {
            edge.removeClass('dimmed');
          }
        });
      });

      updateEvalPanelForPathway(fullGraph, val);
    }
  }

  /**
   * Build a filtered sub-graph containing only the reactions in a pathway
   * and the molecules they consume/produce.
   */
  function buildPathwaySubgraph(graph, pathway) {
    var rxnIds = new Set(pathway.reactionSequence);
    var molIds = new Set();

    // Collect all molecules referenced by pathway reactions
    rxnIds.forEach(function(rxnId) {
      var rxn = graph.reactions.get(rxnId);
      if (rxn) {
        rxn.inputs.forEach(function(id) { molIds.add(id); });
        rxn.outputs.forEach(function(id) { molIds.add(id); });
      }
    });

    // Build filtered molecules map
    var filteredMols = new Map();
    molIds.forEach(function(id) {
      var mol = graph.molecules.get(id);
      if (mol) {
        // Clone to avoid mutating the original
        filteredMols.set(id, Object.assign({}, mol, { svgEl: null }));
      }
    });

    // Build filtered reactions map
    var filteredRxns = new Map();
    rxnIds.forEach(function(id) {
      var rxn = graph.reactions.get(id);
      if (rxn) {
        filteredRxns.set(id, Object.assign({}, rxn, { svgEl: null }));
      }
    });

    // Build filtered edges (only those connecting nodes in the sub-graph)
    var allNodeIds = new Set(molIds);
    rxnIds.forEach(function(id) { allNodeIds.add(id); });

    var filteredEdges = graph.edges
      .filter(function(e) {
        return allNodeIds.has(e.sourceId) && allNodeIds.has(e.targetId);
      })
      .map(function(e) {
        return Object.assign({}, e, { svgEl: null });
      });

    return {
      molecules: filteredMols,
      reactions: filteredRxns,
      edges: filteredEdges,
      pathways: [pathway],
      validationMap: graph.validationMap,
      evaluation: graph.evaluation,
      pathwayEvalMap: graph.pathwayEvalMap,
      meta: Object.assign({}, graph.meta, {
        targetMolecule: graph.meta.targetMolecule + ' \u2014 ' + pathway.id
      })
    };
  }

  // ===== Node Click → Sidebar =====

  function openSidebar(nodeId, graph) {
    var sidebar = document.getElementById('sidebar');
    var content = document.getElementById('sidebar-content');

    var isMol = graph.molecules.has(nodeId);
    var node = isMol ? graph.molecules.get(nodeId) : graph.reactions.get(nodeId);

    if (isMol) {
      document.getElementById('sidebar-title').textContent = 'Molecule Details';
      content.innerHTML = buildMoleculeSidebar(node);
    } else {
      document.getElementById('sidebar-title').textContent = 'Reaction Details';
      content.innerHTML = buildReactionSidebar(node, graph);
    }

    sidebar.classList.add('open');
  }

  function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
  }

  function buildMoleculeSidebar(mol) {
    var roleLabel = mol.role.replace(/_/g, ' ');
    var roleClass = mol.role;

    var html = '';

    // PubChem 2D structure image
    var lookupName = mol.commonName || mol.iupacName || mol.formula;
    if (lookupName) {
      var imgUrl = SV.pubchemImageUrl(lookupName, '300x300');
      var imgId = 'sidebar-pubchem-img';
      html += '<div class="sidebar-section" style="text-align:center;">';
      html += '  <img id="' + imgId + '" src="' + escapeHtml(imgUrl) + '" alt="2D structure of ' + escapeHtml(lookupName) + '"';
      html += '    style="max-width:100%;max-height:200px;border-radius:8px;background:#fff;border:1px solid var(--border-color);"';
      html += '    onerror="this.style.display=\'none\'">';
      html += '</div>';
    }

    html += '<div class="sidebar-section">';
    html += '  <h4>Identity</h4>';
    html += '  <div style="font-size:16px;font-weight:700;margin-bottom:4px;">' + escapeHtml(mol.formula) + '</div>';
    html += '  <div style="color:var(--text-secondary);font-size:13px;">' + escapeHtml(mol.commonName) + '</div>';
    if (mol.iupacName && mol.iupacName !== mol.commonName) {
      html += '  <div style="color:var(--text-muted);font-size:11px;margin-top:3px;">' + escapeHtml(mol.iupacName) + '</div>';
    }
    if (mol.inchi) {
      html += '  <div style="color:var(--text-muted);font-size:9px;margin-top:3px;word-break:break-all;">' + escapeHtml(mol.inchi) + '</div>';
    }
    html += '</div>';

    html += '<div class="sidebar-section">';
    html += '  <h4>Role</h4>';
    html += '  <span class="badge badge-role badge-' + roleClass + '">' + roleLabel + '</span>';
    html += '</div>';

    if (mol.environmentFormed) {
      html += '<div class="sidebar-section">';
      html += '  <h4>Environment Formed</h4>';
      html += '  <span class="badge badge-env badge-' + mol.environmentFormed + '">' + mol.environmentFormed + '</span>';
      html += '</div>';
    }

    return html;
  }

  function buildSimScoreBar(label, score) {
    if (score == null) return '';
    var pct = (score * 100).toFixed(0);
    var color = SV.scoreColor(score);
    return '<div class="score-row">' +
           '<span class="score-label">' + escapeHtml(label) + '</span>' +
           '<div class="score-bar-bg"><div class="score-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
           '<span class="score-value" style="color:' + color + '">' + pct + '%</span>' +
           '</div>';
  }

  function buildChemoriginsRef(v, graph) {
    var html = '';
    var chemMap = graph && graph.chemoriginsMap;
    if (!chemMap || chemMap.size === 0) return html;
    if (!v.pathway_match) return html;

    // Determine which match to display: best_match if valid, otherwise top from matches[]
    var match = null;
    var bm = v.pathway_match.best_match;
    if (bm && bm.match_type && bm.match_type !== 'none' && bm.matched_reaction_key) {
      match = bm;
    } else if (v.pathway_match.matches && v.pathway_match.matches.length > 0) {
      match = v.pathway_match.matches[0];
    }
    if (!match || !match.matched_reaction_key) return html;

    var ref = chemMap.get(match.matched_reaction_key);
    if (!ref) return html;

    html += '<div class="chemorigins-ref">';
    html += '<h5>ChemOrigins Reference</h5>';

    // Reaction key
    html += '<div class="ref-key">' + escapeHtml(match.matched_reaction_key) + '</div>';

    // Reaction string: Reactants -> Products
    var reactantStrs = (ref.reactants || []).map(function(m) {
      var name = m.title && m.title !== 'None' ? ' (' + m.title + ')' : '';
      return m.formula + name;
    });
    var productStrs = (ref.products || []).map(function(m) {
      var name = m.title && m.title !== 'None' ? ' (' + m.title + ')' : '';
      return m.formula + name;
    });
    if (reactantStrs.length > 0 || productStrs.length > 0) {
      html += '<div class="ref-reaction-str">' +
              escapeHtml(reactantStrs.join(' + ') + ' \u2192 ' + productStrs.join(' + ')) +
              '</div>';
    }

    // Similarity scores
    var prodSim = match.product_similarity;
    var reactSim = match.reactant_similarity;
    var coverage = (prodSim != null && reactSim != null)
      ? (prodSim + reactSim) / 2
      : null;

    html += '<div style="margin-top:6px;">';
    html += buildSimScoreBar('Product Similarity', prodSim);
    html += buildSimScoreBar('Reactant Similarity', reactSim);
    html += buildSimScoreBar('Coverage Score', coverage);
    html += '</div>';

    // Source citation from chemorigins
    if (ref.conditions && ref.conditions.length > 0 && ref.conditions[0].sources) {
      var src = ref.conditions[0].sources;
      html += '<div style="margin-top:6px;">';
      var authorFirst = (src.authors || '').split(',')[0];
      html += '<div class="citation">';
      html += escapeHtml(authorFirst) + ' et al. (' + src.year + '). <em>' + escapeHtml(src.journal || '') + '</em>';
      if (src.doi) {
        html += ' <a href="https://doi.org/' + escapeHtml(src.doi.trim()) + '" target="_blank">DOI</a>';
      }
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';
    return html;
  }

  function buildReactionSidebar(rxn, graph) {
    var v = rxn.validation;
    var html = '';

    // Header
    html += '<div class="sidebar-section">';
    html += '  <h4>Reaction</h4>';
    html += '  <div style="font-size:14px;font-weight:600;margin-bottom:4px;">' + escapeHtml(rxn.shortId) + '</div>';
    html += '  <div style="font-size:12px;color:var(--text-secondary);line-height:1.5;">' + escapeHtml(rxn.name) + '</div>';

    // Reaction string: Reactants → Products
    var inputStrs = (rxn.inputs || []).map(function(id) {
      var mol = graph.molecules.get(id);
      if (!mol) return id;
      var name = mol.commonName && mol.commonName !== mol.formula ? ' (' + mol.commonName + ')' : '';
      return mol.formula + name;
    });
    var outputStrs = (rxn.outputs || []).map(function(id) {
      var mol = graph.molecules.get(id);
      if (!mol) return id;
      var name = mol.commonName && mol.commonName !== mol.formula ? ' (' + mol.commonName + ')' : '';
      return mol.formula + name;
    });
    if (inputStrs.length > 0 || outputStrs.length > 0) {
      html += '<div class="ref-reaction-str" style="margin-top:6px;">' +
              escapeHtml(inputStrs.join(' + ') + ' \u2192 ' + outputStrs.join(' + ')) +
              '</div>';
    }

    html += '</div>';

    // Environment
    html += '<div class="sidebar-section">';
    html += '  <h4>Environment</h4>';
    html += '  <span class="badge badge-env badge-' + rxn.environment + '">' + rxn.environment + '</span>';
    html += '</div>';

    // Validation status
    if (v) {
      html += '<div class="sidebar-section">';
      html += '  <h4>Validation</h4>';

      // ChemOrigins reference reaction
      html += buildChemoriginsRef(v, graph);

      html += '</div>';
    }

    // Conditions
    if (rxn.conditions && Object.keys(rxn.conditions).length > 0) {
      html += '<div class="sidebar-section">';
      html += '  <h4>Conditions</h4>';
      Object.keys(rxn.conditions).forEach(function(k) {
        var val = rxn.conditions[k];
        if (val == null) return;
        var valStr = typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val);
        html += '  <div class="sidebar-kv"><span class="kv-key">' + escapeHtml(k) + '</span><span class="kv-val">' + escapeHtml(valStr) + '</span></div>';
      });
      html += '</div>';
    }

    // Catalysts/Agents
    if (rxn.agents && rxn.agents.length > 0) {
      html += '<div class="sidebar-section">';
      html += '  <h4>Catalysts / Agents</h4>';
      html += '  <p style="font-size:11px;">' + escapeHtml(rxn.agents.join(', ')) + '</p>';
      html += '</div>';
    }

    // Mechanism
    if (rxn.mechanism) {
      html += '<div class="sidebar-section">';
      html += '  <h4>Mechanism</h4>';
      html += '  <p style="font-size:11px;">' + escapeHtml(rxn.mechanism) + '</p>';
      html += '</div>';
    }

    // Reasoning
    if (rxn.reasoning) {
      html += '<div class="sidebar-section">';
      html += '  <h4>Scientific Reasoning</h4>';
      html += '  <p style="font-size:11px;">' + escapeHtml(rxn.reasoning) + '</p>';
      html += '</div>';
    }

    return html;
  }

  // ===== Evaluation Panel =====

  function buildScoreBar(label, score) {
    if (score == null) return '';
    var pct = (score * 100).toFixed(0);
    var color = SV.scoreColor(score);
    return '<div class="eval-score-row">' +
           '<span class="eval-score-label">' + escapeHtml(label) + '</span>' +
           '<div class="eval-score-bar-bg"><div class="eval-score-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
           '<span class="eval-score-value" style="color:' + color + '">' + pct + '%</span>' +
           '</div>';
  }

  function updateEvalPanel(graph) {
    var panel = document.getElementById('eval-panel');
    var title = document.getElementById('eval-panel-title');
    var body = document.getElementById('eval-panel-body');

    if (!graph || !graph.evaluation) {
      panel.classList.remove('visible');
      return;
    }

    var ev = graph.evaluation;
    title.textContent = 'Network Evaluation';

    var html = '';

    // Approved/Rejected badge + best pathway
    html += '<div style="margin-bottom:6px;">';
    html += ev.approved
      ? '<span class="eval-badge-approved">Approved</span>'
      : '<span class="eval-badge-rejected">Rejected</span>';
    if (ev.best_pathway_id) {
      html += ' <span style="font-size:9px;color:var(--text-muted);margin-left:6px;">Best: ' + escapeHtml(ev.best_pathway_id) + '</span>';
    }
    html += '</div>';

    // Score bars
    html += buildScoreBar('Overall Confidence', ev.overall_confidence);
    html += buildScoreBar('Hub Quality', ev.hub_quality);
    html += buildScoreBar('Convergence Quality', ev.convergence_quality);

    // Network feedback
    if (ev.network_feedback) {
      html += '<div class="eval-divider"></div>';
      html += '<div class="eval-section-title">Feedback</div>';
      html += '<div class="eval-feedback">' + escapeHtml(ev.network_feedback) + '</div>';
    }

    body.innerHTML = html;
    panel.classList.add('visible');
  }

  function updateEvalPanelForPathway(graph, pathwayId) {
    var panel = document.getElementById('eval-panel');
    var title = document.getElementById('eval-panel-title');
    var body = document.getElementById('eval-panel-body');

    if (!graph || !graph.pathwayEvalMap) {
      panel.classList.remove('visible');
      return;
    }

    var pe = graph.pathwayEvalMap.get(pathwayId);
    if (!pe) {
      updateEvalPanel(graph);
      return;
    }

    title.textContent = pathwayId + ' Evaluation';

    var html = '';

    // Pathway info (name, description, reaction sequence, key intermediates)
    var pw = graph.pathways.find(function(p) { return p.id === pathwayId; });
    if (pw) {
      if (pw.name) {
        html += '<div class="eval-pathway-name">' + escapeHtml(pw.name) + '</div>';
      }
      if (pw.description) {
        html += '<div class="eval-pathway-desc">' + escapeHtml(pw.description) + '</div>';
      }
      if (pw.reactionSequence && pw.reactionSequence.length > 0) {
        html += '<div class="eval-section-title">Reaction Sequence</div>';
        html += '<div class="eval-pathway-seq">';
        html += pw.reactionSequence.map(function(rxnId) {
          var rxn = graph.reactions.get(rxnId);
          var label = rxn ? rxn.shortId : rxnId;
          var name = rxn && rxn.name ? rxn.name : '';
          return '<span class="eval-seq-step" title="' + escapeHtml(name) + '">' + escapeHtml(label) + '</span>';
        }).join('<span class="eval-seq-arrow">\u2192</span>');
        html += '</div>';
      }
      if (pw.keyIntermediates && pw.keyIntermediates.length > 0) {
        html += '<div class="eval-section-title">Key Intermediates</div>';
        html += '<div class="eval-pathway-intermediates">';
        pw.keyIntermediates.forEach(function(molId) {
          var mol = graph.molecules.get(molId);
          var label = mol ? (mol.commonName || mol.formula) : molId;
          html += '<span class="eval-intermediate-chip">' + escapeHtml(label) + '</span>';
        });
        html += '</div>';
      }
      html += '<div class="eval-divider"></div>';
    }

    // Approved/Rejected badge
    html += '<div style="margin-bottom:6px;">';
    html += pe.approved
      ? '<span class="eval-badge-approved">Approved</span>'
      : '<span class="eval-badge-rejected">Rejected</span>';
    html += '</div>';

    // Score bars
    html += buildScoreBar('Overall Confidence', pe.overall_confidence);
    html += buildScoreBar('Chemical Feasibility', pe.chemical_feasibility);
    html += buildScoreBar('Pathway Coherence', pe.pathway_coherence);
    html += buildScoreBar('Env. Progression', pe.environmental_progression);
    html += buildScoreBar('Target Achievement', pe.target_achievement);

    // Per-reaction scores
    if (pe.reaction_scores && Object.keys(pe.reaction_scores).length > 0) {
      html += '<div class="eval-divider"></div>';
      html += '<div class="eval-section-title">Reaction Scores</div>';
      Object.keys(pe.reaction_scores).forEach(function(rxnId) {
        html += buildScoreBar(rxnId.replace('_', ' '), pe.reaction_scores[rxnId]);
      });
    }

    // Problematic reactions
    if (pe.problematic_reactions && pe.problematic_reactions.length > 0) {
      html += '<div class="eval-divider"></div>';
      html += '<div class="eval-problematic">Problematic: ' +
              pe.problematic_reactions.map(function(r) { return escapeHtml(r); }).join(', ') +
              '</div>';
    }

    // Feedback
    if (pe.feedback) {
      html += '<div class="eval-divider"></div>';
      html += '<div class="eval-section-title">Feedback</div>';
      html += '<div class="eval-feedback">' + escapeHtml(pe.feedback) + '</div>';
    }

    // Suggestions
    if (pe.suggestions && pe.suggestions.length > 0) {
      html += '<div class="eval-divider"></div>';
      html += '<div class="eval-section-title">Suggestions</div>';
      html += '<ol class="eval-suggestions">';
      pe.suggestions.forEach(function(s) {
        html += '<li>' + escapeHtml(s) + '</li>';
      });
      html += '</ol>';
    }

    body.innerHTML = html;
    panel.classList.add('visible');
  }

  // ===== Legend =====

  function renderLegend() {
    var body = document.getElementById('legend-body');
    var html = '';

    // Role colors
    html += '<div class="legend-row"><div class="legend-swatch" style="background:#34495e;border-radius:6px;"></div> Starting Molecule</div>';
    html += '<div class="legend-row"><div class="legend-swatch" style="background:#3498db;border-radius:6px;"></div> Intermediate</div>';
    html += '<div class="legend-row"><div class="legend-swatch" style="background:#e74c3c;border-radius:6px;"></div> Target Molecule</div>';

    html += '<div class="legend-divider"></div>';

    // Arrow types
    html += '<div class="legend-row"><div class="legend-line"></div> Reactant (solid)</div>';
    html += '<div class="legend-row"><div class="legend-line-dashed"></div> Product (dashed)</div>';

    html += '<div class="legend-divider"></div>';

    // Environment colors
    html += '<div class="legend-row"><div class="legend-swatch" style="background:#c692dd;"></div> Hydrothermal rxn</div>';
    html += '<div class="legend-row"><div class="legend-swatch" style="background:#ce9576;"></div> Surface rxn</div>';
    html += '<div class="legend-row"><div class="legend-swatch" style="background:#1abc9c;"></div> Biochemical rxn</div>';

    html += '<div class="legend-divider"></div>';

    // High coverage
    html += '<div class="legend-row"><div class="legend-swatch" style="background:transparent;border:2px solid #888;"></div> High coverage (&gt;75%)</div>';

    body.innerHTML = html;

    // Wire up collapse toggle
    var legend = document.getElementById('legend');
    var toggleBtn = document.getElementById('legend-toggle');
    toggleBtn.addEventListener('click', function() {
      legend.classList.toggle('collapsed');
      toggleBtn.innerHTML = legend.classList.contains('collapsed') ? '&#x002B;' : '&#x2212;';
      toggleBtn.title = legend.classList.contains('collapsed') ? 'Expand' : 'Collapse';
    });
  }

  // ===== Helpers =====

  function showStatus(msg) {
    var el = document.getElementById('status-bar');
    if (el) el.textContent = msg;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ===== Markdown Modal =====

  function loadMarkdownReport(title, url, mode) {
    openMarkdownModal(title, '<div class="md-modal-empty">Loading...</div>');

    fetch(url).then(function(resp) {
      if (!resp.ok) {
        // Try case-insensitive fallback: swap first letter case after last underscore
        // Handles L_alanine.txt vs L_Alanine.txt
        var parts = url.split('/');
        var filename = parts[parts.length - 1];
        var dotIdx = filename.lastIndexOf('.');
        var ext = dotIdx >= 0 ? filename.substring(dotIdx) : '';
        var base = dotIdx >= 0 ? filename.substring(0, dotIdx) : filename;
        var lastUnderscore = base.lastIndexOf('_');
        var altBase;
        if (lastUnderscore >= 0) {
          var after = base.substring(lastUnderscore + 1);
          var firstChar = after.charAt(0);
          var swapped = firstChar === firstChar.toLowerCase()
            ? firstChar.toUpperCase() + after.substring(1)
            : firstChar.toLowerCase() + after.substring(1);
          altBase = base.substring(0, lastUnderscore + 1) + swapped;
        } else {
          var fc = base.charAt(0);
          altBase = (fc === fc.toLowerCase() ? fc.toUpperCase() : fc.toLowerCase()) + base.substring(1);
        }
        var altUrl = parts.slice(0, -1).join('/') + '/' + altBase + ext;
        return fetch(altUrl).then(function(resp2) {
          if (!resp2.ok) throw new Error('not found');
          return resp2.text();
        });
      }
      return resp.text();
    }).then(function(text) {
      var markdown;
      if (mode === 'json') {
        try {
          var data = JSON.parse(text);
          markdown = data.raw_response || '';
        } catch (e) {
          markdown = text;
        }
      } else {
        markdown = text;
      }
      if (!markdown || markdown.trim() === '') {
        document.getElementById('md-modal-body').innerHTML = '<div class="md-modal-empty">Report is empty.</div>';
        return;
      }
      document.getElementById('md-modal-body').innerHTML = marked.parse(markdown);
    }).catch(function() {
      document.getElementById('md-modal-body').innerHTML = '<div class="md-modal-empty">No report available for this molecule.</div>';
    });
  }

  function openMarkdownModal(title, bodyHtml) {
    document.getElementById('md-modal-title').textContent = title;
    document.getElementById('md-modal-body').innerHTML = bodyHtml;
    document.getElementById('md-modal-backdrop').classList.add('open');
  }

  function closeMarkdownModal() {
    document.getElementById('md-modal-backdrop').classList.remove('open');
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
