export const maxDuration = 60;

const MAX_REQUEST_BYTES = 16 * 1024;
const LOCAL_MATCHER_URL = "http://127.0.0.1:8001";

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) {
    return Response.json({ error: "The product lookup request is too large." }, { status: 413 });
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return Response.json({ error: "Send a valid JSON request." }, { status: 400 });
  }

  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    return Response.json({ error: "The product lookup request is too large." }, { status: 413 });
  }

  try {
    const upstream = await fetch(`${LOCAL_MATCHER_URL}/api/amazon/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return Response.json(
      {
        error: timedOut
          ? "The Amazon search took too long. Try again with fewer products."
          : "The Python matcher is unavailable. Start the matcher service and try again.",
      },
      { status: timedOut ? 504 : 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
