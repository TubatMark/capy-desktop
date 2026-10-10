import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AssetRef, ProjectDocument, RenderArtifact } from "../../lib/studio/types";
import { run, withCancel, throwIfCancelled, resolveBin } from "../exec";

export const RENDERER_VERSION = "ffmpeg-contract-1";
export const UNSUPPORTED_OPERATIONS = ["crossfade", "music-ducking", "audio-tracks", "source-audio", "captions", "text-overlays", "image-overlays", "transforms", "speed", "gaps", "overlaps"] as const;
export interface RenderPlan {
  renderer: "ffmpeg"; rendererVersion: typeof RENDERER_VERSION;
  projectId: string; revision: number; frameCount: number;
  composition: { width: number; height: number; fps: { numerator: number; denominator: number } };
  assets: { id: string; path: string; checksum: string }[];
  clips: { itemId: string; assetId: string; startFrame: number; durationFrames: number; sourceInUs: number; sourceOutUs: number; sourceStartFrame: number }[];
  audioPlan: { policy: "silent" }; previewPolicy: "same-rendered-artifact";
}
function reject(message: string): never { throw new Error(`Unsupported render plan: ${message}`); }
function positive(value: number) { return Number.isSafeInteger(value) && value > 0; }
function checksum(file: string) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function inspectSource(file: string, fps: {numerator:number;denominator:number}) {
  const result = spawnSync(resolveBin("ffprobe"), ["-v","error","-show_streams","-of","json",file], {encoding:"utf8"});
  if (result.status !== 0) reject("source probe failed");
  const streams = JSON.parse(result.stdout).streams;
  if (streams.some((stream:{codec_type:string}) => stream.codec_type === "audio")) reject("source-audio (verified silent-only contract)");
  const video = streams.find((stream:{codec_type:string}) => stream.codec_type === "video");
  if (!video || video.avg_frame_rate !== video.r_frame_rate) reject("non-CFR source");
  const [n,d] = video.r_frame_rate.split("/").map(Number);
  if (n * fps.denominator !== d * fps.numerator) reject("source fps must match output fps in bounded contract");
  const cadence = spawnSync(resolveBin("ffprobe"), ["-v","error","-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp","-of","json",file], {encoding:"utf8",maxBuffer:64*1024*1024});
  if (cadence.status !== 0) reject("source cadence probe failed");
  const frames = JSON.parse(cadence.stdout).frames;
  const [tbN,tbD] = video.time_base.split("/").map(BigInt);
  if (!frames.length || tbN <= 0n || tbD <= 0n) reject("invalid source cadence");
  // Half a native timebase tick permits container rounding, never cumulative drift.
  const denominator = BigInt(fps.numerator)*tbN;
  frames.forEach((frame:{best_effort_timestamp?:number},index:number) => {
    if (!Number.isSafeInteger(frame.best_effort_timestamp)) reject("missing source timestamp");
    const actual = BigInt(frame.best_effort_timestamp!)*denominator;
    const expected = BigInt(index)*BigInt(fps.denominator)*tbD;
    if ((actual > expected ? actual-expected : expected-actual)*2n > denominator) reject("non-CFR decoded timestamps");
  });
}
/** Bounded R1 compiler. Never silently drops an operation it cannot export. */
export function compileProject(project: ProjectDocument, assets: AssetRef[]): RenderPlan {
  if (!positive(project.canvas.width) || !positive(project.canvas.height) || project.canvas.width % 2 || project.canvas.height % 2) reject("even positive canvas dimensions required");
  if (!positive(project.fps.numerator) || !positive(project.fps.denominator)) reject("invalid fps");
  if ("transitions" in project || project.items.some(item => "ducking" in item)) reject("crossfade/music-ducking");
  if (project.captionCues.length) reject("captions");
  if (project.tracks.some(t => t.kind !== "video")) reject("audio/text tracks");
  if (!project.items.length) reject("empty timeline");
  const items = [...project.items].sort((a,b) => a.startFrame-b.startFrame);
  const resolved: RenderPlan["assets"] = []; let end = 0;
  const clips = items.map(item => {
    if (!project.tracks.some(t => t.id === item.trackId && t.kind === "video")) reject("unknown video track");
    if (item.speed !== 1 || item.transform || item.text || item.gain !== undefined || item.fadeInFrames || item.fadeOutFrames) reject("speed/transforms/text/audio envelopes");
    if (item.startFrame !== end || !positive(item.durationFrames)) reject("gaps/overlaps or invalid duration");
    const asset = assets.find(a => a.id === item.assetId);
    if (!asset || asset.kind !== "video" || asset.status !== "ready" || !path.isAbsolute(asset.location) || !existsSync(asset.location)) reject("missing local video asset");
    if (asset.streams?.some(s => s.kind === "audio")) reject("source-audio (silent-only contract)");
    inspectSource(asset.location, project.fps);
    if (checksum(asset.location) !== asset.checksum) reject("asset checksum mismatch");
    const mapping = project.sourceMappings.find(m => m.itemId === item.id);
    if (!mapping || mapping.assetId !== asset.id || mapping.sourceInUs !== item.sourceInUs || mapping.sourceOutUs !== item.sourceOutUs) reject("source mapping mismatch");
    const sourceInUs = mapping.sourceInUs, sourceOutUs = mapping.sourceOutUs;
    if (!Number.isSafeInteger(sourceInUs) || sourceInUs < 0 || !Number.isSafeInteger(sourceOutUs) || sourceOutUs <= sourceInUs) reject("invalid source range");
    if (asset.durationUs === undefined || sourceOutUs > asset.durationUs) reject("source range outside asset");
    if (Math.abs((sourceOutUs-sourceInUs)*project.fps.numerator/(1e6*project.fps.denominator)-item.durationFrames) > 0.001) reject("source duration does not match frame duration");
    if (!resolved.some(a => a.id === asset.id)) resolved.push({id:asset.id,path:asset.location,checksum:asset.checksum});
    end += item.durationFrames;
    const sourceStartFrame = Number((BigInt(sourceInUs)*BigInt(project.fps.numerator) + BigInt(1000000*project.fps.denominator)-1n)/BigInt(1000000*project.fps.denominator));
    return {itemId:item.id,assetId:asset.id,startFrame:item.startFrame,durationFrames:item.durationFrames,sourceInUs,sourceOutUs,sourceStartFrame};
  });
  return {renderer:"ffmpeg",rendererVersion:RENDERER_VERSION,projectId:project.id,revision:project.revision,frameCount:end,composition:structuredClone({...project.canvas,fps:project.fps}),assets:resolved,clips,audioPlan:{policy:"silent"},previewPolicy:"same-rendered-artifact"};
}
/** Preview and export use this immutable output; interactive preview wiring is deferred. */
export async function renderProject(inputPlan: RenderPlan, signal: AbortSignal): Promise<RenderArtifact> {
  const plan = structuredClone(inputPlan);
  if (!positive(plan.frameCount) || !positive(plan.composition.width) || !positive(plan.composition.height) || !positive(plan.composition.fps.numerator) || !positive(plan.composition.fps.denominator) || plan.clips.reduce((n,c)=>n+c.durationFrames,0) !== plan.frameCount) reject("invalid plan snapshot");
  if (plan.rendererVersion !== RENDERER_VERSION || plan.renderer !== "ffmpeg") reject("renderer version");
  return withCancel(signal, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "capy-render-"));
    try {
      for (const asset of plan.assets) { if (checksum(asset.path) !== asset.checksum) reject("asset changed since compile"); inspectSource(asset.path, plan.composition.fps); }
      const args = ["-v","error","-nostdin"];
      const filters: string[] = [];
      const fps = `${plan.composition.fps.numerator}/${plan.composition.fps.denominator}`;
      plan.clips.forEach((clip,i) => {
        const asset = plan.assets.find(a => a.id === clip.assetId); if (!asset) reject("unresolved asset");
        args.push("-i",asset.path);
        filters.push(`[${i}:v]trim=start_frame=${clip.sourceStartFrame}:end_frame=${clip.sourceStartFrame+clip.durationFrames},setpts=PTS-STARTPTS,fps=${fps},scale=${plan.composition.width}:${plan.composition.height}:force_original_aspect_ratio=decrease,pad=${plan.composition.width}:${plan.composition.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${i}]`);
      });
      filters.push(`${plan.clips.map((_,i)=>`[v${i}]`).join("")}concat=n=${plan.clips.length}:v=1:a=0[out]`);
      const output = path.join(dir,"render.mp4");
      await run("ffmpeg", [...args,"-filter_complex",filters.join(";"),"-map","[out]","-an","-frames:v",String(plan.frameCount),"-c:v","libx264","-preset","ultrafast","-y",output]);
      const probe = JSON.parse((await run("ffprobe",["-v","error","-count_frames","-show_streams","-of","json",output])).stdout);
      const video = probe.streams.find((s:{codec_type:string})=>s.codec_type === "video");
      if (Number(video?.nb_read_frames) !== plan.frameCount) throw new Error("Rendered frame count mismatch");
      const hash = createHash("sha256").update(await readFile(output)).digest("hex");
      throwIfCancelled();
      return {id:randomUUID(),projectId:plan.projectId,revision:plan.revision,checksum:hash,path:output,probe:{durationUs:Math.round(plan.frameCount*1e6*plan.composition.fps.denominator/plan.composition.fps.numerator),width:video.width,height:video.height,fps:plan.composition.fps,hasAudio:false},renderer:plan.renderer,rendererVersion:plan.rendererVersion,reviewIds:[]};
    } catch (error) { await rm(dir,{recursive:true,force:true}); throw error; }
  });
}
