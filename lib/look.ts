/**
 * The "look" of a video's clips: caption and hook styling plus a colour vibe. Set per video,
 * previewed live in the browser and burned in by ffmpeg from the same numbers. Pure data and
 * pure functions only: this file is imported by both client components and the render pipeline.
 *
 * Sizes and positions are in the 1080x1920 render canvas; the preview scales them by container width.
 */

export type VibeId = "original" | "warm" | "cool" | "vivid" | "film" | "mono";

export interface Look {
  /** Caption font size in px on the 1080x1920 canvas. */
  size: number;
  /** Caption baseline distance from the bottom, as a fraction of the height (0.15–0.45). */
  bottom: number;
  /** Max words shown at once (1–5). */
  wordsPerLine: number;
  /** Colours as #rrggbb. */
  text: string;
  highlight: string;
  outline: string;
  /** Outline thickness in canvas px (0 = none). */
  outlineWidth: number;
  /** Dark box behind the caption text. */
  box: boolean;
  hook: {
    size: number;
    text: string;
    /** Box colour behind the hook; the box is always drawn. */
    box: string;
    /** Distance from the top as a fraction of the height (0.05–0.4). */
    top: number;
  };
  vibe: VibeId;
}

/** Defaults per caption style; these reproduce the pre-look renders exactly. */
export const LOOK_DEFAULTS: Record<"bold" | "clean", Look> = {
  bold: {
    size: 76,
    bottom: 560 / 1920,
    wordsPerLine: 3,
    text: "#ffffff",
    highlight: "#ffe500",
    outline: "#000000",
    outlineWidth: 5,
    box: false,
    hook: { size: 84, text: "#ffffff", box: "#000000", top: 300 / 1920 },
    vibe: "original",
  },
  clean: {
    size: 64,
    bottom: 520 / 1920,
    wordsPerLine: 5,
    text: "#ffffff",
    highlight: "#ffffff",
    outline: "#000000",
    outlineWidth: 3,
    box: false,
    hook: { size: 76, text: "#ffffff", box: "#000000", top: 300 / 1920 },
    vibe: "original",
  },
};

export const LOOK_LIMITS = {
  size: { min: 44, max: 120 },
  bottom: { min: 0.15, max: 0.45 },
  wordsPerLine: { min: 1, max: 5 },
  outlineWidth: { min: 0, max: 10 },
  hookSize: { min: 44, max: 120 },
  hookTop: { min: 0.05, max: 0.4 },
} as const;

export function defaultLook(style: "bold" | "clean"): Look {
  const d = LOOK_DEFAULTS[style];
  return { ...d, hook: { ...d.hook } };
}

/** Fill in anything missing (older jobs, partial patches) and clamp to the limits. */
export function normalizeLook(raw: unknown, style: "bold" | "clean"): Look {
  const d = defaultLook(style);
  const r = (raw ?? {}) as Partial<Look> & { hook?: Partial<Look["hook"]> };
  const num = (v: unknown, fallback: number, lim: { min: number; max: number }) => (typeof v === "number" && Number.isFinite(v) ? Math.min(lim.max, Math.max(lim.min, v)) : fallback);
  const hex = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
  return {
    size: Math.round(num(r.size, d.size, LOOK_LIMITS.size)),
    bottom: num(r.bottom, d.bottom, LOOK_LIMITS.bottom),
    wordsPerLine: Math.round(num(r.wordsPerLine, d.wordsPerLine, LOOK_LIMITS.wordsPerLine)),
    text: hex(r.text, d.text),
    highlight: hex(r.highlight, d.highlight),
    outline: hex(r.outline, d.outline),
    outlineWidth: num(r.outlineWidth, d.outlineWidth, LOOK_LIMITS.outlineWidth),
    box: typeof r.box === "boolean" ? r.box : d.box,
    hook: {
      size: Math.round(num(r.hook?.size, d.hook.size, LOOK_LIMITS.hookSize)),
      text: hex(r.hook?.text, d.hook.text),
      box: hex(r.hook?.box, d.hook.box),
      top: num(r.hook?.top, d.hook.top, LOOK_LIMITS.hookTop),
    },
    vibe: VIBES.some((v) => v.id === r.vibe) ? (r.vibe as VibeId) : d.vibe,
  };
}

export function looksEqual(a: Look, b: Look): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Colour vibes. `css` is applied to the preview <video> (CSS filter); `ffmpeg` is appended to the
 * render filter graph. They are hand-matched approximations of each other, not exact.
 */
export const VIBES: { id: VibeId; label: string; css: string; ffmpeg: string }[] = [
  { id: "original", label: "Original", css: "none", ffmpeg: "" },
  { id: "warm", label: "Warm", css: "sepia(0.22) saturate(1.2) brightness(1.02)", ffmpeg: "colorbalance=rs=0.08:gs=0.02:bs=-0.08,eq=saturation=1.12" },
  { id: "cool", label: "Cool", css: "saturate(1.05) hue-rotate(-8deg) brightness(1.02)", ffmpeg: "colorbalance=rs=-0.07:gs=0.0:bs=0.1,eq=saturation=1.05" },
  { id: "vivid", label: "Vivid", css: "contrast(1.12) saturate(1.4)", ffmpeg: "eq=contrast=1.12:saturation=1.4" },
  { id: "film", label: "Film", css: "contrast(0.92) saturate(0.8) sepia(0.15) brightness(1.04)", ffmpeg: "eq=contrast=0.92:saturation=0.8:brightness=0.02,colorbalance=rs=0.04:bs=-0.03" },
  { id: "mono", label: "Black & white", css: "grayscale(1) contrast(1.1)", ffmpeg: "hue=s=0,eq=contrast=1.1" },
];

export function vibeById(id: VibeId) {
  return VIBES.find((v) => v.id === id) ?? VIBES[0]!;
}

/** "#rrggbb" + alpha (0 opaque … 255 transparent, ASS convention) → "&HAABBGGRR". */
export function hexToAss(hex: string, alpha = 0): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  const [r, g, b] = m ? [m[1]!, m[2]!, m[3]!] : ["ff", "ff", "ff"];
  return `&H${alpha.toString(16).padStart(2, "0")}${b}${g}${r}`.toUpperCase();
}
