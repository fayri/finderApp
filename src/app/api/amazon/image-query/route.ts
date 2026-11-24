import { generateText } from "ai";
import { guardedFetch } from "guarded-fetch";

export const maxDuration = 30;

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TITLE_LENGTH = 240;
const MAX_SIZE_LENGTH = 80;
const MAX_PACK_LENGTH = 40;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

class RequestBodyTooLargeError extends Error {}
class ImageTooLargeError extends Error {}

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

  return Buffer.concat(chunks, byteLength).toString("utf8");
}

async function readImageBytes(response: Response): Promise<Buffer> {
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

  return Buffer.concat(chunks, byteLength);
}

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "The image lookup request is too large." }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readRequestBody(request));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json({ error: "The image lookup request is too large." }, { status: 413 });
    }
    return Response.json({ error: "Send a valid JSON request." }, { status: 400 });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Send a valid image lookup request." }, { status: 400 });
  }

  const input = payload as { title?: unknown; imageUrl?: unknown; size?: unknown; pack?: unknown };
  const title = typeof input.title === "string" ? input.title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const size = typeof input.size === "string" ? input.size.trim() : "";
  const pack = typeof input.pack === "string" ? input.pack.trim() : "";
  const imageUrlValue = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";

  if (size.length > MAX_SIZE_LENGTH || pack.length > MAX_PACK_LENGTH) {
    return Response.json({ error: "The size or pack detail is too long." }, { status: 400 });
  }

  if (!imageUrlValue) {
    return Response.json({ error: "Add an image URL to analyze." }, { status: 400 });
  }
  if (imageUrlValue.length > 2048) {
    return Response.json({ error: "The image URL is too long." }, { status: 400 });
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(imageUrlValue);
  } catch {
    return Response.json({ error: "Enter a valid image URL." }, { status: 400 });
  }
  if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password) {
    return Response.json({ error: "Use a public HTTPS image URL without embedded credentials." }, { status: 400 });
  }

  let imageResponse: Response;
  try {
    imageResponse = await guardedFetch(imageUrl, {
      httpsOnly: true,
      maxRedirects: 3,
      timeoutMs: 10_000,
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif" },
    });
  } catch {
    return Response.json(
      { error: "The image URL could not be reached. Use a publicly accessible HTTPS image." },
      { status: 422 },
    );
  }

  if (!imageResponse.ok) {
    return Response.json(
      { error: "The image URL could not be reached. Use a publicly accessible HTTPS image." },
      { status: 422 },
    );
  }

  const declaredImageLength = Number(imageResponse.headers.get("content-length") ?? 0);
  if (declaredImageLength > MAX_IMAGE_BYTES) {
    return Response.json({ error: "The image must be 5 MB or smaller." }, { status: 413 });
  }

  const mediaType = (imageResponse.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const normalizedMediaType = mediaType === "image/jpg" ? "image/jpeg" : mediaType;
  if (!ALLOWED_IMAGE_TYPES.has(normalizedMediaType)) {
    return Response.json({ error: "The URL must return a JPG, PNG, WebP, GIF, or AVIF image." }, { status: 415 });
  }

  let imageBytes: Buffer;
  try {
    imageBytes = await readImageBytes(imageResponse);
  } catch (error) {
    if (error instanceof ImageTooLargeError) {
      return Response.json({ error: "The image must be 5 MB or smaller." }, { status: 413 });
    }
    return Response.json({ error: "The image could not be read. Try a different image URL." }, { status: 422 });
  }

  try {
    const text = [
      "Create one concise search phrase for finding this product on Amazon UK.",
      title ? `User-supplied product title: ${title}` : "No product title was supplied.",
      size ? `User-confirmed size: ${size}` : "No size was supplied.",
      pack ? `User-confirmed pack count: ${pack}` : "No pack count was supplied.",
      "Use the image and supplied title together to identify likely product search terms. Preserve the title's important words. Keep the supplied size and pack count as confirmation details; never guess or alter them. Return only the search phrase, with no explanation or quotation marks.",
    ].join("\n");

    const result = await generateText({
      model: "google/gemini-3.5-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text },
            { type: "file", mediaType: normalizedMediaType, data: imageBytes },
          ],
        },
      ],
      maxOutputTokens: 80,
      temperature: 0.1,
      abortSignal: AbortSignal.timeout(15_000),
    });

    const query = result.text.replace(/[\r\n]+/g, " ").replace(/["'`]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
    if (!query) {
      return Response.json({ error: "The image did not produce a usable product search phrase." }, { status: 422 });
    }

    return Response.json({ query }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Image analysis is unavailable right now. Try again or search by title." }, { status: 502 });
  }
}
