/**
 * Estado de conversaciones SMS, por teléfono. Hay dos tipos: la de ayuda
 * (reporte iniciado por el agricultor) y la de seguimiento (iniciada por
 * nosotros cuando la llamada no tuvo respuesta).
 *
 * En memoria: si el proceso se reinicia, la conversación vuelve a empezar.
 * Lo que no se puede perder (el reporte y su deduplicación) vive en el
 * backend, con una Idempotency-Key derivada del MessageSid. Persistir las
 * sesiones requiere una tabla del Integrante 3; la interfaz permite cambiar
 * la implementación sin tocar la conversación.
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
  /** MessageSid del primer SMS: `provider_reference` y base de la Idempotency-Key del reporte. */
  first_message_sid: string;
  created_at: string;
  last_activity_at: number;
  stage: Stage;
  invalid_replies: number;
  farmer: { farmer_id: string; language: string } | null;
  plot: { plot_id: string; crop: string | null; variety: string | null } | null;
  /** Permisos guardados en el backend al confirmar identidad; null si no hay agricultor confirmado. */
  stored_consent: ContactConsent | null;
  /** Respuestas de esta conversación; null = no se preguntó. */
  consent: Record<ConsentScope, boolean | null>;
  /** Palabras del agricultor (descripción y respuestas), sin interpretar. */
  statements: string[];
  answers: ObservationAnswer[];
  /** Necesidades ya preguntadas; se envían en cada evaluación para que el asesor no las repita. */
  asked_need_codes: string[];
  assessment_rounds: number;
  last_assessment_id: string | null;
  report_submitted: boolean;
}

export type FollowupStage = "status" | "actions" | "worked" | "closed";

/** Seguimiento por SMS tras agotar las llamadas (sección 17). */
export interface FollowupSmsSession {
  kind: "followup";
  /** Ligado a la parcela del caso con el intento `contacting`. */
  session_id: string;
  phone_e164: string;
  followup_id: string;
  /** sid del SMS saliente. */
  outbound_reference: string | null;
  /** MessageSid de la primera respuesta: `provider_reference` y base de la Idempotency-Key. */
  first_reply_sid: string | null;
  created_at: string;
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

export interface SessionStore {
  get(phone: string): AnySession | undefined;
  set(session: AnySession): void;
  delete(phone: string): void;
  all(): Iterable<AnySession>;
}

export function isOpen(session: AnySession | undefined): session is AnySession {
  return session !== undefined && (session.kind === "help" ? session.stage.kind !== "closed" : session.stage !== "closed");
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, AnySession>();
  get(phone: string) {
    return this.sessions.get(phone);
  }
  set(session: AnySession) {
    this.sessions.set(session.phone_e164, session);
  }
  delete(phone: string) {
    this.sessions.delete(phone);
  }
  all() {
    return this.sessions.values();
  }
}

/** Serializa el trabajo por clave: dos SMS seguidos del mismo teléfono no se pisan. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** Respuestas ya enviadas por MessageSid, para contestar igual a un webhook repetido. */
export class ProcessedMessages {
  private readonly replies = new Map<string, string>();
  constructor(private readonly capacity = 5000) {}

  get(sid: string): string | undefined {
    return this.replies.get(sid);
  }

  remember(sid: string, twiml: string): void {
    this.replies.set(sid, twiml);
    if (this.replies.size > this.capacity) {
      const oldest = this.replies.keys().next().value;
      if (oldest !== undefined) this.replies.delete(oldest);
    }
  }
}
