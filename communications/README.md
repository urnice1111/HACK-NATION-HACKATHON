# communications (Integrante 1)

Adaptadores Twilio/ElevenLabs, sesiones, entrega y seguimiento del MVP agrícola. Fuente de la verdad: [`delegacion_mvp_agricultura.md`](delegacion_mvp_agricultura.md); guía del agente en [`CLAUDE.md`](CLAUDE.md).

## Puesta en marcha

```bash
npm install
cp .env.example .env   # rellena MOCK_SERVICE_TOKEN y BACKEND_SERVICE_TOKEN con el mismo valor aleatorio
npm run mock:backend   # mock de /v1 en http://127.0.0.1:8787
npm run dev            # servidor de webhooks en http://127.0.0.1:8080
npm test               # pruebas de contrato y del webhook SMS contra el mock
npm run typecheck
```

## Probar con SMS reales

1. Terminal 1: `npm run mock:backend`. Con `MOCK_PHONE_OVERRIDES` en `.env` puedes asociar tu celular a un agricultor demo; si no lo pones, se te trata como número desconocido.
2. Terminal 2: `npm run dev`.
3. Terminal 3: `ngrok http 8080 --url=<PUBLIC_BASE_URL>`.
4. En la consola de Twilio: Phone Numbers → Active numbers → tu número → *Messaging configuration* → "A message comes in": Webhook, `<PUBLIC_BASE_URL>/v1/webhooks/twilio/sms`, HTTP POST. Si el número pertenece a un Messaging Service, configúralo allí. No toques la configuración de voz: la gestiona ElevenLabs.
5. Envía un SMS desde tu celular.

## Conversación SMS

Identidad (el número no basta) → parcela si hay varias → consentimiento → descripción → preguntas a partir de las `information_needs` del asesor → orientación → reporte.

El asesor (contrato v2) no escribe la pregunta: devuelve necesidades estructuradas y `src/sms/messages.ts` las formula con una plantilla por `need_code`, una por turno y empezando por la de mayor `priority`. Las respuestas se normalizan por `answer_type` (`{need_code, value, unit, raw_text, unknown}`); "no sé" se envía como `value: null, unknown: true`, nunca como cero. Se envía `asked_need_codes` en cada evaluación para no repetir preguntas; como máximo 3 rondas y 5 preguntas. Las respuestas van en TwiML dentro del mismo webhook, con como máximo dos llamadas al backend por SMS (`SMS_STEP_TIMEOUT_MS` cada una). Una conversación produce un reporte con `Idempotency-Key: report-sms-<MessageSid del primer SMS>`, así un webhook repetido no duplica nada aunque el proceso se reinicie. Solo se dice "quedó registrado" tras un 201; si el guardado queda ambiguo, se avisa y se reintenta con la misma clave (máximo 3 intentos). Una conversación abandonada (`SMS_SESSION_IDLE_MS`) se guarda como `completeness: "partial"` si había consentimiento.

### Consentimiento

Tres permisos separados (sección 17): guardar reportes, recibir avisos y recibir llamadas de seguimiento. `contact-resolution` devuelve los guardados (`null` = nunca se preguntó):

- **Reportes:** si nunca lo dio, se pide el permiso completo; si ya lo dio, solo se confirma este reporte ("¿Guardamos este reporte…?"), porque la sección 4 guarda observaciones confirmadas por el usuario. Si dice NO, no se guarda nada.
- **Avisos y seguimientos:** solo se preguntan a un agricultor confirmado que nunca respondió; un "no" o una baja anteriores no se vuelven a preguntar.
- Se guardan con `POST /v1/consents` (PROPUESTO) **en segundo plano**, con reintentos y la misma clave, para no superar dos llamadas bloqueantes por SMS. Un número desconocido solo responde el permiso de reportes, que vale para esa conversación.

### Baja

"BAJA" revoca avisos y llamadas de seguimiento (`POST /v1/consents/revocations`, PROPUESTO) y se contesta solo tras un 200; si queda pendiente, se dice que se está procesando y se reintenta. No revoca el permiso de reportar. STOP y similares hacen lo mismo en el backend, pero no contestamos: Twilio contesta y bloquea el número. Una conversación en curso se cierra guardando lo recibido como parcial.

### Seguimiento por SMS

Respaldo tras 3 llamadas sin respuesta. `FollowupSmsFlow.start(item)` recibe un elemento de `GET /v1/followups`; lo invocará el despachador de `followup.due` (fase 5). Antes de enviar exige permiso de seguimiento, horario permitido (08:00–19:00 hora local por defecto) y, en demo, que el número esté en `DEMO_ALLOWED_NUMBERS`; no pisa una conversación abierta. Registra el intento `contacting` (que liga la sesión a la parcela del caso) **antes** de enviar.

Pregunta, una por SMS, cómo sigue la parcela (1 peor, 2 igual, 3 mejor, 4 ya se resolvió), qué hizo y si funcionó, y lo guarda con `POST /v1/followups/{id}/responses`. Si no responde en `FOLLOWUP_SMS_REPLY_WINDOW_MS` (24 h), registra `no_response`: nunca se declara resolución ni baja el riesgo por silencio. Un envío ambiguo (timeout de Twilio) no se reenvía.

Sin `TWILIO_ACCOUNT_SID`, los SMS salientes usan un stub y no se envía nada.

Limitación: las sesiones viven en memoria. Si el proceso se reinicia, la conversación en curso vuelve a empezar y una respuesta a un seguimiento por SMS se trata como conversación nueva. Persistirlas requiere una tabla del Integrante 3.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `src/contracts/` | Copia provisional de los contratos **v2** (secciones 8–11) como esquemas zod. Se sustituye por `contracts/` cuando el Integrante 3 lo publique. |
| `src/http/` | Helpers compartidos: request_id, error uniforme, lectura de cuerpo, logs con teléfonos enmascarados. |
| `src/backend/client.ts` | Cliente del backend para server tools y webhooks. Valida cada respuesta y distingue `timeout` (resultado ambiguo) de error. |
| `src/mock-backend/` | Mock de `/v1` (backend + asesor v2) con fixtures demo. Estado en memoria. |
| `src/server/` | Servidor HTTP: webhook SMS, herramientas de voz (`/v1/tools/*`) y `followup.due` (`/v1/followups/{id}/dispatch`). |
| `src/followups/dispatcher.ts` | Despachador de `followup.due`: permiso, horario y lista blanca; hasta 3 llamadas y luego SMS; `no_response` por plazo vencido. |
| `src/elevenlabs/outbound.ts` | Llamada saliente con el agente de seguimiento (`/v1/convai/twilio/outbound-call`), con stub. |
| `src/tools/voice-tools.ts` | Server tools de los agentes: `submit_followup`, `assess_observation`, `submit_report`. |
| `agents/` | Prompts y definiciones de herramientas de los agentes de ElevenLabs, con la guía de configuración. |
| `src/backend/writer.ts` | Escrituras (reporte, seguimiento, consentimiento, baja, intentos) con Idempotency-Key fija y reintentos acotados; también en segundo plano. |
| `src/sms/` | Conversación SMS (`conversation.ts`), seguimiento por SMS (`followup.ts`), sesiones y textos (`messages.ts`). |
| `src/policy/outreach.ts` | Reglas de contacto proactivo: consentimiento, horario local y lista blanca de demo. |
| `src/twilio/` | Firma de Twilio, URL pública de callback, TwiML y envío de SMS salientes con stub (adaptado de Marco). |

## Agente de seguimiento (llamadas salientes)

Guía completa y configuración en ElevenLabs: [`agents/README.md`](agents/README.md).

- `followup.due` llega por `POST /v1/followups/{id}/dispatch` (token `COMMS_SERVICE_TOKEN`, deduplicado por `event_id`) o por sondeo cada `FOLLOWUP_POLL_INTERVAL_MS`.
- Intentos 1–3: llamada con el agente de seguimiento y variables dinámicas (nombre, amenaza, síntomas, orientación dada e IDs). Después, SMS. Tras el SMS sin respuesta, no se insiste.
- El agente llama a `/v1/tools/submit-followup` una vez con las cuatro respuestas; si empeoró, sigue con `/v1/tools/assess-observation` y `/v1/tools/submit-report`. Las herramientas se autentican con `ELEVENLABS_TOOL_SECRET` y solo `registered: true` permite decir "quedó registrado".
- Sin `submit_followup` en `FOLLOWUP_CALL_RESULT_TIMEOUT_MS`, se registra `no_response`. Un fallo transitorio de ElevenLabs espera `FOLLOWUP_PLACEMENT_BACKOFF_MS` sin gastar intento; una respuesta ambigua no se repite.
- Sin credenciales de ElevenLabs, las llamadas usan un stub.

Limitación: las llamadas en curso se recuerdan en memoria. Si el proceso se reinicia con una llamada sin resultado, el seguimiento queda en `contacting` hasta que el webhook post-call de ElevenLabs (fase 6, `call_initiation_failure`) lo concilie.

## Mock de /v1

Rutas del documento: `POST /v1/contact-resolution`, `GET /v1/plots/{id}/context` (cabecera `X-Session-Id`; incluye `environment_summary`), `POST /v1/assessments`, `POST /v1/reports`, `GET /v1/reports/{id}`, `GET /v1/followups?status=…&due_before=…`, `POST /v1/followups/{id}/responses`, `GET /v1/health`.

Rutas PROPUESTAS (no están en la v2): `POST /v1/followups/{id}/attempts`, `POST /v1/consents`, `POST /v1/consents/revocations`.

Todas, salvo health, exigen `Authorization: Bearer <MOCK_SERVICE_TOKEN>`.

El asesor mock imita las reglas de la v2: primer turno con dos necesidades (`local_weather_perception`, `leaf_underside`), no repite `asked_need_codes`, "no sé" no cuenta como respuesta, deriva tras 5 preguntas o ante preguntas de fungicida/dosis, declara en `data_used` lo consultado (o que la parcela está fuera de cobertura) y en `advise` menciona primero un caso resuelto `verified`, nunca uno con producto y dosis. Un seguimiento `resolved` crea una sola resolución y cierra el caso; `worse`, `same`, `improved` o `unknown` programan otro a los 3 minutos.

Solo acepta `is_demo: true`. Escenarios con la cabecera `X-Mock-Scenario`: `advisor_unavailable`, `backend_unavailable`, `delay:<ms>`.

Fixtures (`src/mock-backend/fixtures.ts`, teléfonos ficticios +1 202 555 01xx):

| Teléfono | Caso de prueba |
| --- | --- |
| `+12025550101` | Número conocido, una parcela, con resumen ambiental |
| `+12025550102` | Teléfono compartido por dos agricultores |
| `+12025550104` | Sin consentimiento de avisos ni seguimientos; parcela fuera de cobertura de los datasets |
| `+12025550105` | Caso activo con seguimiento **vencido** (`followup_demo_05`) |
| `+12025550106` | Caso con seguimiento `no_response` tras 3 intentos |
| `+12025550107`, `+12025550108` | Parcelas sin contexto (`crop: null`) y consentimiento nunca preguntado (`null`) |
| cualquier otro | Número desconocido (`no_match`) |

Amenaza `coffee_leaf_rust`, protocolo `coffee-rust-demo-v1`. Casos resueltos: `resolution_demo_01` (`verified`), `resolution_demo_02` (`farmer_reported`) y `resolution_demo_03` (producto y dosis: el asesor lo omite).

## Pendiente de acordar con el Integrante 3

El documento no fija estas formas; están marcadas `PROPUESTO` en `src/contracts/resources.ts`:

La v2 ya fija `observation.answers[]` y el cuerpo de `POST /v1/followups/{id}/responses`. Siguen abiertos:

1. **Consentimiento:** dónde se guardan los tres permisos (`POST /v1/consents`) y el permiso de "guardar reportes", que el modelo `Contact` no tiene. `contact-resolution` devuelve `consent: {reports, notifications, followup_calls, consent_at}` con `null` = nunca preguntado. En un teléfono compartido el permiso es del contacto, no de cada agricultor.
2. **"BAJA" por SMS:** `POST /v1/consents/revocations` por teléfono.
3. **Intentos de seguimiento:** `POST /v1/followups/{id}/attempts` (`contacting | no_response | failed`); `contacting` liga la sesión saliente a la parcela del caso, porque no hay `contact-resolution`.
4. **Cómo llega `followup.due` a comunicaciones:** implementado `POST /v1/followups/{id}/dispatch` (cuerpo = evento outbox `followup.due`, `Authorization: Bearer <COMMS_SERVICE_TOKEN>`, 202 con el resultado), simétrico a `/v1/notifications/{id}/dispatch`; también sondeamos `GET /v1/followups?status=…&due_before=…`. Falta confirmar que el worker lo llame así.
5. **Reprogramar tras `no_response`:** comunicaciones asume que el scheduler mueve `due_at` al registrar `no_response` de una llamada (2 min en demo, 2 h en real; inmediato tras la 3.ª llamada, para el SMS). Así lo hace el mock.
6. **`GET /v1/followups`:** forma de `case_summary` (variables del agente de seguimiento) y `contact` (teléfono, zona horaria, horario, permisos), que solo debería ver el token `comms`.
7. **`environment_summary`** dentro de `GET /v1/plots/{id}/context`: lista `{name, value, unit}` con `data_freshness` y `dataset_ids`.
8. **SMS de seguimiento como `Notification`:** hoy se envía directo desde comunicaciones y se registra como intento (`channel: sms`). La sección 9 permite `Notification.followup_id`; si el Integrante 3 prefiere que pase por la cola de notificaciones, el envío se mueve a `/v1/notifications/{id}/dispatch` (fase 6).
9. De la v1, aún sin confirmar: `contact-resolution` en dos pasos; `plot_id: null` en reportes de números desconocidos; cuerpo de `GET /v1/reports/{id}`; estado `cancelled` en notificaciones; códigos de error `IDEMPOTENCY_KEY_REUSED`, `PLOT_NOT_CONFIRMED`, `CANDIDATE_TOKEN_INVALID`, `FARMER_NOT_CONFIRMED`, `FOLLOWUP_CLOSED`, `DEMO_MODE_MISMATCH`, `ADVISOR_UNAVAILABLE`.
