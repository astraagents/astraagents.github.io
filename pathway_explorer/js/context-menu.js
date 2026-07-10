/**
 * context-menu.js — Right-click context menu for renaming/removing nodes.
 *
 * Triggered via Cytoscape cxttap events (wired in cytoscape-bridge.js).
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};

  var menuEl = null;
  var currentNodeId = null;

  // Create menu DOM once
  function ensureMenu() {
    if (menuEl) return;

    menuEl = document.createElement('div');
    menuEl.className = 'context-menu';
    menuEl.innerHTML =
      '<div class="context-menu-item" data-action="rename">Rename</div>' +
      '<div class="context-menu-item" data-action="change-image">Change Image</div>' +
      '<div class="context-menu-item" data-action="remove">Remove</div>';
    document.body.appendChild(menuEl);

    menuEl.addEventListener('click', function(e) {
      var item = e.target.closest('.context-menu-item');
      if (!item) return;
      var action = item.getAttribute('data-action');
      hideMenu();
      if (action === 'rename') doRename();
      if (action === 'change-image') doChangeImage();
      if (action === 'remove') doRemove();
    });

    document.addEventListener('click', function() { hideMenu(); });
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') hideMenu();
    });
  }

  /**
   * Show context menu at screen position for a given node.
   * Called from cytoscape-bridge.js via SV._onNodeCxttap.
   */
  SV.showContextMenu = function(nodeId, screenX, screenY) {
    ensureMenu();
    currentNodeId = nodeId;

    // Show "Change Image" only for molecule nodes
    var isMol = SV._currentGraph && SV._currentGraph.molecules.has(nodeId);
    var imgItem = menuEl.querySelector('[data-action="change-image"]');
    if (imgItem) imgItem.style.display = isMol ? '' : 'none';

    menuEl.style.left = screenX + 'px';
    menuEl.style.top = screenY + 'px';
    menuEl.classList.add('visible');
  };

  function hideMenu() {
    if (menuEl) menuEl.classList.remove('visible');
  }

  function doRename() {
    if (!currentNodeId || !SV._currentGraph) return;
    var graph = SV._currentGraph;

    var isMol = graph.molecules.has(currentNodeId);
    var node = isMol
      ? graph.molecules.get(currentNodeId)
      : graph.reactions.get(currentNodeId);
    if (!node) return;

    var currentName = isMol ? (node.commonName || node.formula) : node.shortId;
    var newName = prompt('Rename:', currentName);
    if (newName === null || newName === currentName) return;

    // Update model
    if (isMol) {
      node.commonName = newName;
    } else {
      node.shortId = newName;
    }

    // Update Cytoscape node label
    if (SV.cy) {
      var cyNode = SV.cy.getElementById(currentNodeId);
      if (cyNode.length) {
        cyNode.data('label', newName);
        if (isMol) {
          cyNode.data('shortLabel', SV.truncate(newName, 16));
        }
      }
    }
  }

  function doChangeImage() {
    if (!currentNodeId || !SV._currentGraph) return;
    var graph = SV._currentGraph;
    if (!graph.molecules.has(currentNodeId)) return;

    var nodeId = currentNodeId;

    // Create a hidden file input to pick SVG or PNG
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/svg+xml,image/png';
    input.style.display = 'none';

    input.addEventListener('change', function() {
      var file = input.files && input.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function(e) {
        SV.setNodeImage(nodeId, e.target.result);
      };
      reader.readAsDataURL(file);

      // Clean up
      document.body.removeChild(input);
    });

    document.body.appendChild(input);
    input.click();
  }

  function doRemove() {
    if (!currentNodeId || !SV._currentGraph) return;
    var graph = SV._currentGraph;

    var isMol = graph.molecules.has(currentNodeId);

    // Remove from Cytoscape (also removes connected edges)
    if (SV.cy) {
      SV.cy.getElementById(currentNodeId).remove();
    }

    // Remove from graph model
    if (isMol) {
      graph.molecules.delete(currentNodeId);
    } else {
      graph.reactions.delete(currentNodeId);
    }

    // Remove connected edges from model
    graph.edges = graph.edges.filter(function(e) {
      return e.sourceId !== currentNodeId && e.targetId !== currentNodeId;
    });

    // Update status bar
    var statusEl = document.getElementById('status-bar');
    if (statusEl) {
      var nMol = graph.molecules.size;
      var nRxn = graph.reactions.size;
      var nEdge = graph.edges.length;
      statusEl.textContent = nMol + ' molecules, ' + nRxn + ' reactions, ' + nEdge + ' edges';
    }
  }

})();
