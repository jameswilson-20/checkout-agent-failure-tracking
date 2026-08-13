import { infrai } from "./infrai_errors.js";

export type AgentStep = "checkout" | "fulfillment" | "receipt" | "customer_update";
export type OrderState = "processing" | "completed" | "needs_attention";

export type CheckoutRequest = {
  orderId: string;
  customerId: string;
  totalCents: number;
  simulateFailureAt?: AgentStep;
};

export type CheckoutResult = {
  orderId: string;
  state: OrderState;
  completedSteps: AgentStep[];
  failedStep?: AgentStep;
};

export type CaptureFailure = (input: {
  order: CheckoutRequest;
  step: AgentStep;
  exception: Error;
}) => Promise<void>;

const steps: AgentStep[] = ["checkout", "fulfillment", "receipt", "customer_update"];

export async function runCheckoutAgent(
  order: CheckoutRequest,
  captureFailure: CaptureFailure = captureAgentFailure,
): Promise<CheckoutResult> {
  const completedSteps: AgentStep[] = [];

  for (const step of steps) {
    try {
      if (order.simulateFailureAt === step) throw new Error(`${step} step failed`);
      completedSteps.push(step);
    } catch (cause) {
      const exception = cause instanceof Error ? cause : new Error(String(cause));
      await captureFailure({ order, step, exception });
      return {
        orderId: order.orderId,
        state: step === "customer_update" ? "completed" : "needs_attention",
        completedSteps,
        failedStep: step,
      };
    }
  }

  return { orderId: order.orderId, state: "completed", completedSteps };
}

async function captureAgentFailure({ order, step, exception }: Parameters<CaptureFailure>[0]) {
  await infrai.errors.capture(
    {
      message: `Order agent failed during ${step}`,
      level: "error",
      fingerprint: ["checkout-agent", step],
      exception: { type: exception.name, value: exception.message, stacktrace: exception.stack },
      context: {
        orderId: order.orderId,
        customerId: order.customerId,
        totalCents: order.totalCents,
        step,
      },
    },
    `order:${order.orderId}:step:${step}`,
  );
}
