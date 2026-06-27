import type {
  AlternatorUserAgentConfig,
  AlternatorUserAgentOptions,
  AlternatorUserAgentTransformer,
  NormalizedUserAgentOptions,
} from "./types.js";

declare const __PACKAGE_VERSION__: string;

export const ALTERNATOR_USER_AGENT_PRODUCT = "scylladb-alternator-client-javascript";

export function alternatorUserAgentToken(): string {
  return `${ALTERNATOR_USER_AGENT_PRODUCT}/${normalizeVersion(packageVersion())}`;
}

export function normalizeUserAgent(input: AlternatorUserAgentConfig | undefined): NormalizedUserAgentOptions {
  const defaultUserAgent = alternatorUserAgentToken();

  if (input === false) {
    return {};
  }
  if (input === undefined) {
    return { value: defaultUserAgent };
  }
  if (!isRecord(input)) {
    throw new TypeError("userAgent must be false or an options object");
  }
  const options = input as AlternatorUserAgentOptions;

  const configuredFields = [
    options.value !== undefined,
    options.append !== undefined,
    options.transform !== undefined,
  ].filter(Boolean).length;
  if (configuredFields > 1) {
    throw new TypeError("userAgent.value, userAgent.append, and userAgent.transform are mutually exclusive");
  }

  if (options.value !== undefined) {
    requireValidUserAgent(options.value, "userAgent.value");
    return { value: options.value };
  }
  if (options.append !== undefined) {
    requireValidUserAgent(options.append, "userAgent.append");
    return { value: `${defaultUserAgent} ${options.append}` };
  }
  if (options.transform !== undefined) {
    return normalizeTransformedUserAgent(options.transform, defaultUserAgent);
  }

  return { value: defaultUserAgent };
}

export function applyUserAgent(
  headers: Record<string, string | undefined>,
  userAgent: NormalizedUserAgentOptions,
  options: { removeAwsSdkUserAgent?: boolean } = {},
): Record<string, string> {
  const nextHeaders: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.toLowerCase();
    if (
      value === undefined ||
      normalizedName === "user-agent" ||
      (options.removeAwsSdkUserAgent && normalizedName === "x-amz-user-agent")
    ) {
      continue;
    }
    nextHeaders[name] = value;
  }

  if (userAgent.value !== undefined) {
    nextHeaders["user-agent"] = userAgent.value;
  }

  return nextHeaders;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function packageVersion(): string | undefined {
  return typeof __PACKAGE_VERSION__ === "string" ? __PACKAGE_VERSION__ : undefined;
}
