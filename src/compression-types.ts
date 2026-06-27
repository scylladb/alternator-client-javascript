import type { NormalizedRequestCompressionOptions } from "./types.js";

export interface CompressedBody {
  readonly body: Uint8Array;
  readonly contentEncoding: string;
  readonly contentLength: number;
}

export type AlternatorBodyCompressor = (
  body: unknown,
  config: NormalizedRequestCompressionOptions,
) => Promise<CompressedBody | undefined>;
