/**
 * SMS conversation state, per phone. Two kinds: help (a report started by
 * the farmer) and follow-up (started by us when the call went unanswered).
 *
 * In memory: if the process restarts, the conversation starts over. What
 * can't be lost (the report and its deduplication) lives in the backend, with
 * an Idempotency-Key derived from the MessageSid. Persisting sessions needs a
 * table from Member 3.
 */
import type {
  ActionWorked,
  ContactCandidate,
  ContactConsent,
  InformationNeed,
  ObservationAnswer,
  StatusReported,
} from "../contracts/index.ts";

export type ConsentScope = "reports" | "notifications" | "followup_calls";

export type Stage =
  | { kind: "identify"; candidates: ContactCandidate[] }
  | { kind: "choose_plot"; plots: { plot_id: string; label: string }[] }
  | { kind: "consent"; scope: ConsentScope }
  | { kind: "describe" }
  | { kind: "answer"; need: InformationNeed }
  | { kind: "closed" };

export interface SmsSession {
  kind: "help";
  session_id: string;
  phone_e164: string;
  /** MessageSid of the first SMS: `provider_reference` and base of the report's Idempotency-Key. */
  first_message_sid: string;
  last_activity_at: number;
  stage: Stage;
  invalid_replies: number;
  farmer: { farmer_id: string; language: string } | null;
  plot: { plot_id: string; crop: string | null; variety: string | null } | null;
  /** Permissions stored in the backend when identity was confirmed; null without a confirmed farmer. */
  stored_consent: ContactConsent | null;
  /** Answers in this conversation; null = not asked. */
  consent: Record<ConsentScope, boolean | null>;
  /** The farmer's own words (description and answers), uninterpreted. */
  statements: string[];
  answers: ObservationAnswer[];
  /** Needs already asked; sent with every assessment so the advisor doesn't repeat them. */
  asked_need_codes: string[];
  assessment_rounds: number;
  last_assessment_id: string | null;
  report_submitted: boolean;
}

export type FollowupStage = "status" | "actions" | "worked" | "closed";

/** SMS follow-up after the calls are used up (section 17). */
export interface FollowupSmsSession {
  kind: "followup";
  /** Bound to the case's plot by the `contacting` attempt. */
  session_id: string;
  phone_e164: string;
  followup_id: string;
  /** sid of the outbound SMS. */
  outbound_reference: string | null;
  /** MessageSid of the first reply: `provider_reference` and base of the Idempotency-Key. */
  first_reply_sid: string | null;
  last_activity_at: number;
  stage: FollowupStage;
  invalid_replies: number;
  status_reported: StatusReported | null;
  actions_taken: string | null;
  action_worked: ActionWorked | null;
  statements: string[];
  submitted: boolean;
}

export type AnySession = SmsSession | FollowupSmsSession;

/** Sessions by E.164 phone. */
export type SessionStore = Map<string, AnySession>;

export function isOpen(session: AnySession | undefined): session is AnySession {
  return session !== undefined && (session.kind === "help" ? session.stage.kind !== "closed" : session.stage !== "closed");
}
