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

import type { HttpResponse } from "@smithy/protocol-http";
import { bodyToBytes } from "./body.js";
import {
  bodyToReadableStream,
  mapFetchDecodedResponse,
  mapCompressedResponse,
} from "./compression-shared.js";
import type { CompressedBody } from "./compression-types.js";
import type {
  AlternatorResponseCompressionAlgorithm,
  NormalizedRequestCompressionOptions,
} from "./types.js";

export async function compressBody(
  body: unknown,
  config: NormalizedRequestCompressionOptions,
): Promise<CompressedBody | undefined> {
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

export async function decompressResponse(response: HttpResponse): Promise<HttpResponse> {
  return mapCompressedResponse(response, decompressWebResponseBody);
}

export async function decompressOrNormalizeResponse(response: HttpResponse): Promise<HttpResponse> {
  return mapCompressedResponse(response, decompressOrNormalizeWebResponseBody);
}

export function normalizeFetchResponse(response: HttpResponse): Promise<HttpResponse> {
  return Promise.resolve(mapFetchDecodedResponse(response));
}

async function decompressOrNormalizeWebResponseBody(
  body: unknown,
  encoding: AlternatorResponseCompressionAlgorithm,
): Promise<unknown> {
  // Fetch exposes a decoded body while preserving the wire encoding header.
  // Probe the body instead of relying on handler identity, which is not stable
  // across duplicate packages and can collide with custom class names.
  const stream = await bodyToReadableStream(body);
  const [probe, payload] = stream.tee();
  let encoded: boolean;
  try {
    encoded = await hasCompressionSignature(probe, encoding);
  } catch (error) {
    void payload.cancel().catch(() => undefined);
    throw error;
  }

  if (!encoded) {
    return payload;
  }
  if (typeof DecompressionStream === "undefined") {
    void payload.cancel().catch(() => undefined);
    throw new Error("response compression requires DecompressionStream support in edge runtime");
  }
  return payload.pipeThrough(new DecompressionStream(encoding));
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

async function hasCompressionSignature(
  stream: ReadableStream<BufferSource>,
  encoding: AlternatorResponseCompressionAlgorithm,
): Promise<boolean> {
  const requiredBytes = encoding === "gzip" ? 3 : 2;
  const prefix = new Uint8Array(requiredBytes);
  let offset = 0;
  const reader = stream.getReader();

  try {
    while (offset < requiredBytes) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const bytes = bodyToBytes(value);
      if (!bytes) {
        throw new Error("compressed response body chunk is not readable");
      }
      const length = Math.min(bytes.byteLength, requiredBytes - offset);
      prefix.set(bytes.subarray(0, length), offset);
      offset += length;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }

  if (offset < requiredBytes) {
    return false;
  }
  if (encoding === "gzip") {
    return prefix[0] === 0x1f && prefix[1] === 0x8b && prefix[2] === 0x08;
  }

  const compressionMethodAndInfo = prefix[0] ?? 0;
  const flags = prefix[1] ?? 0;
  return (
    (compressionMethodAndInfo & 0x0f) === 8 &&
    (compressionMethodAndInfo >> 4) <= 7 &&
    ((compressionMethodAndInfo << 8) | flags) % 31 === 0
  );
}
