import { guardedFetch } from "guarded-fetch";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["regalsales.co.uk", "www.regalsales.co.uk"]);
const ALLOWED_IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

class ImageTooLargeError extends Error {}

async function readImageBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The source image response was empty.");

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

  const imageBytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    imageBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return imageBytes;
}

export async function GET(request: Request) {
  const imageUrlValue = new URL(request.url).searchParams.get("url")?.trim() ?? "";
  if (!imageUrlValue || imageUrlValue.length > 2048) {
    return Response.json({ error: "Provide a valid source image URL." }, { status: 400 });
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(imageUrlValue);
  } catch {
    return Response.json({ error: "Provide a valid source image URL." }, { status: 400 });
  }

  if (
    imageUrl.protocol !== "https:" ||
    imageUrl.username ||
    imageUrl.password ||
    !ALLOWED_HOSTS.has(imageUrl.hostname) ||
    !imageUrl.pathname.startsWith("/product/image/")
  ) {
    return Response.json({ error: "Only public Regal product images can be displayed through this route." }, { status: 400 });
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
    return Response.json({ error: "The source image could not be reached." }, { status: 422 });
  }

  if (!imageResponse.ok) {
    return Response.json({ error: "The source image could not be reached." }, { status: 422 });
  }

  let finalUrl: URL;
  try {
    finalUrl = new URL(imageResponse.url);
  } catch {
    return Response.json({ error: "The source image redirect was invalid." }, { status: 422 });
  }
  if (
    finalUrl.protocol !== "https:" ||
    !ALLOWED_HOSTS.has(finalUrl.hostname) ||
    !finalUrl.pathname.startsWith("/product/image/")
  ) {
    return Response.json({ error: "The source image redirected outside the approved image path." }, { status: 422 });
  }

  const contentType = (imageResponse.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const normalizedContentType = contentType === "image/jpg" ? "image/jpeg" : contentType;
  if (!ALLOWED_IMAGE_TYPES.has(normalizedContentType)) {
    return Response.json({ error: "The source URL did not return a supported image." }, { status: 415 });
  }

  const declaredLength = Number(imageResponse.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_IMAGE_BYTES) {
    return Response.json({ error: "The source image must be 5 MB or smaller." }, { status: 413 });
  }

  let imageBytes: Uint8Array;
  try {
    imageBytes = await readImageBytes(imageResponse);
  } catch (error) {
    const tooLarge = error instanceof ImageTooLargeError;
    return Response.json(
      { error: tooLarge ? "The source image must be 5 MB or smaller." : "The source image could not be read." },
      { status: tooLarge ? 413 : 422 },
    );
  }

  const imageBody = new ArrayBuffer(imageBytes.byteLength);
  new Uint8Array(imageBody).set(imageBytes);
  return new Response(imageBody, {
    headers: {
      "Content-Type": normalizedContentType,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
