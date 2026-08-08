import { describe, it, expect } from "vitest";
import { UpdateCompanySchema } from "@/lib/schemas/company";

describe("UpdateCompanySchema", () => {
  const valid = { name: "Nimbus Labs", industry: "SaaS / B2B Software", currency: "PKR" };

  it("accepts valid company info", () => {
    expect(UpdateCompanySchema.safeParse(valid).success).toBe(true);
  });

  it("locks currency to PKR (rejects a forged non-PKR value)", () => {
    expect(UpdateCompanySchema.safeParse({ ...valid, currency: "USD" }).success).toBe(false);
  });

  it("requires a name", () => {
    expect(UpdateCompanySchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(UpdateCompanySchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("requires an industry", () => {
    expect(UpdateCompanySchema.safeParse({ ...valid, industry: "" }).success).toBe(false);
  });

  it("trims name and industry", () => {
    const result = UpdateCompanySchema.safeParse({ ...valid, name: "  Nimbus  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Nimbus");
  });

  it("caps name at 120 and industry at 80 characters", () => {
    expect(UpdateCompanySchema.safeParse({ ...valid, name: "x".repeat(121) }).success).toBe(false);
    expect(UpdateCompanySchema.safeParse({ ...valid, industry: "x".repeat(81) }).success).toBe(
      false
    );
  });
});
