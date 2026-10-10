import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FrameCandidate, ThumbnailBrief } from "../../lib/thumbnails";
import type { AiCost } from "../../lib/ai-policy";
export interface ImageRequest {
  frames: FrameCandidate[];
  brief: ThumbnailBrief;
  outputDirectory: string;
}
export interface ImageResult {
  provider: string;
  model: string;
  assets: { path: string; kind: "background"; checksum: string }[];
  cost: AiCost;
  usage?: {
    requests: number;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}
export interface ImageProvider {
  id: string;
  model: string;
  local: boolean;
  capabilities: {
    referenceImages: boolean;
    imageGeneration: boolean;
    preserveSubject: boolean;
    providerQuotaBound: boolean;
  };
  bounds: {
    costUsd: number;
    requests: number;
    tokens: number;
    basis: "estimated" | "verified";
  };
  generate(input: ImageRequest, signal: AbortSignal): Promise<ImageResult>;
}
/** Reviewed 2026-10-10. Direct multipart image edits, not the text CLI or Responses tool chain.
 * https://developers.openai.com/api/reference/resources/images/methods/edit
 * https://developers.openai.com/api/docs/guides/image-generation
 * https://developers.openai.com/api/docs/pricing
 * Estimates are admission allowances, not enforceable provider dollar/token ceilings.
 */
export function createOpenAiImageProvider(
  config: {
    apiKey: string;
    model:
      "gpt-image-2.5-sunburst-2026-09-08" | "gpt-image-2.5-flare-2026-09-08";
    estimatedCallUsd: number;
  },
  transport: typeof fetch = fetch,
): ImageProvider {
  if (
    !config.apiKey.trim() ||
    !Number.isFinite(config.estimatedCallUsd) ||
    config.estimatedCallUsd <= 0
  )
    throw Error(
      "Image provider requires credentials and a positive estimated call allowance",
    );
  if (
    ![
      "gpt-image-2.5-sunburst-2026-09-08",
      "gpt-image-2.5-flare-2026-09-08",
    ].includes(config.model)
  )
    throw Error("Image model capability/pricing have not been verified");
  return {
    id: "openai-images",
    model: config.model,
    local: false,
    capabilities: {
      referenceImages: true,
      imageGeneration: true,
      preserveSubject: true,
      providerQuotaBound: false,
    },
    bounds: {
      costUsd: config.estimatedCallUsd,
      requests: 1,
      tokens: 50_000,
      basis: "estimated",
    },
    async generate(input, signal) {
      if (!input.frames.length || input.frames.length > 3)
        throw Error("Image edits require one to three selected source frames");
      signal.throwIfAborted();
      const form = new FormData();
      form.set("model", config.model);
      form.set("prompt", input.brief.instructions);
      form.set("n", "1");
      form.set("quality", "medium");
      form.set("output_format", "png");
      form.set(
        "size",
        input.brief.aspect === "landscape"
          ? "1536x1024"
          : input.brief.aspect === "portrait"
            ? "1024x1536"
            : "1024x1024",
      );
      for (const frame of input.frames) {
        const bytes = await readFile(frame.path);
        if (
          bytes.length > 10 * 1024 * 1024 ||
          createHash("sha256").update(bytes).digest("hex") !== frame.checksum
        )
          throw Error("Selected image changed or exceeds upload allowance");
        form.append(
          "image[]",
          new Blob([bytes], { type: "image/jpeg" }),
          `${frame.id}.jpg`,
        );
      }
      const response = await transport(
        "https://api.openai.com/v1/images/edits",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        },
      );
      if (!response.ok)
        throw Object.assign(
          Error(
            `Image provider returned HTTP ${response.status}; generation needs attention`,
          ),
          { retryable: response.status === 429 || response.status >= 500 },
        );
      // Bound the body before parsing; never follow provider-returned URLs.
      const reader = response.body?.getReader();
      if (!reader) throw Error("Empty image response");
      const parts: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 32 * 1024 * 1024) {
          await reader.cancel();
          throw Error("Image response exceeds output allowance");
        }
        parts.push(part.value);
      }
      const data = JSON.parse(Buffer.concat(parts).toString()) as {
        data?: { b64_json?: string }[];
        usage?: {
          input_tokens: number;
          output_tokens: number;
          input_tokens_details?: { text_tokens: number; image_tokens: number };
        };
      };
      if (data.data?.length !== 1 || !data.data[0]?.b64_json)
        throw Error("Image provider did not return one image asset");
      const bytes = Buffer.from(data.data[0].b64_json, "base64");
      if (
        bytes.length < 8 ||
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw Error("Image provider returned invalid PNG");
      await mkdir(input.outputDirectory, { recursive: true });
      const file = path.join(
        input.outputDirectory,
        `${input.brief.layout}-background.png`,
      );
      await writeFile(file, bytes);
      signal.throwIfAborted();
      const usage = data.usage;
      const validUsage =
        usage &&
        [
          usage.input_tokens,
          usage.output_tokens,
          usage.input_tokens_details?.text_tokens,
          usage.input_tokens_details?.image_tokens,
        ].every(
          (n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0,
        );
      // API token receipts + documented standard rates yield a cost estimate, not a dollar receipt.
      const cost: AiCost = validUsage
        ? {
            basis: "estimated",
            value:
              (usage!.input_tokens_details!.text_tokens * 5 +
                usage!.input_tokens_details!.image_tokens * 8 +
                usage!.output_tokens * 30) /
              1_000_000,
            currency: "USD",
          }
        : { basis: "unknown" };
      return {
        provider: "openai-images",
        model: config.model,
        assets: [
          {
            path: file,
            kind: "background",
            checksum: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        cost,
        ...(validUsage
          ? {
              usage: {
                requests: 1,
                tokens: usage!.input_tokens + usage!.output_tokens,
                inputTokens: usage!.input_tokens,
                outputTokens: usage!.output_tokens,
              },
            }
          : {}),
      };
    },
  };
}
/** An explicit image setting is required. A text-agent login never enables paid image generation. */
export function configuredImageProvider(): ImageProvider | undefined {
  if (process.env.CAPY_IMAGE_PROVIDER !== "openai-images") return undefined;
  const model = process.env.CAPY_IMAGE_MODEL;
  if (
    model !== "gpt-image-2.5-sunburst-2026-09-08" &&
    model !== "gpt-image-2.5-flare-2026-09-08"
  )
    return undefined;
  const apiKey = process.env.CAPY_IMAGE_API_KEY,
    estimatedCallUsd = Number(process.env.CAPY_IMAGE_CALL_ESTIMATE_USD);
  if (!apiKey || !Number.isFinite(estimatedCallUsd) || estimatedCallUsd <= 0)
    return undefined;
  return createOpenAiImageProvider({ apiKey, model, estimatedCallUsd });
}
