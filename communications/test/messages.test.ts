import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { InformationNeed } from "../src/contracts/index.ts";
import { answerFrom, isAlertsOffKeyword, needQuestion, parseActionWorked, parseStatusReported, parseYesNo } from "../src/sms/messages.ts";

function need(overrides: Partial<InformationNeed>): InformationNeed {
  return {
    need_code: "leaf_underside",
    variable: "Appearance of the underside of affected leaves",
    reason: "Tells rust apart from American leaf spot",
    farmer_hint: "Ask what they see on the underside of the leaves",
    answer_type: "choice",
    options: ["orange or yellow powder", "white fuzz", "nothing", "don't know"],
    priority: 1,
    can_be_unknown: true,
    ...overrides,
  };
}

describe("SMS question phrasing", () => {
  it("uses the need_code template and numbers the options; never the technical name", () => {
    const text = needQuestion(need({}));
    assert.match(text, /underside of the leaves/);
    assert.match(text, /1 orange or yellow powder, 2 white fuzz/);
    assert.doesNotMatch(text, /affected leaves/);
  });
});

describe("answer normalization", () => {
  it("\"I don't know\" → value null and unknown true, never zero", () => {
    for (const text of ["I don't know", "dont know", "not sure", "idk"]) {
      const a = answerFrom(need({ need_code: "symptom_onset_days", answer_type: "number_with_unit", options: null }), text);
      assert.equal(a.value, null);
      assert.equal(a.unknown, true);
      assert.equal(a.raw_text, text);
    }
  });

  it("choice: the number picks the option; the \"don't know\" option is unknown", () => {
    assert.equal(answerFrom(need({}), "2").value, "white fuzz");
    const dontKnow = answerFrom(need({}), "4");
    assert.equal(dontKnow.unknown, true);
    assert.equal(dontKnow.value, null);
  });

  it("choice with free text: keeps the text", () => {
    const a = answerFrom(need({}), "some yellow dust");
    assert.equal(a.value, "some yellow dust");
    assert.equal(a.unknown, false);
  });

  it("number with unit and yes/no", () => {
    const days = answerFrom(need({ need_code: "symptom_onset_days", answer_type: "number_with_unit", options: null }), "3 days ago");
    assert.equal(days.value, 3);
    assert.equal(days.unit, "d");
    assert.equal(answerFrom(need({ need_code: "leaf_drop", answer_type: "yes_no", options: null }), "yes").value, true);
  });

  it("yes/no accepts Y and N", () => {
    assert.equal(parseYesNo("Y"), true);
    assert.equal(parseYesNo("yeah!"), true);
    assert.equal(parseYesNo("N"), false);
    assert.equal(parseYesNo("nope"), false);
    assert.equal(parseYesNo("maybe"), null);
  });
});

describe("follow-up replies and opt-out", () => {
  it("reported status by number or word; \"I don't know\" → unknown", () => {
    assert.equal(parseStatusReported("1"), "worse");
    assert.equal(parseStatusReported("About the same"), "same");
    assert.equal(parseStatusReported("better"), "improved");
    assert.equal(parseStatusReported("it's gone"), "resolved");
    assert.equal(parseStatusReported("I don't know"), "unknown");
    assert.equal(parseStatusReported("who knows what"), null);
  });

  it("whether it worked", () => {
    assert.equal(parseActionWorked("yes"), "yes");
    assert.equal(parseActionWorked("2"), "no");
    assert.equal(parseActionWorked("kind of"), "partial");
    assert.equal(parseActionWorked("not sure"), "unknown");
  });

  it("ALERTS OFF", () => {
    assert.ok(isAlertsOffKeyword("ALERTS OFF"));
    assert.ok(isAlertsOffKeyword("no more alerts"));
    assert.ok(!isAlertsOffKeyword("the alerts were off"));
  });
});
