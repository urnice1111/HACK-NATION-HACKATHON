# MVP agrícola por voz y SMS: delegación y contratos técnicos

Versión: 2.0 · Fecha: 2026-10-03 · Equipo: cuatro integrantes

## 0. Cambios respecto a la versión 1.0

| Cambio | Qué implica | Integrantes afectados |
| --- | --- | --- |
| Los datasets ambientales (lluvia, humedad, temperatura y demás variables) se cargan como tablas consultables | Nuevo esquema `env` con catálogo de variables y una consulta estructurada que el asesor diseña según el caso | 4 (dueño), 2 (consume), 3 (aristas y características) |
| El asesor decide qué información falta y ElevenLabs formula la pregunta | `assessments` ya no devuelve el texto de la pregunta, sino `information_needs`; el agente de voz convierte cada necesidad en una pregunta natural | 2 y 1 |
| La prioridad de cada nodo sale de una regresión lineal | El integrante 2 entrena el modelo y entrega un artefacto con coeficientes y cortes; el integrante 3 lo aplica en el motor del grafo | 2 y 3 |
| Nueva tabla de casos resueltos | Guarda parcela, amenaza, fecha de solución y solución aplicada; se llena con la llamada de seguimiento y el asesor la consulta durante las llamadas | 3 (dueño), 1 (captura), 2 (consume) |
| La llamada de seguimiento pasa a ser parte central del MVP | En la v1.0 era ampliación; ahora normaliza el grafo y alimenta los casos resueltos. El SMS queda como respaldo | 1 y 3 |
| Bright Data pasa del integrante 2 al 4 | Toda la capa de datos ambientales y externos queda con un solo dueño; el asesor solo lee contexto ya curado | 4 y 2 |

Reparto resultante: integrante 1 comunicaciones, integrante 2 inteligencia (asesor y modelo de riesgo), integrante 3 backend y grafo, integrante 4 datos y dashboard.

## 1. Objetivo y alcance

Permitir que un agricultor reporte un problema por llamada o SMS, reciba preguntas y orientación, y que el sistema use la observación, los datos ambientales y los casos resueltos para priorizar inspecciones y preparar alertas a otras parcelas. El operador administra los casos desde un dashboard con un grafo.

El usuario no instala una aplicación ni necesita datos móviles. Las llamadas y SMS necesitan cobertura; ElevenLabs, Twilio, el backend y las consultas externas necesitan conectividad del lado del servicio. Esta arquitectura no demuestra inferencia offline. El requisito del reto de que la función central opere offline sigue pendiente; no presentar la ausencia de instalación como cumplimiento de ese requisito.

### Incluido en el MVP

- Una región, un idioma de interacción y una amenaza agrícola seleccionada con el asesor.
- Una parcela por agricultor en la demo; el modelo de datos admite más de una.
- Llamadas entrantes, llamadas salientes de seguimiento, SMS entrantes y SMS salientes.
- Asesor que decide qué información falta, la busca primero en los datos y pregunta al agricultor solo lo que no puede consultar o necesita confirmar.
- Datasets ambientales cargados en tablas y consultables por parcela o coordenada y ventana de tiempo.
- Tabla de casos resueltos alimentada por las llamadas de seguimiento y consultable por el asesor.
- Grafo de parcelas con distancia y similitud ambiental.
- Prioridad de inspección `low | medium | high` calculada con una regresión lineal explicable; no es una probabilidad de contagio validada.
- Aprobación humana de alertas colectivas.
- Datos simulados identificados como tales cuando no exista registro real.

### Fuera de alcance inicial

- Predicción epidemiológica calibrada, red neuronal de grafos y diagnóstico confirmado por voz.
- SQL libre generado por el modelo de lenguaje contra la base de datos.
- Modelos de riesgo más complejos que la regresión lineal acordada.
- Recomendaciones libres de productos o dosis sin protocolo agronómico validado, aunque aparezcan en casos resueltos.
- Compras, pagos, contratación o ejecución de tratamientos.
- Scraping abierto de cualquier sitio durante cada llamada.
- Sensores, procesamiento de fotografías de hojas y una aplicación para agricultores.

## 2. Decisiones de arquitectura

| Componente | Decisión propuesta | Responsable |
| --- | --- | --- |
| Telefonía y SMS | Twilio | Integrante 1 |
| Conversación de voz y formulación de preguntas | ElevenLabs Agents conectado a Twilio | Integrante 1 |
| Llamadas de seguimiento | Llamada saliente de ElevenLabs vía Twilio, disparada por la cola | Integrante 1 |
| Asesor agrícola | Servicio con modelo de lenguaje y herramientas internas; decide información faltante, consulta datos y devuelve JSON validado | Integrante 2 |
| Modelo de riesgo | Regresión lineal entrenada fuera de línea; artefacto JSON versionado | Integrante 2 |
| Datos ambientales | Esquema `env` en Supabase cargado desde los datasets, con catálogo y función de consulta de solo lectura | Integrante 4 |
| Contexto externo | Bright Data en segundo plano, con fuentes permitidas y caché | Integrante 4 |
| Persistencia de negocio | PostgreSQL/Supabase, esquema `public`, un único proyecto compartido | Integrante 3 |
| API, grafo y trabajos | Backend HTTP, worker, aplicación del modelo de riesgo | Integrante 3 |
| Casos resueltos | Tabla `case_resolutions` y búsqueda por similitud | Integrante 3 |
| Dashboard | Lovable, conectado a la API | Integrante 4 |

Hay un solo tomador de decisiones sobre la información: el asesor. ElevenLabs no decide qué preguntar ni consulta datos; recibe necesidades estructuradas y las convierte en preguntas naturales. Así el conocimiento agronómico vive en un servicio que se prueba sin teléfono, y el prompt de voz solo se ocupa de cómo hablar con la persona. El canal SMS usa el mismo contrato de evaluación.

La base tiene dos esquemas en el mismo proyecto. `env` contiene datos de referencia (datasets, catálogo, resúmenes, contexto externo); su dueño es el integrante 4 y es de solo lectura para los demás. `public` contiene datos de negocio (agricultores, parcelas, casos, reportes, grafo, alertas, casos resueltos); su dueño es el integrante 3.

No añadir Neo4j, un broker de eventos ni streaming de audio propio al MVP. Una tabla de trabajos con estados, reintentos y bloqueo temporal basta para la cola inicial. El dashboard puede consultar cada cinco segundos; tiempo real es opcional.

Antes de empezar, confirmar acceso a ElevenLabs Agents y al modelo de lenguaje elegido, créditos para llamadas entrantes y salientes, capacidades del número Twilio en el país objetivo, permisos para SMS/llamadas salientes y un backend desplegable con HTTPS. Tener créditos de voz no implica que cualquier función esté habilitada.

### 2.1 Flujo de una llamada de ayuda

1. Twilio recibe la llamada y la conecta con ElevenLabs.
2. El agente de voz identifica al agricultor (`resolve_farmer`) y obtiene el contexto de la parcela (`get_plot_context`), que ya incluye el resumen ambiental reciente.
3. El agricultor describe el problema y el agente de voz lo envía a `assess_observation`.
4. El asesor razona sobre la observación y decide qué información falta. Para cada dato elige la fuente:
   - Si está en los datasets, diseña una consulta estructurada a `env_query` y la ejecuta.
   - Si puede haber antecedentes útiles, busca casos resueltos similares.
   - Si solo el agricultor lo sabe (síntomas, qué ha hecho, lo que percibe en su parcela), lo devuelve en `information_needs`.
5. El agente de voz convierte cada necesidad en una pregunta natural (por ejemplo, de "humedad y lluvia recientes en la parcela" a "¿y cómo ha estado el clima por allá estos días?"), recoge la respuesta y vuelve a llamar a `assess_observation`.
6. Cuando hay suficiente información, el asesor devuelve `disposition: advise` con recomendaciones y, si aplica, menciones de casos resueltos parecidos. El agente de voz las comunica.
7. El agente de voz guarda el reporte (`submit_report`). El backend recalcula la prioridad con la regresión, actualiza el grafo y propone alertas.
8. Si la parcela queda en prioridad media o alta, o tiene un caso activo, el backend programa una llamada de seguimiento.

### 2.2 Flujo de seguimiento

1. El scheduler emite `followup.due`.
2. El integrante 1 inicia una llamada saliente con un agente de seguimiento que recibe el resumen del caso como variables dinámicas.
3. El agente pregunta cómo sigue la parcela, qué hizo el agricultor y si funcionó.
4. `submit_followup` guarda la evolución. Si el agricultor reporta que se resolvió, el backend crea un registro en `case_resolutions`.
5. El backend recalcula. Un caso resuelto deja de ser caso fuente y sus vecinos se recalculan.
6. Sin respuesta: reintentos limitados y luego SMS. Nunca bajar el riesgo por falta de respuesta.

## 3. Propiedad y coordinación

| Integrante | Es dueño de | No modifica sin acuerdo |
| --- | --- | --- |
| 1: comunicaciones | Twilio/ElevenLabs, prompts de voz, formulación de preguntas, llamadas de seguimiento, entrega de mensajes | Lógica del asesor, reglas de riesgo, esquemas |
| 2: inteligencia | Asesor, catálogo de necesidades, diseño de consultas, uso de casos resueltos, modelo de regresión y cortes | Envío de mensajes, esquemas, aplicación del modelo en el grafo |
| 3: backend y grafo | Esquema `public`, API, casos, casos resueltos, grafo, aplicación del modelo, alertas, cola, seguimientos programados | Prompts, entrenamiento del modelo, esquema `env`, UI |
| 4: datos y dashboard | Esquema `env`, carga de datasets, catálogo, `env_query`, resúmenes ambientales, Bright Data, dashboard | Esquema `public`, cálculo de riesgo, credenciales |

El integrante 3 es responsable de integración. Cada integrante conserva la responsabilidad de corregir su módulo durante la integración. El integrante 4 no debe permitir que Lovable altere las tablas o funciones compartidas sin revisión del dueño del esquema.

Las únicas costuras entre integrantes son estos contratos; cada uno se puede simular con un mock desde el primer día:

| Contrato | Productor | Consumidor | Mock inicial |
| --- | --- | --- | --- |
| `assessments` con `information_needs` | 2 | 1 | Respuesta fija con dos necesidades |
| `env_query` y catálogo | 4 | 2 y 3 | Fixtures de 8 parcelas y 90 días |
| Artefacto del modelo de riesgo | 2 | 3 | Coeficientes puestos a mano con el mismo formato |
| Búsqueda de casos resueltos | 3 | 2 | Tres resoluciones de ejemplo |
| `followups` y `submit_followup` | 3 | 1 | Seguimiento de fixture vencido |

Primera reunión, 45–60 minutos:

1. Asignar nombres a los cuatro roles.
2. Elegir amenaza, idioma, backend y modelo de lenguaje.
3. Revisar juntos los datasets: variables, unidades, cobertura de la región y huecos.
4. Elegir la variable objetivo de la regresión (ver sección 17).
5. Acordar los contratos de este documento, el catálogo inicial de necesidades y ejemplos compartidos.
6. Crear IDs de ejemplo, datos simulados y respuestas mock.
7. Configurar repositorio, ramas, secretos y URL base de desarrollo.
8. Fijar hora de primera integración; no esperar a terminar todas las funciones.

## 4. Integrante 1: comunicaciones

### Tareas en orden

- [ ] Configurar número y verificar una llamada/SMS real en los teléfonos de prueba.
- [ ] Conectar Twilio y ElevenLabs para llamadas entrantes y salientes.
- [ ] Resolver contacto y pedir confirmación de identidad/parcela cuando corresponda.
- [ ] Capturar consentimiento para reportes, avisos y llamadas de seguimiento; no grabar por defecto sin consentimiento y decisión explícita.
- [ ] Escribir el prompt del agente de ayuda: formular preguntas a partir de `information_needs`, comunicar recomendaciones y límites, nunca decidir ni comprar nada por el agricultor.
- [ ] Conectar `assess_observation` primero con el mock del integrante 2 y después con el servicio real.
- [ ] Enviar el reporte al backend antes de colgar cuando haya información suficiente.
- [ ] Procesar webhook posterior para conciliar estado, resumen y referencias.
- [ ] Crear el agente de seguimiento y la llamada saliente disparada por `followup.due`.
- [ ] Capturar en el seguimiento: estado de la parcela, acción realizada, si funcionó y desde cuándo.
- [ ] SMS: entrada de reportes, salida de alertas aprobadas y respaldo de seguimientos sin respuesta.
- [ ] Implementar envío desde cola, estados de entrega y reintentos limitados.

### Formulación de preguntas

El asesor no escribe la pregunta; devuelve necesidades estructuradas (sección 10.1). El agente de voz las convierte en lenguaje cotidiano con estas reglas:

- Una pregunta por turno, empezando por la necesidad de mayor `priority`.
- Usar `farmer_hint` para traducir variables técnicas a algo observable. Nunca preguntar "¿cuál es la conductividad eléctrica?" si el asesor indica que el agricultor puede responder "¿se le hacen costras blancas a la tierra?".
- Respetar `answer_type` para normalizar la respuesta: sí/no, número con unidad, opción o texto libre.
- Aceptar "no sé" y enviarlo como desconocido (`null`), nunca como cero.
- No repetir una necesidad ya respondida en la sesión; enviar `asked_need_codes` en cada evaluación.
- Respetar el máximo de preguntas por llamada configurado. Si se alcanza, comunicar la orientación disponible o la derivación.
- En SMS, usar una plantilla breve por `need_code` o el mismo modelo de lenguaje con un prompt corto.

### Herramientas expuestas al agente de voz

| Herramienta | Uso |
| --- | --- |
| `resolve_farmer` | Localizar candidatos por teléfono; confirmar antes de acceder a información individual. |
| `get_plot_context` | Consultar la parcela identificada, casos activos y resumen ambiental. |
| `assess_observation` | Enviar observación y respuestas; recibir necesidades de información u orientación. |
| `submit_report` | Guardar observación confirmada por el usuario. |
| `submit_followup` | Registrar evolución de un caso existente y, si aplica, la solución aplicada. |

El agente de voz no llama directamente a `env_query` ni a la búsqueda de casos resueltos; lo hace el asesor dentro de `assess_observation`. Las herramientas llaman al backend con credenciales de servicio. El agente no recibe claves de Twilio, Supabase ni Bright Data.

### Agente de seguimiento

Recibe como variables dinámicas el nombre del agricultor, la amenaza, los síntomas reportados y la orientación que se dio. Pregunta, en este orden: cómo sigue la parcela, qué hizo, si funcionó y desde cuándo notó el cambio. Envía todo en una sola llamada a `submit_followup`. No da orientación nueva; si la situación empeoró, llama a `assess_observation` como en una llamada de ayuda.

### Manejo de fallos

- Si falla o tarda el asesor: informar que no se pudo completar la evaluación, conservar el reporte como incompleto y avisar que habrá seguimiento; no inventar orientación.
- Si falla el guardado: no decir que el caso quedó registrado; reintentar con la misma clave.
- Si se corta la llamada: guardar solo observaciones recibidas, marcando incompleto.
- Un número desconocido inicia registro mínimo o derivación; nunca selecciona una parcela al azar.
- Un número compartido puede devolver varios candidatos; sus datos personales no se leen antes de confirmación.
- Seguimiento sin respuesta: registrar `no_response`, reintentar dentro del límite y pasar a SMS.

### Entregable y aceptación

Adaptador desplegado y configuración documentada. Una llamada real con el asesor mock que devuelve dos necesidades: el agente las formula como preguntas naturales y envía las respuestas. Una llamada saliente de seguimiento sobre un caso de fixture registra la solución aplicada. Un SMS genera un reporte y un mensaje de salida conserva la referencia del proveedor. Repetir un webhook no crea otro reporte. Un estado `delivered` no se presenta como leído o atendido.

## 5. Integrante 2: inteligencia (asesor y modelo de riesgo)

El integrante 2 tiene dos productos independientes entre sí: el asesor que se usa durante las llamadas y el modelo de regresión que usa el grafo. Pueden avanzar en paralelo.

### 5.1 Asesor: tareas en orden

- [ ] Convertir la entrevista agrícola en catálogo de amenazas, síntomas, señales de alarma, límites y protocolos de orientación.
- [ ] Crear el catálogo de necesidades (`need_code`): qué variable es, por qué importa, `farmer_hint`, tipo de respuesta y si puede consultarse en datos.
- [ ] Crear servicio `/v1/assessments` con JSON validado y herramientas internas: catálogo ambiental, `env_query`, búsqueda de casos resueltos y contexto externo.
- [ ] Implementar la regla "consultar antes de preguntar".
- [ ] Usar casos resueltos en la orientación con las restricciones de abajo.
- [ ] Definir límite de consultas internas por turno, tiempo máximo y respuesta de degradación.
- [ ] Normalizar mediciones; conservar texto original, unidad, muestra y fecha.
- [ ] Probar con fixtures sin telefonía: casos típicos, ambiguos y fuera de alcance.

### Cómo decide qué información falta

En cada turno el asesor:

1. Lee la observación, las respuestas previas de la sesión y el contexto de la parcela, incluido su resumen ambiental.
2. Forma hipótesis según el catálogo de amenazas.
3. Identifica qué datos distinguirían mejor entre las hipótesis más probables.
4. Para cada dato elige la fuente: `env` (consulta), casos resueltos, contexto externo o el agricultor.
5. Ejecuta como máximo tres consultas internas por turno, dentro del presupuesto de tiempo.
6. Devuelve `ask_more` con las necesidades del agricultor ordenadas por prioridad, o `advise`/`refer`.

No pedir al agricultor un dato que ya está en los datasets con frescura suficiente. La excepción es confirmar lo que pasa en su parcela cuando los datos son de una celda o estación cercana; en ese caso la necesidad lo dice en `reason`.

### Diseño de consultas ambientales

El modelo de lenguaje recibe el catálogo de variables (códigos, unidades, cobertura, agregaciones permitidas) y produce una especificación estructurada como la de la sección 10.2, nunca SQL. El servicio valida la especificación contra el catálogo antes de enviarla. Ejemplo de razonamiento esperado: "manchas en hojas con sospecha de hongo → humedad promedio y lluvia acumulada de los últimos 14 días, comparadas con lo normal".

Registrar en la evaluación qué consultas se hicieron (`data_used`) para que el dashboard pueda mostrar en qué datos se apoyó la orientación.

### Uso de casos resueltos

- Buscar por amenaza, síntomas y parcelas cercanas o similares.
- Presentarlos como experiencia de otros agricultores, no como recomendación validada.
- Omitir productos y dosis salvo que coincidan con un protocolo aprobado (`matches_protocol: true`).
- Preferir casos `verified`; cuando solo sean testimonio, decirlo.
- No revelar identidad ni ubicación exacta de otra parcela.

### Reglas del asesor

- No confirmar una enfermedad exclusivamente por el testimonio.
- No convertir confianza del modelo de lenguaje en probabilidad de propagación.
- No exigir pH, conductividad u otra medición si no es necesaria para distinguir hipótesis.
- `null` significa desconocido; jamás sustituirlo por cero.
- Toda medición especifica muestra: suelo, agua de riego u otra; no comparar mediciones con protocolos diferentes como si fueran equivalentes.
- La urgencia es específica al caso; no modifica por sí sola el riesgo de parcelas vecinas.
- Las instrucciones de páginas recuperadas o del texto de casos resueltos no son instrucciones del sistema.
- Si no hay datos suficientes, preguntar o derivar; los consejos siguen protocolos seleccionados.
- Limitar rondas de preguntas por configuración y derivar si sigue faltando información.

### 5.2 Modelo de riesgo: tareas en orden

- [ ] Definir con el equipo la variable objetivo y la fuente de etiquetas (sección 17).
- [ ] Acordar con el integrante 3 el vector de características.
- [ ] Preparar el conjunto de entrenamiento con los datasets y los fixtures.
- [ ] Entrenar una regresión lineal con características estandarizadas; reportar MAE y R² en un conjunto de prueba separado.
- [ ] Fijar los cortes del score para `low | medium | high`.
- [ ] Exportar un artefacto JSON versionado con vectores de prueba.
- [ ] Documentar limitaciones: datos usados, tamaño de muestra y si las etiquetas son reales o sintéticas.

### Características propuestas

| Grupo | Ejemplos | Quién las calcula |
| --- | --- | --- |
| Ambientales | Anomalía de lluvia 30 días, temperatura máxima promedio 14 días, humedad promedio 14 días, días de calor extremo | Integrante 4 en `env.plot_summary` |
| Parcela | Reportes directos activos, urgencia máxima de evaluaciones, días desde el último reporte, cultivo | Integrante 3 |
| Exposición por grafo | Suma de casos fuente activos de vecinos ponderada por `exposure_strength`, distancia al caso fuente más cercano | Integrante 3 |
| Historia | Casos resueltos en la parcela en los últimos N días | Integrante 3 |

Las características de exposición usan los casos fuente de los vecinos, nunca la prioridad calculada del vecino. Así se evita que una alerta se vuelva evidencia y recircule por el grafo.

### Artefacto del modelo

El integrante 2 no despliega un servicio de inferencia. Entrega un JSON con todo lo necesario para calcular el score, y el integrante 3 lo aplica con una suma ponderada. Esto elimina una dependencia en tiempo de ejecución.

```json
{
  "model_id": "risk_linear",
  "model_version": "1.0.0",
  "threat_code": "demo_threat",
  "target": "descripción de la variable objetivo",
  "trained_at": "2026-10-03T20:00:00Z",
  "features": [
    {"name": "rain_anomaly_30d", "mean": 1.0, "std": 0.45, "coef": 0.12, "required": true},
    {"name": "humidity_mean_14d", "mean": 65.0, "std": 9.0, "coef": 0.08, "required": true},
    {"name": "neighbor_source_exposure", "mean": 0.3, "std": 0.4, "coef": 0.21, "required": true},
    {"name": "direct_active_reports", "mean": 0.2, "std": 0.5, "coef": 0.25, "required": true}
  ],
  "intercept": 0.31,
  "score_range": [0, 1],
  "cutoffs": {"medium": 0.4, "high": 0.7},
  "metrics": {"mae": null, "r2": null, "n_train": null, "n_test": null},
  "labels_are_synthetic": true,
  "heuristic": true,
  "test_vectors": [
    {"input": {"rain_anomaly_30d": 1.8, "humidity_mean_14d": 80.0, "neighbor_source_exposure": 1.0, "direct_active_reports": 0}, "expected_score": null, "expected_priority": null}
  ]
}
```

Aplicación: `score = intercept + Σ coef × (x − mean) / std`, recortado a `score_range` y comparado con `cutoffs`. Si falta una característica `required`, la prioridad es `unknown`. La explicación son las tres contribuciones `coef × valor estandarizado` de mayor magnitud. Los valores numéricos del ejemplo son ilustrativos.

Una regresión lineal con cortes es válida para el MVP. Si la variable objetivo resulta ser una categoría y no un número, una regresión logística u ordinal encaja mejor; el formato del artefacto se mantiene.

### Entregable y aceptación

Asesor que funciona con fixtures sin telefonía y devuelve JSON válido en: un caso típico, uno insuficiente, uno fuera de alcance, uno que consulta `env` en vez de preguntar y uno que menciona un caso resuelto. Cada recomendación identifica protocolo o fuente. Una caída de `env` o del contexto externo no bloquea la evaluación; declara contexto insuficiente. Artefacto del modelo con métricas y vectores de prueba. Registrar modelo de lenguaje, versión de protocolo y versión del modelo de riesgo.

## 6. Integrante 3: backend, grafo y trabajos

### Tareas en orden

- [ ] Crear esquema `public` y datos de prueba; publicar contratos antes de completar el motor.
- [ ] Implementar API con validación, autenticación y errores uniformes.
- [ ] Guardar reportes de manera idempotente y mantener observaciones inmutables.
- [ ] Mantener casos para agrupar reportes del mismo episodio.
- [ ] Construir aristas con distancia y similitud ambiental, leyendo `env.plot_summary`.
- [ ] Calcular el vector de características por parcela y amenaza.
- [ ] Aplicar el artefacto del modelo de riesgo; verificar los vectores de prueba antes de activar una versión.
- [ ] Crear eventos y propuestas de alerta en una transacción/outbox.
- [ ] Implementar aprobación, deduplicación y cola de notificaciones.
- [ ] Programar seguimientos y procesar sus respuestas.
- [ ] Crear `case_resolutions` y el endpoint de búsqueda de casos resueltos.
- [ ] Exponer grafo, detalle, historial y casos resueltos al dashboard.

### Grafo y prioridad

Nodo = parcela. Arista = relación entre parcelas. La similitud ambiental puede ser simétrica; una exposición específica puede ser direccional. Guardar `distance_km`, `environment_similarity`, `exposure_type`, `threat_code`, `exposure_strength`, `rule_version` y `missing_features`.

La prioridad de inspección la calcula el artefacto del modelo de regresión del integrante 2. El backend arma el vector de características, aplica el artefacto activo, guarda score, contribuciones y versión, y deriva `inspection_priority`. Hasta que exista el artefacto real se usa uno con coeficientes puestos a mano en el mismo formato, marcado `heuristic: true`. La API devuelve `heuristic: true` mientras no exista validación predictiva.

Los radios y pesos de las aristas se definen con la información del asesor. Para la demo pueden ser configuraciones hipotéticas explícitamente etiquetadas.

Cada parcela tiene tres indicadores distintos:

- `inspection_priority`: `unknown | low | medium | high`.
- `local_case_status`: `none | reported | suspected | confirmed | monitoring | resolved`.
- `data_freshness`: `fresh | stale | unknown`.

Cada amenaza tiene su evaluación propia. Para la demo, la prioridad agregada del nodo es la mayor prioridad activa conocida; si no existe evidencia evaluable, es `unknown`. La frescura y la explicación permanecen visibles, incluso con prioridad alta.

Recalcular cuando ocurra cualquiera de estos eventos: reporte nuevo evaluado, seguimiento respondido, caso resuelto o reabierto, resumen ambiental actualizado y nueva versión del modelo.

### Reglas de seguimiento

- Programar al abrir un caso o cuando una parcela pase a `medium` o `high`. El intervalo es configurable: minutos en demo, días en uso real.
- Sin respuesta: registrar `no_response`; no disminuir riesgo por falta de información.
- Mejoría: añadir evidencia y programar otro seguimiento.
- Resuelto según el agricultor: crear `case_resolutions` con `verification: farmer_reported`, pasar el caso a `resolved` y dejar de usarlo como caso fuente. Un agrónomo puede marcarlo `verified` o reabrirlo.
- Persistencia o empeoramiento: recalcular prioridad y proponer revisión.
- Resolver un caso no borra reportes independientes de otras parcelas.

### Casos resueltos

`case_resolutions` relaciona un nodo con la fecha de solución y la solución aplicada. Se crea únicamente desde un seguimiento con `status_reported: resolved` o por acción de un agrónomo. La búsqueda (sección 10.3) ordena por misma amenaza, coincidencia de síntomas y peso de arista o distancia, y nunca devuelve datos personales ni ubicación exacta de otra parcela.

Para cada resolución, el integrante 2 puede proporcionar `solution_codes` normalizados y `matches_protocol`; si aún no existen, se guardan como `null` y el texto original se conserva.

### Entregable y aceptación

Backend desplegado con fixtures. Un reporte afecta solo los vecinos previstos; repeticiones no duplican alertas; cada cambio de prioridad guarda score, contribuciones, versión del modelo e IDs de evidencia. El artefacto activo reproduce sus vectores de prueba. Procesar aprobación no envía dos veces. Un seguimiento sin respuesta conserva incertidumbre. Un seguimiento resuelto crea una sola resolución y baja la exposición de los vecinos. Una actualización antigua no sobrescribe un estado más reciente.

## 7. Integrante 4: datos y dashboard

### 7.1 Datos: tareas en orden

- [ ] Inventariar los datasets: variables, unidades, resolución espacial y temporal, cobertura y huecos.
- [ ] Diseñar el esquema `env` y cargar los datos con un script reproducible.
- [ ] Mapear cada parcela a la celda o estación más cercana.
- [ ] Calcular normales (climatología) para poder expresar anomalías.
- [ ] Publicar el catálogo de variables.
- [ ] Implementar `env_query` como función de solo lectura que recibe la especificación estructurada.
- [ ] Precalcular `env.plot_summary` una vez al día y emitir `env.summary_refreshed`.
- [ ] Bright Data en segundo plano hacia `env.external_context`, solo con fuentes aprobadas por el integrante 2.
- [ ] Imágenes: si son satelitales, extraer un índice por celda y fecha como variable más; si son fotos de plantas, quedan fuera del MVP.

### Tablas del esquema `env`

| Tabla | Campos mínimos | Uso |
| --- | --- | --- |
| `env.datasets` | `dataset_id`, `name`, `source`, `license`, `loaded_at`, `is_demo` | Trazabilidad |
| `env.grid_cells` | `cell_id`, `latitude`, `longitude`, `dataset_id` | Ubicación de cada serie |
| `env.daily_observations` | `cell_id`, `date`, `variable_code`, `value`, `dataset_id` | Datos crudos en formato largo |
| `env.climatology` | `cell_id`, `variable_code`, `month`, `mean`, `std` | Normales para anomalías |
| `env.variable_catalog` | `variable_code`, `label`, `unit`, `description`, `temporal_resolution`, `coverage_start`, `coverage_end`, `allowed_aggregations` | Lo que el asesor puede pedir |
| `env.plot_cell_map` | `plot_id`, `cell_id`, `distance_km` | Parcela → celda más cercana |
| `env.plot_summary` | `plot_id`, `computed_at`, `features`, `data_freshness` | Resumen precalculado para contexto, aristas y modelo |
| `env.external_context` | `source_id`, `url`, `title`, `retrieved_at`, `valid_until`, `region`, `data_type`, `content`, `quality_status` | Contexto de Bright Data |

El formato largo de `daily_observations` permite que el asesor consulte cualquier variable del catálogo sin agregar columnas. Agregar un dataset nuevo solo requiere cargarlo y registrar sus variables.

`quality_status`: `reviewed | unreviewed | rejected`. Solo contexto permitido para el tipo de respuesta puede alimentar orientación. Datos meteorológicos oficiales por API son preferibles a scrapear páginas; Bright Data sirve para fuentes que realmente requieren extracción. No ejecutar descargas lentas durante una llamada.

### 7.2 Dashboard: tareas en orden

- [ ] Construir UI con datos mock compatibles con `/v1/graph`.
- [ ] Crear acceso de operador y estados de carga/error/vacío.
- [ ] Mostrar grafo y leyenda; usar etiquetas además de colores.
- [ ] Mostrar detalle de parcela y amenaza al seleccionar un nodo, con score, contribuciones principales y versión del modelo.
- [ ] Separar reportes directos de priorización por exposición/similitud.
- [ ] Mostrar historial, última observación, datos ambientales consultados y frescura de evidencia.
- [ ] Construir cola de alertas con aprobar/rechazar.
- [ ] Mostrar llamadas de seguimiento: programadas, en curso, respondidas y sin respuesta.
- [ ] Mostrar casos resueltos con su verificación.
- [ ] Cambiar adaptador mock por API sin rediseñar componentes.
- [ ] Añadir modo demo con aviso permanente y botón de reinicio restringido.

### Pantallas mínimas

1. Vista general: grafo, filtros por amenaza/prioridad y contadores.
2. Parcela: contexto, reportes, evaluaciones, datos usados por el asesor y razones de prioridad.
3. Alertas: propuestas, aprobación, destinatarios y estado de entrega.
4. Seguimientos: vencidos, programados, en curso, respondidos y sin respuesta.
5. Casos resueltos: parcela, amenaza, fecha, solución reportada y verificación.

El frontend nunca llama directamente a proveedores con claves privadas ni calcula el riesgo. Las llamadas de prueba van a contactos habilitados; el modo demo no envía a números arbitrarios.

### Entregable y aceptación

Datasets cargados con catálogo; `env_query` responde a una especificación válida y rechaza una variable inexistente. Una parcela fuera de cobertura devuelve valores `null` con cobertura cero. Panel operable con fixtures, sin backend terminado. Un nodo muestra su explicación y los reportes asociados. Una alerta solo se aprueba una vez. Una pérdida de conexión conserva el último estado mostrando que está desactualizado. Datos simulados y reales están identificados.

## 8. Convenciones comunes de contratos v2

- Prefijo HTTP: `/v1` (la ruta no cambia; los cuerpos llevan `schema_version: "2.0"`). JSON UTF-8; nombres `snake_case`.
- IDs opacos de texto generados por backend; UUID recomendado. Los ejemplos legibles no son IDs de producción.
- Fechas ISO 8601 UTC; zona local guardada por agricultor para horarios.
- Teléfonos E.164. Coordenadas WGS84: latitud [-90,90], longitud [-180,180].
- Similitudes y scores en [0,1]; no expresarlos como porcentaje de infección.
- Variables ambientales siempre con unidad explícita.
- Campos obligatorios explícitos; opcionales desconocidos como `null` o listas vacías según contrato.
- `observed_at` puede ser `null` si no se conoce; `received_at` lo fija el servidor. No inventar precisión temporal.
- Incluir `is_demo` en registros y eventos; demo y producción no se mezclan.
- Escrituras externas llevan `Idempotency-Key`; misma clave y mismo cuerpo devuelven el resultado original. Misma clave con otro cuerpo devuelve 409.
- Cambios de revisión llevan `expected_version`; conflicto devuelve 409.
- Cada solicitud incluye o recibe `request_id`; una sesión conserva `correlation_id`.
- Los contratos se validan con un esquema compartido; no confiar en JSON producido por el modelo de lenguaje.

### Error uniforme

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "variables[0].code no existe en el catálogo",
    "retryable": false,
    "request_id": "req_demo_01",
    "details": [{"field": "variables[0].code", "reason": "unknown_variable"}]
  }
}
```

Códigos HTTP: 400 JSON inválido; 401 credenciales ausentes/inválidas; 403 acceso denegado; 404 recurso inexistente; 409 conflicto; 422 campos inválidos; 429 límite; 503 dependencia temporalmente indisponible. No incluir claves, teléfonos completos o transcripciones en errores públicos.

## 9. Modelos de datos

Todos los objetos almacenados incluyen `id`, `created_at`, `is_demo`. Los editables incluyen `updated_at`, `version`. Las tablas del esquema `env` están en la sección 7.1.

| Modelo | Campos específicos mínimos |
| --- | --- |
| Farmer | `name`, `preferred_language`, `timezone`, `contact_id` |
| Contact | `phone_e164`, `is_shared`, `notification_consent`, `followup_call_consent`, `consent_at`, `allowed_hours` |
| Plot | `farmer_id`, `name`, `latitude`, `longitude`, `crop`, `variety`, `altitude_m` |
| Case | `plot_id`, `threat_code`, `status`, `opened_at`, `last_observation_at`, `closed_at` |
| Report | `case_id`, `plot_id`, `session_id`, `channel`, `observed_at`, `received_at`, `symptoms`, `measurements`, `user_statement`, `completeness`, `provider_reference` |
| Assessment | `report_id`, `disposition`, `suspected_issue`, `evidence_quality`, `urgency`, `information_needs`, `data_used`, `resolved_case_ids`, `recommendations`, `human_review_required`, `source_ids`, `model_version`, `protocol_version` |
| RiskModel | `threat_code`, `model_version`, `artifact`, `status`, `activated_at` |
| RiskEvaluation | `plot_id`, `threat_code`, `score`, `inspection_priority`, `feature_vector`, `contributions`, `reasons`, `evidence_report_ids`, `source_case_ids`, `model_version`, `heuristic`, `data_freshness`, `expires_at` |
| CaseResolution | `case_id`, `plot_id`, `threat_code`, `symptoms`, `resolved_at`, `solution_statement`, `solution_codes`, `matches_protocol`, `outcome`, `verification`, `followup_id`, `verified_by` |
| Alert | `plot_id`, `threat_code`, `risk_evaluation_id`, `status`, `message`, `dedup_key`, `approved_by`, `approved_at` |
| Notification | `alert_id`, `followup_id`, `contact_id`, `channel`, `status`, `provider_reference`, `attempt_count`, `last_error` |
| FollowUp | `case_id`, `due_at`, `status`, `channel`, `attempt_count`, `questionnaire_version`, `call_reference`, `response_report_id` |
| OutboxEvent | `event_id`, `event_type`, `payload`, `published_at`, `attempt_count` |

`CaseResolution.verification`: `farmer_reported | verified | disputed`. `outcome`: `resolved | improved_enough`. `RiskModel.status`: `draft | active | retired`; solo hay un modelo activo por amenaza.

`Notification.alert_id` y `followup_id` son alternativos; puede haber además un motivo `advisory_response` vinculado a reporte para responder al agricultor original.

`measurements[]`: `name`, `value`, `unit`, `sample_type`, `measured_at`, `method`, `source`. `source`: `farmer_reported | sensor | technician`. Una medición autodeclarada no se convierte automáticamente en verificada.

## 10. Contratos HTTP

| Método y ruta | Dueño | Entrada | Resultado |
| --- | --- | --- | --- |
| POST `/v1/contact-resolution` | 3; consume 1 | Teléfono y sesión | Candidatos mínimos; se requiere confirmación |
| GET `/v1/plots/{plot_id}/context` | 3; consume 1 | ID y autorización | Contexto, casos activos y resumen ambiental |
| POST `/v1/assessments` | 2; consume 1 | Observación, contexto y respuestas | Necesidades de información u orientación |
| GET `/v1/environment/catalog` | 4; consume 2 | Ninguna | Variables disponibles, unidades y cobertura |
| POST `/v1/environment/query` | 4; consume 2 | Especificación estructurada | Valores agregados, normales y cobertura |
| GET `/v1/plots/{plot_id}/environment-summary` | 4; consume 1, 2 y 3 | ID | Resumen precalculado |
| GET `/v1/external-context?region=…&threat_code=…` | 4; consume 2 | Región y amenaza | Contexto curado vigente |
| POST `/v1/resolved-cases/search` | 3; consume 2 | Amenaza, síntomas, parcela de referencia | Resoluciones similares sin datos personales |
| POST `/v1/risk-models` | 3; publica 2 | Artefacto | Modelo en `draft` tras validar vectores de prueba |
| POST `/v1/risk-models/{id}/activate` | 3; invoca 2 | Versión | Modelo activo y recálculo programado |
| POST `/v1/reports` | 3; consume 1 | Reporte y evaluación opcional | 201 guardado + procesamiento pendiente |
| GET `/v1/reports/{report_id}` | 3 | ID | Caso, evaluación y estado de procesamiento |
| GET `/v1/graph?threat_code=…` | 3; consume 4 | Amenaza y filtros | Nodos, aristas y versión |
| GET `/v1/plots/{plot_id}/timeline` | 3; consume 4 | ID | Historial paginado |
| GET `/v1/resolved-cases?plot_id=…` | 3; consume 4 | Filtros y cursor | Resoluciones paginadas para el panel |
| GET `/v1/alerts?status=pending_review` | 3; consume 4 | Estado y cursor | Alertas paginadas |
| POST `/v1/alerts/{id}/review` | 3; consume 4 | Aprobar/rechazar, versión, motivo | Estado actualizado y envío en cola |
| GET `/v1/followups?status=…` | 3; consume 1 y 4 | Estado | Seguimientos con resumen del caso |
| POST `/v1/followups/{id}/responses` | 3; consume 1 | Evolución y solución aplicada | Reporte guardado, resolución si aplica |
| POST `/v1/notifications/{id}/dispatch` | 1; invoca worker | Notificación autorizada | Aceptación o fallo del proveedor |
| POST `/v1/webhooks/twilio/sms` | 1 | Payload nativo firmado | Respuesta exigida por proveedor |
| POST `/v1/webhooks/twilio/status` | 1 | Callback nativo firmado | Registro idempotente |
| POST `/v1/webhooks/elevenlabs/post-call` | 1 | Payload nativo verificado | Conciliación sin duplicados |

La tabla define contratos internos propuestos, no las rutas oficiales de los proveedores. Los adaptadores traducen sus payloads reales. Aplicar las verificaciones exigidas por cada proveedor; los webhooks no usan el token de operador.

Para resolución de contacto, devolver un `candidate_token` opaco y etiqueta mínima; habilitar datos individuales solo al confirmar. El número llamante no es prueba suficiente de identidad.

### 10.1 Evaluar una observación

Solicitud a `POST /v1/assessments`:

```json
{
  "schema_version": "2.0",
  "session_id": "session_demo_01",
  "plot_id": "plot_demo_01",
  "language": "es",
  "observation": {
    "observed_at": null,
    "symptoms": ["manchas en hojas"],
    "user_statement": "Desde ayer veo manchas en varias plantas",
    "measurements": [],
    "answers": [],
    "completeness": "partial"
  },
  "asked_need_codes": [],
  "plot_context": {"crop": "coffee", "variety": null},
  "is_demo": true
}
```

Cada elemento de `answers`: `{need_code, value, unit, raw_text, unknown}`. `unknown: true` cuando el agricultor no sabe.

Respuesta 200 cuando falta información:

```json
{
  "schema_version": "2.0",
  "assessment_id": "assessment_demo_01",
  "disposition": "ask_more",
  "suspected_issue": null,
  "evidence_quality": "insufficient",
  "urgency": "unknown",
  "information_needs": [
    {
      "need_code": "local_weather_perception",
      "variable": "Lluvia y humedad recientes en la parcela",
      "reason": "Los datos de la zona muestran humedad por encima de lo normal; confirmar si en la parcela también",
      "farmer_hint": "Preguntar cómo ha estado el clima estos días: si ha llovido, si ha estado nublado o húmedo",
      "answer_type": "free_text",
      "options": null,
      "priority": 1,
      "can_be_unknown": true
    },
    {
      "need_code": "leaf_underside",
      "variable": "Aspecto del envés de las hojas afectadas",
      "reason": "Distingue entre hongo e insecto",
      "farmer_hint": "Preguntar qué ve en la parte de abajo de las hojas: polvito, bichitos o nada",
      "answer_type": "choice",
      "options": ["polvo o pelusa", "insectos", "nada", "no sé"],
      "priority": 2,
      "can_be_unknown": true
    }
  ],
  "data_used": [
    {
      "query_id": "q_demo_01",
      "summary": "Humedad promedio 14 días por encima de lo normal",
      "data_freshness": "fresh",
      "dataset_ids": ["dataset_humedad_demo"]
    }
  ],
  "resolved_case_mentions": [],
  "recommendations": [],
  "human_review_required": false,
  "source_ids": [],
  "context_stale": false,
  "model_version": "configured-model-version",
  "protocol_version": "coffee-demo-v1"
}
```

Respuesta 200 cuando hay suficiente información (campos relevantes):

```json
{
  "disposition": "advise",
  "information_needs": [],
  "recommendations": [
    {"code": "remove_affected_leaves", "text": "Retirar hojas con manchas y sacarlas de la parcela", "protocol_id": "coffee-demo-v1", "source_ids": []}
  ],
  "resolved_case_mentions": [
    {"resolution_id": "resolution_demo_03", "summary_for_speech": "En una parcela parecida de la zona, el agricultor contó que mejoró al retirar hojas afectadas y espaciar el riego", "verification": "farmer_reported"}
  ]
}
```

Enums: `disposition = ask_more | advise | refer`; `evidence_quality = insufficient | low | medium | high`; `urgency = unknown | routine | soon | urgent`; `answer_type = yes_no | number_with_unit | choice | free_text`. `suspected_issue` cuando existe: `{code, label, certainty: suspected}`.

La respuesta ya no incluye texto de pregunta ni `spoken_response`; la formulación es responsabilidad del agente de voz. `information_needs` solo contiene datos que debe aportar el agricultor; lo que el asesor obtuvo de los datos aparece en `data_used`. Cada recomendación incluye `protocol_id`; el asesor no emite recomendaciones ejecutables sin protocolo aplicable.

### 10.2 Consultar datos ambientales

Solicitud a `POST /v1/environment/query`:

```json
{
  "schema_version": "2.0",
  "query_id": "q_demo_01",
  "requested_by": "advisor",
  "target": {"plot_id": "plot_demo_01"},
  "variables": [
    {"code": "humidity_pct", "aggregation": "mean"},
    {"code": "precip_mm", "aggregation": "sum"}
  ],
  "window": {"days_back": 14, "end_date": null},
  "compare_to_normal": true,
  "is_demo": true
}
```

`target` es `{plot_id}` o `{latitude, longitude}`. `aggregation`: `daily | weekly | sum | mean | min | max`, limitada por `allowed_aggregations` del catálogo. Límites: máximo cinco variables y 365 días por consulta; `end_date: null` significa el dato más reciente.

Respuesta 200:

```json
{
  "query_id": "q_demo_01",
  "cell_id": "cell_demo_12",
  "distance_km": 3.4,
  "results": [
    {"code": "humidity_pct", "unit": "%", "aggregation": "mean", "value": 82.0, "normal": 68.0, "anomaly_ratio": 1.21, "coverage": 0.93, "missing_days": 1},
    {"code": "precip_mm", "unit": "mm", "aggregation": "sum", "value": 46.5, "normal": 20.0, "anomaly_ratio": 2.33, "coverage": 1.0, "missing_days": 0}
  ],
  "data_freshness": "fresh",
  "latest_data_date": "2026-10-02",
  "dataset_ids": ["dataset_humedad_demo", "dataset_lluvia_demo"],
  "is_demo": true
}
```

Una variable inexistente devuelve 422. Fuera de cobertura devuelve `value: null` y `coverage: 0`, no un error. Valores del ejemplo ficticios.

### 10.3 Buscar casos resueltos

Solicitud a `POST /v1/resolved-cases/search`:

```json
{
  "threat_code": "demo_threat",
  "symptoms": ["manchas en hojas"],
  "near_plot_id": "plot_demo_01",
  "max_distance_km": 20,
  "only_verified": false,
  "limit": 5
}
```

Respuesta 200:

```json
{
  "results": [
    {
      "resolution_id": "resolution_demo_03",
      "threat_code": "demo_threat",
      "similarity": 0.78,
      "distance_band": "menos de 5 km",
      "resolved_at": "2026-09-20T00:00:00Z",
      "days_to_resolution": 12,
      "solution_summary": "Retiró hojas afectadas y espació el riego",
      "solution_codes": ["remove_affected_leaves", "adjust_irrigation"],
      "matches_protocol": true,
      "verification": "farmer_reported"
    }
  ]
}
```

No incluye `plot_id`, nombre ni coordenadas de la parcela resuelta. `distance_band` sustituye la distancia exacta.

### 10.4 Registrar un seguimiento

Solicitud a `POST /v1/followups/followup_demo_01/responses`, con `Idempotency-Key`:

```json
{
  "schema_version": "2.0",
  "session_id": "session_demo_07",
  "channel": "voice",
  "status_reported": "resolved",
  "user_statement": "Ya no salen manchas desde que quité las hojas",
  "actions_taken": "Quitó hojas con manchas y regó menos",
  "action_worked": "yes",
  "change_noticed_at": null,
  "provider_reference": "provider-demo-reference",
  "is_demo": true
}
```

`status_reported = worse | same | improved | resolved | unknown`; `action_worked = yes | no | partial | unknown`.

Respuesta 201:

```json
{
  "report_id": "report_demo_09",
  "case_id": "case_demo_01",
  "case_status": "resolved",
  "resolution_id": "resolution_demo_04",
  "next_followup_at": null
}
```

`resolution_id` es `null` salvo con `status_reported: resolved`. Con `worse` o `same`, el backend programa otro seguimiento y propone revisión.

### 10.5 Guardar un reporte

Sin cambios respecto a la v1.0. Solicitud a `POST /v1/reports`, con `Idempotency-Key`:

```json
{
  "schema_version": "2.0",
  "session_id": "session_demo_01",
  "plot_id": "plot_demo_01",
  "case_id": null,
  "channel": "voice",
  "provider_reference": "provider-demo-reference",
  "observed_at": null,
  "symptoms": ["manchas en hojas"],
  "measurements": [],
  "user_statement": "Desde ayer veo manchas en varias plantas",
  "completeness": "partial",
  "assessment_id": "assessment_demo_01",
  "is_demo": true
}
```

Respuesta 201: `{report_id, case_id, received_at, processing_status, correlation_id}`. `channel = voice | sms | operator`; `completeness = partial | sufficient`; `processing_status = pending | processed | failed`.

### 10.6 Grafo para el dashboard

```json
{
  "schema_version": "2.0",
  "graph_version": 7,
  "generated_at": "2026-10-03T23:00:10Z",
  "threat_code": "demo_threat",
  "nodes": [
    {
      "id": "plot_demo_01",
      "label": "Parcela 1",
      "latitude": 19.0,
      "longitude": -96.0,
      "inspection_priority": "high",
      "score": 0.74,
      "contributions": [
        {"feature": "direct_active_reports", "value": 0.31},
        {"feature": "humidity_mean_14d", "value": 0.12}
      ],
      "model_version": "1.0.0",
      "local_case_status": "suspected",
      "data_freshness": "fresh",
      "risk_evaluation_id": "risk_demo_01",
      "reasons": ["Reporte directo activo", "Humedad por encima de lo normal"],
      "evidence_report_ids": ["report_demo_01"],
      "heuristic": true,
      "is_demo": true
    }
  ],
  "edges": []
}
```

Cada arista: `{id, source, target, distance_km, environment_similarity, exposure_type, exposure_strength, missing_features, rule_version}`. `exposure_strength` puede ser `null`; no inventar una exposición a partir de mera similitud. Coordenadas ficticias.

### 10.7 Revisar una alerta

Sin cambios respecto a la v1.0:

```json
{
  "decision": "approve",
  "expected_version": 1,
  "reason": "Aviso preventivo revisado",
  "message": "Se reportaron síntomas en la zona. Revisa tu parcela y responde si observas cambios. Este aviso no confirma afectación."
}
```

El servidor toma `approved_by` del usuario autenticado. Solo aprobar `pending_review`; si cambió la evidencia o venció la evaluación, devolver 409. La aprobación crea el trabajo de envío en la misma transacción; no llama directamente a Twilio dentro de esa transacción.

## 11. Eventos y cola

No hace falta un broker. Los eventos se guardan en outbox junto con la escritura de negocio. El worker los procesa al menos una vez; cada consumidor registra eventos procesados para deduplicar.

```json
{
  "event_id": "event_demo_01",
  "schema_version": "2.0",
  "event_type": "report.created",
  "occurred_at": "2026-10-03T23:00:00Z",
  "aggregate_id": "report_demo_01",
  "aggregate_version": 1,
  "correlation_id": "session_demo_01",
  "is_demo": true,
  "payload": {"report_id": "report_demo_01", "case_id": "case_demo_01", "plot_id": "plot_demo_01"}
}
```

| Evento | Productor | Consumidor | Efecto |
| --- | --- | --- | --- |
| `report.created` | Backend | Evaluador/worker | Evaluar si falta y recalcular cuando esté disponible |
| `assessment.completed` | Asesor/backend | Grafo | Recalcular parcelas pertinentes |
| `env.summary_refreshed` | Datos | Grafo | Recalcular aristas y características ambientales |
| `risk_model.activated` | Backend | Grafo | Recalcular todas las parcelas de la amenaza |
| `risk.updated` | Grafo | Generador de alertas y scheduler | Proponer alerta y programar seguimiento si cumple regla |
| `alert.approved` | Backend | Comunicaciones | Despachar si consentimiento y horario permiten |
| `notification.status_changed` | Comunicaciones | Backend/dashboard | Actualizar entrega, sin afirmar acción agrícola |
| `followup.due` | Scheduler | Comunicaciones | Llamar dentro del horario permitido; SMS si se agotan intentos |
| `followup.responded` | Backend | Asesor/grafo | Evaluar nueva observación |
| `case.resolved` | Backend | Grafo y dashboard | Retirar caso fuente, recalcular vecinos, mostrar resolución |

`report.created` con evaluación ya disponible no vuelve a evaluarse. No publicar transcripciones completas en eventos si basta un ID autorizado.

### Estados

- Alerta: `pending_review → approved | rejected | cancelled`; `approved → queued | cancelled`.
- Notificación: `queued → sending → accepted → delivered | failed | unknown`; puede cancelarse antes de enviar.
- Seguimiento: `scheduled → contacting → responded | no_response | failed | cancelled`.
- Caso: `reported → suspected | confirmed | monitoring → resolved`; cualquier cierre conserva motivo y autor. `resolved` puede reabrirse con nueva evidencia.
- Modelo de riesgo: `draft → active → retired`.

`accepted` significa que el proveedor aceptó la solicitud. `delivered` se aplica cuando el canal/proveedor lo confirma; las llamadas necesitan además resultado de contacto. No confundir llamada completada con conversación útil. Callbacks fuera de orden no degradan un estado terminal válido.

Deduplicación de alertas: parcela + amenaza + episodio/ventana configurada. Máximo propuesto de tres intentos para fallos transitorios, con backoff configurable; no reintentar números inválidos o falta de consentimiento. Si el envío queda ambiguo por timeout, marcar `unknown` y conciliar antes de volver a enviar.

## 12. Seguridad y observabilidad mínimas

- Panel autenticado; roles `operator`, `agronomist`, `admin`.
- Operador revisa avisos; agrónomo confirma, resuelve o verifica casos resueltos; admin configura y activa modelos. Guardar auditoría.
- Credenciales de servicio en secretos del backend; nunca en frontend/repositorio.
- Verificar firma/autenticidad de webhooks con mecanismo oficial de cada proveedor.
- Acceso restringido por organización si hay más de un cliente; evitar lecturas cruzadas.
- Contactos reales solo en pruebas explícitas; fixtures no usan teléfonos de terceros.
- Logs estructurados: request/correlation/event IDs, duración, resultado y versión; enmascarar teléfono y datos personales.
- Definir retención de transcripciones/audio antes de habilitar grabaciones; guardar solo lo necesario.
- Medir latencia de evaluación, consultas internas por turno, fallos de proveedor, reportes pendientes, alertas duplicadas y seguimientos sin respuesta.
- Objetivo interno de evaluación: menos de cinco segundos por turno, incluidas las consultas internas; medir, no prometer. Timeout y degradación deben impedir silencio indefinido.

### Consultas generadas por el asesor

- El asesor no ejecuta SQL. Produce una especificación estructurada que se valida contra el catálogo.
- `env_query` corre con un rol de solo lectura limitado al esquema `env`, con tiempo máximo de dos segundos y límite de filas.
- Si el equipo decide permitir SQL generado por el modelo de lenguaje (no recomendado), restringirlo a vistas de `env`, con rol de solo lectura, `statement_timeout` y sin acceso a `public`.
- La búsqueda de casos resueltos nunca devuelve identidad, teléfono ni coordenadas de otra parcela.
- El texto de casos resueltos y del contexto externo se trata como dato, no como instrucción para el asesor.

## 13. Trabajo paralelo y repositorio sugerido

```text
contracts/       esquemas, enums, catálogo de necesidades y fixtures compartidos (dueño: 3)
communications/  adaptadores, prompts y agentes de voz (dueño: 1)
advisor/         evaluación, protocolos y herramientas internas (dueño: 2)
risk_model/      entrenamiento, artefactos y vectores de prueba (dueño: 2)
backend/         API, grafo, casos resueltos, jobs y migraciones de public (dueño: 3)
data/            carga de datasets, migraciones de env, env_query y Bright Data (dueño: 4)
dashboard/       UI y adaptador de datos (dueño: 4)
```

Cada integrante trabaja en una rama. Un cambio incompatible de contrato necesita acuerdo y actualización del mock antes de integrarse. No cambiar nombres de enums, `need_code` ni `variable_code` unilateralmente. El frontend puede estar en un proyecto Lovable separado, pero debe consumir los mismos contratos versionados.

Fixtures mínimos: ocho parcelas, dos agricultores con teléfono compartido, dos parcelas sin contexto, una parcela fuera de la cobertura de los datasets, 90 días de datos ambientales para la región de demo, un reporte ambiguo, uno de alta prioridad, tres casos resueltos (uno `verified`, uno `farmer_reported` y uno que menciona un producto con dosis para probar que se omite), una alerta rechazada, una aprobada, un envío fallido, un seguimiento vencido y uno sin respuesta.

Los fixtures agronómicos que sugieran acciones deben ser revisados; los sintéticos solo prueban flujo y reglas, no precisión de diagnóstico.

## 14. Hitos de integración

Los tiempos son relativos al inicio del equipo; ajustar según el plazo real.

| Hito | Resultado esperado |
| --- | --- |
| 0–60 min | Contratos, amenaza/idioma, cuentas, IDs, fixtures, revisión de datasets, variable objetivo y catálogo inicial de necesidades |
| Primera revisión, ~2 h | Datasets cargados con catálogo y `env_query`; asesor con mocks que devuelve necesidades; artefacto de modelo puesto a mano; llamada con mock que formula preguntas; dashboard navegable |
| Segunda revisión, ~4 h | Llamada → asesor consulta `env` → pregunta formulada por ElevenLabs → reporte → score del modelo → cambio visible en panel |
| Tercera revisión, ~6 h | Aprobación → SMS real; llamada de seguimiento → caso resuelto → aparece en casos resueltos y el nodo se recalcula |
| Cierre | Modelo entrenado activado; asesor menciona un caso resuelto en una llamada nueva; fallos, guion de demo y límites visibles |

Si falta tiempo: preservar llamada entrante, evaluación con necesidades, consulta ambiental, grafo con el modelo (aunque sea el artefacto puesto a mano), seguimiento con resolución y SMS aprobado. Reducir Bright Data, consultas por coordenada libre, imágenes, vistas de datos del panel, animaciones y tiempo real. No sacrificar contratos, persistencia ni deduplicación para agregar funciones visuales.

## 15. Pruebas necesarias

| Prueba | Resultado esperado | Dueño |
| --- | --- | --- |
| Llamada de número conocido | Confirma parcela y obtiene contexto | 1 |
| Teléfono compartido | Pide confirmación, no expone otro agricultor | 1 |
| Necesidad técnica | ElevenLabs la formula en lenguaje cotidiano usando `farmer_hint` | 1 |
| Agricultor responde "no sé" | Se envía como desconocido, nunca como cero | 1 y 2 |
| Evaluación incompleta | Devuelve necesidades o deriva sin diagnóstico inventado | 2 |
| Dato disponible en datasets | El asesor lo consulta y no lo pide al agricultor | 2 |
| Variable inexistente en la consulta | 422; el asesor continúa sin ese dato | 2 y 4 |
| Parcela fuera de cobertura | `env_query` devuelve `null` con cobertura cero; el asesor lo declara | 2 y 4 |
| Caso resuelto con producto y dosis | El asesor omite producto y dosis si no hay protocolo | 2 |
| Búsqueda de casos resueltos | No devuelve identidad ni coordenadas | 3 |
| Artefacto del modelo | Reproduce sus vectores de prueba antes de activarse | 2 y 3 |
| Falta una característica requerida | Prioridad `unknown`, no `low` | 3 |
| Bright Data caído | Usa caché o declara contexto insuficiente | 4 |
| Webhook duplicado | Un reporte/caso, sin alerta duplicada | 1 y 3 |
| Mismo caso reportado tres veces | Actualiza evidencia, no cuenta tres brotes | 3 |
| Alta similitud sin exposición validada | No afirma contagio ni porcentaje | 3 |
| Dos operadores aprueban a la vez | Una aprobación efectiva y un envío | 3 y 4 |
| Timeout de envío | Conciliación; no reenvío ciego | 1 y 3 |
| Seguimiento sin respuesta | No declara resolución; pasa a SMS tras reintentos | 1 y 3 |
| Seguimiento resuelto | Crea una sola resolución, cierra el caso y recalcula vecinos | 1 y 3 |
| Seguimiento con empeoramiento | Programa otro seguimiento y propone revisión | 3 |
| Dashboard desconectado | Muestra datos desactualizados y permite reintentar | 4 |
| Falta de consentimiento | No envía aviso ni llamada proactiva | 1 y 3 |

## 16. Guion de demostración y definición de terminado

1. Mostrar parcelas con estado inicial y datos simulados identificados.
2. Agricultor de prueba llama y describe síntomas.
3. El panel muestra que el asesor consultó datos ambientales; ElevenLabs solo pregunta lo que faltaba ("¿y cómo ha estado el clima por allá?").
4. El asesor da orientación permitida y menciona un caso resuelto parecido.
5. Se registra el reporte; el modelo recalcula y el panel muestra el cambio de la parcela y sus vecinos con explicación.
6. El operador aprueba un aviso preventivo; un segundo teléfono recibe la llamada de voz con el aviso aprobado y el panel muestra la entrega (ver sección 17: avisos por voz).
7. Llamada de seguimiento: el agricultor cuenta que se resolvió y qué hizo.
8. La resolución aparece en casos resueltos, la parcela deja de ser caso fuente y los vecinos se recalculan.
9. Opcional: un vecino llama con síntomas parecidos y el asesor menciona la resolución anterior.

El MVP está terminado cuando este recorrido funciona con los servicios reales disponibles, sus fallos principales están tratados y cada cambio de prioridad puede rastrearse a evidencia, características y una versión del modelo. Si se simula una etapa, indicarlo durante la demo.

## 17. Decisiones aún por completar

Decisiones tomadas el 2026-10-03. `[x]` = decidido; `[ ]` = depende de algo externo y queda pendiente de confirmar. Cualquier cambio posterior se anota aquí y se actualizan mocks y fixtures.

- [x] **Amenaza y protocolo seleccionados:** roya del café (*Hemileia vastatrix*). `threat_code: coffee_leaf_rust`. Protocolo `coffee-rust-demo-v1`: solo prácticas culturales (retirar y enterrar hojas afectadas, regular sombra, podar para ventilar, control de maleza, nutrición, vigilar plantas vecinas). Cualquier fungicida, producto o dosis → `refer` a agrónomo. El protocolo es de demo y debe revisarlo el integrante 2 con la entrevista agrícola. Hipótesis alternativas que el asesor debe distinguir: ojo de gallo (*Mycena citricolor*), mancha de hierro (*Cercospora*), minador de la hoja.
- [x] **Región y lengua:** zona cafetalera del centro de Veracruz, México (Xalapa–Coatepec–Huatusco, aprox. lat 19.0–19.6, lon -97.1 a -96.7). Español de México (`es`, `es-MX` para voz). Zona horaria `America/Mexico_City`. Si los datasets del reto no cubren esta zona, la región se mueve a la que cubran y se mantienen la amenaza y el idioma.
- [ ] **Nombres de integrantes 1/2/3/4:** integrante 3 = usuario de este repositorio (backend y grafo); 1, 2 y 4 por asignar en la reunión.
- [ ] **Modelo de lenguaje y acceso confirmado:** asesor con `gpt-4.1-mini` (OpenAI) usando Structured Outputs con el esquema JSON de `assessments`; alternativa equivalente: Claude Sonnet con tool use. La salida del modelo siempre se revalida con Pydantic en el servicio. El acceso y los créditos los confirma el integrante 2.
- [x] **Backend elegido y URL base:** Python 3.12 + FastAPI + Pydantic v2 + psycopg 3 sobre Supabase Postgres (un proyecto, esquemas `public` y `env`). Migraciones SQL versionadas en `backend/migrations/`. El worker es un proceso Python separado del mismo código; lee `outbox_events` y `jobs` con `FOR UPDATE SKIP LOCKED` cada 2 s e incluye el scheduler de seguimientos. Despliegue en Render (servicio web + worker, HTTPS). URL de desarrollo `http://localhost:8000/v1`; la URL pública se anota al primer despliegue. Autenticación: tokens de servicio Bearer por consumidor (`comms`, `advisor`, `data`) para las herramientas y JWT de Supabase Auth con rol en `app_metadata` para el dashboard.
- [ ] **Datasets: cobertura de la región elegida y variables disponibles:** el reto proporciona los datasets; inventario pendiente (integrante 4). Variables mínimas que necesitan el asesor y el modelo: `precip_mm` (diaria), `humidity_pct` (humedad relativa media diaria), `temp_max_c`, `temp_min_c`, `temp_mean_c`. Si falta humedad, se sustituye por punto de rocío o días con lluvia y se actualiza el catálogo.
- [x] **Variable objetivo de la regresión y origen de las etiquetas:** si los datasets traen incidencia o severidad de roya, se usa esa columna. Si no, para la demo: `rust_pressure_index` ∈ [0,1], presión de roya esperada en la parcela en los próximos 30 días, con etiquetas sintéticas de una regla documentada (humedad alta, temperatura 21–25 °C, lluvia sobre lo normal, exposición a casos fuente y reportes directos, más ruido) y `labels_are_synthetic: true`. En operación real se reemplaza por casos confirmados o descartados en inspección, con una regresión logística en el mismo formato de artefacto.
- [x] **Cortes del score para `medium` y `high`:** `medium ≥ 0.40`, `high ≥ 0.70`, `score_range [0,1]`. El integrante 2 puede ajustarlos tras entrenar, solo publicando una nueva versión del artefacto.
- [x] **Catálogo inicial de `need_code`:** solo datos que aporta el agricultor (clima, humedad y temperatura se consultan en `env`, no se preguntan).

  | `need_code` | `answer_type` | Para qué sirve |
  | --- | --- | --- |
  | `leaf_underside` | `choice`: polvo naranja o amarillo / pelusa blanca / insectos o galerías / nada / no sé | Distingue roya de ojo de gallo y minador |
  | `spot_appearance` | `choice`: manchas amarillas o naranjas / manchas cafés con centro claro / manchas redondas grises / otro | Distingue roya de cercospora y ojo de gallo |
  | `affected_extent` | `choice`: pocas plantas / un sector / casi toda la parcela / no sé | Urgencia y extensión |
  | `leaf_drop` | `yes_no` | Defoliación, señal de severidad |
  | `symptom_onset_days` | `number_with_unit` (días) | Fecha aproximada de observación |
  | `coffee_variety` | `free_text` | Variedades susceptibles (Typica, Bourbon, Caturra) frente a tolerantes |
  | `shade_level` | `choice`: sin sombra / poca / mucha / no sé | Microclima de la parcela |
  | `local_weather_perception` | `free_text` | Confirmar en la parcela lo que dicen los datos de la celda cercana |
  | `actions_taken` | `free_text` | Qué ha hecho ya el agricultor |

- [x] **Límite de consultas internas por turno y presupuesto de tiempo:** máximo 3 consultas internas por turno (`env_query`, casos resueltos, contexto externo). Timeout de 2 s por consulta y presupuesto de 5 s por turno. Si se agota, el asesor responde con lo que tenga y `context_stale: true`, sin inventar datos. Máximo 3 rondas y 5 preguntas al agricultor por llamada; después, `advise` con lo disponible o `refer`.
- [x] **Intervalo de seguimiento en demo y en uso real; número de reintentos antes de SMS:** demo: 3 minutos tras abrir caso o pasar a `medium`/`high`, reintentos cada 2 minutos. Real: 7 días, reintentos cada 2 horas dentro del horario permitido. Dos reintentos (3 intentos de llamada en total); después, un SMS. Sin respuesta → `no_response`, nunca baja el riesgo.
- [x] **Pesos, radio y ventana de aristas** (hipotéticos para la demo, `rule_version: edges-v1-hypothetical`, pendientes de revisión con el asesor): se crea arista entre parcelas a ≤ 10 km, con un máximo de 5 vecinos por parcela. `environment_similarity = 1 − distancia euclidiana normalizada` sobre características estandarizadas de `env.plot_summary` (humedad media 14 d, anomalía de lluvia 30 d, temperatura media 14 d), en ventana de 30 días. `exposure_type: proximity`, simétrica; `exposure_strength = exp(−distance_km / 5)` solo si existe un caso fuente activo en el otro extremo, si no `null`. La similitud ambiental por sí sola nunca crea exposición.
- [x] **Política de consentimiento/horarios/retención, incluidas llamadas salientes:** consentimiento verbal explícito en la primera llamada, con tres permisos separados: guardar reportes, recibir avisos y recibir llamadas de seguimiento. Se guardan con `consent_at`. Responder "BAJA" por SMS revoca avisos y seguimientos. Horario permitido por defecto: 08:00–19:00 hora local, todos los días. Fuera de horario, el trabajo espera. Sin grabación de audio por defecto. Las transcripciones se conservan 30 días (en demo se borran con el reinicio); los campos estructurados se conservan. Teléfonos enmascarados en logs. En demo solo se llama o escribe a números en lista blanca.
- [x] **Estrategia explícita para el requisito offline del reto:** en la demo se declara **no cumplido**. Voz y SMS evitan que el agricultor necesite datos móviles o una aplicación, pero el servicio sí necesita internet. Propuesta para después del MVP: modo degradado local en una cooperativa, con el backend y un módem GSM como pasarela SMS, un asesor por reglas (árbol de decisión sobre el catálogo de `need_code` y el protocolo) y el artefacto JSON de riesgo, que no tiene dependencias externas. En ese modo no se usan ElevenLabs ni el modelo de lenguaje. Los reportes se sincronizan al volver la conexión con las mismas claves de idempotencia.
- [x] **Avisos aprobados por llamada de voz, no por SMS (2026-10-04):** los avisos preventivos aprobados se entregan con una llamada saliente del agente de voz "Alerts" de ElevenLabs, que lee el mensaje aprobado (`alerts.message`) y pide al agricultor confirmar que lo escuchó. Motivo: el registro A2P de Twilio necesario para enviar SMS a números de México no es viable en el tiempo del hackathon, y las llamadas salientes de ElevenLabs ya funcionan para los seguimientos. Al aprobar, el backend crea la notificación con `channel = 'voice'` y nunca hace la llamada. Comunicaciones consulta la cola con `GET /v1/notifications?status=queued&channel=voice` y reporta cada cambio con `POST /v1/notifications/{id}/status` (con `Idempotency-Key`). Estados no terminales: `queued`, `sending`, `accepted`, `unknown` (se puede pasar libremente entre ellos porque las llamadas se reintentan; cada `sending` suma un intento). Terminales: `delivered`, `failed`, `cancelled`; una actualización posterior responde `applied: false` y no cambia nada. `delivered` significa que el agricultor confirmó en la llamada que escuchó el aviso, nunca que lo leyó o actuó. Cada cambio aplicado escribe `notification.status_changed` en `outbox_events`. El SMS sigue siendo el canal de reportes entrantes y de respaldo de seguimientos cuando haya número habilitado.

Sobre la variable objetivo: una regresión necesita ejemplos con la respuesta conocida. Si los datasets traen una columna de incidencia, daño o pérdida de rendimiento, esa es la mejor opción. Si no, las etiquetas pueden salir de reportes confirmados conforme el sistema opere; para la demo pueden ser sintéticas, siempre marcadas con `labels_are_synthetic: true`.

## 18. Referencias de implementación

- Twilio, voz y webhooks: https://www.twilio.com/docs/usage/webhooks/voice-webhooks
- Twilio, mensajería y webhooks: https://www.twilio.com/docs/usage/webhooks/messaging-webhooks
- ElevenLabs, integraciones: https://elevenlabs.io/docs/eleven-agents/integrate/overview
- ElevenLabs, contexto de llamadas Twilio: https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/customising-calls
- ElevenLabs, webhooks posteriores: https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks
- Bright Data, progreso de extracción: https://docs.brightdata.com/api-reference/web-scraper-api/management-apis/monitor-progress
- Lovable, conexión Supabase: https://docs.lovable.dev/integrations/supabase
- scikit-learn, regresión lineal: https://scikit-learn.org/stable/modules/generated/sklearn.linear_model.LinearRegression.html

Estos contratos son decisiones propuestas del equipo, no esquemas nativos de proveedores. Verificar sus payloads, permisos y capacidades actuales durante la configuración, en particular las llamadas salientes de ElevenLabs con Twilio.
