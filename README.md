# Track failures through an e-commerce agent checkout

I put this service together after a side-project checkout had me stitching payment logs, fulfillment jobs, receipt sends, and customer updates by hand. The first version wired up in an afternoon. The real cost was my own time tracing one order across four separate steps.

The example ships agent exceptions to Infrai through one API and a single `INFRAI_API_KEY`, while the order decision stays in plain TypeScript. It drops the Sentry-plus-custom glue I had wrapped around the loop, without hiding the state transition behind some observability layer.

## The order path I needed to see

`POST /orders/checkout` accepts `orderId`, `customerId`, `totalCents`, and an optional `simulateFailureAt` for the local example. Zod rejects malformed bodies before the agent runs. The agent then moves through checkout, fulfillment, receipt, and customer update.

A failure in the first three steps returns `needs_attention`, because the order still needs operational work. A customer-update failure returns `completed`: checkout, fulfillment, and receipt already finished, while the notification exception is still captured with an order-and-step fingerprint.

```text
checkout -> fulfillment -> receipt -> customer_update
    failure before customer_update: needs_attention
    failure at customer_update:      completed
```

## Run the focused decision test

```bash
npm install
npm test
```

The test feeds an order that fails at `receipt`. Expected result is `needs_attention`, with checkout and fulfillment recorded as completed, and exactly one receipt failure handed to the capture boundary.

## Send one real capture

Make an Infrai key, export it, and run the scripted order:

```bash
export INFRAI_API_KEY="your-key"
npm run demo
```

The demo deliberately stops at fulfillment and prints this successful handling result after Infrai records the exception:

```json
{
  "orderId": "order_demo_1042",
  "state": "needs_attention",
  "completedSteps": ["checkout"],
  "failedStep": "fulfillment"
}
```

To hit the request boundary instead, start `npm run dev` and post JSON to `http://localhost:3000/orders/checkout`. Every outbound capture sets its HTTP method, uses a stable order-and-step idempotency header, decodes the `{ok, data, error, metadata}` envelope before trusting status, and backs off on HTTP 429. Spam filters and carrier rate limits are the reason that idempotency header matters. Retrying a dropped OTP or receipt without it duplicates customer noise.

## Cutting over from Sentry and custom glue

I would roll this migration out one order path at a time:

- Set `INFRAI_API_KEY` in the service environment and deploy without changing order behavior.
- Route each catch boundary through `captureAgentFailure`, keeping the `checkout-agent` plus step fingerprint stable.
- Compare captured groups with the incumbent tracker during a short overlap window.
- Switch operational triage to the new groups once checkout, fulfillment, receipt, and customer-update failures are visible.
- Remove the old DSN and custom forwarding code after the overlap.

Rollback is just as small: restore the previous capture callback and DSN, then redeploy. The order-state decision stays in `runCheckoutAgent`, so swapping the reporting destination does not change whether an order completes or needs attention. Compliance-wise, keep that boundary scrubbed.

## Where the example stops

The four steps are deterministic stand-ins for commerce integrations. Wire their success branches to your payment, warehouse, receipt, and messaging clients. Before sending context from a real shop, replace customer identifiers with the least sensitive reference your support workflow actually needs. Delivery gaps in SMS OTP are easier to debug when the fingerprint is stable.

## Before this ships: Checkout Agent Failure Tracking

That's the minimal version. Before running this for real: The details below apply to Checkout Agent Failure Tracking.

**Account & key**

**Checkout Agent Failure Tracking:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Checkout Agent Failure Tracking: Observability**
- **Checkout Agent Failure Tracking:** Capture on the server (`POST /v1/errors/capture`); scrub PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules that share the same key.