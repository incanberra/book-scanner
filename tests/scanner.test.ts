import { describe, expect, it } from "vitest";
import { validateScannedValue } from "../src/scanner";

describe("scanner barcode validation", () => {
  it("returns only a canonical ISBN", () => {
    expect(validateScannedValue("978-0-14-032872-1")).toBe("9780140328721");
  });

  it("rejects unrelated product barcodes", () => {
    expect(() => validateScannedValue("4006381333931")).toThrow(/book range|ISBN/i);
  });
});
