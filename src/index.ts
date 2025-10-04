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
  QUOTA_BYTES: string;
  REENABLE_THRESHOLD?: string;
  STATE_KV: KVNamespace;
}

type AccessKeyStatus = "enabled" | "disabled";

interface StoredState {
  accessKeyStatus: AccessKeyStatus;
  lastUsageBytes: number;
  quotaBytes: number;
  reenableThresholdBytes: number;
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

interface RunResult {
  success: boolean;
  accessKeyStatus: AccessKeyStatus;
  usageBytes: number;
  quotaBytes: number;
  reenableThresholdBytes: number;
  updatedAt: string;
  message?: string;
}

async function runQuotaController(env: Env, ctx: ExecutionContext): Promise<RunResult> {
  const quotaBytes = parseSizeToBytes(env.QUOTA_BYTES);
  let reenableThresholdBytes = env.REENABLE_THRESHOLD
    ? parseSizeToBytes(env.REENABLE_THRESHOLD)
    : Math.floor(quotaBytes * 0.8);

  if (!env.CF_ACCOUNT_ID) {
    throw new Error("Missing CF_ACCOUNT_ID environment variable");
  }
  if (!env.CF_API_TOKEN) {
    throw new Error("Missing CF_API_TOKEN secret");
  }
  if (!env.R2_ACCESS_KEY_ID) {
    throw new Error("Missing R2_ACCESS_KEY_ID environment variable");
  }
  if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
    throw new Error("Invalid quota configuration (QUOTA_BYTES)");
  }
  if (!Number.isFinite(reenableThresholdBytes) || reenableThresholdBytes < 0) {
    throw new Error("Invalid REENABLE_THRESHOLD configuration");
  }
  if (reenableThresholdBytes > quotaBytes) {
    console.warn("Re-enable threshold is higher than quota; adjusting to 90% of quota");
    reenableThresholdBytes = Math.floor(quotaBytes * 0.9);
  }

  const [usageBytes, storedState] = await Promise.all([
    fetchR2Usage(env),
    env.STATE_KV.get<StoredState>(STATE_KEY, "json"),
  ]);

  const currentStatus = storedState?.accessKeyStatus ?? (await fetchAccessKeyStatus(env));
  const timestamp = new Date().toISOString();

  let desiredStatus: AccessKeyStatus = currentStatus;
  let message = "Usage within thresholds";

  if (usageBytes >= quotaBytes) {
    desiredStatus = "disabled";
    message = `Usage ${formatBytes(usageBytes)} is above the quota ${formatBytes(quotaBytes)}; disabling access key.`;
  } else if (usageBytes <= reenableThresholdBytes) {
    desiredStatus = "enabled";
    message = `Usage ${formatBytes(usageBytes)} is below the re-enable threshold ${formatBytes(reenableThresholdBytes)}; enabling access key.`;
  } else {
    message = `Usage ${formatBytes(usageBytes)} is between thresholds (${formatBytes(reenableThresholdBytes)} - ${formatBytes(quotaBytes)}); keeping status ${currentStatus}.`;
  }

  if (desiredStatus !== currentStatus) {
    await updateAccessKeyStatus(env, desiredStatus);
  }

  const state: StoredState = {
    accessKeyStatus: desiredStatus,
    lastUsageBytes: usageBytes,
    quotaBytes,
    reenableThresholdBytes,
    updatedAt: timestamp,
    message,
  };

  await env.STATE_KV.put(STATE_KEY, JSON.stringify(state));

  return {
    success: true,
    accessKeyStatus: desiredStatus,
    usageBytes,
    quotaBytes,
    reenableThresholdBytes,
    updatedAt: timestamp,
    message,
  };
}

async function fetchR2Usage(env: Env): Promise<number> {
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
  const usageBytes = extractUsageBytes(payload);

  if (!Number.isFinite(usageBytes)) {
    throw new Error("Could not determine R2 usage from API response");
  }

  return usageBytes;
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

function extractUsageBytes(payload: unknown): number {
  if (typeof payload === "number") {
    return payload;
  }

  if (!payload || typeof payload !== "object") {
    return NaN;
  }

  // Cloudflare's API typically wraps responses in { result, success, errors }
  const maybeResult = (payload as Record<string, unknown>).result ?? payload;

  const found = findFirstNumberByKeys(maybeResult, CANDIDATE_USAGE_KEYS);
  return typeof found === "number" ? found : NaN;
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
