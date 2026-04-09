export const prReviewBaselineFiles = {
  "README.md": `# Checkout Service

Small TypeScript service that prices carts before payment.
`,
  "package.json": `{
  "name": "checkout-service",
  "private": true,
  "scripts": {
    "test": "vitest run"
  }
}
`,
  "src/pricing.ts": `export type PricingInput = {
  subtotalCents: number;
  couponCents: number;
  taxRate: number;
};

export function calculateTotal(input: PricingInput): number {
  const discountedSubtotal = Math.max(
    0,
    input.subtotalCents - input.couponCents,
  );
  const taxCents = Math.round(discountedSubtotal * input.taxRate);
  return discountedSubtotal + taxCents;
}
`,
  "src/pricing.test.ts": `import { describe, expect, it } from "vitest";
import { calculateTotal } from "./pricing";

describe("calculateTotal", () => {
  it("applies coupon before tax", () => {
    expect(
      calculateTotal({
        subtotalCents: 10_000,
        couponCents: 1_000,
        taxRate: 0.1,
      }),
    ).toBe(9_900);
  });
});
`,
} satisfies Record<string, string>;

export const prReviewModifiedFiles = {
  "src/pricing.ts": `export type PricingInput = {
  subtotalCents: number;
  couponCents: number;
  taxRate: number;
};

export function calculateTotal(input: PricingInput): number {
  const discountedSubtotal = input.subtotalCents - input.couponCents;
  const taxCents = Math.round(input.subtotalCents * input.taxRate);
  return discountedSubtotal + taxCents;
}
`,
} satisfies Record<string, string>;
