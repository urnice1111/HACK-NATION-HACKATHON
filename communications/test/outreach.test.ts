import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canContact, isWithinAllowedHours } from "../src/policy/outreach.ts";

const TZ = "America/Mexico_City"; // UTC-6, sin horario de verano desde 2022

describe("horario permitido (hora local del agricultor)", () => {
  it("08:00–19:00 por defecto", () => {
    assert.equal(isWithinAllowedHours(new Date("2026-10-03T14:00:00Z"), TZ, null), true); // 08:00
    assert.equal(isWithinAllowedHours(new Date("2026-10-03T13:59:00Z"), TZ, null), false); // 07:59
    assert.equal(isWithinAllowedHours(new Date("2026-10-04T01:00:00Z"), TZ, null), false); // 19:00
  });

  it("respeta el horario propio del contacto", () => {
    assert.equal(isWithinAllowedHours(new Date("2026-10-03T23:00:00Z"), TZ, { start: "10:00", end: "12:00" }), false);
  });
});

describe("canContact", () => {
  const base = {
    phone_e164: "+12025550105",
    timezone: TZ,
    allowed_hours: null,
    consent: true,
    now: new Date("2026-10-03T23:00:00Z"),
    isDemo: true,
    demoAllowlist: new Set(["+12025550105"]),
  };

  it("permite con consentimiento, en horario y en lista blanca", () => {
    assert.deepEqual(canContact(base), { ok: true });
  });

  it("el consentimiento va primero; en demo la lista vacía bloquea a todos", () => {
    assert.deepEqual(canContact({ ...base, consent: false }), { ok: false, reason: "no_consent" });
    assert.deepEqual(canContact({ ...base, demoAllowlist: new Set() }), { ok: false, reason: "not_allowlisted" });
    assert.deepEqual(canContact({ ...base, isDemo: false, demoAllowlist: new Set() }), { ok: true });
  });
});
