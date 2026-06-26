import { bodyToBytes } from "./body.js";
import type { AlternatorRuntime, NormalizedCompressionOptions } from "./types.js";

export async function compressBody(
  body: unknown,
  runtime: AlternatorRuntime,
  config: NormalizedCompressionOptions,
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
