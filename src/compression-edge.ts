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
  compressedChunkToBytes,
  mapCompressedResponse,
  type ResponseDecompressionOptions,
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

export async function decompressResponse(
  response: HttpResponse,
  options?: ResponseDecompressionOptions,
): Promise<HttpResponse> {
  return mapCompressedResponse(response, decompressWebResponseBody, options);
}

async function decompressWebResponseBody(
  body: unknown,
  encoding: AlternatorResponseCompressionAlgorithm,
  options: ResponseDecompressionOptions = {},
): Promise<unknown> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("response compression requires DecompressionStream support in edge runtime");
  }

  const source = await bodyToReadableStream(body, options);
  const pipeOptions = options.signal ? { signal: options.signal } : undefined;
  const boundedStream = Number.isFinite(options.maxCompressedBytes)
    ? compressedInputLimiter(source, options.maxCompressedBytes!)
    : cancellationSafeReadableStream(source);
  return boundedStream.pipeThrough(new DecompressionStream(encoding), pipeOptions);
}

function cancellationSafeReadableStream(source: ReadableStream): ReadableStream<unknown> {
  return readerBackedReadableStream(source, (chunk) => chunk);
}

function compressedInputLimiter(source: ReadableStream, maxBytes: number): ReadableStream<Uint8Array> {
  let size = 0;
  return readerBackedReadableStream(source, (chunk) => {
    const bytes = compressedChunkToBytes(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      throw new Error(`compressed response body exceeds ${maxBytes} bytes`);
    }
    return bytes;
  });
}

function readerBackedReadableStream<T>(
  source: ReadableStream,
  transform: (chunk: unknown) => T,
): ReadableStream<T> {
  const reader = source.getReader();
  let finished = false;
  let released = false;

  const release = () => {
    if (released) {
      return;
    }
    try {
      reader.releaseLock();
      released = true;
    } catch (_error) {
      // A pending read will retry the release when it settles after cancel().
    }
  };

  const cancelReader = (reason: unknown) => {
    try {
      const cancellation = reader.cancel(reason);
      void cancellation.catch(() => undefined);
    } catch (_error) {
      // Preserve the downstream cancellation or transformation error.
    }
  };

  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (finished) {
          release();
          return;
        }
        if (result.done) {
          finished = true;
          release();
          controller.close();
          return;
        }
        controller.enqueue(transform(result.value));
      } catch (error) {
        if (finished) {
          release();
          return;
        }
        finished = true;
        cancelReader(error);
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!finished) {
        finished = true;
        cancelReader(reason);
      }
      release();
    },
  });
}
