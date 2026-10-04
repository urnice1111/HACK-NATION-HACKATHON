# Asesor agrícola (dev 2)

Servicio Python/FastAPI para `POST /v1/assessments`. Usa el snapshot
`gpt-4.1-mini-2025-04-14`, Function Calling para consultar información interna y
Structured Outputs/Pydantic para la respuesta final.

Comunicaciones llama siempre al backend (`http://localhost:8000/v1/assessments`).
El asesor corre **en el mismo proceso** y consulta las APIs internas por HTTP
(`ADVISOR_BACKEND_BASE_URL`, por defecto el propio backend). Los `def` síncronos
de FastAPI corren en threadpool, así que esas llamadas no se bloquean.

## Variables del servidor

Definirlas en `.env` en la raíz (ver `.env.example`). `load_dotenv` no pisa
variables ya exportadas. Nunca commitear `.env`.

- `OPENAI_API_KEY`: clave de OpenAI; nunca se expone al navegador.
- `ADVISOR_MODE=openai` (default): asesor real. `mock` para integrar voz sin clave.
- `ADVISOR_BACKEND_BASE_URL`: API interna; por defecto `http://localhost:8000`.
- `ADVISOR_MODEL` (opcional): snapshot de OpenAI.
- `ADVISOR_MAX_TOKENS` (opcional): tope de tokens por llamada; default `700`.

La demo no usa autenticación entre servicios. No exponer `OPENAI_API_KEY` fuera
del proceso del backend/asesor.

## Ejecutar localmente

```sh
# mismo proceso que consume comunicaciones
.venv/bin/uvicorn backend.app.main:app --reload --port 8000

# solo el asesor (pruebas)
.venv/bin/uvicorn advisor.app:app --app-dir advisor/src --reload
.venv/bin/pytest advisor/tests
```

El asesor tiene un máximo de tres consultas internas por turno y un presupuesto
de 5 s. Antes del modelo consulta humedad/lluvia (14 días) y casos resueltos;
`data_used` y las menciones salen de esas respuestas reales, no se inventan.
Una dependencia caída se entrega al modelo como contexto insuficiente. Si
OpenAI o la validación fallan, el puente responde 503 uniforme y no inventa
orientación.

Datos ambientales: `python -m backend.scripts.load_nasa_power --offline` si ya
hay caché en `backend/data/nasa_power/`. Si el loader falla por SSL, descargar
con `curl` las celdas `19.5,-96.875` y `19.0,-96.875` (daily + climatology) y
repetir `--offline`. Contexto curado: `psql "$DATABASE_URL" -f backend/seed/external_context.sql`.

Verificación live (clave en `.env`):

```sh
ADVISOR_MODE=openai ADVISOR_BACKEND_BASE_URL=http://localhost:8000 \
  .venv/bin/uvicorn backend.app.main:app --reload --port 8000
.venv/bin/python advisor/scripts/verify_demo.py
```
