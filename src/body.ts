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

export async function bodyToString(
  body: unknown,
  maxBytes = Number.POSITIVE_INFINITY,
  signal?: AbortSignal,
): Promise<string> {
  if (body === undefined || body === null) {
    return "";
  }
  if (typeof body === "string") {
    assertBodySize(new TextEncoder().encode(body).byteLength, maxBytes);
    return body;
  }
  if (body instanceof Uint8Array) {
    assertBodySize(body.byteLength, maxBytes);
    return new TextDecoder().decode(body);
  }
  if (body instanceof ArrayBuffer) {
    assertBodySize(body.byteLength, maxBytes);
    return new TextDecoder().decode(new Uint8Array(body));
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    assertBodySize(body.size, maxBytes);
    return abortable(body.text(), signal);
  }
  if (isReadableStreamLike(body)) {
    return readableStreamToString(body, maxBytes, signal);
  }
  if (isAsyncIterable(body)) {
    // Smithy SDK stream mixins add transform helpers to otherwise streamable
    // Node bodies. Prefer the bounded streaming path whenever it is available.
    return asyncIterableToString(body, maxBytes, signal);
  }

  if (isTransformableBody(body)) {
    if (Number.isFinite(maxBytes)) {
      // An opaque transform can allocate its entire result before returning,
      // so a post-transform length check cannot enforce a discovery memory
      // bound. Production handlers expose stream/byte bodies; fail closed for
      // custom transform-only bodies when the caller requires a finite cap.
      throw new Error("transform-only response body cannot be read within a finite byte limit");
    }
    const transformed = await abortable(body.transformToString(), signal);
    if (typeof transformed !== "string") {
      throw new Error("response body transform did not return a string");
    }
    assertBodySize(new TextEncoder().encode(transformed).byteLength, maxBytes);
    return transformed;
  }

  if (typeof body === "object") {
    const serialized = JSON.stringify(body) ?? Object.prototype.toString.call(body);
    assertBodySize(new TextEncoder().encode(serialized).byteLength, maxBytes);
    return serialized;
  }
  let serialized: string;
  switch (typeof body) {
    case "bigint":
    case "number":
      serialized = body.toString();
      break;
    case "boolean":
      serialized = body ? "true" : "false";
      break;
    case "function":
      serialized = body.name ? `[function ${body.name}]` : "[function]";
      break;
    case "symbol":
      serialized = body.description ?? body.toString();
      break;
    case "undefined":
      serialized = "";
      break;
    default:
      serialized = "";
  }
  assertBodySize(new TextEncoder().encode(serialized).byteLength, maxBytes);
  return serialized;
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

async function readableStreamToString(
  body: ReadableStream,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) {
        break;
      }
      const chunk = toBytes(result.value);
      size += chunk.byteLength;
      assertBodySize(size, maxBytes);
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      void reader.cancel(error).catch(() => undefined);
    } catch (_cancelError) {
      // Preserve the original read or size error.
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch (_releaseError) {
      // A failed cancellation can leave a read pending and the reader locked.
    }
  }
  return chunksToString(chunks, size);
}

async function asyncIterableToString(
  body: AsyncIterable<unknown>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const iterator = body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await abortable(Promise.resolve(iterator.next()), signal);
      if (result.done) {
        break;
      }
      const chunk = toBytes(result.value);
      size += chunk.byteLength;
      assertBodySize(size, maxBytes);
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      const cancellation = iterator.return?.();
      if (cancellation) {
        void Promise.resolve(cancellation).catch(() => undefined);
      }
    } catch (_returnError) {
      // Preserve the original read, size, or cancellation error.
    }
    throw error;
  }
  return chunksToString(chunks, size);
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("response body read failed"));
      },
    );
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("response body read was cancelled");
}

function chunksToString(chunks: readonly Uint8Array[], size: number): string {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function assertBodySize(size: number, maxBytes: number): void {
  if (size > maxBytes) {
    throw new Error(`response body exceeds ${maxBytes} bytes`);
  }
}

function isTransformableBody(body: unknown): body is { transformToString(): Promise<string> } {
  return (
    typeof body === "object" &&
    body !== null &&
    "transformToString" in body &&
    typeof (body as { transformToString?: unknown }).transformToString === "function"
  );
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
