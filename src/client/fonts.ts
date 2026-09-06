/**
 * The UI webfont — the one thing the game fetches that is not code.
 *
 * The stylesheet is injected at boot instead of being a `<link>` in the HTML so
 * a stalled fonts.googleapis.com can never hold up first paint: the browser
 * renders with the fallback stack, `display=swap` swaps the faces in when they
 * arrive, and the boot sequence races `document.fonts.ready` against a short
 * timeout. `index.html` keeps the `preconnect` hints so the fetch is still fast.
 * The CSP allows `style-src https://fonts.googleapis.com`, so a dynamically
 * inserted stylesheet link is fine where an inline `<style>` would not be.
 */
export const FONTS_HOST = 'https://fonts.googleapis.com';
export const FONTS_HREF = `${FONTS_HOST}/css2?family=Outfit:wght@300;400;600;800;900&family=Noto+Sans+KR:wght@400;500;700;900&display=swap`;

/**
 * Append the webfont stylesheet link to `<head>` (idempotent: a second call
 * returns the existing link). Returns null when the document has no head.
 */
export function loadFonts(doc: Document): HTMLLinkElement | null {
  const head = doc.head;
  if (!head) return null;
  const existing = head.querySelector<HTMLLinkElement>(`link[rel="stylesheet"][href="${FONTS_HREF}"]`);
  if (existing) return existing;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = FONTS_HREF;
  link.crossOrigin = 'anonymous';
  head.appendChild(link);
  return link;
}
