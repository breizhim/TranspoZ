// Fusion des pages reconnues séparément en une seule partition MusicXML.
// Même comportement que server/musicxml.py (merge_scores), en JS pur pour
// l'application de bureau (reconnaissance sans serveur) ; testé sous Node.

function children(el, name) {
  const out = [];
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (!name || n.nodeName === name)) out.push(n);
  }
  return out;
}

function parse(text, DOMParserImpl) {
  const doc = new DOMParserImpl().parseFromString(text.replace(/<!DOCTYPE[^>]*>/, ""), "application/xml");
  if (doc.getElementsByTagName("parsererror").length || doc.documentElement?.nodeName !== "score-partwise") {
    throw new Error("MusicXML invalide.");
  }
  return doc;
}

const ATTRS = ["key", "time", "clef"];

/**
 * Concatène plusieurs partitions (pages) : les mesures de chaque partie sont
 * ajoutées à la partie de même rang de la première partition, puis renumérotées.
 * Les armures, chiffrages et clés répétés en début de page sont retirés.
 *
 * @param {string[]} scores  textes MusicXML, dans l'ordre des pages
 * @param {{DOMParser?: Function, XMLSerializer?: Function}} [dom]  (sous Node : @xmldom/xmldom)
 */
export function mergeScores(scores, dom = globalThis) {
  if (!scores.length) throw new Error("Aucune partition à fusionner.");
  if (scores.length === 1) return scores[0];
  const serializer = new dom.XMLSerializer();
  const signature = (el) => serializer.serializeToString(el).replace(/\s+/g, " ");

  const base = parse(scores[0], dom.DOMParser);
  const baseParts = children(base.documentElement, "part");
  const last = baseParts.map(() => ({}));
  const remember = (i, measure) => {
    for (const attrs of children(measure, "attributes")) {
      for (const name of ATTRS) {
        const el = children(attrs, name)[0];
        if (el) last[i][name] = signature(el);
      }
    }
  };
  baseParts.forEach((part, i) => children(part, "measure").forEach((m) => remember(i, m)));

  for (const text of scores.slice(1)) {
    const other = parse(text, dom.DOMParser);
    children(other.documentElement, "part").forEach((part, i) => {
      if (i >= baseParts.length) return;
      children(part, "measure").forEach((source, j) => {
        const measure = base.importNode(source, true);
        if (j === 0) {
          for (const attrs of children(measure, "attributes")) {
            for (const name of ATTRS) {
              for (const el of children(attrs, name)) if (signature(el) === last[i][name]) attrs.removeChild(el);
            }
            if (!children(attrs).length) measure.removeChild(attrs);
          }
        }
        remember(i, measure);
        baseParts[i].appendChild(measure);
      });
    });
  }

  for (const part of baseParts) {
    children(part, "measure").forEach((m, n) => m.setAttribute("number", String(n + 1)));
  }
  const body = serializer.serializeToString(base.documentElement);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${body}`;
}
