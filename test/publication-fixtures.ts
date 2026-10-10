import {mkdirSync,writeFileSync} from "node:fs";
import path from "node:path";
import {saveAccount,resetAccountsCache} from "../server/accounts";
import {dataDir} from "../server/settings";
export function publicationFixture() {
  mkdirSync(dataDir(),{recursive:true});
  const file=path.join(dataDir(),"fixture.mp4");
  writeFileSync(file,"isolated rendered bytes");
  resetAccountsCache();
  for(const platform of ["youtube","instagram","tiktok"] as const) saveAccount(platform,{tokens:{accessToken:"fixture",refreshToken:"fixture",expiresAt:Date.now()+86400000},account:{id:"fixture-account",name:"Fixture"},igUserId:platform==="instagram" ? "fixture-account" : undefined});
  return {file};
}
