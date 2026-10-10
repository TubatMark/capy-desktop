import { describe, expect, it } from "vitest";
import { approve, move, postNow, retry, upsertForRender } from "../server/queue";

describe("central publication gate", () => {
  it("blocked_review_cannot_schedule_via_any_route", () => {
    const now = new Date();
    const entries = upsertForRender([], {jobId:"blocked",n:1,start:0,end:30,clipTitle:"blocked",aiReview:{verdict:"block",summary:"unsafe",issues:[],at:now.getTime()}}, ["youtube"], now);
    expect(approve(entries,"blocked",1,{audienceTz:"UTC",now}).scheduled).toHaveLength(0);
    for (const action of [postNow,retry]) expect(action(entries,entries[0]!.key,now)[0]!.status).toBe("review");
    expect(move(entries,entries[0]!.key,now.getTime()+1000,now,"UTC")[0]!.status).toBe("review");
  });
});

import { afterAll, beforeEach } from "vitest";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {publicationFixture} from "./publication-fixtures";
import {decide,eligibility,evaluatePublication,publicationContext,buildPublishPackage} from "../server/publication-policy";
import {saveAccount} from "../server/accounts";
import {reconnected,editText,queue,resetQueueCache} from "../server/queue";
import type {QueueEntry} from "../lib/types";
const root=mkdtempSync(path.join(tmpdir(),"capy-publication-"));
let sequence=0;
let files:{file:string;thumbFile?:string};
beforeEach(()=>{process.env.CAPY_DATA_DIR=path.join(root,String(++sequence));files=publicationFixture();resetQueueCache();});
afterAll(()=>rmSync(root,{recursive:true,force:true}));
const entry=():QueueEntry=>decide(upsertForRender([],{publicationFiles:files,jobId:"J",n:1,start:0,end:30,clipTitle:"Fixture",aiReview:{verdict:"ok",summary:"passed",issues:[],at:1}},["youtube"],new Date())[0]!,false,new Date());

describe("immutable package decisions",()=>{
  it("fresh valid package succeeds and snapshot text is independent of mutable input",()=>{
    const e=entry();expect(eligibility(e).allowed).toBe(true);
    e.text.title="modified";expect(e.publishPackage!.text.title).toBe("Fixture");expect(eligibility(e).allowed).toBe(false);
  });
  it("changed_package_requires_new_decision",()=>{
    for(const bytes of ["different footage","caption-only render","audio-only render"]){
      const e=entry();writeFileSync(files.file,bytes);expect(eligibility(e).allowed).toBe(false);
    }
    const e=entry();expect(eligibility({...e,text:{title:"changed text"}}).allowed).toBe(false);
    expect(eligibility({...e,thumbAt:20}).allowed).toBe(false);
    expect(eligibility({...e,platform:"tiktok"}).allowed).toBe(false);
    saveAccount("youtube",{account:{id:"different",name:"Different"}});expect(eligibility(e).allowed).toBe(false);
  });
  it("changed thumbnail bytes or revision invalidates approval",()=>{
    files.thumbFile=path.join(path.dirname(files.file),"thumb.jpg");writeFileSync(files.thumbFile,"thumbnail A");
    const e=entry();expect(eligibility(e).allowed).toBe(true);
    const context=publicationContext(e);context.thumbnailRevision="new revision";expect(evaluatePublication(e.publishPackage,context).allowed).toBe(false);
    writeFileSync(files.thumbFile,"thumbnail B");expect(eligibility(e).allowed).toBe(false);
    rmSync(files.thumbFile);expect(eligibility(e).allowed).toBe(false);
  });
  it("automatic policy cannot override block or missing/failed review",()=>{
    for(const review of [undefined,{verdict:"block" as const,summary:"blocked",issues:[],at:1}]){
      const e=entry();e.aiReview=review;const decided=decide(e,true,new Date());const c=publicationContext(decided);c.approval=undefined;c.automaticPolicy={enabled:true,policyVersion:c.policyVersion,accountId:decided.publishPackage!.accountId};
      expect(evaluatePublication(decided.publishPackage,c).allowed).toBe(false);
    }
  });
  it("explicit human override is separate and bound to exact package",()=>{
    const e=entry();e.aiReview={verdict:"block",summary:"blocked",issues:[],at:1};
    expect(eligibility(decide(e,false,new Date())).allowed).toBe(false);
    const override=decide(e,true,new Date());expect(override.publicationDecision?.kind).toBe("human_override");expect(eligibility(override).allowed).toBe(true);
    writeFileSync(files.file,"edited");expect(eligibility(override).allowed).toBe(false);
  });
  it("same-account reconnect recovers, different ID requires new review",()=>{
    const e={...entry(),status:"needs_action" as const,authBlocked:true};
    saveAccount("youtube",{needsReconnect:true});expect(reconnected([e],"youtube","UTC",new Date())[0]!.status).toBe("review");
    saveAccount("youtube",{needsReconnect:null});expect(reconnected([e],"youtube","UTC",new Date())[0]!.status).toBe("scheduled");
    saveAccount("youtube",{account:{id:"new",name:"New"}});expect(reconnected([e],"youtube","UTC",new Date())[0]!.status).toBe("review");
  });
  it("legacy unknown media/account identity and altered manifests fail closed",()=>{
    const e=entry();expect(eligibility({...e,publishPackage:undefined}).allowed).toBe(false);
    expect(eligibility({...e,publishPackage:{...e.publishPackage!,accountId:"new"}}).allowed).toBe(false);
    expect(editText([{...e,status:"scheduled"}],e.key,{title:"new"},new Date())[0]!.status).toBe("review");
  });
  it("canonical package hashes ignore key order and random identity",()=>{
    const e=entry();const {packageHash:_hash,...input}=e.publishPackage!;
    expect(buildPublishPackage({...input,id:"another-id",text:{...input.text}}).packageHash).toBe(e.publishPackage!.packageHash);
    const c=publicationContext(e);c.policyVersion="different-policy";expect(evaluatePublication(e.publishPackage,c).allowed).toBe(false);
    const stale=publicationContext(e);stale.reviewHash="stale";expect(evaluatePublication(e.publishPackage,stale).allowed).toBe(false);
  });
});

it("malformed persisted packages cannot authorize publication",()=>{
  const e=entry();
  expect(eligibility({...e,publishPackage:{...e.publishPackage!,artifact:{id:"broken",checksum:"not-a-hash"}}}).allowed).toBe(false);
});

it("malformed persisted decisions never grant human authority",()=>{
  const e=entry();
  for(const decision of [{packageHash:e.publishPackage!.packageHash,at:1},{kind:"unknown",packageHash:e.publishPackage!.packageHash,at:1},{kind:"human",packageHash:e.publishPackage!.packageHash},{kind:"human",packageHash:e.publishPackage!.packageHash,at:NaN},{kind:"human_override",packageHash:e.publishPackage!.packageHash,at:Infinity}]) {
    expect(eligibility({...e,publicationDecision:decision as QueueEntry["publicationDecision"]}).allowed).toBe(false);
  }
});
it("changing TikTok assisted inbox to direct requires a new decision",()=>{
  const raw=upsertForRender([],{publicationFiles:files,jobId:"TT",n:1,start:0,end:30,clipTitle:"TikTok"},["tiktok"],new Date())[0]!;
  const e=decide(raw,false,new Date());expect(eligibility(e).allowed).toBe(true);
  saveAccount("tiktok",{mode:"direct"});expect(eligibility(e).allowed).toBe(false);
  expect(eligibility(decide(e,false,new Date())).allowed).toBe(true);
});

import { runtimeStore } from '../server/db/runtime';
import { hashFile } from '../server/publication-policy';
import { queueGroup } from '../lib/queue-source';
it('Studio stale revisions cannot approve or post-now, while historical bytes remain intact',()=>{
 const e:QueueEntry={...entry(),jobId:undefined,n:undefined,key:'studio:r:youtube',source:{kind:'studio',projectId:'p',revision:1,renderId:'r',renderChecksum:hashFile(files.file)!},publishPackage:undefined,publicationDecision:undefined};
 runtimeStore().put('projects','p',{id:'p',revision:1});runtimeStore().put('renders','r',{id:'r',projectId:'p',revision:1,checksum:hashFile(files.file),path:files.file});
 const approved=decide(e,false,new Date());expect(approved.publishPackage?.artifact).toMatchObject({id:'r',projectId:'p',revision:1});expect(eligibility(approved).allowed).toBe(true);
 queue().mutate(()=>[approved]);expect(queue().list()[0]?.source?.renderId).toBe('r');
 for(const change of ['audio','captions','video']){
 runtimeStore().put('projects','p',{id:'p',revision:2,change});expect(eligibility(approved).reasons.join(' ')).toContain('revision changed');
 expect(approve([approved],'',undefined,{group:queueGroup(approved),audienceTz:'UTC',now:new Date()}).scheduled).toHaveLength(0);
 expect(postNow([approved],approved.key,new Date())[0]?.status).toBe('review');expect(hashFile(files.file)).toBe(e.source!.renderChecksum);
 }
});
