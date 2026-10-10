import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { AssetRef } from "../../lib/studio/types";
import type { Store } from "../db";
import { runtimeStore } from "../db/runtime";
import { OUTPUT_ROOT, toMediaUrl } from "../paths";
import { enqueueWork } from "../worker/api";
export interface StudioDependencies {
  store: Store;
  root: string;
  enqueue: (input: {
    kind: string;
    workKey: string;
    inputRevision: number;
    payload: Record<string, unknown>;
  }) => Promise<{ id: string }>;
}
export const studioDependencies = (): StudioDependencies => ({
  store: runtimeStore(),
  root: OUTPUT_ROOT,
  enqueue: enqueueWork,
});
export interface AssetImport {
  path: string;
  kind: AssetRef["kind"];
  name?: string;
}
const extensions: Record<AssetRef["kind"], string[]> = {
  video: [".mp4", ".mov", ".mkv", ".webm", ".m4v"],
  audio: [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"],
  image: [".png", ".jpg", ".jpeg", ".webp"],
  font: [".ttf", ".otf", ".woff", ".woff2"],
};
export async function checksum(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function validateFile(input: AssetImport) {
  if (
    !input ||
    typeof input.path !== "string" ||
    !path.isAbsolute(input.path) ||
    !Object.hasOwn(extensions, input.kind) ||
    !extensions[input.kind].includes(path.extname(input.path).toLowerCase())
  )
    throw Error("Choose an absolute path to supported media");
  const file = await realpath(input.path);
  const info = await stat(file);
  if (!info.isFile() || info.size === 0 || info.size > 20 * 1024 ** 3)
    throw Error("Media must be a nonempty file under 20 GB");
  return file;
}
export function mediaUrl(file: string, root: string) {
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw Error("Asset outside media root");
  return root === OUTPUT_ROOT
    ? toMediaUrl(file)
    : `/api/media/${rel.split(path.sep).map(encodeURIComponent).join("/")}`;
}
export async function importAsset(
  input: AssetImport,
  deps = studioDependencies(),
): Promise<AssetRef> {
  const file = await validateFile(input);
  const digest = await checksum(file);
  const id = randomUUID();
  const dir = path.join(deps.root, "studio", "assets", id);
  await mkdir(dir, { recursive: true });
  const destination = path.join(
    dir,
    `original${path.extname(file).toLowerCase()}`,
  );
  await copyFile(file, destination);
  if ((await checksum(destination)) !== digest)
    throw Error("Source changed during import; please import it again");
  const asset: AssetRef = {
    id,
    kind: input.kind,
    checksum: digest,
    location: destination,
    name: (input.name ?? path.basename(file)).slice(0, 200),
    status: input.kind === "font" ? "ready" : "probing",
    mediaUrl: mediaUrl(destination, deps.root),
  };
  deps.store.save("assets", id, asset, 0);
  if (asset.status !== "ready") await queueAsset(asset, deps);
  return asset;
}
/** Work is durable before the request returns; the worker owns all probe/proxy processes. */
export async function queueAsset(asset: AssetRef, deps: StudioDependencies) {
  const row = deps.store.get<AssetRef>("assets", asset.id)!;
  try {
    const work = await deps.enqueue({
      kind: asset.request && !asset.checksum ? "source-range" : "asset-probe",
      workKey: `prepare:${asset.id}`,
      inputRevision: row.revision,
      payload: { assetId: asset.id, location: asset.location },
    });
    asset.workId = work.id;
    const current = deps.store.get<AssetRef>("assets", asset.id)!;
    deps.store.save(
      "assets",
      asset.id,
      { ...current.value, workId: work.id },
      current.revision,
    );
  } catch (error) {
    const current = deps.store.get<AssetRef>("assets", asset.id)!;
    deps.store.save(
      "assets",
      asset.id,
      {
        ...current.value,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
      current.revision,
    );
    throw error;
  }
}
/** Inventory is never evidence of historical approval. Copy and verify as a new identity. */
export async function adoptLegacyAsset(id: string, replacement?: string, deps = studioDependencies()) {
  const row = deps.store.get<AssetRef>("assets", id);
  if (!row?.value.legacy || row.value.checksum)
    throw Error("Choose unverified legacy media to prepare or recover");
  if (row.value.adoptedAssetId) {
    const adopted = deps.store.get<AssetRef>("assets", row.value.adoptedAssetId);
    if (adopted) return adopted.value;
  }
  const asset = await importAsset({
    path: replacement ?? row.value.location,
    kind: row.value.kind,
    name: row.value.name ?? path.basename(replacement ?? row.value.location),
  }, deps);
  // Keep the original inventory and original files, without transferring old approvals.
  deps.store.save("assets", id, { ...row.value, adoptedAssetId: asset.id }, row.revision);
  return asset;
}
export async function retryAsset(id: string, deps = studioDependencies()) {
  const row = deps.store.get<AssetRef>("assets", id);
  if (!row) throw Object.assign(Error("Asset not found"), { status: 404 });
  const asset = {
    ...row.value,
    status:
      row.value.request && !row.value.checksum
        ? ("waiting" as const)
        : ("probing" as const),
    error: undefined,
  };
  deps.store.save("assets", id, asset, row.revision);
  await queueAsset(asset, deps);
  return asset;
}
export async function relinkAsset(
  id: string,
  file: string,
  deps = studioDependencies(),
): Promise<AssetRef> {
  const row = deps.store.get<AssetRef>("assets", id);
  if (!row) throw Object.assign(Error("Asset not found"), { status: 404 });
  const replacement = await validateFile({ path: file, kind: row.value.kind });
  if ((await checksum(replacement)) !== row.value.checksum)
    throw Error("Relink checksum differs; import this file as a new asset");
  await mkdir(path.dirname(row.value.location), { recursive: true });
  if (replacement !== row.value.location)
    await copyFile(replacement, row.value.location);
  const asset = { ...row.value, status: "probing" as const, error: undefined };
  deps.store.save("assets", id, asset, row.revision);
  await queueAsset(asset, deps);
  return asset;
}
export async function listAssets(deps = studioDependencies()) {
  return Promise.all(
    deps.store.list<AssetRef>("assets").filter((row) =>
      !row.value.adoptedAssetId || !deps.store.get("assets", row.value.adoptedAssetId)
    ).map(async (row) => {
      let asset = row.value;
      if (asset.legacy && !asset.checksum) {
        try {
          await stat(asset.location);
          return { ...asset, status: "waiting" as const, error: "Legacy media needs preparation before editing. Original files and old decisions are preserved." };
        } catch {
          return { ...asset, status: "missing" as const, error: "Original identity is unknown. Recover a file as new media; old approvals do not apply." };
        }
      }
      try {
        await stat(asset.location);
      } catch {
        if (asset.status === "ready")
          asset = {
            ...asset,
            status: "missing",
            error: "Original media is missing. Relink its file.",
          };
      }
      if (asset.status === "ready" && asset.proxyLocation) {
        try {
          await stat(asset.proxyLocation);
        } catch {
          asset = { ...asset, proxyLocation: undefined, proxyUrl: undefined };
        }
      }
      if (
        asset.workId &&
        (asset.status === "probing" || asset.status === "waiting")
      ) {
        const work = deps.store.get<{ status: string; error?: string }>(
          "work",
          asset.workId,
        );
        if (work && ["needs_action", "cancelled"].includes(work.value.status))
          asset = {
            ...asset,
            status: "failed",
            error: work.value.error ?? "Media preparation failed",
          };
      }
      if (workStatusError(asset, deps))
        asset = { ...asset, error: workStatusError(asset, deps) };
      return asset;
    }),
  );
}

function workStatusError(asset: AssetRef, deps: StudioDependencies) {
  if (!asset.workId || !["probing", "waiting"].includes(asset.status))
    return undefined;
  const work = deps.store.get<{ status: string; error?: string }>(
    "work",
    asset.workId,
  )?.value;
  return work && ["blocked", "retryable"].includes(work.status)
    ? work.error
    : undefined;
}
