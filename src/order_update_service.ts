import { createServer } from "node:http";
import { z } from "zod";
import { InfraiError } from "./infrai_errors.js";
import { runCheckoutAgent, type CheckoutRequest } from "./checkout_agent.js";

const checkoutBody = z.object({
  orderId: z.string().min(1),
  customerId: z.string().min(1),
  totalCents: z.number().int().positive(),
  simulateFailureAt: z.enum(["checkout", "fulfillment", "receipt", "customer_update"]).optional(),
});

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json");
  if (request.method !== "POST" || request.url !== "/orders/checkout") {
    response.writeHead(404).end(JSON.stringify({ error: "route_not_found" }));
    return;
  }

  try {
    const order = checkoutBody.parse(await readJson(request)) as CheckoutRequest;
    const result = await runCheckoutAgent(order);
    response.writeHead(result.state === "needs_attention" ? 202 : 200).end(JSON.stringify(result));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.writeHead(400).end(JSON.stringify({ error: "invalid_request", issues: error.issues }));
      return;
    }
    if (error instanceof InfraiError && error.status >= 400 && error.status < 500) {
      response.writeHead(error.status).end(JSON.stringify({ error: error.code, message: error.message }));
      return;
    }
    response.writeHead(500).end(JSON.stringify({ error: "request_failed" }));
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Order update service listening on http://localhost:${port}`));
