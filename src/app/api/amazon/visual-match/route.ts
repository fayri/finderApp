import { Output, generateText } from "ai";
import { guardedFetch } from "guarded-fetch";
import { z } from "zod";

export const maxDuration = 30;

const MAX_REQUEST_BYTES = 24 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_CANDIDATES = 5;
const MAX_URL_LENGTH = 2048;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const VISUAL_VERDICTS = ["strong", "possible", "different", "uncertain"] as const;

class RequestBodyTooLargeError extends Error {}
class ImageTooLargeError extends Error {}

interface ImageAsset {
  mediaType: string;
  data: Uint8Array;
}

interface CandidateInput {
  imageUrl: string;
}

function isAmazonImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "media-amazon.com" ||
    host.endsWith(".media-amazon.com") ||
    host.endsWith(".ssl-images-amazon.com")
  );
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

async function readRequestBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function readImageBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The image response was empty.");

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new ImageTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchImage(value: string, kind: "source" | "amazon"): Promise<ImageAsset | null> {
  const url = parseHttpsUrl(value);
  if (!url || (kind === "amazon" && !isAmazonImageHost(url.hostname))) return null;

  try {
    const response = await guardedFetch(url, {
      httpsOnly: true,
      maxRedirects: 3,
      timeoutMs: 6_000,
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
    });
    if (!response.ok) return null;

    let finalUrl: URL;
    try {
      finalUrl = new URL(response.url);
    } catch {
      return null;
    }
    if (
      finalUrl.protocol !== "https:" ||
      (kind === "amazon" && !isAmazonImageHost(finalUrl.hostname))
    ) {
      return null;
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) return null;

    const declaredType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const mediaType = declaredType === "image/jpg" ? "image/jpeg" : declaredType;
    if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return null;

    const data = await readImageBytes(response);
    return data.byteLength ? { mediaType, data } : null;
  } catch (error) {
    if (error instanceof ImageTooLargeError) return null;
    return null;
  }
}

const responseSchema = z.object({
  evaluations: z.array(
    z.object({
      index: z.number().int().min(0).max(MAX_CANDIDATES - 1),
      verdict: z.enum(VISUAL_VERDICTS),
      imageMatchScore: z.number().int().min(0).max(100),
      reason: z.string().trim().min(1).max(240),
    }),
  ),
});

const requestOriginIsSameSite = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const forwardedHosts = (request.headers.get("x-forwarded-host") ?? "").split(",");
    const headerHosts = (request.headers.get("host") ?? "").split(",");
    const requestHosts = [...forwardedHosts, ...headerHosts, new URL(request.url).host]
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    return requestHosts.includes(originHost);
  } catch {
    return false;
  }
};

function unavailableEvaluations(candidates: CandidateInput[]) {
  return candidates.map((_, index) => ({
    index,
    verdict: "uncertain" as const,
    imageMatchScore: null,
    reason: "The images could not be compared; title-word matching was used instead.",
  }));
}

export async function POST(request: Request) {
  if (!requestOriginIsSameSite(request)) {
    return Response.json({ error: "Cross-origin image comparisons are not allowed." }, { status: 403 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "The visual comparison request is too large." }, { status: 413 });
  }

  let payload: unknown;
  try {
    const body = await readRequestBody(request);
    payload = JSON.parse(body);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "The visual comparison request is too large." }, { status: 413 });
    }
    return Response.json({ error: "Send a valid visual comparison request." }, { status: 400 });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Send a valid visual comparison request." }, { status: 400 });
  }

  const input = payload as {
    sourceImageUrl?: unknown;
    candidates?: unknown;
  };
  const sourceImageUrl =
    typeof input.sourceImageUrl === "string" ? input.sourceImageUrl.trim().slice(0, MAX_URL_LENGTH) : "";

  if (!Array.isArray(input.candidates) || input.candidates.length > MAX_CANDIDATES) {
    return Response.json({ error: `Provide up to ${MAX_CANDIDATES} Amazon candidates.` }, { status: 400 });
  }

  const candidates: CandidateInput[] = [];
  for (const value of input.candidates) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return Response.json({ error: "Each Amazon candidate must include an image URL." }, { status: 400 });
    }
    const candidate = value as { imageUrl?: unknown };
    if (typeof candidate.imageUrl !== "string" || candidate.imageUrl.length > MAX_URL_LENGTH) {
      return Response.json({ error: "Candidate image URLs are invalid." }, { status: 400 });
    }
    candidates.push({ imageUrl: candidate.imageUrl.trim() });
  }

  if (candidates.length === 0) {
    return Response.json({ evaluations: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const fallback = unavailableEvaluations(candidates);
  const sourceImage = sourceImageUrl ? await fetchImage(sourceImageUrl, "source") : null;
  if (!sourceImage) {
    return Response.json({ evaluations: fallback }, { headers: { "Cache-Control": "no-store" } });
  }

  const candidateImages = await Promise.all(
    candidates.map(async (candidate, index) => ({
      index,
      candidate,
      image: candidate.imageUrl ? await fetchImage(candidate.imageUrl, "amazon") : null,
    })),
  );
  const usableCandidates = candidateImages.filter(
    (candidate): candidate is typeof candidate & { image: ImageAsset } => candidate.image !== null,
  );
  if (!usableCandidates.length) {
    return Response.json({ evaluations: fallback }, { headers: { "Cache-Control": "no-store" } });
  }

  const content: Array<
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; data: Uint8Array }
  > = [
    {
      type: "text",
      text: "SOURCE PRODUCT IMAGE — compare visible packaging, colors, shapes, and label details only.",
    },
    { type: "file", mediaType: sourceImage.mediaType, data: sourceImage.data },
  ];

  for (const candidate of usableCandidates) {
    content.push({
      type: "text",
      text: `AMAZON CANDIDATE IMAGE ${candidate.index}`,
    });
    content.push({ type: "file", mediaType: candidate.image.mediaType, data: candidate.image.data });
  }

  try {
    const { output } = await generateText({
      model: "google/gemini-3.5-flash",
      output: Output.object({ schema: responseSchema }),
      instructions: [
        "Compare each Amazon candidate image with the source product image and return one conservative visual assessment per candidate index.",
        "Assess visible packaging, product silhouette, colors, and text that can actually be read in the images. Do not use external product titles, search terms, or source metadata: the image score must stay independent of title matching.",
        "Do not require pixel-identical packaging: packaging redesigns can still depict the same product when distinctive visual evidence supports it. A shared product category alone is weak evidence.",
        "Use strong only when multiple product-specific visual cues align and no clear visual contradiction exists; possible when some cues align but are inconclusive; different for a clear visual conflict; uncertain when the images are too unclear.",
        "Return an integer imageMatchScore from 0 to 100 as an AI-estimated visual similarity, not a calibrated probability. Keep the score consistent with the verdict and cite visible evidence in the short reason.",
        'Return only the requested structured result. Use the exact shape {"evaluations":[{"index":0,"verdict":"strong|possible|different|uncertain","imageMatchScore":0,"reason":"..."}]}.',
      ].join(" "),
      messages: [{ role: "user", content }],
      maxOutputTokens: 1_200,
      temperature: 0,
      abortSignal: AbortSignal.timeout(15_000),
    });

    if (!output) {
      return Response.json({ evaluations: fallback }, { headers: { "Cache-Control": "no-store" } });
    }

    const allowedIndices = new Set(usableCandidates.map(({ index }) => index));
    const evaluationsByIndex = new Map<number, (typeof output.evaluations)[number]>();
    for (const evaluation of output.evaluations) {
      if (allowedIndices.has(evaluation.index) && !evaluationsByIndex.has(evaluation.index)) {
        evaluationsByIndex.set(evaluation.index, evaluation);
      }
    }

    const evaluations = fallback.map((defaultEvaluation, index) => {
      const evaluation = evaluationsByIndex.get(index);
      return evaluation
        ? { ...evaluation, reason: evaluation.reason.trim().slice(0, 240) }
        : defaultEvaluation;
    });
    return Response.json({ evaluations }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ evaluations: fallback }, { headers: { "Cache-Control": "no-store" } });
  }
}
