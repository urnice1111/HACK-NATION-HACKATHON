import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { InformationNeed } from "../src/contracts/index.ts";
import { answerFrom, isBajaKeyword, needQuestion, parseActionWorked, parseStatusReported } from "../src/sms/messages.ts";

function need(overrides: Partial<InformationNeed>): InformationNeed {
  return {
    need_code: "leaf_underside",
    variable: "Aspecto del envés de las hojas afectadas",
    reason: "Distingue roya de ojo de gallo",
    farmer_hint: "Preguntar qué ve en la parte de abajo de las hojas",
    answer_type: "choice",
    options: ["polvo naranja o amarillo", "pelusa blanca", "nada", "no sé"],
    priority: 1,
    can_be_unknown: true,
    ...overrides,
  };
}

describe("formulación de preguntas SMS", () => {
  it("usa la plantilla del need_code y numera las opciones; nunca el nombre técnico", () => {
    const text = needQuestion(need({}));
    assert.match(text, /parte de abajo de las hojas/);
    assert.match(text, /1 polvo naranja o amarillo, 2 pelusa blanca/);
    assert.doesNotMatch(text, /envés/);
  });
});

describe("normalización de respuestas", () => {
  it("\"no sé\" → value null y unknown true, nunca cero", () => {
    for (const text of ["no sé", "No se", "ni idea"]) {
      const a = answerFrom(need({ need_code: "symptom_onset_days", answer_type: "number_with_unit", options: null }), text);
      assert.equal(a.value, null);
      assert.equal(a.unknown, true);
      assert.equal(a.raw_text, text);
    }
  });

  it("choice: el número elige la opción; la opción \"no sé\" es desconocido", () => {
    assert.equal(answerFrom(need({}), "2").value, "pelusa blanca");
    const dontKnow = answerFrom(need({}), "4");
    assert.equal(dontKnow.unknown, true);
    assert.equal(dontKnow.value, null);
  });

  it("choice con texto libre: conserva el texto", () => {
    const a = answerFrom(need({}), "un polvito amarillo");
    assert.equal(a.value, "un polvito amarillo");
    assert.equal(a.unknown, false);
  });

  it("número con unidad y sí/no", () => {
    const days = answerFrom(need({ need_code: "symptom_onset_days", answer_type: "number_with_unit", options: null }), "hace 3 días");
    assert.equal(days.value, 3);
    assert.equal(days.unit, "d");
    assert.equal(answerFrom(need({ need_code: "leaf_drop", answer_type: "yes_no", options: null }), "si").value, true);
  });
});

describe("respuestas de seguimiento y baja", () => {
  it("estado reportado por número o palabra; \"no sé\" → unknown", () => {
    assert.equal(parseStatusReported("1"), "worse");
    assert.equal(parseStatusReported("Sigue igual"), "same");
    assert.equal(parseStatusReported("mejor"), "improved");
    assert.equal(parseStatusReported("ya se resolvió"), "resolved");
    assert.equal(parseStatusReported("no sé"), "unknown");
    assert.equal(parseStatusReported("quién sabe qué"), null);
  });

  it("si funcionó", () => {
    assert.equal(parseActionWorked("sí"), "yes");
    assert.equal(parseActionWorked("2"), "no");
    assert.equal(parseActionWorked("más o menos"), "partial");
    assert.equal(parseActionWorked("ni idea"), "unknown");
  });

  it("BAJA", () => {
    assert.ok(isBajaKeyword("BAJA"));
    assert.ok(isBajaKeyword("darme de baja"));
    assert.ok(!isBajaKeyword("bajaron las hojas"));
  });
});
