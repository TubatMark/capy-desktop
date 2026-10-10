import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './index';
export interface LegacyImportInput {store:Store;dataDir:string;outputRoot:string;beforeCommit?:()=>void}
export interface ImportReport {imported:string[];skipped:string[];unresolved:{id:string;location:string}[];corrupt:{file:string;error:string}[];backupLocation:string}
/** Validate and back up every legacy source before a single transactional activation. Originals are never modified. */
export async function importLegacy(input:LegacyImportInput):Promise<ImportReport>{
 const {store,dataDir,outputRoot}=input;
 const backupLocation=path.join(dataDir,'legacy-backups',randomUUID());mkdirSync(backupLocation,{recursive:true});
 const report:ImportReport={imported:[],skipped:[],unresolved:[],corrupt:[],backupLocation};
 const files:{file:string;kind:string;id:string}[]=[{file:path.join(dataDir,'watch.json'),kind:'legacy-state',id:'watch'},{file:path.join(dataDir,'queue.json'),kind:'legacy-state',id:'queue'}];
 if(existsSync(outputRoot))for(const dir of readdirSync(outputRoot,{withFileTypes:true}))if(dir.isDirectory())files.push({file:path.join(outputRoot,dir.name,'job.json'),kind:'legacy-jobs',id:dir.name});
 const records:{file:string;kind:string;id:string;body:any;digest:string}[]=[];
 for(const entry of files){if(!existsSync(entry.file))continue;const raw=readFileSync(entry.file);copyFileSync(entry.file,path.join(backupLocation,`${records.length}-${path.basename(path.dirname(entry.file))}-${path.basename(entry.file)}`));try{const body=JSON.parse(raw.toString());if(entry.id==='watch'&&(!body||!Array.isArray(body.channels)))throw Error('Invalid watch channels');if(entry.id==='queue'&&!Array.isArray(body))throw Error('Invalid queue entries');if(entry.kind==='legacy-jobs'&&(!body||typeof body.id!=='string'||!Array.isArray(body.clips)))throw Error('Invalid job identity/clips');const id=entry.kind==='legacy-jobs'?body.id:entry.id;records.push({...entry,id,body,digest:createHash('sha256').update(raw).digest('hex')});}catch(e){report.corrupt.push({file:entry.file,error:String(e)});}}
 if(report.corrupt.length){writeFileSync(path.join(backupLocation,'report.json'),JSON.stringify(report,null,2));throw Object.assign(Error(`Legacy import blocked by corrupt records: ${report.corrupt.map(c=>c.file).join(', ')}`),{report});}
 store.backup(path.join(backupLocation,'before.sqlite'));
 store.transaction(()=>{for(const r of records){const prior=store.db.prepare('SELECT digest FROM imports WHERE source=?').get(r.file) as {digest:string}|undefined;if(prior){report.skipped.push(r.id);continue;}if(store.get(r.kind,r.id)){report.skipped.push(r.id);}else{store.put(r.kind,r.id,r.body);report.imported.push(r.id);if(r.kind==='legacy-jobs')for(const clip of r.body.clips){const original=clip.render?.file;if(typeof original!=='string')continue;const local=path.join(path.dirname(r.file),path.basename(original));const location=existsSync(original)?original:local;const id=`${r.id}:clip:${clip.n}`;const ready=existsSync(location);store.put('assets',id,{id,kind:'video',location,originalLocation:original,status:ready?'ready':'missing',legacy:true});if(!ready)report.unresolved.push({id,location:original});}}store.db.prepare('INSERT INTO imports(source,digest,imported_at) VALUES(?,?,?)').run(r.file,r.digest,Date.now());}input.beforeCommit?.();});
 if(store.integrity()!=='ok')throw Error('Import integrity failed');writeFileSync(path.join(backupLocation,'report.json'),JSON.stringify(report,null,2));return report;
}
