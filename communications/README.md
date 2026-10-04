# communications (Integrante 1)

Adaptadores Twilio/ElevenLabs, sesiones, entrega y seguimiento del MVP agrícola. Fuente de la verdad: [`INSTRUCTIONS.md`](../INSTRUCTIONS.md) (raíz del repo); guía del agente en [`CLAUDE.md`](CLAUDE.md).

## Puesta en marcha

```bash
npm install
cp .env.example .env   # rellena MOCK_SERVICE_TOKEN y BACKEND_SERVICE_TOKEN con el mismo valor aleatorio
npm run mock:backend   # mock de /v1 en http://127.0.0.1:8787
npm run dev            # servidor de webhooks en http://127.0.0.1:8080
npm test               # pruebas de contrato, webhook SMS y seguimiento contra el mock
npm run typecheck
```

## Probar con SMS reales

1. Terminal 1: `npm run mock:backend`. Con `MOCK_PHONE_OVERRIDES` en `.env` asocias tu celular a un agricultor demo; si no, se te trata como número desconocido.
2. Terminal 2: `npm run dev`.
3. Terminal 3: `ngrok http 8080 --url=<PUBLIC_BASE_URL>`.
4. En Twilio: Phone Numbers → Active numbers → tu número → *Messaging configuration* → "A message comes in": Webhook, `<PUBLIC_BASE_URL>/v1/webhooks/twilio/sms`, HTTP POST (o en su Messaging Service). No toques la configuración de voz: la gestiona ElevenLabs.
5. Envía un SMS desde tu celular.

## Conversación SMS

Identidad (el número no basta) → parcela si hay varias → consentimiento → descripción → preguntas a partir de las `information_needs` del asesor → orientación → reporte.

- El asesor no escribe la pregunta: `src/sms/messages.ts` la formula con una plantilla por `need_code`, una por turno y empezando por la de mayor `priority`. Respuestas normalizadas por `answer_type` (`{need_code, value, unit, raw_text, unknown}`); "no sé" → `value: null, unknown: true`, nunca cero. Se envía `asked_need_codes` en cada evaluación; como máximo 3 rondas y 5 preguntas.
- Se responde con TwiML en el mismo webhook, con como máximo dos llamadas bloqueantes al backend por SMS (`SMS_STEP_TIMEOUT_MS` cada una).
- Una conversación produce un reporte con `Idempotency-Key: report-sms-<MessageSid del primer SMS>`: un webhook repetido no duplica nada aunque el proceso se reinicie. Solo se dice "quedó registrado" tras un 201; si el guardado queda ambiguo, se avisa y se reintenta con la misma clave (máximo 3 intentos).
- Una conversación abandonada (`SMS_SESSION_IDLE_MS`) se guarda como `completeness: "partial"` si había consentimiento.

**Consentimiento** (tres permisos, sección 17). `contact-resolution` devuelve los guardados (`null` = nunca se preguntó):

- Reportes: si nunca lo dio, se pide el permiso; si ya lo dio, solo se confirma este reporte. Si dice NO, no se guarda nada.
- Avisos y seguimientos: solo se preguntan a un agricultor confirmado que nunca respondió.
- Se guardan con `POST /v1/consents` (PROPUESTO) en segundo plano, con reintentos. Un número desconocido solo responde el permiso de reportes, válido para esa conversación.

**Baja.** "BAJA" revoca avisos y llamadas de seguimiento (`POST /v1/consents/revocations`, PROPUESTO) y se contesta solo tras un 200; si queda pendiente, se dice que se está procesando. No revoca el permiso de reportar. STOP y similares hacen lo mismo en el backend, pero no contestamos: Twilio contesta y bloquea el número. Una conversación en curso se cierra guardando lo recibido como parcial.

**Seguimiento por SMS.** Respaldo tras 3 llamadas sin respuesta; lo inicia el despachador con `FollowupSmsFlow.start(item)`. Exige permiso de seguimiento, horario permitido (08:00–19:00 hora local) y, en demo, `DEMO_ALLOWED_NUMBERS`; no pisa una conversación abierta. Registra el intento `contacting` **antes** de enviar. Pregunta, una por SMS, cómo sigue la parcela (1 peor, 2 igual, 3 mejor, 4 ya se resolvió), qué hizo y si funcionó, y lo guarda con `POST /v1/followups/{id}/responses`. Sin respuesta en `FOLLOWUP_SMS_REPLY_WINDOW_MS` (24 h) registra `no_response`: nunca se declara resolución por silencio. Un envío ambiguo no se reenvía. Sin `TWILIO_ACCOUNT_SID`, los SMS salientes usan un stub.

Limitación: las sesiones viven en memoria. Si el proceso se reinicia, la conversación en curso vuelve a empezar. Persistirlas requiere una tabla del Integrante 3.

## Agente de seguimiento (llamadas salientes)

Flujo, variables dinámicas y configuración en ElevenLabs: [`agents/README.md`](agents/README.md).

- `followup.due` llega por `POST /v1/followups/{id}/dispatch` (token `COMMS_SERVICE_TOKEN`, deduplicado por `event_id`) o por sondeo cada `FOLLOWUP_POLL_INTERVAL_MS`.
- Intentos 1–3: llamada con el agente de seguimiento; después, SMS; tras el SMS sin respuesta, no se insiste.
- Las herramientas (`/v1/tools/*`) se autentican con `ELEVENLABS_TOOL_SECRET`; solo `registered: true` permite decir "quedó registrado".
- Sin `submit_followup` en `FOLLOWUP_CALL_RESULT_TIMEOUT_MS` se registra `no_response`. Un fallo transitorio de ElevenLabs espera `FOLLOWUP_PLACEMENT_BACKOFF_MS` sin gastar intento; una respuesta ambigua no se repite. Sin credenciales, las llamadas usan un stub.
- Para probar de noche: `DEMO_IGNORE_ALLOWED_HOURS=true` se salta el horario. Solo con `IS_DEMO=true` (si no, el servidor no arranca) y no se salta el consentimiento ni la lista blanca.

Limitación: las llamadas en curso se recuerdan en memoria. Si el proceso se reinicia con una llamada sin resultado, el seguimiento queda en `contacting` hasta que el webhook post-call de ElevenLabs (fase 6) lo concilie.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `src/server/` | Servidor HTTP: webhook SMS, herramientas de voz (`/v1/tools/*`) y `followup.due` (`/v1/followups/{id}/dispatch`). `main.ts` arma las dependencias. |
| `src/sms/` | Conversación SMS (`conversation.ts`), seguimiento por SMS (`followup.ts`), tipos de sesión (`session.ts`) y textos (`messages.ts`). |
| `src/followups/dispatcher.ts` | Despachador de `followup.due`: permiso, horario y lista blanca; hasta 3 llamadas y luego SMS. |
| `src/tools/voice-tools.ts` | Server tools de los agentes: `submit_followup`, `assess_observation`, `submit_report`. |
| `src/backend/` | Cliente de `/v1` que valida cada respuesta (`client.ts`) y escrituras con Idempotency-Key fija y reintentos acotados (`writer.ts`). |
| `src/twilio/`, `src/elevenlabs/` | Firma y TwiML de Twilio, envío de SMS y llamada saliente, ambos con stub. |
| `src/policy/outreach.ts` | Contacto proactivo: consentimiento, horario local y lista blanca de demo. |
| `src/contracts/` | Copia provisional de los contratos v2 como esquemas zod. |
| `src/http/`, `src/util.ts` | request_id, error uniforme, validación 422, logs con teléfonos enmascarados; mutex por clave y mapa con tope. |
| `src/mock-backend/` | Mock de `/v1` (backend + asesor) con fixtures demo y estado en memoria. |
| `agents/` | Prompts y herramientas de los agentes de ElevenLabs. |

## Mock de /v1

Rutas: `POST /v1/contact-resolution`, `GET /v1/plots/{id}/context` (cabecera `X-Session-Id`), `POST /v1/assessments`, `POST /v1/reports`, `GET /v1/reports/{id}`, `GET /v1/followups?status=…&due_before=…`, `POST /v1/followups/{id}/responses`, `GET /v1/health`. PROPUESTAS (no están en la v2): `POST /v1/followups/{id}/attempts`, `POST /v1/consents`, `POST /v1/consents/revocations`. Todas, salvo health, exigen `Authorization: Bearer <MOCK_SERVICE_TOKEN>` y solo aceptan `is_demo: true`.

El asesor mock imita la v2: primer turno con dos necesidades (`local_weather_perception`, `leaf_underside`), no repite `asked_need_codes`, "no sé" no cuenta como respuesta, deriva tras 5 preguntas o ante fungicida/dosis, declara en `data_used` lo consultado y en `advise` menciona primero un caso `verified`, nunca uno con producto y dosis. Un seguimiento `resolved` crea una sola resolución y cierra el caso; los demás programan otro a los 3 minutos.

Escenarios con la cabecera `X-Mock-Scenario`: `advisor_unavailable`, `backend_unavailable`, `delay:<ms>`.

Fixtures (`src/mock-backend/fixtures.ts`, teléfonos ficticios +1 202 555 01xx; amenaza `coffee_leaf_rust`, protocolo `coffee-rust-demo-v1`):

| Teléfono | Caso de prueba |
| --- | --- |
| `+12025550101` | Número conocido, una parcela, con resumen ambiental |
| `+12025550102` | Teléfono compartido por dos agricultores |
| `+12025550104` | Sin consentimiento de avisos ni seguimientos; parcela fuera de cobertura |
| `+12025550105` | Caso activo con seguimiento **vencido** (`followup_demo_05`) |
| `+12025550106` | Caso con seguimiento `no_response` tras 3 intentos |
| `+12025550107`, `+12025550108` | Parcelas sin contexto (`crop: null`) y consentimiento nunca preguntado |
| cualquier otro | Número desconocido (`no_match`) |

Casos resueltos: `resolution_demo_01` (`verified`), `resolution_demo_02` (`farmer_reported`) y `resolution_demo_03` (producto y dosis: el asesor lo omite).

## Pendiente de acordar con el Integrante 3

Las formas marcadas `PROPUESTO` en `src/contracts/resources.ts` no están en la v2:

1. **El backend real ya diverge del mock.** `backend/` y `contracts/` (raíz) separan la confirmación en `POST /v1/contact-resolution/confirm`, devuelven `PlotContext` con `name`, `risk` y `environment_summary.features` como objeto, y aún no tienen `assessments`, `followups` ni `consents`. Hay que alinear `src/contracts/` antes de apuntar `BACKEND_BASE_URL` al backend real.
2. **Consentimiento:** dónde se guardan los tres permisos (`POST /v1/consents`) y el de "guardar reportes", que `Contact` no tiene. En un teléfono compartido el permiso es del contacto.
3. **"BAJA" por SMS:** `POST /v1/consents/revocations` por teléfono.
4. **Intentos de seguimiento:** `POST /v1/followups/{id}/attempts` (`contacting | no_response | failed`); `contacting` liga la sesión saliente a la parcela del caso.
5. **Cómo llega `followup.due`:** `POST /v1/followups/{id}/dispatch` (cuerpo = evento outbox, 202 con el resultado), además del sondeo de `GET /v1/followups`. Falta confirmar que el worker lo llame así.
6. **Reprogramar tras `no_response`:** asumimos que el scheduler mueve `due_at` (2 min en demo, 2 h en real; inmediato tras la 3.ª llamada, para el SMS). Así lo hace el mock.
7. **`GET /v1/followups`:** forma de `case_summary` y `contact` (teléfono, zona horaria, horario, permisos), solo para el token `comms`.
8. **SMS de seguimiento como `Notification`:** hoy se envía directo y se registra como intento (`channel: sms`); si se prefiere la cola de notificaciones, pasa a `/v1/notifications/{id}/dispatch` (fase 6).
9. De la v1, sin confirmar: `plot_id: null` en reportes de números desconocidos; cuerpo de `GET /v1/reports/{id}`; estado `cancelled` en notificaciones; códigos de error `IDEMPOTENCY_KEY_REUSED`, `PLOT_NOT_CONFIRMED`, `CANDIDATE_TOKEN_INVALID`, `FARMER_NOT_CONFIRMED`, `FOLLOWUP_CLOSED`, `DEMO_MODE_MISMATCH`, `ADVISOR_UNAVAILABLE`.
