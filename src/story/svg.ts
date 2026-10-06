/**
 * Picture-book pages as SVG. Characters are drawn once (an SVG fragment in a 400×400 box, feet at 200,390) and
 * placed on every page by capy, so they look the same throughout a story; the AI only draws each page's scene.
 */

export const PAGE_W = 1080;
export const PAGE_H = 1920;
/** Where a character's feet are inside its 400×400 drawing box. */
const FEET = { x: 200, y: 390 };

export interface CastPlacement {
  id: string;
  /** Horizontal centre, 0..1 of the page width. */
  x: number;
  /** Where the feet stand, 0..1 of the page height (default 0.72: above the caption area). */
  y?: number;
  /** 1 = 400px tall on the 1080×1920 page (default 1.6). */
  scale?: number;
  /** Face the other way. */
  flip?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const n = (v: number) => String(Math.round(v * 100) / 100);

/** Make AI-written SVG safe to render: no scripts, embedded HTML, images, handlers or outside references. */
export function sanitizeSvg(raw: string): string {
  let s = raw.trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "");
  s = s
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*\/>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<image[\s\S]*?(\/>|<\/image\s*>)/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "")
    // only same-document references (#id) survive
    .replace(/\s(?:xlink:)?href\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*')/gi, "")
    .replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, "none");
  // the AI was asked for a fragment; keep the inside of an <svg> wrapper if it added one
  const wrapped = s.match(/^\s*<svg\b[^>]*>([\s\S]*)<\/svg>\s*$/i);
  return (wrapped ? wrapped[1]! : s).trim();
}

/** SVG transform that stands a character's feet on the placement point (clamped onto the page). */
export function castTransform(p: CastPlacement): string {
  const s = clamp(p.scale ?? 1.6, 0.5, 3);
  const X = clamp(p.x, 0.05, 0.95) * PAGE_W;
  const Y = clamp(p.y ?? 0.72, 0.35, 0.85) * PAGE_H;
  const ty = Y - FEET.y * s;
  return p.flip ? `translate(${n(X + FEET.x * s)} ${n(ty)}) scale(${n(-s)} ${n(s)})` : `translate(${n(X - FEET.x * s)} ${n(ty)}) scale(${n(s)})`;
}

/** One page: the scene, then the cast on top. Cast members that aren't characters of the series are skipped. */
export function composePage(background: string, chars: { id: string; svg: string }[], cast: CastPlacement[]): string {
  const known = new Set(chars.map((c) => c.id));
  const defs = chars.map((c) => `<g id="char-${c.id}">${sanitizeSvg(c.svg)}</g>`).join("");
  const uses = cast
    .filter((p) => known.has(p.id))
    .map((p) => `<use href="#char-${p.id}" transform="${castTransform(p)}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}"><defs>${defs}</defs><rect width="${PAGE_W}" height="${PAGE_H}" fill="#fef9f1"/>${sanitizeSvg(background)}${uses}</svg>`;
}

/** A character alone on cream, for the series page and as a reference. */
export function characterCard(svg: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><rect width="400" height="400" fill="#fef9f1"/>${sanitizeSvg(svg)}</svg>`;
}
