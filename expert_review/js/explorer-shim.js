/**
 * Loaded by explorer.html before the Pathway Explorer's own scripts.
 *
 * main.js builds its dataset dropdowns from file_index.csv and auto-loads the
 * selection. Rather than modify it, we answer that one request with a single-row
 * index for the network named in our query string (?f=<network>&v=<validation>,
 * both relative to pathway_explorer/), so main.js finds exactly one choice and
 * loads it. Every other request goes to the real fetch untouched.
 */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var file = params.get("f") || "";
  var valid = params.get("v") || "";
  // network_<Molecule>[_<YYYYMMDD>_<HHMMSS>]_..._run<N>[_attempt<N>].json -- the molecule
  // only matters to the explorer for its chemorigins lookup and the dropdown it fills.
  var m = /network_(.+?)(?:_\d{8}_\d{6})?_(?:deep_research_[\w.]+|perfect_rag|no_research|Naive)_run/.exec(file);
  var molecule = params.get("m") || (m ? m[1] : "network");

  var csv =
    "model,molecule,config,run,attempt,synthesis_network_path,validation_path\n" +
    ["review", molecule, "review", "1", "", file, valid].join(",") + "\n";

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (/(^|\/)file_index\.csv(\?|$)/.test(url)) {
      return Promise.resolve(new Response(csv, { headers: { "Content-Type": "text/csv" } }));
    }
    return realFetch(input, init);
  };
})();
