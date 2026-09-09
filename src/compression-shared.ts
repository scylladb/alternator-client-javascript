/*
 * Copyright ScyllaDB, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { HttpResponse } from "@smithy/protocol-http";
import { bodyToBytes } from "./body.js";
import type { AlternatorResponseCompressionAlgorithm } from "./types.js";

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

export async function mapCompressedResponse(
  response: HttpResponse,
  decompressBody: (
    body: unknown,
    encoding: AlternatorResponseCompressionAlgorithm,
  ) => Promise<unknown>,
): Promise<HttpResponse> {
  const encoding = responseContentEncoding(getHeader(response.headers, "content-encoding"));
  const body: unknown = response.body;
  if (!encoding || body === undefined || body === null) {
    return response;
  }

  const decodedBody = await decompressBody(body, encoding);
  return new HttpResponse({
    statusCode: response.statusCode,
    ...(response.reason !== undefined ? { reason: response.reason } : {}),
    headers: removeHeaders(response.headers, ["content-encoding", "content-length"]),
    body: decodedBody,
  });
}

export function mapFetchDecodedResponse(response: HttpResponse): HttpResponse {
  // Fetch decodes content codings before exposing the body but preserves the
  // original response headers. Remove stale metadata without decoding twice.
  const encoding = responseContentEncoding(getHeader(response.headers, "content-encoding"));
  if (!encoding) {
    return response;
  }

  return new HttpResponse({
    statusCode: response.statusCode,
    ...(response.reason !== undefined ? { reason: response.reason } : {}),
    headers: removeHeaders(response.headers, ["content-encoding", "content-length"]),
    body: response.body,
  });
}

export async function bodyToReadableStream(body: unknown): Promise<ReadableStream<BufferSource>> {
  if (isUsableReadableStream(body)) {
    return body as ReadableStream<BufferSource>;
  }
  let readableFallback: ReadableStreamLike | undefined;
  if (isStreamableBody(body)) {
    const stream = body.stream();
    if (isUsableReadableStream(stream)) {
      return stream as ReadableStream<BufferSource>;
    }
    if (isReadableStreamLike(stream)) {
      readableFallback = stream;
    }
  }

  const bytes = readableFallback
    ? await collectReadableStream(readableFallback)
    : await bodyToAsyncBytes(body);
  return bytesToReadableStream(bytes);
}

export async function bodyToAsyncBytes(body: unknown): Promise<Uint8Array> {
  const bytes = bodyToBytes(body);
  if (bytes) {
    return bytes;
  }
  if (isArrayBufferBody(body)) {
    return new Uint8Array(await body.arrayBuffer());
  }
  if (isReadableStreamLike(body)) {
    return collectReadableStream(body);
  }
  if (isStreamableBody(body)) {
    const stream = body.stream();
    if (isReadableStreamLike(stream)) {
      return collectReadableStream(stream);
    }
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

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<BufferSource> {
  if (typeof ReadableStream !== "undefined") {
    const copy = new Uint8Array(bytesToArrayBuffer(bytes));
    return new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(copy);
        controller.close();
      },
    });
  }
  if (typeof Blob !== "undefined") {
    return new Blob([bytesToArrayBuffer(bytes)]).stream();
  }
  throw new Error("compressed response body is not readable");
}

interface ReadableStreamLike {
  getReader(): {
    read(): Promise<{ done?: boolean; value?: unknown }>;
    cancel?(reason?: unknown): unknown;
    releaseLock?(): void;
  };
}

async function collectReadableStream(stream: ReadableStreamLike): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(chunkToBytes(value));
    }
  } catch (error) {
    try {
      await reader.cancel?.(error);
    } catch (_cancelError) {
      // Preserve the stream read error.
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return concatBytes(chunks);
}

function isReadableStreamLike(body: unknown): body is ReadableStreamLike {
  return (
    isObject(body) &&
    "getReader" in body &&
    typeof (body as { getReader?: unknown }).getReader === "function"
  );
}

function isUsableReadableStream(body: unknown): boolean {
  return (
    isReadableStreamLike(body) &&
    "tee" in body &&
    typeof (body as { tee?: unknown }).tee === "function" &&
    "pipeThrough" in body &&
    typeof (body as { pipeThrough?: unknown }).pipeThrough === "function"
  );
}

function isArrayBufferBody(body: unknown): body is { arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    isObject(body) &&
    "arrayBuffer" in body &&
    typeof (body as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function isStreamableBody(body: unknown): body is { stream(): unknown } {
  return (
    isObject(body) &&
    "stream" in body &&
    typeof (body as { stream?: unknown }).stream === "function"
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
