import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cardArgs, clipArgs } from "../src/longform/edit";
import { commentaryArgs } from "../src/shorts-commentary";
import { commentaryCues, cueInputs, mixCues, sectionCues, shortCues, soundFile } from "../src/sfx";

const names = (c: { file: string }[]) => c.map((x) => path.basename(x.file, ".wav"));

describe("the sound pack", () => {
  const dir = path.join(process.cwd(), "public", "sfx");
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as { sounds: { id: string; file: string; license: string; source: string; sha256: string }[] };
  it("holds only CC0 files with a source, unchanged", () => {
    for (const s of manifest.sounds) {
      expect(s.license).toBe("CC0-1.0");
      expect(s.source).toMatch(/^https:\/\//);
      expect(createHash("sha256").update(readFileSync(path.join(dir, s.file))).digest("hex")).toBe(s.sha256);
    }
  });
  it("has every sound the edits ask for", () => {
    for (const id of ["whoosh", "impact", "riser", "drone"] as const) expect(soundFile(id)).toBeTruthy();
  });
});

describe("cues", () => {
  it("hits the hook of a Short and whooshes as it leaves", () => {
    const c = shortCues(30, 3);
    expect(names(c)).toEqual(["impact", "whoosh"]);
    expect(c[1]!.at).toBe(2.8);
  });
  it("skips the whoosh when there's no hook or it fills the clip", () => {
    expect(names(shortCues(30))).toEqual(["impact"]);
    expect(names(shortCues(3, 3))).toEqual(["impact"]);
  });
  it("leaves the moments themselves alone in a long video", () => {
    expect(sectionCues({ kind: "clip", name: "rank-01-clip", seconds: 60 })).toEqual([]);
  });
  it("builds into the intro and runs a quiet bed under cards", () => {
    expect(names(sectionCues({ kind: "teaser", name: "teaser-0", seconds: 3.5 }))).toEqual(["whoosh"]);
    const last = sectionCues({ kind: "teaser", name: "teaser-2", seconds: 3.5, lastTeaser: true });
    expect(names(last)).toEqual(["whoosh", "riser"]);
    expect(last[1]!.at).toBe(1.5);
    const card = sectionCues({ kind: "card", name: "intro", seconds: 8 });
    expect(names(card)).toEqual(["impact", "drone"]);
    expect(card[1]!.loopUntil).toBe(8);
    expect(card[1]!.gainDb).toBeLessThan(-20);
  });
});

describe("the mix", () => {
  const cues = [{ file: "a.wav", at: 1.5, gainDb: -10 }, { file: "b.wav", at: 0, gainDb: -26, loopUntil: 6 }];
  it("keeps the edit's length and doesn't raise its level", () => {
    const f = mixCues("in", "out", cues, 2);
    expect(f).toContain("[2:a]");
    expect(f).toContain("[3:a]");
    expect(f).toContain("adelay=delays=1500:all=1");
    expect(f).toContain("amix=inputs=3:normalize=0:duration=first");
    expect(f).toContain("level=disabled");
  });
  it("loops only the bed", () => {
    expect(cueInputs(cues)).toEqual(["-i", "a.wav", "-stream_loop", "-1", "-i", "b.wav"]);
  });
  it("numbers cue inputs after each edit's own inputs", () => {
    const at = (args: string[]) => args[args.indexOf("-filter_complex") + 1]!;
    const base = { ass: "x.ass", out: "o.mp4", enc: "libx264", cues: [cues[0]!] };
    expect(at(clipArgs({ ...base, footage: "f.mp4", ranges: [{ start: 0, end: 2 }] }))).toContain("[1:a]aresample=48000,aformat");
    expect(at(cardArgs({ ...base, footage: "f.mp4", offset: 0, narration: "n.wav", seconds: 6, lead: 0.35 }))).toContain("[2:a]aresample=48000,aformat");
    const o = { ...base, clip: "c.mp4", clipSeconds: 50, opening: "o.wav", openingSeconds: 3, verdict: "v.wav", verdictSeconds: 4 };
    expect(at(commentaryArgs(o).args)).toContain("[3:a]aresample=48000,aformat");
    expect(at(commentaryArgs({ ...o, middle: { file: "m.wav", at: 20, seconds: 2 } }).args)).toContain("[4:a]aresample=48000,aformat");
  });
  it("adds no effects when asked for none", () => {
    const args = clipArgs({ footage: "f.mp4", ranges: [{ start: 0, end: 2 }], ass: "x.ass", out: "o.mp4", enc: "libx264" });
    expect(args[args.indexOf("-filter_complex") + 1]).not.toContain("amix");
  });
  it("puts a narrated Short's effects over the host, not under them", () => {
    const c = commentaryCues(50, 3);
    expect(names(c)).toEqual(["impact", "whoosh", "whoosh"]);
    expect(c.map((x) => x.at)).toEqual([0, 3.1, 50]);
    expect(names(commentaryCues(3.5, 3))).toEqual(["impact", "whoosh"]);
  });
});
