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

export interface ResponseDecompressionOptions {
  readonly signal?: AbortSignal;
  readonly maxCompressedBytes?: number;
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

export async function mapCompressedResponse(
  response: HttpResponse,
  decompressBody: (
    body: unknown,
    encoding: AlternatorResponseCompressionAlgorithm,
    options?: ResponseDecompressionOptions,
  ) => Promise<unknown>,
  options?: ResponseDecompressionOptions,
): Promise<HttpResponse> {
  const encoding = responseContentEncoding(getHeader(response.headers, "content-encoding"));
  const body: unknown = response.body;
  if (!encoding || body === undefined || body === null) {
    return response;
  }

  const decodedBody = await decompressBody(body, encoding, options);
  return new HttpResponse({
    statusCode: response.statusCode,
    ...(response.reason !== undefined ? { reason: response.reason } : {}),
    headers: removeHeaders(response.headers, ["content-encoding", "content-length"]),
    body: decodedBody,
  });
}

export async function bodyToReadableStream(
  body: unknown,
  options: ResponseDecompressionOptions = {},
): Promise<ReadableStream> {
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    return body;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return body.stream();
  }

  const bytes = bodyToBytes(body);
  if (bytes) {
    return bytesToReadableStream(bytes);
  }
  if (isAsyncIterable(body)) {
    return asyncIterableToReadableStream(body);
  }
  if (isTransformableByteBody(body) && Number.isFinite(options.maxCompressedBytes)) {
    throw new Error("transform-only compressed response body cannot be read within a finite byte limit");
  }

  const transformed = await abortable(bodyToAsyncBytes(body), options.signal);
  return bytesToReadableStream(transformed);
}

export async function bodyToAsyncBytes(body: unknown): Promise<Uint8Array> {
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
      chunks.push(compressedChunkToBytes(chunk));
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

export function compressedChunkToBytes(chunk: unknown): Uint8Array {
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

function bytesToReadableStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function asyncIterableToReadableStream(body: AsyncIterable<unknown>): ReadableStream<Uint8Array> {
  const iterator = body[Symbol.asyncIterator]();
  let finished = false;

  const cancelIterator = () => {
    if (finished) {
      return;
    }
    finished = true;
    try {
      const cancellation = iterator.return?.();
      if (cancellation) {
        void Promise.resolve(cancellation).catch(() => undefined);
      }
    } catch (_error) {
      // Preserve the read, conversion, or downstream cancellation error.
    }
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (finished) {
          return;
        }
        if (result.done) {
          controller.close();
          finished = true;
          return;
        }
        controller.enqueue(compressedChunkToBytes(result.value));
      } catch (error) {
        cancelIterator();
        throw error;
      }
    },
    cancel() {
      cancelIterator();
    },
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("compressed response body read failed"));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("compressed response body read was cancelled");
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
