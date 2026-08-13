import assert from "node:assert/strict";
import test from "node:test";
import { runCheckoutAgent } from "../src/checkout_agent.js";

test("a receipt failure sends a paid order to manual attention", async () => {
  const captures: string[] = [];
  const result = await runCheckoutAgent(
    {
      orderId: "order_42",
      customerId: "customer_7",
      totalCents: 4800,
      simulateFailureAt: "receipt",
    },
    async ({ step }) => {
      captures.push(step);
    },
  );

  assert.deepEqual(result, {
    orderId: "order_42",
    state: "needs_attention",
    completedSteps: ["checkout", "fulfillment"],
    failedStep: "receipt",
  });
  assert.deepEqual(captures, ["receipt"]);
});
