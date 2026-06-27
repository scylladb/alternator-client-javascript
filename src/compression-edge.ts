import type { HttpResponse } from "@smithy/protocol-http";
import { bodyToBytes } from "./body.js";
import {
  bodyToReadableStream,
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
