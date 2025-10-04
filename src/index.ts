/*
 * Cloudflare Worker that monitors R2 usage and disables/enables an access key
 * when a configurable quota is reached.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";
const STATE_KEY = "quota-controller";

interface Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  R2_ACCESS_KEY_ID: string;
  QUOTA_BYTES?: string;
  REENABLE_THRESHOLD?: string;
  CLASS_A_QUOTA?: string;
  CLASS_A_REENABLE_THRESHOLD?: string;
  CLASS_B_QUOTA?: string;
  CLASS_B_REENABLE_THRESHOLD?: string;
  STATE_KV: KVNamespace;
}

type AccessKeyStatus = "enabled" | "disabled";

interface StoredState {
  accessKeyStatus: AccessKeyStatus;
  lastUsageBytes?: number;
  quotaBytes?: number;
  reenableThresholdBytes?: number;
  lastClassARequests?: number;
  classAQuota?: number;
  classAReenableThreshold?: number;
  lastClassBRequests?: number;
  classBQuota?: number;
  classBReenableThreshold?: number;
  updatedAt: string;
  message?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const summary = await runQuotaController(env, ctx);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(JSON.stringify({ success: false, error: message }, null, 2), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runQuotaController(env, ctx).catch((error) => {
      console.error("Failed to evaluate quota", error);
      throw error;
    }));
  },
};

interface UsageSnapshot {
  storageBytes?: number;
  classARequests?: number;
  classBRequests?: number;
}

interface MetricThreshold {
  name: "storage" | "classA" | "classB";
  usage: number | undefined;
  quota: number | undefined;
  reenable: number | undefined;
  formatter: (value: number | undefined) => string;
}

interface ThresholdSnapshot {
  name: MetricThreshold["name"];
  usage?: number;
  quota?: number;
  reenable?: number;
}

interface RunResult {
  success: boolean;
  accessKeyStatus: AccessKeyStatus;
  usage: UsageSnapshot;
  thresholds: ThresholdSnapshot[];
  updatedAt: string;
  message?: string;
}

async function runQuotaController(env: Env, ctx: ExecutionContext): Promise<RunResult> {
  if (!env.CF_ACCOUNT_ID) {
    throw new Error("Missing CF_ACCOUNT_ID environment variable");
  }
  if (!env.CF_API_TOKEN) {
    throw new Error("Missing CF_API_TOKEN secret");
  }
  if (!env.R2_ACCESS_KEY_ID) {
    throw new Error("Missing R2_ACCESS_KEY_ID environment variable");
  }

  const [usage, storedState] = await Promise.all([
    fetchR2Usage(env),
    env.STATE_KV.get<StoredState>(STATE_KEY, "json"),
  ]);

  const thresholds = normaliseThresholds(env);
  for (const metric of thresholds) {
    switch (metric.name) {
      case "storage":
        metric.usage = usage.storageBytes;
        break;
      case "classA":
        metric.usage = usage.classARequests;
        break;
      case "classB":
        metric.usage = usage.classBRequests;
        break;
    }
  }

  const currentStatus = storedState?.accessKeyStatus ?? (await fetchAccessKeyStatus(env));
  const timestamp = new Date().toISOString();

  let desiredStatus: AccessKeyStatus = currentStatus;
  const overQuotaReasons: string[] = [];
  const reenableChecks: string[] = [];

  for (const metric of thresholds) {
    if (metric.quota !== undefined && metric.usage !== undefined && metric.usage >= metric.quota) {
      overQuotaReasons.push(
        `${describeMetric(metric.name)} ${metric.formatter(metric.usage)} exceeds quota ${metric.formatter(metric.quota)}`,
      );
    }

    if (metric.reenable !== undefined && metric.usage !== undefined) {
      if (metric.usage <= metric.reenable) {
        reenableChecks.push(`${describeMetric(metric.name)} ${metric.formatter(metric.usage)} <= ${metric.formatter(metric.reenable)}`);
      } else {
        reenableChecks.push(
          `${describeMetric(metric.name)} ${metric.formatter(metric.usage)} > ${metric.formatter(metric.reenable)}`,
        );
      }
    }
  }

  if (overQuotaReasons.length > 0) {
    desiredStatus = "disabled";
  } else {
    const shouldReenable = thresholds.every((metric) => {
      if (metric.reenable === undefined || metric.usage === undefined) {
        return true;
      }
      return metric.usage <= metric.reenable;
    });

    if (shouldReenable) {
      desiredStatus = "enabled";
    }
  }

  if (desiredStatus !== currentStatus) {
    await updateAccessKeyStatus(env, desiredStatus);
  }

  const message = buildStatusMessage(desiredStatus, currentStatus, overQuotaReasons, reenableChecks);

  const thresholdSnapshot = thresholds.map(({ name, usage: metricUsage, quota, reenable }) => ({
    name,
    usage: metricUsage,
    quota,
    reenable,
  }));

  const state: StoredState = {
    accessKeyStatus: desiredStatus,
    lastUsageBytes: usage.storageBytes,
    quotaBytes: thresholds.find((t) => t.name === "storage")?.quota,
    reenableThresholdBytes: thresholds.find((t) => t.name === "storage")?.reenable,
    lastClassARequests: usage.classARequests,
    classAQuota: thresholds.find((t) => t.name === "classA")?.quota,
    classAReenableThreshold: thresholds.find((t) => t.name === "classA")?.reenable,
    lastClassBRequests: usage.classBRequests,
    classBQuota: thresholds.find((t) => t.name === "classB")?.quota,
    classBReenableThreshold: thresholds.find((t) => t.name === "classB")?.reenable,
    updatedAt: timestamp,
    message,
  };

  await env.STATE_KV.put(STATE_KEY, JSON.stringify(state));

  return {
    success: true,
    accessKeyStatus: desiredStatus,
    usage,
    thresholds: thresholdSnapshot,
    updatedAt: timestamp,
    message,
  };
}

async function fetchR2Usage(env: Env): Promise<UsageSnapshot> {
  const endpoint = `${API_BASE}/accounts/${env.CF_ACCOUNT_ID}/r2/usage`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to retrieve R2 usage: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json<unknown>();

  const usage: UsageSnapshot = {
    storageBytes: extractUsageBytes(payload),
    classARequests: extractClassARequests(payload),
    classBRequests: extractClassBRequests(payload),
  };

  if (
    usage.storageBytes === undefined &&
    usage.classARequests === undefined &&
    usage.classBRequests === undefined
  ) {
    throw new Error("Could not determine any R2 usage metrics from API response");
  }

  return usage;
}

async function fetchAccessKeyStatus(env: Env): Promise<AccessKeyStatus> {
  const endpoint = `${API_BASE}/accounts/${env.CF_ACCOUNT_ID}/r2/access_keys/${env.R2_ACCESS_KEY_ID}`;
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to retrieve access key: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as { result?: { status?: AccessKeyStatus } };
  return payload?.result?.status ?? "enabled";
}

async function updateAccessKeyStatus(env: Env, status: AccessKeyStatus): Promise<void> {
  const endpoint = `${API_BASE}/accounts/${env.CF_ACCOUNT_ID}/r2/access_keys/${env.R2_ACCESS_KEY_ID}`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to update access key status: ${response.status} ${response.statusText} ${text}`);
  }
}

function parseSizeToBytes(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  if (!value) {
    return NaN;
  }

  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)?$/i);
  if (!match) {
    return NaN;
  }

  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "b";
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
    pb: 1024 ** 5,
  };

  const multiplier = multipliers[unit];
  return amount * multiplier;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return "unknown";
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatBytesOptional(value: number | undefined): string {
  if (value === undefined) {
    return "unknown";
  }
  return formatBytes(value);
}

const CANDIDATE_USAGE_KEYS = [
  "usageBytes",
  "usage_bytes",
  "used_bytes",
  "storedBytes",
  "stored_bytes",
  "storageBytes",
  "storage_bytes",
  "storageUsageBytes",
  "size_bytes",
  "sizeBytes",
  "total_usage_bytes",
  "totalUsageBytes",
];

const CANDIDATE_CLASS_A_KEYS = [
  "classARequests",
  "class_a_requests",
  "classAOperations",
  "class_a_operations",
  "classA_ops",
  "class_a_ops",
  "classA",
  "requestsClassA",
  "request_class_a",
];

const CANDIDATE_CLASS_B_KEYS = [
  "classBRequests",
  "class_b_requests",
  "classBOperations",
  "class_b_operations",
  "classB_ops",
  "class_b_ops",
  "classB",
  "requestsClassB",
  "request_class_b",
];

function extractUsageBytes(payload: unknown): number | undefined {
  return extractMetric(payload, CANDIDATE_USAGE_KEYS);
}

function extractClassARequests(payload: unknown): number | undefined {
  return extractMetric(payload, CANDIDATE_CLASS_A_KEYS);
}

function extractClassBRequests(payload: unknown): number | undefined {
  return extractMetric(payload, CANDIDATE_CLASS_B_KEYS);
}

function extractMetric(payload: unknown, keys: string[]): number | undefined {
  if (typeof payload === "number") {
    return Number.isFinite(payload) ? payload : undefined;
  }

  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const maybeResult = (payload as Record<string, unknown>).result ?? payload;

  const found = findFirstNumberByKeys(maybeResult, keys);
  return typeof found === "number" ? found : undefined;
}

function findFirstNumberByKeys(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (keys.includes(key) && typeof nested === "number" && Number.isFinite(nested)) {
      return nested;
    }
    if (typeof nested === "object") {
      const candidate = findFirstNumberByKeys(nested, keys);
      if (candidate !== null) {
        return candidate;
      }
    }
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const candidate = findFirstNumberByKeys(item, keys);
        if (candidate !== null) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function normaliseThresholds(env: Env): MetricThreshold[] {
  const storageQuota = parseOptionalSize(env.QUOTA_BYTES);
  const storageReenable = parseOptionalSize(env.REENABLE_THRESHOLD);
  const classAQuota = parseOptionalNumber(env.CLASS_A_QUOTA, 1_000_000);
  const classAReenable = parseOptionalNumber(env.CLASS_A_REENABLE_THRESHOLD);
  const classBQuota = parseOptionalNumber(env.CLASS_B_QUOTA, 10_000_000);
  const classBReenable = parseOptionalNumber(env.CLASS_B_REENABLE_THRESHOLD);

  const thresholds: MetricThreshold[] = [];

  thresholds.push({
    name: "storage",
    usage: undefined,
    quota: storageQuota,
    reenable: determineReenable(storageQuota, storageReenable),
    formatter: formatBytesOptional,
  });

  thresholds.push({
    name: "classA",
    usage: undefined,
    quota: classAQuota,
    reenable: determineReenable(classAQuota, classAReenable),
    formatter: formatInteger,
  });

  thresholds.push({
    name: "classB",
    usage: undefined,
    quota: classBQuota,
    reenable: determineReenable(classBQuota, classBReenable),
    formatter: formatInteger,
  });

  return thresholds;
}

function determineReenable(quota: number | undefined, override: number | undefined): number | undefined {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override < 0) {
      throw new Error("Invalid re-enable threshold configuration");
    }
    if (quota !== undefined && override > quota) {
      console.warn("Re-enable threshold higher than quota; adjusting to 90% of quota");
      return Math.floor(quota * 0.9);
    }
    return override;
  }

  if (quota === undefined) {
    return undefined;
  }

  return Math.floor(quota * 0.8);
}

function parseOptionalSize(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = parseSizeToBytes(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid quota configuration (size value)");
  }
  return parsed;
}

function parseOptionalNumber(value: string | undefined, defaultValue?: number): number | undefined {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("Invalid numeric quota configuration");
  }
  return parsed;
}

function formatInteger(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "unknown";
  }
  return value.toLocaleString("en-US");
}

function describeMetric(name: MetricThreshold["name"]): string {
  switch (name) {
    case "storage":
      return "Storage";
    case "classA":
      return "Class A requests";
    case "classB":
      return "Class B requests";
    default:
      return name;
  }
}

function buildStatusMessage(
  desired: AccessKeyStatus,
  current: AccessKeyStatus,
  overQuotaReasons: string[],
  reenableChecks: string[],
): string {
  if (desired === "disabled" && overQuotaReasons.length > 0) {
    return `Disabling access key: ${overQuotaReasons.join("; ")}.`;
  }

  if (desired === "enabled" && current === "disabled") {
    return `Re-enabling access key: ${reenableChecks.join("; ")}.`;
  }

  return `Keeping access key ${current}. Metrics: ${[...overQuotaReasons, ...reenableChecks].join("; ") || "no thresholds configured"}.`;
}
