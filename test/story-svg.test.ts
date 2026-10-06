import { describe, expect, it } from "vitest";
import { castTransform, composePage, PAGE_H, PAGE_W, sanitizeSvg } from "../src/story/svg";

describe("sanitizeSvg", () => {
  it("drops scripts, foreignObject, images, event handlers and outside links", () => {
    const dirty = `<?xml version="1.0"?><!DOCTYPE x><g onclick="alert(1)"><script>alert(1)</script><foreignObject><div/></foreignObject><image href="https://x/y.png"/><use href="https://evil/x.svg#a"/><use href="#ok"/><rect style="fill:url(https://x)" width="1"/><circle r="2"/></g>`;
    const clean = sanitizeSvg(dirty);
    expect(clean).not.toMatch(/script|foreignObject|<image|onclick|https:|DOCTYPE|<\?xml/i);
    expect(clean).toContain('<use href="#ok"/>');
    expect(clean).toContain('<circle r="2"/>');
  });
  it("unwraps an <svg> wrapper the AI added anyway", () => {
    expect(sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="1"/></svg>')).toBe('<rect width="1"/>');
  });
  it("drops stray <svg> and </svg> tags inside a fragment (they would close the page early)", () => {
    expect(sanitizeSvg('<defs><linearGradient id="sky"/></defs><rect width="1"/></svg>')).toBe('<defs><linearGradient id="sky"/></defs><rect width="1"/>');
    expect(sanitizeSvg('<rect width="1"/><svg x="5"><circle r="1"/></svg>')).toBe('<rect width="1"/><circle r="1"/>');
  });
  it("strips code fences around the markup", () => {
    expect(sanitizeSvg("```svg\n<rect width=\"1\"/>\n```")).toBe('<rect width="1"/>');
  });
});

describe("castTransform", () => {
  it("puts the character's feet (200,390 in its 400 box) at the placement point", () => {
    const t = castTransform({ id: "pip", x: 0.5, y: 0.75, scale: 2 });
    // feet → (540, 1440): tx = 540 - 200*2, ty = 1440 - 390*2
    expect(t).toBe("translate(140 660) scale(2)");
  });
  it("mirrors around the feet when flipped", () => {
    expect(castTransform({ id: "pip", x: 0.5, y: 0.75, scale: 2, flip: true })).toBe("translate(940 660) scale(-2 2)");
  });
  it("clamps silly placements onto the page", () => {
    expect(castTransform({ id: "p", x: 3, y: -1, scale: 50 })).toBe(castTransform({ id: "p", x: 0.95, y: 0.35, scale: 3 }));
  });
});

describe("composePage", () => {
  it("builds one portrait SVG with the character sprites defined once and placed per the cast", () => {
    const svg = composePage('<rect width="1080" height="1920" fill="#fde"/>', [{ id: "pip", svg: '<circle r="5"/>' }, { id: "lu", svg: "<rect/>" }], [{ id: "pip", x: 0.4 }, { id: "ghost", x: 0.6 }]);
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}"`)).toBe(true);
    expect(svg).toContain('<g id="char-pip"><circle r="5"/></g>');
    expect(svg).toContain('<use href="#char-pip"');
    expect(svg).not.toContain("#char-ghost"); // unknown cast members are skipped
    expect(svg.indexOf('fill="#fde"')).toBeLessThan(svg.indexOf("<use")); // background first, characters on top
  });
});
