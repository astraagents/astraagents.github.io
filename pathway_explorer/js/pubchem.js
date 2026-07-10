/**
 * pubchem.js — Fetch and cache 2D molecule structure images from PubChem.
 *
 * Uses PUG REST API: https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/{name}/PNG
 * Adds to window.SynthVis namespace.
 */
(function() {
  'use strict';

  var SV = window.SynthVis = window.SynthVis || {};

  var BASE_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/';

  // Cache: name → { status: 'loading'|'loaded'|'failed', url: string|null, callbacks: [] }
  var cache = {};

  // Throttle queue: PubChem allows max 5 req/sec
  var queue = [];
  var inflight = 0;
  var MAX_CONCURRENT = 4;
  var THROTTLE_MS = 250;

  function processQueue() {
    while (queue.length > 0 && inflight < MAX_CONCURRENT) {
      var job = queue.shift();
      inflight++;
      job(function() {
        inflight--;
        setTimeout(processQueue, THROTTLE_MS);
      });
    }
  }

  function enqueue(fn) {
    queue.push(fn);
    processQueue();
  }

  /**
   * Build PubChem PNG URL for a compound name.
   * @param {string} name - compound name (common or IUPAC)
   * @param {string} [size] - image size param (default '300x300' for good quality)
   */
  function pubchemUrl(name, size) {
    var encoded = encodeURIComponent(name);
    var sizeParam = size || '300x300';
    return BASE_URL + encoded + '/PNG?record_type=2d&image_size=' + sizeParam;
  }

  /**
   * Try loading an image URL. Calls back with (url) on success, (null) on failure.
   */
  function tryLoadImage(url, onDone) {
    var img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function() { onDone(url); };
    img.onerror = function() { onDone(null); };
    img.src = url;
  }

  /**
   * Fetch a molecule structure image from PubChem.
   * Tries commonName first, then iupacName as fallback.
   *
   * @param {object} mol - molecule object with commonName, iupacName, formula
   * @param {function} callback - called with (imageUrl) or (null) if not found
   * @param {string} [size] - PubChem image_size param (default 'small')
   */
  SV.fetchMoleculeImage = function(mol, callback, size) {
    var names = [];
    if (mol.commonName) names.push(mol.commonName);
    if (mol.iupacName && mol.iupacName !== mol.commonName) names.push(mol.iupacName);
    if (names.length === 0 && mol.formula) names.push(mol.formula);

    if (names.length === 0) {
      callback(null);
      return;
    }

    // Check cache for any of the names
    for (var i = 0; i < names.length; i++) {
      var key = names[i] + '|' + (size || '300x300');
      var entry = cache[key];
      if (entry) {
        if (entry.status === 'loaded') { callback(entry.url); return; }
        if (entry.status === 'failed') continue;
        if (entry.status === 'loading') { entry.callbacks.push(callback); return; }
      }
    }

    // Try names in order
    tryNames(names, 0, callback, size);
  };

  function tryNames(names, idx, callback, size) {
    if (idx >= names.length) {
      callback(null);
      return;
    }

    var name = names[idx];
    var key = name + '|' + (size || '300x300');

    // Already failed this name
    if (cache[key] && cache[key].status === 'failed') {
      tryNames(names, idx + 1, callback, size);
      return;
    }

    // Already loading this name
    if (cache[key] && cache[key].status === 'loading') {
      cache[key].callbacks.push(function(url) {
        if (url) callback(url);
        else tryNames(names, idx + 1, callback, size);
      });
      return;
    }

    // Start loading
    cache[key] = { status: 'loading', url: null, callbacks: [callback] };
    var url = pubchemUrl(name, size);

    enqueue(function(done) {
      tryLoadImage(url, function(loadedUrl) {
        var entry = cache[key];
        if (loadedUrl) {
          entry.status = 'loaded';
          entry.url = loadedUrl;
          entry.callbacks.forEach(function(cb) { cb(loadedUrl); });
        } else {
          entry.status = 'failed';
          entry.callbacks.forEach(function(cb) {
            tryNames(names, idx + 1, cb, size);
          });
        }
        entry.callbacks = [];
        done();
      });
    });
  }

  /**
   * Get PubChem URL directly (for sidebar use — no preload check).
   */
  SV.pubchemImageUrl = function(name, size) {
    return pubchemUrl(name, size || '300x300');
  };

})();
