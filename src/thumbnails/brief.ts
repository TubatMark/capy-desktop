import type {
  ThumbnailBrief,
  ThumbnailBriefInput,
  ThumbnailLayout,
} from "../../lib/thumbnails";
const layouts: ThumbnailLayout[] = ["bold", "editorial", "minimal"];
export function buildThumbnailBrief(
  input: ThumbnailBriefInput,
): ThumbnailBrief {
  if (!input.frames.length)
    throw Error("Thumbnail generation requires selected source frames");
  const headline = input.headline.trim();
  if (!headline || headline.length > 120 || /[\x00-\x1f]/.test(headline))
    throw Error("Headline must contain 1–120 printable characters");
  if (!layouts[input.variant])
    throw Error("Thumbnail variant must be between zero and two");
  if (input.layout && !layouts.includes(input.layout))
    throw Error("Unknown thumbnail layout");
  const layout = input.layout ?? layouts[input.variant]!;
  const treatments = {
    bold: "Use a bold color field and a large framed source subject, with clear space for a short headline.",
    editorial:
      "Use an editorial split composition with a restrained dark panel and fine accent rules.",
    minimal:
      "Use a minimal high-contrast composition with generous negative space and one accent band.",
  };
  return {
    style: input.style,
    version: 1,
    layout,
    headline,
    aspect: input.aspect,
    sourceFrameIds: input.frames.map((f) => f.id),
    instructions: `${treatments[layout]} Preserve the actual source subject's identity, expression and event. Do not invent products, events or claims absent from these frames. Generate background treatment only; the original subject pixels are composed locally. No lettering: all text remains a local editable layer. Headline supplied by the user: ${headline}`,
  };
}
