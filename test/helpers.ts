import { HttpRequest, HttpResponse } from "@smithy/protocol-http";
import type { HttpHandlerOptions } from "@smithy/types";
import { Readable } from "node:stream";

export type HandlerResponder = (
  request: HttpRequest,
  options?: HttpHandlerOptions,
) => unknown | Promise<unknown>;

export class RecordingHandler {
  readonly metadata = { handlerProtocol: "http/1.1" };
  readonly requests: HttpRequest[] = [];

  constructor(private readonly responder: HandlerResponder = () => ({})) {}

  async handle(
    request: HttpRequest,
    options?: HttpHandlerOptions,
  ): Promise<{ response: HttpResponse }> {
    const clone = HttpRequest.clone(request);
    this.requests.push(clone);

    const response = await this.responder(clone, options);
    if (response instanceof HttpResponse) {
      return { response };
    }

    return {
      response: jsonResponse(response),
    };
  }

  updateHttpClientConfig(): void {}

  httpHandlerConfigs(): Record<string, never> {
    return {};
  }
}

export function jsonResponse(payload: unknown, statusCode = 200): HttpResponse {
  return new HttpResponse({
    statusCode,
    headers: {
      "content-type": "application/x-amz-json-1.0",
    },
    body: Readable.from([JSON.stringify(payload)]),
  });
}

export async function requestBodyJson(request: HttpRequest): Promise<unknown> {
  const body = request.body;
  if (typeof body === "string") {
    return JSON.parse(body);
  }
  if (body instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(body));
  }
  if (body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(body)));
  }
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return JSON.parse(String(body));
}

export function commandRequests(handler: RecordingHandler): HttpRequest[] {
  return handler.requests.filter((request) => request.path !== "/localnodes");
}
