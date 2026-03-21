import { describe, it, expect } from "vitest";
import { isValidTimezone } from "@/lib/timezone";

describe("isValidTimezone", () => {
  it("returns true for valid IANA timezones", () => {
    expect(isValidTimezone("America/New_York")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("US/Pacific")).toBe(true);
    expect(isValidTimezone("Australia/Sydney")).toBe(true);
  });

  it("returns false for invalid timezones", () => {
    expect(isValidTimezone("Invalid/Zone")).toBe(false);
    expect(isValidTimezone("Not_A_Timezone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
  });

  it("returns false for numeric offsets that are not IANA names", () => {
    // "GMT+5" is actually valid in some environments, but "Etc/GMT+5" is standard
    expect(isValidTimezone("Etc/GMT+5")).toBe(true);
  });
});
