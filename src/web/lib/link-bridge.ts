/**
 * HTML previews render in a sandbox (ADR 0004) that can't navigate the
 * board. For their links to work anyway (ADR 0007), each page gets a script
 * that hands clicks on links to the board by `postMessage`.
 *
 * The page's own scripts may post to the board too, so a post only counts
 * with the page's token. The bridge runs before them, keeps the token in a
 * closure and removes its own element, so they can't read it; and it only
 * forwards clicks a person made (`isTrusted`), not ones a script faked.
 */

/**
 * In-page anchors (`#section`) the bridge scrolls to itself: a srcdoc page's
 * URLs resolve against the board's, so the browser would load the board's
 * URL into the frame — and not by `scrollIntoView`, which would scroll the
 * board too.
 */
const bridge = (token: string) =>
  `<script>(function(){var T=${JSON.stringify(token)},P=parent,S=document.currentScript;if(S)S.remove();addEventListener("click",function(e){var a=e.target&&e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href")||"";e.preventDefault();if(h.charAt(0)==="#"&&!/[#&](frame|path)=/.test(h)){var id=decodeURIComponent(h.slice(1)),t=id?document.getElementById(id)||document.getElementsByName(id)[0]:document.body;if(t)scrollTo(scrollX,t.getBoundingClientRect().top+scrollY);return}if(e.isTrusted)P.postMessage({canvasLink:h,token:T},"*")},true)})()</script>`;

/** The page with the bridge in its head — never before a doctype, which would mean quirks mode. */
export function withLinkBridge(html: string, token: string): string {
  const at =
    /<head(\s[^>]*)?>/i.exec(html) ??
    /<html(\s[^>]*)?>/i.exec(html) ??
    /<!doctype[^>]*>/i.exec(html);
  if (!at) return bridge(token) + html;
  const end = at.index + at[0].length;
  return html.slice(0, end) + bridge(token) + html.slice(end);
}

/** A link the bridge posted with `token`, if `data` is one. */
export function bridgedLink(data: unknown, token: string): string | null {
  const message = data as { canvasLink?: unknown; token?: unknown } | null;
  return message?.token === token && typeof message.canvasLink === "string"
    ? message.canvasLink
    : null;
}
