# Agentes de ElevenLabs

Los agentes **viven en la cuenta de ElevenLabs**: se crean y se ajustan en el panel. Comunicaciones solo los referencia por ID (`.env`) y, antes de usarlos, comprueba que estén configurados como el código espera.

| Agente | Para qué | Variable en `.env` | Copia de referencia |
| --- | --- | --- | --- |
| Ayuda (p. ej. "Ayuda café") | Llamadas entrantes al número de Twilio | `ELEVENLABS_HELP_AGENT_ID` | [`help/`](help/) |
| Seguimiento (p. ej. "Seguimiento café") | Llamadas salientes disparadas por `followup.due` | `ELEVENLABS_FOLLOWUP_AGENT_ID` | [`followup/`](followup/) |

```bash
npm run agents:check   # lee los agentes y el número de la cuenta y dice qué falta o está mal
npm run agents:pull    # guarda en agents/ una copia de referencia (prompt, voz, herramientas) para revisarla en git
```

El servidor hace la misma comprobación al arrancar: en demo solo la registra en el log; con `IS_DEMO=false` **no arranca** si un agente está mal configurado (si ElevenLabs no responde, solo avisa).

Qué se comprueba ([`src/elevenlabs/agents.ts`](../src/elevenlabs/agents.ts)): idioma español; sin grabación de audio; las herramientas de cada agente, con la URL de `PUBLIC_BASE_URL`, método POST, la cabecera `Authorization` desde un secreto y solo parámetros que las rutas `/v1/tools/*` aceptan; `session_id` y los IDs desde variables, nunca del modelo; que el prompt solo use variables que comunicaciones envía; la herramienta de sistema para colgar; y que el número contesta con el agente de ayuda y admite salientes. Lo que no se puede leer por API (el valor del secreto) se comprueba con una llamada de prueba.

## Crear todo desde cero

Antes: comunicaciones desplegado con HTTPS fijo (`PUBLIC_BASE_URL`, sin "/" final), un número de Twilio con voz y SMS y permiso de llamar al país de los agricultores (Twilio → Voice → Geo permissions → México), y una clave de API de ElevenLabs con permisos de agentes y números.

### 1. Número

1. ElevenLabs → **Phone Numbers** → **Import number** → Twilio: el número, el Account SID y el Auth Token.
2. Copia su ID (`phnum_…`) a `ELEVENLABS_AGENT_PHONE_NUMBER_ID`.
3. **Importante:** al importarlo, ElevenLabs reescribe los webhooks del número en Twilio (la voz pasa a `https://api.elevenlabs.io/twilio/inbound_call`, que es lo correcto) y también el de SMS. En Twilio → Phone Numbers → el número → *Messaging configuration*, vuelve a poner `<PUBLIC_BASE_URL>/v1/webhooks/twilio/sms` (POST).
4. Si alguien cambia después la voz del número en Twilio, las llamadas entrantes dejan de llegar al agente: hay que re-importar el número (cambia su ID) y repetir el paso 3.

### 2. Secreto de las herramientas

1. Genera un valor aleatorio: `openssl rand -hex 24`. Ponlo en `ELEVENLABS_TOOL_SECRET`.
2. ElevenLabs → **Workspace settings → Secrets → Add secret**: nombre `comms_tool_secret`, valor `Bearer <ese valor>` (con la palabra Bearer y un espacio).

### 3. Herramientas (Agents → Tools → Add tool → Webhook)

Para todas: **Method** POST; **URL** `<PUBLIC_BASE_URL>` + la ruta de la tabla; **Headers**: `Authorization` → *Secret* `comms_tool_secret`; **Body parameters** como en las tablas. "Variable" = el parámetro se llena con esa *dynamic variable* (en el panel: *Value type → Dynamic variable*); el modelo nunca lo escribe. El resto lo llena el modelo con la descripción del JSON de referencia ([`help/tools/`](help/tools/), [`followup/tools/`](followup/tools/)): copia nombre, descripción del tool y de cada parámetro tal cual.

`assess_observation` y `submit_report` existen dos veces (una por agente) porque `session_id` sale de variables distintas: crea dos herramientas separadas.

**Agente de ayuda** — `session_id` ← variable `system__conversation_id` en todas:

| Herramienta | Ruta | Parámetros (obligatorios en negrita) | Timeout |
| --- | --- | --- | --- |
| `resolve_farmer` | `/v1/tools/resolve-farmer` | **`session_id`**; `caller_phone` ← variable `system__caller_id` | 10 s |
| `confirm_farmer` | `/v1/tools/confirm-farmer` | **`session_id`**; **`candidate_number`** (integer) | 10 s |
| `get_plot_context` | `/v1/tools/get-plot-context` | **`session_id`**; `plot_number` (integer) | 10 s |
| `record_consent` | `/v1/tools/record-consent` | **`session_id`**; `reports`, `notifications`, `followup_calls` (boolean) | 10 s |
| `assess_observation` | `/v1/tools/assess-observation` | **`session_id`**; **`user_statement`** (string); `symptoms` (array de string); `answers` (array de objetos: **`need_code`** string, `value` string, `unit` string, **`raw_text`** string, **`unknown`** boolean); `asked_need_codes` (array de string) | 15 s |
| `submit_report` | `/v1/tools/submit-report` | **`session_id`**; **`user_statement`** (string); `symptoms` (array de string); **`completeness`** (enum `partial`, `sufficient`); `assessment_id` (string) | 10 s |

**Agente de seguimiento** — `session_id` ← variable `session_id` en todas:

| Herramienta | Ruta | Parámetros (obligatorios en negrita) | Timeout |
| --- | --- | --- | --- |
| `submit_followup` | `/v1/tools/submit-followup` | **`session_id`**; **`followup_id`** ← variable `followup_id`; `conversation_id` ← variable `system__conversation_id`; **`status_reported`** (enum `worse`, `same`, `improved`, `resolved`, `unknown`); **`user_statement`** (string); `actions_taken` (string); **`action_worked`** (enum `yes`, `no`, `partial`, `unknown`); `change_noticed_days_ago` (integer) | 10 s |
| `assess_observation` | `/v1/tools/assess-observation` | Como en ayuda, más **`plot_id`** ← variable `plot_id` | 15 s |
| `submit_report` | `/v1/tools/submit-report` | Como en ayuda, más `plot_id` ← variable `plot_id` y `conversation_id` ← variable `system__conversation_id` | 10 s |

ElevenLabs exige descripción en cada parámetro que llena el modelo, también en los elementos de los arreglos.

### 4. Agente de ayuda

ElevenLabs → **Agents → New agent → Blank**:

1. Nombre, p. ej. "Ayuda café".
2. **Agent**: idioma *Spanish*; *First message* = [`help/first_message.txt`](help/first_message.txt); *System prompt* = [`help/prompt.md`](help/prompt.md); el LLM que elija el equipo.
3. **Tools**: las seis herramientas de ayuda del paso 3 y la herramienta de sistema **End call**.
4. **Voice**: la voz y el modelo del equipo (hoy, voz `YOq2y2Up4RgXP2HyXjE5` con *V4 Turbo* y *Expressive mode*; ver [`help/agent.json`](help/agent.json)).
5. **Privacy** (sección 17): desactiva la grabación de audio; retención de conversaciones de 30 días.
6. Guarda y copia el ID (`agent_…`) a `ELEVENLABS_HELP_AGENT_ID`.
7. **Phone Numbers** → el número → *Agent*: este agente (contesta las llamadas entrantes).

### 5. Agente de seguimiento

Igual que el de ayuda, con [`followup/first_message.txt`](followup/first_message.txt), [`followup/prompt.md`](followup/prompt.md), sus tres herramientas y **End call**. Además, en **Dynamic variables** declara con valores de prueba (el panel los pide para probar sin llamada): `farmer_name`, `threat_label`, `symptoms`, `guidance_given`, `followup_id`, `plot_id`, `session_id`, `attempt_number`. Son las únicas que envía comunicaciones; el prompt no puede usar otras. Copia el ID a `ELEVENLABS_FOLLOWUP_AGENT_ID`.

### 6. Comprobar y guardar la copia

```bash
npm run agents:check   # debe terminar con "Agentes listos para usarse con este código."
npm run agents:pull    # actualiza agents/; súbelo a git
```

Prueba de punta a punta: llama al número desde un teléfono registrado en el backend (agente de ayuda) y dispara un `followup.due` (agente de seguimiento; ver abajo). Solo `registered: true` en las herramientas confirma que el secreto y el backend funcionan.

### 7. `.env` de producción

| Variable | Valor |
| --- | --- |
| `IS_DEMO` | `false`. Con esto, el servidor exige todo lo de esta tabla y no usa stubs. |
| `PUBLIC_BASE_URL` | Dominio HTTPS fijo del despliegue (el de las herramientas y de los webhooks de Twilio). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Cuenta y número de Twilio (el importado en ElevenLabs). |
| `ELEVENLABS_API_KEY` | Con permisos de agentes y números. |
| `ELEVENLABS_HELP_AGENT_ID`, `ELEVENLABS_FOLLOWUP_AGENT_ID`, `ELEVENLABS_AGENT_PHONE_NUMBER_ID` | Pasos 1, 4 y 5. |
| `ELEVENLABS_TOOL_SECRET` | Paso 2. |
| `COMMS_SERVICE_TOKEN` | Token con el que el backend entrega `followup.due`; compártelo solo con el Integrante 3. |
| `BACKEND_BASE_URL`, `BACKEND_SERVICE_TOKEN`, `ADVISOR_BASE_URL` | Backend y asesor desplegados. |
| `FOLLOWUP_POLL_INTERVAL_MS` | `30000` mientras el backend no entregue `followup.due` por sí mismo. |

`DEMO_ALLOWED_NUMBERS`, `DEMO_IGNORE_ALLOWED_HOURS` y `MOCK_*` son solo de demo.

## Cambiar un agente

Edítalo en el panel → `npm run agents:check` → `npm run agents:pull` → commit. Si el cambio toca una herramienta (parámetros, nombre, URL), `agents:check` dice si el código la acepta; si hace falta un parámetro nuevo, primero hay que añadirlo en `src/tools/voice-tools.ts`.

## Cómo funcionan

### Agente de ayuda (sección 2.1)

La sesión es `system__conversation_id` y el teléfono, `system__caller_id`: el modelo no los escribe. Identidad, parcela y permisos viven en comunicaciones ([`src/tools/voice-tools.ts`](../src/tools/voice-tools.ts)); el modelo solo ve nombres numerados, nunca tokens ni IDs.

| Herramienta | Qué hace |
| --- | --- |
| `resolve_farmer` | Candidatos por caller ID (`POST /v1/contact-resolution`). Solo nombres: "1 Rosa, 2 Marta". |
| `confirm_farmer` | Confirma al candidato que la persona dijo; devuelve sus parcelas numeradas y qué permisos faltan. Si el candidato venció (15 min), pide confirmar de nuevo. |
| `get_plot_context` | Fija una parcela del agricultor confirmado (`GET /v1/plots/{id}/context`) para el resto de la llamada. |
| `record_consent` | Tres permisos separados (`POST /v1/consents`). Número no registrado: vale solo para la llamada. |
| `assess_observation` | Necesidades del asesor u orientación, con la parcela confirmada; máximo 3 rondas y 5 preguntas. |
| `submit_report` | Solo con permiso de guardar; usa la parcela confirmada (o ninguna para un número no registrado). |

Si la llamada se corta sin `submit_report`, tras `VOICE_SESSION_IDLE_MS` (15 min) se guarda lo descrito como `completeness: "partial"`, solo si había permiso.

### Agente de seguimiento (secciones 2.2 y 17)

1. Llega `followup.due` a `POST /v1/followups/{id}/dispatch` (con `COMMS_SERVICE_TOKEN`) o, como respaldo, por el sondeo de `GET /v1/followups`.
2. El despachador exige permiso de seguimiento, horario permitido (08:00–19:00 hora local) y, en demo, la lista blanca `DEMO_ALLOWED_NUMBERS`.
3. Intentos 1 a 3: llamada saliente (`POST /v1/convai/twilio/outbound-call`, sin grabación) con estas variables:

   | Variable | Contenido |
   | --- | --- |
   | `farmer_name` | Nombre del agricultor |
   | `threat_label` | Amenaza en palabras ("roya del café") |
   | `symptoms` | Síntomas reportados, separados por comas |
   | `guidance_given` | Orientación que se dio, o "ninguna" |
   | `followup_id`, `plot_id`, `session_id` | IDs que usan las herramientas |
   | `attempt_number` | Número de intento |

4. El agente pregunta en orden: cómo sigue la parcela, qué hizo, si funcionó y desde cuándo, y llama una vez a `submit_followup`. Si empeoró, sigue con `assess_observation` y `submit_report`.
5. Sin `submit_followup` en `FOLLOWUP_CALL_RESULT_TIMEOUT_MS` (10 min) se registra `no_response` (lo vence el siguiente evento o el barrido de cada minuto) y el backend reprograma el reintento. Tras 3 llamadas sin respuesta, un SMS. Nunca baja el riesgo por silencio.

Disparar una llamada a mano (demo):

```bash
curl -X POST "http://127.0.0.1:8080/v1/followups/<followup_id>/dispatch" \
  -H "Authorization: Bearer $COMMS_SERVICE_TOKEN" -H "Content-Type: application/json" \
  -d '{"event_id":"evt_<único>","schema_version":"2.0","event_type":"followup.due","occurred_at":"2026-10-04T06:00:00Z","aggregate_id":"<followup_id>","aggregate_version":1,"correlation_id":null,"is_demo":true,"payload":{"followup_id":"<followup_id>"}}'
```

Sin credenciales de ElevenLabs (solo en demo), el despachador usa un stub: registra el intento y no llama a nadie.
