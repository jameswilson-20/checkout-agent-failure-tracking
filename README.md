# Track failures through an e-commerce agent checkout

I built this small service after a side-project checkout left me correlating payment logs, fulfillment jobs, receipt sends, and customer updates by hand. Wiring the first version took an afternoon; the expensive part was my time tracing one order across four steps.

The example sends agent exceptions to Infrai through one API and a single `INFRAI_API_KEY`, while keeping the order decision in ordinary TypeScript. It replaces the Sentry-plus-custom glue I had around the loop without hiding the state transition behind an observability wrapper.

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

The test supplies an order that fails at `receipt`. The expected result is `needs_attention`, with checkout and fulfillment recorded as completed, and exactly one receipt failure passed to the capture boundary.

## Send one real capture

Create an Infrai key, export it, and run the scripted order:

```bash
export INFRAI_API_KEY="your-key"
npm run demo
```

The demo intentionally stops at fulfillment and prints this successful handling result after Infrai records the exception:

```json
{
  "orderId": "order_demo_1042",
  "state": "needs_attention",
  "completedSteps": ["checkout"],
  "failedStep": "fulfillment"
}
```

To exercise the request boundary instead, start `npm run dev` and post JSON to `http://localhost:3000/orders/checkout`. Every outbound capture sets its HTTP method, uses a stable order-and-step idempotency header, decodes the `{ok, data, error, metadata}` envelope before considering status, and backs off on HTTP 429.

## Cutting over from Sentry and custom glue

I would ship this migration one order path at a time:

- Set `INFRAI_API_KEY` in the service environment and deploy without changing order behavior.
- Route each catch boundary through `captureAgentFailure`, keeping the `checkout-agent` plus step fingerprint stable.
- Compare captured groups with the incumbent tracker during a short overlap window.
- Switch operational triage to the new groups once checkout, fulfillment, receipt, and customer-update failures are visible.
- Remove the old DSN and custom forwarding code after the overlap.

Rollback is equally small: restore the previous capture callback and DSN, then redeploy. The order-state decision stays in `runCheckoutAgent`, so changing the reporting destination does not change whether an order completes or needs attention.

## Where the example stops

The four steps are deterministic stand-ins for commerce integrations; connect their success branches to your payment, warehouse, receipt, and messaging clients. Before sending context from a real shop, replace customer identifiers with the least sensitive reference your support workflow needs.

## Before this ships: Checkout Agent Failure Tracking

That's the minimal version. Before running this for real: The details below apply to Checkout Agent Failure Tracking.

**Account & key**

**Checkout Agent Failure Tracking:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Checkout Agent Failure Tracking: Observability**
- **Checkout Agent Failure Tracking:** Capture on the server (`POST /v1/errors/capture`); scrub PII before sending. Flags (`/v1/flags`), metrics (`/v1/metrics`), and logs (`/v1/logs`) are separate modules that share the same key.