/** Client-safe durable Studio contracts. Timeline units are frames; source units are microseconds. */
export interface AssetRef {
  id: string; kind: "video" | "audio" | "image" | "font"; checksum: string; location: string;
  durationUs?: number; streams?: {kind:"video"|"audio";codec:string;width?:number;height?:number;sampleRate?:number}[];
  original?: {jobId?:string;videoId?:string;sourceOffsetUs?:number}; status: "ready" | "missing" | "relink";
}
export interface TimelineItem {
  id:string;trackId:string;assetId?:string;startFrame:number;durationFrames:number;sourceInUs?:number;sourceOutUs?:number;speed:1;
  transform?:{x:number;y:number;scale:number;rotation:number}; gain?:number;fadeInFrames?:number;fadeOutFrames?:number;
  text?:{value:string;fontAssetId?:string;fontSize:number;color:string};
}
export interface ProjectDocument {
  schemaVersion:number;id:string;revision:number;canvas:{width:number;height:number};fps:{numerator:number;denominator:number};
  tracks:{id:string;kind:"video"|"audio"|"text"}[];items:TimelineItem[];
  sourceMappings:{itemId:string;assetId:string;sourceInUs:number;sourceOutUs:number}[];
  captionCues:{id:string;startFrame:number;durationFrames:number;text:string}[];thumbnailIds:string[];
}
export interface RenderArtifact {
  id:string;projectId:string;revision:number;checksum:string;path:string;
  probe:{durationUs:number;width:number;height:number;fps:{numerator:number;denominator:number};hasAudio:boolean};
  renderer:string;rendererVersion:string;reviewIds:string[];
}
export interface ThumbnailDocument {
  id:string;projectId?:string;revision?:number;legacyClipId?:string;renderChecksum?:string;
  sourceFrames:{assetId:string;sourceUs:number;checksum:string}[];aspectPreset:"landscape"|"portrait"|"square";
  layers:{id:string;kind:"image"|"text";assetId?:string;text?:string;x:number;y:number;width:number;height:number}[];
  versions:{id:string;checksum:string;path:string}[];
  provenance?:{provider:string;model:string;prompt:string};generationState:"draft"|"generating"|"ready"|"failed";reviewState:"pending"|"approved"|"blocked"|"stale";
}
export interface JobRecord {
  id:string;kind:string;workKey:string;inputRevision:string;stage:string;status:"pending"|"running"|"waiting"|"complete"|"failed"|"cancelled";
  checkpoint:Record<string,unknown>;lease?:{owner:string;generation:number;expiresAt:number};attempts:number;retryAt?:number;cancelRequested:boolean;error?:string;
}
export interface AiTaskPolicy {
  taskId:string;capability:string;provider:string;model:string;contextLimit:number;outputLimit:number;timeoutMs:number;retryLimit:number;
  fallback?:{provider:string;model:string};escalation?:{provider:string;model:string};allowLocal:boolean;allowCloud:boolean;budgetCeiling:number;
}
export interface AiRunRecord {
  taskId:string;inputVersion:string;provider:string;model:string;routingReason:string;attempts:number;latencyMs:number;
  usage?:{inputTokens:number;outputTokens:number};cost?:{amount:number;estimated:boolean};outcome:"success"|"failed"|"waiting";cacheIdentity:string;
}
