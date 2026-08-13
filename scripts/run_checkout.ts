import { runCheckoutAgent } from "../src/checkout_agent.js";

const result = await runCheckoutAgent({
  orderId: "order_demo_1042",
  customerId: "customer_88",
  totalCents: 12900,
  simulateFailureAt: "fulfillment",
});

console.log(JSON.stringify(result, null, 2));
