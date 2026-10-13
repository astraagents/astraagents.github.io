/**
 * Graph popup -- glue between the review app and the renderer copied verbatim
 * from pathway_explorer (js/vendor-graph/*, globals on window.SynthVis).
 *
 * The render sequence mirrors pathway_explorer/js/main.js renderAll().
 * We deliberately do not load main.js: it carries MODEL_LABELS / CONFIG_LABELS
 * and would reveal the authorship this tool keeps hidden.
 */

const SV = () => window.SynthVis;

const $ = (id) => document.getElementById(id);

let started = false;              // cytoscape initialised (needs a visible container)
const modelCache = new Map();     // network file -> normalized graph model
let onReactionTap = null;         // set by app.js: (reactionId) => void
let focusMode = false;            // dim everything but the current reaction
let currentRxn = null;

export function setReactionTapHandler(fn) {
  onReactionTap = fn;
}

export function isOpen() {
  return !$("graph-modal").hidden;
}

/**
 * Show the popup for a network file, highlighting the reaction being scored.
 * Cytoscape measures its container on init and silently renders 0x0 if that
 * container is hidden, so the modal is revealed BEFORE anything is built.
 */
export async function openGraph(networkFile, currentReactionId, subtitle) {
  const modal = $("graph-modal");
  modal.hidden = false;
  $("graph-sub").textContent = subtitle || "";

  if (!started) {
    SV().initCytoscape($("cy"));
    started = true;
    SV()._onNodeTap = (nodeId) => {
      if (nodeId && nodeId.startsWith("rxn_") && onReactionTap) {
        onReactionTap(nodeId);
        closeGraph();
      }
    };
  }

  let graph = modelCache.get(networkFile);
  if (!graph) {
    // The explorer's own adapter from raw network JSON to the {molecules: Map,
    // reactions: Map, edges: []} shape the layout and bridge expect. Validation
    // and chemorigins are optional extras we do not have here.
    graph = await SV().loadFromPaths(networkFile, null, null);
    modelCache.set(networkFile, graph);
  }

  const cy = SV().cy;
  SV()._currentGraph = graph;

  const positions = SV().computeLayout(graph.molecules, graph.reactions, graph.edges);
  const elements = SV().buildCytoscapeElements(graph, positions);
  cy.json({ elements });
  cy.layout({ name: "preset" }).run();

  // The modal was only just shown, so the container's size may still be stale.
  cy.resize();
  cy.fit(undefined, 30);

  currentRxn = currentReactionId;
  highlight();
}

/**
 * Mark the reaction being scored. By default the whole network stays legible --
 * the point of the popup is to inspect it -- and the current reaction is simply
 * selected. Focus mode additionally dims everything outside its neighbourhood
 * (.dimmed is the bridge's own class, opacity 0.15).
 */
function highlight() {
  const cy = SV().cy;
  if (!cy) return;
  cy.elements().removeClass("dimmed");
  cy.$(":selected").unselect();

  const node = currentRxn && cy.getElementById(currentRxn);
  if (!node || node.empty()) return;

  node.select();
  if (focusMode) cy.elements().difference(node.closedNeighborhood()).addClass("dimmed");
}

export function closeGraph() {
  $("graph-modal").hidden = true;
}

function setFocus(on) {
  focusMode = on;
  const btn = $("btn-focus");
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = on ? "Show all" : "Focus this reaction";
  highlight();
}

/** Wire the popup's own controls. Called once at app start. */
export function initGraphControls() {
  $("btn-graph-close").addEventListener("click", closeGraph);
  $("btn-zoom-in").addEventListener("click", () => SV().zoomIn());
  $("btn-zoom-out").addEventListener("click", () => SV().zoomOut());
  $("btn-zoom-fit").addEventListener("click", () => SV().cy && SV().cy.fit(undefined, 30));
  $("btn-focus").addEventListener("click", () => setFocus(!focusMode));

  // Click the backdrop (but not the dialog) to dismiss.
  $("graph-modal").addEventListener("click", (ev) => {
    if (ev.target === $("graph-modal")) closeGraph();
  });
}
