import type { ActionWorked, AssessmentResponse, InformationNeed, ObservationAnswer, StatusReported } from "../contracts/index.ts";

/**
 * Textos SMS (español). Todo el copy vive aquí para ajustarlo cuando se
 * decidan región, idioma y política de consentimiento. Mensajes cortos: los
 * acentos fuerzan UCS-2 (70 caracteres por segmento).
 */
export const sms = {
  identify: (labels: string[]) =>
    labels.length === 1
      ? `Hola. ¿Escribes tú, ${labels[0]}? Responde 1 para sí o 0 para no.`
      : `Hola. ¿Quién escribe? ${labels.map((l, i) => `${i + 1} ${l}`).join(", ")}. Responde con el número, o 0 si no eres ninguno.`,
  choosePlot: (labels: string[]) => `¿De qué parcela se trata? ${labels.map((l, i) => `${i + 1} ${l}`).join(", ")}. Responde con el número.`,
  unknownNumber: "Hola. Tu número no está registrado en el programa.",
  // Consentimiento (sección 17): tres permisos separados.
  consent:
    "Para guardar tu reporte y que un técnico lo revise, responde SI. Si prefieres que no lo guardemos, responde NO.",
  /** Ya dio permiso de guardar reportes: se confirma este reporte en concreto (sección 4: "observación confirmada"). */
  confirmReport: "¿Guardamos este reporte para que un técnico lo revise? Responde SI o NO.",
  consentNotifications: "¿Quieres recibir avisos por SMS si hay problemas en parcelas cercanas? Responde SI o NO.",
  consentFollowupCalls: "¿Podemos llamarte en unos días para saber cómo sigue tu parcela? Responde SI o NO.",
  consentDeclined: "Entendido, no guardamos tu mensaje. Puedes escribirnos cuando quieras.",
  describe: "Cuéntanos qué estás viendo en tus plantas.",
  notUnderstood: "No entendí tu respuesta.",
  gaveUp: "No logramos entender las respuestas. Escríbenos de nuevo cuando quieras.",
  textOnly: "Por ahora solo podemos leer mensajes de texto.",
  technicalIssue: "Tenemos un problema técnico. Intenta de nuevo en unos minutos.",

  // Baja ("BAJA"): revoca avisos y llamadas de seguimiento, no el permiso de reportar.
  optedOut: "Listo. Ya no te enviaremos avisos ni llamadas de seguimiento. Puedes seguir enviando reportes.",
  optOutPending: "Recibimos tu solicitud de baja y la estamos procesando.",
  optOutFailed: "No pudimos procesar tu baja. Escribe BAJA de nuevo en unos minutos.",

  // Seguimiento por SMS (respaldo tras 3 llamadas sin respuesta).
  followupIntro: (name: string) =>
    `Hola ${name}, te escribimos del programa de café por tu reporte. ¿Cómo sigue tu parcela? Responde 1 peor, 2 igual, 3 mejor, 4 ya se resolvió.`,
  followupStatusRetry: "Responde 1 peor, 2 igual, 3 mejor o 4 ya se resolvió.",
  followupActions: "¿Qué hiciste en la parcela desde tu reporte?",
  followupWorked: "¿Te funcionó? Responde 1 sí, 2 no o 3 en parte.",
  followupSaved: (status: StatusReported) =>
    ({
      resolved: "Gracias, qué bueno que se resolvió. Quedó registrado.",
      improved: "Gracias. Quedó registrado; te volveremos a preguntar en unos días.",
      same: "Gracias. Quedó registrado y un técnico revisará tu caso.",
      worse: "Gracias. Quedó registrado y un técnico revisará tu caso. Si quieres contarnos qué ves ahora, escríbenos.",
      unknown: "Gracias. Quedó registrado.",
    })[status],

  // Cierre del reporte. Solo `saved` afirma que quedó registrado, y solo tras un 201.
  saved: "Tu reporte quedó registrado.",
  savedUnknown: "Guardamos tu mensaje para que un técnico lo revise.",
  notConfirmed: "No pude confirmar que tu reporte quedó registrado. Lo vamos a reintentar; no necesitas volver a enviarlo.",
  notSaved: "No pudimos registrar tu reporte. Un técnico revisará el problema.",
  advisorFailed: "No pudimos completar la evaluación.",
  refer: "Con lo que nos cuentas no podemos darte una orientación segura. Un técnico revisará tu caso.",
  notConfirmedDisease: "Esto no confirma ninguna enfermedad; un técnico lo revisará.",
  unverifiedTestimony: "Es lo que contó el agricultor; no está verificado.",
} as const;

/**
 * Plantilla breve por `need_code` (sección 4). El asesor no escribe la
 * pregunta: aquí se formula en lenguaje cotidiano. Nunca se usa el nombre
 * técnico de la variable.
 */
const NEED_QUESTIONS: Record<string, string> = {
  local_weather_perception: "¿Cómo ha estado el clima en tu parcela estos días? ¿Ha llovido o ha estado húmedo?",
  leaf_underside: "¿Qué ves en la parte de abajo de las hojas?",
  spot_appearance: "¿De qué color y forma son las manchas?",
  affected_extent: "¿Cuántas plantas tienen el problema?",
  leaf_drop: "¿Se están cayendo las hojas? Responde SI o NO.",
  symptom_onset_days: "¿Hace cuántos días empezaste a ver el problema?",
  coffee_variety: "¿Qué variedad de café tienes sembrada?",
  shade_level: "¿Cuánta sombra tienen tus cafetos?",
  actions_taken: "¿Qué has hecho hasta ahora para atender el problema?",
};

/** Unidad de las respuestas numéricas por `need_code` (el contrato no la trae en la necesidad). */
const NEED_UNITS: Record<string, string> = { symptom_onset_days: "d" };

export function needQuestion(need: InformationNeed): string {
  const question = NEED_QUESTIONS[need.need_code] ?? `Cuéntanos: ${need.variable.toLowerCase()}.`;
  if (need.answer_type !== "choice" || !need.options) return question;
  return `${question} Responde con el número: ${need.options.map((o, i) => `${i + 1} ${o}`).join(", ")}.`;
}

export function isDontKnow(text: string): boolean {
  return /^(no se|nose|ns|no lo se|ni idea|quien sabe)$/.test(normalizeAnswer(text));
}

/**
 * Normaliza la respuesta según `answer_type`. "No sé" → `value: null, unknown: true`
 * (nunca cero). Si no se entiende, se conserva el texto tal cual; `raw_text`
 * siempre lleva lo que escribió el agricultor.
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

/** Orientación del asesor en texto: recomendaciones con protocolo y, como testimonio, un caso resuelto. */
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
  if (/^(si|s|1|ok|acepto|claro|yes)$/.test(t)) return true;
  if (/^(no|n|0)$/.test(t)) return false;
  return null;
}

/** 1..max → índice base 0; "0"/"no" → "none"; otra cosa → null. */
export function parseChoice(text: string, max: number): number | "none" | null {
  const t = normalizeAnswer(text);
  if (t === "0" || t === "no" || t === "ninguno") return "none";
  const n = Number(t);
  return Number.isInteger(n) && n >= 1 && n <= max ? n - 1 : null;
}

export function normalizeAnswer(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.!¡¿?,]+/g, "")
    .trim();
}

/** Un saludo suelto no es una observación; no se manda al asesor como tal. */
export function isGreetingOnly(text: string): boolean {
  return /^(hola|ola|buen[oa]s?( dias| tardes| noches)?|saludos|hi|hello)$/.test(normalizeAnswer(text));
}

/** Palabras de baja que Twilio gestiona y contesta por su cuenta; nosotros solo revocamos en el backend. */
export function isOptOutKeyword(text: string): boolean {
  return /^(stop|stopall|unsubscribe|cancel|end|quit)$/.test(normalizeAnswer(text));
}

/** "BAJA" (sección 17): Twilio no la conoce; la gestionamos y contestamos nosotros. */
export function isBajaKeyword(text: string): boolean {
  return /^(baja|darme de baja|dar de baja)$/.test(normalizeAnswer(text));
}

export function parseStatusReported(text: string): StatusReported | null {
  if (isDontKnow(text)) return "unknown";
  const t = normalizeAnswer(text);
  if (/^(1|peor|empeoro|esta peor|mas mal)$/.test(t)) return "worse";
  if (/^(2|igual|sigue igual|lo mismo)$/.test(t)) return "same";
  if (/^(3|mejor|mejoro|esta mejor|va mejor)$/.test(t)) return "improved";
  if (/^(4|resuelto|ya se resolvio|se resolvio|ya no hay|ya se quito|ya esta bien)$/.test(t)) return "resolved";
  return null;
}

export function parseActionWorked(text: string): ActionWorked | null {
  if (isDontKnow(text)) return "unknown";
  const t = normalizeAnswer(text);
  if (/^(1|si|s|claro|funciono)$/.test(t)) return "yes";
  if (/^(2|no|n|no funciono)$/.test(t)) return "no";
  if (/^(3|en parte|parcial|un poco|mas o menos|algo)$/.test(t)) return "partial";
  return null;
}
