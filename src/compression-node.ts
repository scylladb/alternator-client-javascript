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
import {
  pipeline,
  Readable,
  Transform,
  type TransformCallback,
} from "node:stream";
import * as zlib from "node:zlib";
import { bodyToBytes } from "./body.js";
import {
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

  const compressed = zlib.gzipSync(bytes, {
    level: config.gzipLevel,
  });
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
  return mapCompressedResponse(response, decompressNodeResponseBody, options);
}

async function decompressNodeResponseBody(
  body: unknown,
  encoding: AlternatorResponseCompressionAlgorithm,
  options: ResponseDecompressionOptions = {},
): Promise<unknown> {
  const source = await nodeResponseBodyStream(body, options);
  const decoder = encoding === "gzip"
    ? zlib.createGunzip()
    : zlib.createInflate();
  const removeAbortListener = destroyOnAbort(options.signal, decoder);
  const onComplete = () => removeAbortListener();
  if (Number.isFinite(options.maxCompressedBytes)) {
    const limiter = new CompressedInputLimiter(options.maxCompressedBytes!);
    pipeline(source, limiter, decoder, onComplete);
  } else {
    pipeline(source, decoder, onComplete);
  }
  return decoder;
}

async function nodeResponseBodyStream(
  body: unknown,
  options: ResponseDecompressionOptions,
): Promise<NodeJS.ReadableStream> {
  if (isNodePipeableBody(body)) {
    return body;
  }
  if (isWebReadableBody(body)) {
    return webReadableToNode(body);
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return webReadableToNode(body.stream());
  }

  const bytes = bodyToBytes(body);
  if (bytes) {
    return Readable.from([bytes]);
  }
  if (isAsyncIterable(body)) {
    return asyncIterableToNode(body);
  }
  if (isTransformableByteBody(body)) {
    if (Number.isFinite(options.maxCompressedBytes)) {
      throw new Error("transform-only compressed response body cannot be read within a finite byte limit");
    }
    const transformed = await abortable(body.transformToByteArray(), options.signal);
    return Readable.from([transformed]);
  }

  throw new Error("compressed response body is not readable");
}

class CompressedInputLimiter extends Transform {
  private size = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    let bytes: Uint8Array;
    try {
      bytes = compressedChunkToBytes(chunk);
    } catch (error) {
      callback(asError(error));
      return;
    }
    this.size += bytes.byteLength;
    if (this.size > this.maxBytes) {
      callback(new Error(`compressed response body exceeds ${this.maxBytes} bytes`));
      return;
    }
    callback(null, bytes);
  }
}

function webReadableToNode(body: ReadableStream): Readable {
  const reader = body.getReader();
  let reading = false;
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
  const pump = () => {
    if (reading || finished || stream.destroyed) {
      return;
    }
    reading = true;
    reader.read().then(
      (result) => {
        reading = false;
        if (stream.destroyed) {
          release();
          return;
        }
        if (result.done) {
          finished = true;
          release();
          stream.push(null);
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = compressedChunkToBytes(result.value);
        } catch (error) {
          stream.destroy(asError(error));
          return;
        }
        if (stream.push(bytes)) {
          pump();
        }
      },
      (error: unknown) => {
        reading = false;
        if (stream.destroyed) {
          release();
          return;
        }
        stream.destroy(asError(error));
      },
    );
  };

  const stream = new Readable({
    read() {
      pump();
    },
    destroy(error, callback) {
      if (!finished) {
        finished = true;
        try {
          const cancellation = reader.cancel(error ?? undefined);
          void cancellation.catch(() => undefined);
        } catch (_error) {
          // Preserve the stream destruction reason.
        }
      }
      release();
      callback(error);
    },
  });
  return stream;
}

function asyncIterableToNode(body: AsyncIterable<unknown>): Readable {
  const iterator = body[Symbol.asyncIterator]();
  let reading = false;
  let finished = false;

  const pump = () => {
    if (reading || finished || stream.destroyed) {
      return;
    }
    reading = true;
    Promise.resolve(iterator.next()).then(
      (result) => {
        reading = false;
        if (stream.destroyed) {
          return;
        }
        if (result.done) {
          finished = true;
          stream.push(null);
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = compressedChunkToBytes(result.value);
        } catch (error) {
          stream.destroy(asError(error));
          return;
        }
        if (stream.push(bytes)) {
          pump();
        }
      },
      (error: unknown) => {
        reading = false;
        if (!stream.destroyed) {
          stream.destroy(asError(error));
        }
      },
    );
  };

  const stream = new Readable({
    read() {
      pump();
    },
    destroy(error, callback) {
      if (!finished) {
        finished = true;
        try {
          const cancellation = iterator.return?.();
          if (cancellation) {
            void Promise.resolve(cancellation).catch(() => undefined);
          }
        } catch (_error) {
          // Preserve the stream destruction reason.
        }
      }
      callback(error);
    },
  });
  return stream;
}

function destroyOnAbort(
  signal: AbortSignal | undefined,
  stream: { destroy(error?: Error): void },
): () => void {
  if (!signal) {
    return () => undefined;
  }
  const destroy = () => {
    stream.destroy(abortReason(signal));
  };
  if (signal.aborted) {
    destroy();
    return () => undefined;
  }
  signal.addEventListener("abort", destroy, { once: true });
  return () => signal.removeEventListener("abort", destroy);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(asError(error));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("compressed response body read was cancelled");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("compressed response body read failed");
}

function isWebReadableBody(body: unknown): body is ReadableStream {
  return (
    isObject(body) &&
    "getReader" in body &&
    typeof (body as { getReader?: unknown }).getReader === "function"
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

function isNodePipeableBody(body: unknown): body is NodeJS.ReadableStream {
  return (
    isObject(body) &&
    "pipe" in body &&
    typeof (body as { pipe?: unknown }).pipe === "function"
  );
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
