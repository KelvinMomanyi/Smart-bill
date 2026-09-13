import type { PlanKey } from "./plans";

export function testBillingPlan(value: string | undefined): PlanKey | null {
  return value === "true" ? "GROWTH" : null;
}
