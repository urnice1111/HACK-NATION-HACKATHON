# Agentes de ElevenLabs

| Agente | Carpeta | Estado |
| --- | --- | --- |
| Seguimiento (llamadas salientes) | [`followup/`](followup/) | Listo para configurar |
| Ayuda (llamadas entrantes) | `help/` | Pendiente (fase 4) |

Los archivos son la fuente de verdad del prompt y de las herramientas: si cambias algo en el panel de ElevenLabs, cópialo aquí.

## Agente de seguimiento

Flujo completo (secciones 2.2 y 17):

1. El backend emite `followup.due`. Comunicaciones lo recibe en `POST /v1/followups/{id}/dispatch` (PROPUESTO, con `COMMS_SERVICE_TOKEN`) o, como respaldo, sondea `GET /v1/followups` cada `FOLLOWUP_POLL_INTERVAL_MS`.
2. `FollowupDispatcher` comprueba permiso de seguimiento, horario permitido (08:00–19:00 hora local por defecto) y, en demo, la lista blanca `DEMO_ALLOWED_NUMBERS`. Fuera de horario, espera.
3. Intentos 1 a 3: llamada saliente con `POST https://api.elevenlabs.io/v1/convai/twilio/outbound-call`, sin grabación, con estas variables dinámicas:

   | Variable | Contenido |
   | --- | --- |
   | `farmer_name` | Nombre del agricultor |
   | `threat_label` | Amenaza en palabras ("roya del café") |
   | `symptoms` | Síntomas reportados, separados por comas |
   | `guidance_given` | Orientación que se dio, o "ninguna" |
   | `followup_id`, `plot_id`, `session_id` | IDs que usan las herramientas; el modelo no los escribe |
   | `attempt_number` | Número de intento |

4. El agente pregunta en orden: cómo sigue la parcela, qué hizo, si funcionó y desde cuándo notó el cambio, y llama una vez a `submit_followup`. Si empeoró, sigue con `assess_observation` y `submit_report` como en una llamada de ayuda.
5. Sin `submit_followup` en `FOLLOWUP_CALL_RESULT_TIMEOUT_MS` (10 min): se registra `no_response` y el backend reprograma el reintento (2 min en demo). Tras 3 llamadas sin respuesta, va un SMS ([`src/sms/followup.ts`](../src/sms/followup.ts)). Tras el SMS sin respuesta, no se insiste. Nunca baja el riesgo por silencio.

### Configuración en ElevenLabs (una vez)

1. **Número:** en *Phone Numbers*, importa el número de Twilio (Account SID + Auth Token). Copia su ID a `ELEVENLABS_AGENT_PHONE_NUMBER_ID`. Comprueba que la cuenta Twilio tiene permisos de llamada saliente al país del agricultor (`+52`).
2. **Agente:** crea un agente nuevo, "Seguimiento café".
   - Idioma: español (`es`); voz con acento de México.
   - *First message*: contenido de [`followup/first_message.txt`](followup/first_message.txt).
   - *System prompt*: contenido de [`followup/prompt.md`](followup/prompt.md).
   - Desactiva la grabación y el guardado de audio (sección 17: sin grabación; transcripciones 30 días).
   - Copia el ID del agente a `ELEVENLABS_FOLLOWUP_AGENT_ID`.
3. **Variables dinámicas:** declara `farmer_name`, `threat_label`, `symptoms`, `guidance_given`, `followup_id`, `plot_id`, `session_id` y `attempt_number` con valores de prueba (el panel los pide para probar el agente sin llamada).
4. **Secreto de las herramientas:** genera un valor aleatorio de al menos 16 caracteres, ponlo en `ELEVENLABS_TOOL_SECRET` y crea en ElevenLabs un *secret* con el texto `Bearer <ese valor>`.
5. **Herramientas:** crea tres *webhook tools* con los datos de [`followup/tools/`](followup/tools/): `submit_followup`, `assess_observation` y `submit_report`.
   - URL: `<PUBLIC_BASE_URL>/v1/tools/...` (la de ngrok o el despliegue).
   - Cabecera `Authorization` desde el secreto del paso 4.
   - Los parámetros con `dynamic_variable` se rellenan desde la variable indicada; no los dejes al modelo.
   - Los JSON siguen el formato de la API de ElevenLabs; si el panel o la API rechazan algún campo, ajusta el JSON aquí y avísanos.
6. **Prueba sin teléfono:** en el panel, prueba el agente con las variables de ejemplo. Con el mock (`npm run mock:backend`) y `followup_id = followup_demo_05`, `plot_id = plot_demo_05` y una sesión ligada, `submit_followup` responde `registered: true`.

### Probar una llamada real

1. `.env`: `ELEVENLABS_API_KEY`, `ELEVENLABS_FOLLOWUP_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID`, `ELEVENLABS_TOOL_SECRET`, `COMMS_SERVICE_TOKEN` y tu celular en `DEMO_ALLOWED_NUMBERS`.
2. En el mock, asocia tu celular a Marta (seguimiento vencido `followup_demo_05`): `MOCK_PHONE_OVERRIDES=contact_demo_05=+52…`.
3. `npm run mock:backend`, `npm run dev` y `ngrok http 8080 --url=<PUBLIC_BASE_URL>`.
4. Dispara el evento (o espera al sondeo, dentro de 08:00–19:00 hora de México):

   ```bash
   curl -X POST "$PUBLIC_BASE_URL/v1/followups/followup_demo_05/dispatch" \
     -H "Authorization: Bearer $COMMS_SERVICE_TOKEN" -H "Content-Type: application/json" \
     -d '{"event_id":"evt_demo_1","schema_version":"2.0","event_type":"followup.due","occurred_at":"2026-10-03T23:00:00Z","aggregate_id":"followup_demo_05","aggregate_version":1,"correlation_id":null,"is_demo":true,"payload":{"followup_id":"followup_demo_05"}}'
   ```

Sin credenciales de ElevenLabs, el despachador usa un stub: registra el intento y no llama a nadie.
