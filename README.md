# Bolivar

A Cloudflare Worker that periodically inspects your R2 usage quota and toggles an
access key when a configurable limit is crossed. This allows you to keep a
bucket online while you are below your free-tier allocation and automatically
disable it once the budget is exhausted.

## How it works

1. A Cron Trigger wakes the worker on a fixed schedule (15 minutes by default).
2. The worker queries Cloudflare's API for the latest R2 usage numbers.
3. Current usage and the most recent action are stored in Workers KV to avoid
   repeated toggles.
4. When usage reaches the configured quota the worker disables the target R2
   access key. Once usage drops below a secondary threshold it re-enables the
   key.

You can also trigger the same logic manually by sending a `GET` request to the
worker URL (useful for debugging).

## Configuration

The worker relies on several environment variables and secrets:

| Name | Type | Description |
| ---- | ---- | ----------- |
| `CF_ACCOUNT_ID` | plain | Your Cloudflare account ID. |
| `CF_API_TOKEN` | secret | API token with permission to read R2 analytics and manage access keys. |
| `R2_ACCESS_KEY_ID` | plain | The identifier of the access key to toggle. |
| `QUOTA_BYTES` | plain | Quota at which the key should be disabled. Accepts either a byte value (`1073741824`) or a human-friendly string (`1GB`). |
| `REENABLE_THRESHOLD` | plain, optional | Usage level that re-enables the key. Defaults to 80% of `QUOTA_BYTES` if omitted. |

Workers KV is used to remember the previous state. Update the namespace IDs in
`wrangler.toml` after creating them:

```bash
wrangler kv:namespace create STATE_KV
wrangler kv:namespace create STATE_KV --preview
```

Store the secrets with:

```bash
wrangler secret put CF_API_TOKEN
```

The worker expects the access key API to accept `enabled` / `disabled` status
values. Replace `0000…` and `1111…` in `wrangler.toml` with the actual
namespace IDs before deploying.

## Development

Install dependencies and use Wrangler for local development:

```bash
npm install
npm run dev
```

To deploy:

```bash
npm run deploy
```

Use `npm run check` for a dry-run deploy that validates the worker without
publishing it.
