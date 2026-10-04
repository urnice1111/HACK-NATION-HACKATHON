# Asesor agrícola (dev 2)

Servicio Python/FastAPI para `POST /v1/assessments`. Usa el snapshot
`gpt-4.1-mini-2025-04-14`, Function Calling para consultar información interna y
Structured Outputs/Pydantic para la respuesta final.

## Variables del servidor

- `OPENAI_API_KEY`: clave de OpenAI; nunca se expone al navegador.
- `ADVISOR_BACKEND_BASE_URL`: API interna de los devs 3/4; por defecto `http://localhost:8000`.
- `ADVISOR_MODE=mock`: respuesta estable sin OpenAI, útil para integrar voz y backend.

La demo no usa autenticación entre servicios. No exponer `OPENAI_API_KEY` fuera del
proceso del asesor.

## Ejecutar localmente

```sh
.venv/bin/uvicorn advisor.app:app --app-dir advisor/src --reload
.venv/bin/pytest advisor/tests
```

El asesor tiene un máximo de tres consultas internas por turno. Una respuesta de
dependencia caída se entrega al modelo como contexto insuficiente; no se inventa
clima ni una recomendación.
