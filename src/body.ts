export async function bodyToString(body: unknown): Promise<string> {
  if (body === undefined || body === null) {
    return "";
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.text();
  }
  if (typeof Response !== "undefined" && body instanceof ReadableStream) {
    return new Response(body).text();
  }

  if (isTransformableBody(body)) {
    return body.transformToString();
  }
  if (isReadableStreamLike(body)) {
    const response = new Response(body as BodyInit);
    return response.text();
  }
  if (isAsyncIterable(body)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(toBytes(chunk));
    }
    const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  return String(body);
}

export function bodyToBytes(body: unknown): Uint8Array | undefined {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return undefined;
}

function toBytes(chunk: unknown): Uint8Array {
  const bytes = bodyToBytes(chunk);
  if (bytes) {
    return bytes;
  }
  return new TextEncoder().encode(String(chunk));
}

function isTransformableBody(body: unknown): body is { transformToString(): Promise<string> } {
  return typeof body === "object" && body !== null && "transformToString" in body;
}

function isReadableStreamLike(body: unknown): body is ReadableStream {
  return (
    typeof body === "object" &&
    body !== null &&
    "getReader" in body &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  );
}

function isAsyncIterable(body: unknown): body is AsyncIterable<unknown> {
  return (
    typeof body === "object" &&
    body !== null &&
    Symbol.asyncIterator in body &&
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}
