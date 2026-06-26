import packageJson from "../package.json" with { type: "json" };
import type {
  AlternatorUserAgentConfig,
  AlternatorUserAgentTransformer,
  NormalizedUserAgentOptions,
} from "./types.js";

export const ALTERNATOR_USER_AGENT_PRODUCT = "scylladb-alternator-client-javascript";

export function alternatorUserAgentToken(): string {
  return `${ALTERNATOR_USER_AGENT_PRODUCT}/${normalizeVersion(packageJson.version)}`;
}

export function normalizeUserAgent(input: AlternatorUserAgentConfig | undefined): NormalizedUserAgentOptions {
  const defaultUserAgent = alternatorUserAgentToken();

  if (input === false) {
    return {};
  }
  if (input === undefined || input === true) {
    return { value: defaultUserAgent };
  }
  if (typeof input === "string") {
    requireValidUserAgent(input, "userAgent");
    return { value: input };
  }
  if (typeof input === "function") {
    return normalizeTransformedUserAgent(input, defaultUserAgent);
  }
  if (input.enabled === false) {
    return {};
  }
  if (input.value !== undefined && input.transform !== undefined) {
    throw new TypeError("userAgent.value and userAgent.transform cannot both be set");
  }
  if (input.value !== undefined) {
    requireValidUserAgent(input.value, "userAgent.value");
    return { value: input.value };
  }
  if (input.transform !== undefined) {
    return normalizeTransformedUserAgent(input.transform, defaultUserAgent);
  }
  return { value: defaultUserAgent };
}

export function applyUserAgent(
  headers: Record<string, string | undefined>,
  userAgent: NormalizedUserAgentOptions,
): Record<string, string> {
  const nextHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name.toLowerCase() === "user-agent") {
      continue;
    }
    nextHeaders[name] = value;
  }

  if (userAgent.value !== undefined) {
    nextHeaders["user-agent"] = userAgent.value;
  }

  return nextHeaders;
}

function normalizeTransformedUserAgent(
  transform: AlternatorUserAgentTransformer,
  defaultUserAgent: string,
): NormalizedUserAgentOptions {
  const transformed = transform(defaultUserAgent);
  if (transformed === null || transformed === undefined || transformed.trim() === "") {
    return {};
  }
  return { value: transformed };
}

function requireValidUserAgent(userAgent: string, label: string): void {
  if (userAgent.trim() === "") {
    throw new TypeError(`${label} cannot be blank`);
  }
}

function normalizeVersion(version: string | undefined): string {
  const trimmed = version?.trim();
  if (!trimmed) {
    return "unknown";
  }
  return trimmed.replace(/\s+/g, "_");
}
