/** Small DOM helpers shared by the reviewer app (app.js) and the admin view (admin.js). */

export const $ = (id) => document.getElementById(id);

/** Create an element, assign properties, append children (null/false skipped). */
export const el = (tag, props = {}, kids = []) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of [].concat(kids)) if (k != null && k !== false) n.append(k);
  return n;
};

/** A Font Awesome solid icon; decorative, so hidden from screen readers. */
export const icon = (name, cls = "") => {
  const i = el("i", { className: `fa-solid fa-${name}${cls ? ` ${cls}` : ""}` });
  i.setAttribute("aria-hidden", "true");
  return i;
};

/** Set a button's label: text with a trailing icon (or none). */
export const setLabel = (node, text, iconName = null) =>
  node.replaceChildren(text, ...(iconName ? [" ", icon(iconName)] : []));

/** "Arginine" / "L_Alanine" -> display form "L-Alanine". */
export const pretty = (m) => m.replace(/_/g, "-");
