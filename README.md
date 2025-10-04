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
| `QUOTA_BYTES` | plain, optional | Storage quota that disables the key. Accepts a byte value (`1073741824`) or a human-friendly string (`1GB`). If omitted the worker ignores storage usage. |
| `REENABLE_THRESHOLD` | plain, optional | Storage usage level that re-enables the key. Defaults to 80% of `QUOTA_BYTES` when both are set. |
| `CLASS_A_QUOTA` | plain, optional | Maximum Class A requests (e.g. PUT/LIST) permitted before the key is disabled. Defaults to `1000000` (Cloudflare's free tier). |
| `CLASS_A_REENABLE_THRESHOLD` | plain, optional | Class A request count that re-enables the key. Defaults to 80% of `CLASS_A_QUOTA`. |
| `CLASS_B_QUOTA` | plain, optional | Maximum Class B requests (e.g. GET) permitted before the key is disabled. Defaults to `10000000`. |
| `CLASS_B_REENABLE_THRESHOLD` | plain, optional | Class B request count that re-enables the key. Defaults to 80% of `CLASS_B_QUOTA`. |

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

By default the worker mirrors Cloudflare's R2 free-tier allowances: 1,000,000
Class A requests and 10,000,000 Class B requests per billing period. You can
override these ceilings (and their re-enable thresholds) with the environment
variables above.

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
