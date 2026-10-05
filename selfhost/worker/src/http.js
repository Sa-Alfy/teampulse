// Response helpers and content-free logging.

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

export function error(status, code) {
  return json(status, { error: code });
}

/** Logs only numbers, fixed codes and route names — never request content or secrets. */
export function log(fields) {
  console.log(JSON.stringify(fields));
}

/** Read the body as text, refusing more than `cap` bytes even without Content-Length. */
export async function readCapped(request, cap) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return { tooLarge: true };
  if (!request.body) return { text: "", bytes: 0 };
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > cap) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(all), bytes };
}
