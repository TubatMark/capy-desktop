// Disposable synthetic evidence, deliberately separate from the bounded compiler.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir=mkdtempSync(path.join(tmpdir(),'capy-b1-rich-'));
const ff='/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const font='/System/Library/Fonts/Supplemental/Arial.ttf';
const graph="[0:v][1:v]xfade=transition=fade:duration=1:offset=10[v01];[v01][2:v]xfade=transition=fade:duration=1:offset=20,drawtext=fontfile="+font+":text='B1 static overlay':fontsize=14:x=8:y=8,drawtext=fontfile="+font+":text='Caption 10 to 15 seconds':fontsize=12:x=8:y=h-20:enable='between(t,10,15)'[v];[3:a]asplit=2[voice][trigger];[4:a][trigger]sidechaincompress=threshold=0.03:ratio=8:attack=100:release=300[duck];[voice][duck]amix=inputs=2:normalize=0[a]";
const start=performance.now();
const p=spawnSync('/usr/bin/time',['-l',ff,'-v','error','-f','lavfi','-i','color=red:s=320x180:r=30:d=11','-f','lavfi','-i','color=green:s=320x180:r=30:d=11','-f','lavfi','-i','color=blue:s=320x180:r=30:d=10','-f','lavfi','-i',"sine=frequency=1000:sample_rate=48000:duration=30,volume='if(between(t,10,15),1,0)':eval=frame",'-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=30','-filter_complex',graph,'-map','[v]','-map','[a]','-frames:v','900','-t','30','-c:v','libx264','-preset','ultrafast','-c:a','aac','-y',path.join(dir,'rich.mp4')],{encoding:'utf8'});
if(p.status!==0)throw new Error(p.stderr);
const probe=spawnSync('/opt/homebrew/opt/ffmpeg-full/bin/ffprobe',['-v','error','-count_frames','-show_streams','-of','json',path.join(dir,'rich.mp4')],{encoding:'utf8'});
const record={dir,elapsedMs:performance.now()-start,resourceUsage:p.stderr,probe:JSON.parse(probe.stdout),referenceFrames:[0,150,299,300,315,330,450,599,600,615,630,750,899],audio:{voiceHz:1000,musicHz:220,voiceWindowSeconds:[10,15],attackMs:100,releaseMs:300,duckingAmplitudeMeasured:false}};
for(const frame of record.referenceFrames){const r=spawnSync(ff,['-v','error','-i',path.join(dir,'rich.mp4'),'-vf',`select=eq(n\\,${frame})`,'-frames:v','1','-y',path.join(dir,`frame-${frame}.png`)],{encoding:'utf8'});if(r.status)throw new Error(r.stderr);}
const pcm=spawnSync(ff,['-v','error','-i',path.join(dir,'rich.mp4'),'-map','0:a','-f','f32le','-ac','1','-ar','48000','pipe:1'],{maxBuffer:10000000}).stdout;
function toneAmplitude(start, frequency){let re=0,im=0;const count=48000;for(let n=0;n<count;n++){const sample=pcm.readFloatLE((start*48000+n)*4);const phase=2*Math.PI*frequency*n/48000;re+=sample*Math.cos(phase);im+=sample*Math.sin(phase);}return 2*Math.hypot(re,im)/count;}
record.audio.measuredMusicAmplitude={before:toneAmplitude(5,220),during:toneAmplitude(12,220),after:toneAmplitude(20,220)};
record.audio.measuredDuckingDb=20*Math.log10(record.audio.measuredMusicAmplitude.during/record.audio.measuredMusicAmplitude.before);
record.audio.duckingAmplitudeMeasured=true;
writeFileSync(path.join(dir,'evidence.json'),JSON.stringify(record,null,2));console.log(JSON.stringify(record,null,2));
