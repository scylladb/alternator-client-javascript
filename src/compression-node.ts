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
import * as zlib from "node:zlib";
import { bodyToBytes } from "./body.js";
import {
  bodyToAsyncBytes,
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

  const compressed = zlib.gzipSync(bytes, {
    level: config.gzipLevel,
  });
  return {
    body: compressed,
    contentEncoding: "gzip",
    contentLength: compressed.byteLength,
  };
}

export async function decompressResponse(response: HttpResponse): Promise<HttpResponse> {
  return mapCompressedResponse(response, decompressNodeResponseBody);
}

async function decompressNodeResponseBody(
  body: unknown,
  encoding: AlternatorResponseCompressionAlgorithm,
): Promise<unknown> {
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

function isNodePipeableBody(body: unknown): body is {
  pipe(destination: NodeJS.WritableStream): NodeJS.ReadableStream;
} {
  return (
    isObject(body) &&
    "pipe" in body &&
    typeof (body as { pipe?: unknown }).pipe === "function"
  );
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}
