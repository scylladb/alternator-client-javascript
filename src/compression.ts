import { HttpResponse } from "@smithy/protocol-http";
import { bodyToBytes } from "./body.js";
import type {
  AlternatorResponseCompressionAlgorithm,
  AlternatorRuntime,
  NormalizedRequestCompressionOptions,
} from "./types.js";

export async function compressBody(
  body: unknown,
  runtime: AlternatorRuntime,
  config: NormalizedRequestCompressionOptions,
): Promise<{ body: Uint8Array; contentEncoding: string; contentLength: number } | undefined> {
  const bytes = bodyToBytes(body);
  if (!bytes) {
    return undefined;
  }

  if (config.compressor) {
    const compressed = await config.compressor(bytes);
    return {
      body: compressed.body,
      contentEncoding: compressed.contentEncoding,
      contentLength: compressed.contentLength ?? compressed.body.byteLength,
    };
  }

  if (runtime === "edge") {
    if (typeof CompressionStream === "undefined") {
      throw new Error("gzip compression requires CompressionStream support in edge runtime");
    }
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const stream = new Blob([arrayBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    return {
      body: compressed,
      contentEncoding: "gzip",
      contentLength: compressed.byteLength,
    };
  }

  const zlib = await import("node:zlib");
  const compressed = zlib.gzipSync(bytes, {
    level: config.gzipLevel,
  });
  return {
    body: compressed,
    contentEncoding: "gzip",
    contentLength: compressed.byteLength,
  };
}

export function applyResponseEncodingHeaders(
  headers: Record<string, string | undefined>,
  algorithms: readonly AlternatorResponseCompressionAlgorithm[],
): Record<string, string> {
  const acceptEncoding = responseAcceptEncoding(algorithms);
  if (acceptEncoding === "") {
    return copyDefinedHeaders(headers);
  }

  const currentAcceptEncoding = getHeader(headers, "accept-encoding")?.trim();
  if (currentAcceptEncoding && currentAcceptEncoding.toLowerCase() !== "identity") {
    return copyDefinedHeaders(headers);
  }

  return {
    ...removeHeaders(headers, ["accept-encoding"]),
    "accept-encoding": acceptEncoding,
  };
}

export function responseAcceptEncoding(
  algorithms: readonly AlternatorResponseCompressionAlgorithm[],
): string {
  const seen = new Set<AlternatorResponseCompressionAlgorithm>();
  const parts: AlternatorResponseCompressionAlgorithm[] = [];

  for (const algorithm of algorithms) {
    if (seen.has(algorithm)) {
      continue;
    }
    seen.add(algorithm);
    parts.push(algorithm);
  }

  return parts.join(", ");
}

export async function decompressResponse(
  response: HttpResponse,
  runtime: AlternatorRuntime,
): Promise<HttpResponse> {
  const encoding = responseContentEncoding(getHeader(response.headers, "content-encoding"));
  const body: unknown = response.body;
  if (!encoding || body === undefined || body === null) {
    return response;
  }

  const decodedBody = await decompressResponseBody(body, runtime, encoding);
  return new HttpResponse({
    statusCode: response.statusCode,
    ...(response.reason !== undefined ? { reason: response.reason } : {}),
    headers: removeHeaders(response.headers, ["content-encoding", "content-length"]),
    body: decodedBody,
  });
}

async function decompressResponseBody(
  body: unknown,
  runtime: AlternatorRuntime,
  encoding: AlternatorResponseCompressionAlgorithm,
): Promise<unknown> {
  if (runtime === "edge") {
    return decompressWebResponseBody(body, encoding);
  }
  return decompressNodeResponseBody(body, encoding);
}

async function decompressNodeResponseBody(
  body: unknown,
  encoding: AlternatorResponseCompressionAlgorithm,
): Promise<unknown> {
  const zlib = await import("node:zlib");

  if (isNodePipeableBody(body)) {
    const decoder = encoding === "gzip"
      ? zlib.createGunzip()
      : zlib.createInflate();
    return body.pipe(decoder);
  }

  const bytes = await bodyToAsyncBytes(body);
  return encoding === "gzip"
    ? zlib.gunzipSync(bytes)
    : zlib.inflateSync(bytes);
}

async function decompressWebResponseBody(
  body: unknown,
  encoding: AlternatorResponseCompressionAlgorithm,
): Promise<unknown> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("response compression requires DecompressionStream support in edge runtime");
  }

  const stream = await bodyToReadableStream(body);
  return stream.pipeThrough(new DecompressionStream(encoding));
}

async function bodyToReadableStream(body: unknown): Promise<ReadableStream> {
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return body;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.stream();
  }

  const bytes = await bodyToAsyncBytes(body);
  return new Blob([bytesToArrayBuffer(bytes)]).stream();
}

async function bodyToAsyncBytes(body: unknown): Promise<Uint8Array> {
  const bytes = bodyToBytes(body);
  if (bytes) {
    return bytes;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return new Uint8Array(await new Response(body).arrayBuffer());
  }
  if (isTransformableByteBody(body)) {
    return body.transformToByteArray();
  }
  if (isAsyncIterable(body)) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) {
      chunks.push(chunkToBytes(chunk));
    }
    return concatBytes(chunks);
  }

  throw new Error("compressed response body is not readable");
}

function responseContentEncoding(value: string | undefined): AlternatorResponseCompressionAlgorithm | undefined {
  switch (value?.trim().toLowerCase()) {
    case "gzip":
      return "gzip";
    case "deflate":
      return "deflate";
    default:
      return undefined;
  }
}

function copyDefinedHeaders(headers: Record<string, string | undefined>): Record<string, string> {
  const nextHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      nextHeaders[name] = value;
    }
  }
  return nextHeaders;
}

function removeHeaders(
  headers: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string> {
  const removed = new Set(names.map((name) => name.toLowerCase()));
  const nextHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || removed.has(name.toLowerCase())) {
      continue;
    }
    nextHeaders[name] = value;
  }

  return nextHeaders;
}

function getHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
}

function chunkToBytes(chunk: unknown): Uint8Array {
  const bytes = bodyToBytes(chunk);
  if (bytes) {
    return bytes;
  }
  switch (typeof chunk) {
    case "string":
      return new TextEncoder().encode(chunk);
    case "bigint":
    case "number":
    case "boolean":
      return new TextEncoder().encode(String(chunk));
    default:
      throw new Error("compressed response body chunk is not readable");
  }
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isNodePipeableBody(body: unknown): body is {
  pipe(destination: NodeJS.WritableStream): NodeJS.ReadableStream;
} {
  return (
    isObject(body) &&
    "pipe" in body &&
    typeof (body as { pipe?: unknown }).pipe === "function"
  );
}

function isTransformableByteBody(body: unknown): body is {
  transformToByteArray(): Promise<Uint8Array>;
} {
  return (
    isObject(body) &&
    "transformToByteArray" in body &&
    typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function"
  );
}

function isAsyncIterable(body: unknown): body is AsyncIterable<unknown> {
  return (
    isObject(body) &&
    Symbol.asyncIterator in body &&
    typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
