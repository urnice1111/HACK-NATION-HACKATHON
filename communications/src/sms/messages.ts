import type { ActionWorked, AssessmentResponse, InformationNeed, ObservationAnswer, StatusReported } from "../contracts/index.ts";

/**
 * SMS copy (English). All copy lives here so it can be tuned once region,
 * language and consent policy are settled. Keep messages short: plain ASCII
 * stays in GSM-7 (160 characters per segment). Yes/no questions ask for Y or N
 * because Twilio treats YES as an opt-in keyword and may send its own reply.
 */
export const sms = {
  identify: (labels: string[], lead = "Hi.") =>
    labels.length === 1
      ? `${lead} Is this ${labels[0]}? Reply 1 for yes or 0 for no.`
      : `${lead} Who is texting? ${labels.map((l, i) => `${i + 1} ${l}`).join(", ")}. Reply with the number, or 0 if none of these.`,
  /** The candidate expired (15 min): ask again with fresh candidates. */
  identifyExpired: "For your security, please confirm again.",
  choosePlot: (labels: string[]) => `Which plot is this about? ${labels.map((l, i) => `${i + 1} ${l}`).join(", ")}. Reply with the number.`,
  unknownNumber: "Hi. Your number is not registered with the program.",
  // Consent (section 17): three separate permissions.
  consent: "To save your report so a technician can review it, reply Y. If you'd rather we don't save it, reply N.",
  /** Report permission already granted: confirm this specific report (section 4: "confirmed observation"). */
  confirmReport: "Should we save this report so a technician can review it? Reply Y or N.",
  consentNotifications: "Would you like SMS alerts if there are problems on nearby plots? Reply Y or N.",
  consentFollowupCalls: "Can we call you in a few days to see how your plot is doing? Reply Y or N.",
  consentDeclined: "Understood, we won't save your message. You can text us anytime.",
  describe: "Tell us what you're seeing on your plants.",
  notUnderstood: "Sorry, I didn't understand your reply.",
  gaveUp: "We couldn't understand your replies. Text us again anytime.",
  textOnly: "For now we can only read text messages.",
  technicalIssue: "We're having a technical problem. Please try again in a few minutes.",

  // "ALERTS OFF": revokes alerts and follow-up calls, not the permission to report.
  optedOut: "Done. We won't send you alerts or follow-up calls anymore. You can still send reports.",
  optOutPending: "We got your opt-out request and are processing it.",
  optOutFailed: "We couldn't process your opt-out. Text ALERTS OFF again in a few minutes.",

  // SMS follow-up (fallback after 3 unanswered calls).
  followupIntro: (name: string) =>
    `Hi ${name}, this is the coffee program following up on your report. How is your plot doing? Reply 1 worse, 2 same, 3 better, 4 resolved.`,
  followupStatusRetry: "Reply 1 worse, 2 same, 3 better or 4 resolved.",
  followupActions: "What have you done on the plot since your report?",
  followupWorked: "Did it work? Reply 1 yes, 2 no or 3 partly.",
  followupSaved: (status: StatusReported) =>
    ({
      resolved: "Thanks, glad it's resolved. It's been recorded.",
      improved: "Thanks. It's been recorded; we'll check in again in a few days.",
      same: "Thanks. It's been recorded and a technician will review your case.",
      worse: "Thanks. It's been recorded and a technician will review your case. If you want to tell us what you see now, text us.",
      unknown: "Thanks. It's been recorded.",
    })[status],

  // Closing the report. Only `saved` claims it was recorded, and only after a 201.
  saved: "Your report has been recorded.",
  savedUnknown: "We saved your message so a technician can review it.",
  notConfirmed: "I couldn't confirm your report was recorded. We'll retry; you don't need to send it again.",
  notSaved: "We couldn't record your report. A technician will look into it.",
  advisorFailed: "We couldn't complete the assessment.",
  refer: "From what you've told us we can't give you safe guidance. A technician will review your case.",
  notConfirmedDisease: "This doesn't confirm any disease; a technician will review it.",
  unverifiedTestimony: "That's what the other farmer reported; it isn't verified.",
} as const;

/**
 * Short template per `need_code` (section 4). The advisor doesn't write the
 * question: it is phrased here in everyday language. The variable's technical
 * name is never used.
 */
const NEED_QUESTIONS: Record<string, string> = {
  local_weather_perception: "How has the weather been on your plot these days? Has it rained or been humid?",
  leaf_underside: "What do you see on the underside of the leaves?",
  spot_appearance: "What color and shape are the spots?",
  affected_extent: "How many plants have the problem?",
  leaf_drop: "Are the leaves falling off? Reply Y or N.",
  symptom_onset_days: "How many days ago did you first see the problem?",
  coffee_variety: "What coffee variety do you grow?",
  shade_level: "How much shade do your coffee plants get?",
  actions_taken: "What have you done so far about the problem?",
};

/** Unit of numeric answers per `need_code` (the contract doesn't carry it in the need). */
const NEED_UNITS: Record<string, string> = { symptom_onset_days: "d" };

export function needQuestion(need: InformationNeed): string {
  const question = NEED_QUESTIONS[need.need_code] ?? `Tell us: ${need.variable.toLowerCase()}.`;
  if (need.answer_type !== "choice" || !need.options) return question;
  return `${question} Reply with the number: ${need.options.map((o, i) => `${i + 1} ${o}`).join(", ")}.`;
}

export function isDontKnow(text: string): boolean {
  return /^(i dont know|dont know|idk|dunno|not sure|im not sure|unsure|no idea)$/.test(normalizeAnswer(text));
}

/**
 * Normalizes the answer by `answer_type`. "I don't know" → `value: null, unknown: true`
 * (never zero). If it can't be parsed, the text is kept as is; `raw_text`
 * always carries what the farmer wrote.
 */
export function answerFrom(need: InformationNeed, text: string): ObservationAnswer {
  const raw = text.trim();
  if (isDontKnow(raw)) return { need_code: need.need_code, value: null, unit: null, raw_text: raw, unknown: true };

  let value: string | number | boolean = raw;
  let unit: string | null = null;
  if (need.answer_type === "choice" && need.options) {
    const choice = parseChoice(raw, need.options.length);
    if (typeof choice === "number") {
      const option = need.options[choice]!;
      if (isDontKnow(option)) return { need_code: need.need_code, value: null, unit: null, raw_text: raw, unknown: true };
      value = option;
    }
  } else if (need.answer_type === "yes_no") {
    const yesNo = parseYesNo(raw);
    if (yesNo !== null) value = yesNo;
  } else if (need.answer_type === "number_with_unit") {
    const n = raw.match(/\d+(?:[.,]\d+)?/)?.[0];
    if (n !== undefined) {
      value = Number(n.replace(",", "."));
      unit = NEED_UNITS[need.need_code] ?? null;
    }
  }
  return { need_code: need.need_code, value, unit, raw_text: raw, unknown: false };
}

/** Advisor guidance as text: protocol recommendations and, as testimony, a resolved case. */
export function adviceText(assessment: AssessmentResponse): string {
  const parts: string[] = [sms.notConfirmedDisease, ...assessment.recommendations.map((r) => r.text)];
  const mention = assessment.resolved_case_mentions[0];
  if (mention) {
    parts.push(`${mention.summary_for_speech}.`);
    if (mention.verification !== "verified") parts.push(sms.unverifiedTestimony);
  }
  return parts.join(" ");
}

export function parseYesNo(text: string): boolean | null {
  const t = normalizeAnswer(text);
  if (/^(y|yes|yeah|yep|yup|sure|ok|okay|1|i agree|agree|of course)$/.test(t)) return true;
  if (/^(n|no|nope|0|no thanks)$/.test(t)) return false;
  return null;
}

/** 1..max → zero-based index; "0"/"no"/"none" → "none"; anything else → null. */
export function parseChoice(text: string, max: number): number | "none" | null {
  const t = normalizeAnswer(text);
  if (t === "0" || t === "no" || t === "none" || t === "neither" || t === "none of these") return "none";
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= max ? n - 1 : null;
}

export function normalizeAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.!¡¿?,'’]+/g, "")
    .trim();
}

/** A bare greeting isn't an observation; it is never sent to the advisor as one. */
export function isGreetingOnly(text: string): boolean {
  return /^(hi|hello|hey|hi there|hello there|good (morning|afternoon|evening)|greetings)$/.test(normalizeAnswer(text));
}

/** Opt-out keywords Twilio handles and answers on its own; we only revoke in the backend. */
export function isOptOutKeyword(text: string): boolean {
  return /^(stop|stopall|unsubscribe|cancel|end|quit)$/.test(normalizeAnswer(text));
}

/**
 * "ALERTS OFF" (section 17): stops alerts and follow-up calls but still lets the
 * farmer report. Not a Twilio keyword, so we handle and answer it ourselves.
 */
export function isAlertsOffKeyword(text: string): boolean {
  return /^(alerts off|alert off|no alerts|no more alerts)$/.test(normalizeAnswer(text));
}

export function parseStatusReported(text: string): StatusReported | null {
  if (isDontKnow(text)) return "unknown";
  const t = normalizeAnswer(text);
  if (/^(1|worse|its worse|getting worse|it got worse)$/.test(t)) return "worse";
  if (/^(2|same|the same|about the same|no change|still the same)$/.test(t)) return "same";
  if (/^(3|better|its better|getting better|improved|it improved)$/.test(t)) return "improved";
  if (/^(4|resolved|its resolved|fixed|its fixed|gone|its gone|all good)$/.test(t)) return "resolved";
  return null;
}

export function parseActionWorked(text: string): ActionWorked | null {
  if (isDontKnow(text)) return "unknown";
  const t = normalizeAnswer(text);
  if (/^(1|yes|y|yeah|yep|it worked|worked)$/.test(t)) return "yes";
  if (/^(2|no|n|nope|it didnt work|didnt work)$/.test(t)) return "no";
  if (/^(3|partly|partially|in part|somewhat|a little|kind of|sort of)$/.test(t)) return "partial";
  return null;
}
