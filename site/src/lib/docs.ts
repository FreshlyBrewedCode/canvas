import { getCollection } from "astro:content";
import { SECTIONS } from "./sections";

export { SECTIONS };

/**
 * Every doc in sidebar order: by section, then `order` ascending, then title,
 * so two pages that forget to set `order` still land somewhere stable. The
 * sidebar, the markdown index, and anything else listing docs read this rather
 * than re-sorting.
 */
export async function sortedDocs() {
  const entries = await getCollection("docs");
  return entries.sort(
    (a, b) =>
      SECTIONS.indexOf(a.data.section) - SECTIONS.indexOf(b.data.section) ||
      a.data.order - b.data.order ||
      a.data.title.localeCompare(b.data.title),
  );
}
