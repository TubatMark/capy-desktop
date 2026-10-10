const finalRead = vi.hoisted(() => ({ after: undefined as undefined | ((file: unknown) => void) }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {...original, readFile: async (...args: Parameters<typeof original.readFile>) => { const bytes = await original.readFile(...args); finalRead.after?.(args[0]); return bytes; }};
});
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { run } from "../src/exec";
import { compileProject, renderProject } from "../src/studio/renderer";
import type { AssetRef, ProjectDocument } from "../lib/studio/types";
let dir:string; let asset:AssetRef;
const project:ProjectDocument={schemaVersion:1,id:"fixture",revision:2,canvas:{width:160,height:90},fps:{numerator:30,denominator:1},tracks:[{id:"v",kind:"video"}],items:[0,1,2].map(i=>({id:`i${i}`,trackId:"v",assetId:"a",startFrame:i*300,durationFrames:300,sourceInUs:0,sourceOutUs:10000000,speed:1})),sourceMappings:[0,1,2].map(i=>({itemId:`i${i}`,assetId:"a",sourceInUs:0,sourceOutUs:10000000})),captionCues:[],thumbnailIds:[]};
beforeAll(async()=>{dir=await mkdtemp(path.join(tmpdir(),"capy-fixture-"));const file=path.join(dir,"source.mp4");await run("ffmpeg",["-v","error","-f","lavfi","-i","color=c=red:s=160x90:r=30:d=10","-an","-c:v","libx264","-preset","ultrafast","-y",file]);asset={id:"a",kind:"video",checksum:createHash("sha256").update(await readFile(file)).digest("hex"),location:file,durationUs:10000000,status:"ready",streams:[{kind:"video",codec:"h264"}]};});
afterAll(async()=>{await rm(dir,{recursive:true,force:true});});
test("compiles 900 frames with exact source mappings and revision",()=>{const plan=compileProject(project,[asset]);expect(plan.frameCount).toBe(900);expect(plan.revision).toBe(2);expect(plan.clips[2]!.startFrame).toBe(600);});
test("rejects operations before silently dropping them",()=>{expect(()=>compileProject({...project,captionCues:[{id:"c",startFrame:0,durationFrames:30,text:"hello"}]},[asset])).toThrow("captions");expect(()=>compileProject({...project,items:project.items.map((i,n)=>({...i,startFrame:i.startFrame+(n===1?1:0)}))},[asset])).toThrow("gaps/overlaps");expect(()=>compileProject(project,[{...asset,checksum:"changed"}])).toThrow("checksum");});
test("exports actual 900 frames and ties artifact to input revision",async()=>{const artifact=await renderProject(compileProject(project,[asset]),new AbortController().signal);expect(artifact.probe.durationUs).toBe(30000000);expect(artifact.probe.hasAudio).toBe(false);expect(artifact.revision).toBe(2);await rm(path.dirname(artifact.path),{recursive:true,force:true});},30000);
test("already cancelled renders never publish artifacts",async()=>{const controller=new AbortController();controller.abort();await expect(renderProject(compileProject(project,[asset]),controller.signal)).rejects.toThrow("Cancelled");});

test("final read cancellation cleans the unpublished output",async()=>{
  const controller=new AbortController();let output:unknown;finalRead.after=file=>{output=file;controller.abort();};
  try { await expect(renderProject(compileProject(project,[asset]),controller.signal)).rejects.toThrow("Cancelled"); }
  finally { finalRead.after=undefined; }
  expect(typeof output).toBe("string"); expect(existsSync(path.dirname(String(output)))).toBe(false);
});
test("render snapshots caller plan before its first await",async()=>{
  const plan=compileProject(project,[asset]); const pending=renderProject(plan,new AbortController().signal);
  plan.revision=999;plan.projectId="mutated";plan.clips.length=0;plan.assets.length=0;plan.composition.width=2;
  const artifact=await pending;expect(artifact.revision).toBe(2);expect(artifact.projectId).toBe("fixture");expect(artifact.probe.width).toBe(160);
  await rm(path.dirname(artifact.path),{recursive:true,force:true});
});
test("actual audio is rejected even when metadata omits it",async()=>{
  const file=path.join(dir,"audio.mp4");await run("ffmpeg",["-v","error","-i",asset.location,"-f","lavfi","-i","sine=duration=10","-c:v","copy","-c:a","aac","-shortest","-y",file]);
  const ref={...asset,location:file,streams:undefined,checksum:createHash("sha256").update(await readFile(file)).digest("hex")};
  expect(()=>compileProject(project,[ref])).toThrow("verified silent-only");
});
test("arbitrary microsecond offset deterministically rounds to next CFR frame",async()=>{
  const file=path.join(dir,"offset.mp4");await run("ffmpeg",["-v","error","-f","lavfi","-i","nullsrc=s=160x90:r=30:d=11,geq=lum='mod(N*5,220)+16':cb=128:cr=128","-c:v","libx264","-crf","0","-y",file]);
  const ref={...asset,location:file,durationUs:11000000,checksum:createHash("sha256").update(await readFile(file)).digest("hex")};
  const one={...project,items:[{...project.items[0]!,durationFrames:30,sourceInUs:1000,sourceOutUs:1001000}],sourceMappings:[{itemId:"i0",assetId:"a",sourceInUs:1000,sourceOutUs:1001000}]};
  const plan=compileProject(one,[ref]);expect(plan.clips[0]!.sourceStartFrame).toBe(1);
  const artifact=await renderProject(plan,new AbortController().signal);
  const first=await run("ffmpeg",["-v","error","-i",artifact.path,"-vf","signalstats,metadata=print:file=-","-frames:v","1","-f","null","-"]);
  const reference=await run("ffmpeg",["-v","error","-i",file,"-vf","select=eq(n\\,1),signalstats,metadata=print:file=-","-frames:v","1","-f","null","-"]);
  const luma=(value:string)=>Number(value.match(/lavfi.signalstats.YAVG=(\S+)/)?.[1]);
  expect(luma(first.stdout)).toBeCloseTo(luma(reference.stdout),0);
  await rm(path.dirname(artifact.path),{recursive:true,force:true});
});
test("matching aggregate rates cannot hide variable decoded timestamps",async()=>{
  const file=path.join(dir,"variable.mp4");
  await run("ffmpeg",["-v","error","-f","lavfi","-i","color=red:s=160x90:r=30:d=1","-vf","settb=1/30000,setpts=PTS+if(eq(N\\,10)\\,150\\,0)","-fps_mode","passthrough","-enc_time_base","1/30000","-video_track_timescale","30000","-c:v","libx264","-y",file]);
  const probe=JSON.parse((await run("ffprobe",["-v","error","-show_streams","-of","json",file])).stdout);
  expect(probe.streams[0].r_frame_rate).toBe("30/1");expect(probe.streams[0].avg_frame_rate).toBe("30/1");
  const ref={...asset,location:file,durationUs:1000000,checksum:createHash("sha256").update(await readFile(file)).digest("hex")};
  const one={...project,items:[{...project.items[0]!,durationFrames:30,sourceOutUs:1000000}],sourceMappings:[{itemId:"i0",assetId:"a",sourceInUs:0,sourceOutUs:1000000}]};
  expect(()=>compileProject(one,[ref])).toThrow("non-CFR decoded timestamps");
});
