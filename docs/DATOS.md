# Datos: fuentes, uso y límites

Responsable: integrante 4. Este documento responde a la sección 7 del reto ("Every entry should cite its
data sources … You must also indicate what your data does not cover").

## 1. Datos con los que construimos

| Dataset | Fuente y licencia | Qué usamos | Dónde vive |
| --- | --- | --- | --- |
| **NASA POWER Daily** (comunidad AG, API v2) | NASA Langley Research Center, POWER Project. Datos abiertos, sin restricción de uso; se cita "NASA LaRC POWER Project". https://power.larc.nasa.gov/ | Serie diaria de los últimos 120 días: `T2M`, `T2M_MAX`, `T2M_MIN`, `RH2M`, `PRECTOTCORR` | `env.daily_observations` |
| **NASA POWER Climatology** | Misma fuente. Normales mensuales 2001–2020 | Normal de cada variable por mes, para calcular anomalías | `env.climatology` |
| **Parcelas, casos y reportes de demo** | Sintéticos, creados por el equipo. `is_demo = true` en todos los registros | Ubicación de 8 parcelas en la zona Xalapa–Coatepec–Huatusco, casos y reportes de ejemplo | `public.*` (seed de demo) |
| **Etiquetas del modelo de riesgo** | Sintéticas (`labels_are_synthetic: true`), regla documentada en INSTRUCTIONS.md §17 | Entrenar la regresión de prioridad de inspección | Artefacto del integrante 2 |

Tamaño cargado hoy: 2 celdas × 5 variables × ~118 días = 1,180 observaciones diarias, más 120 normales mensuales.

Reproducible: `python -m backend.scripts.load_nasa_power` descarga, guarda la respuesta cruda en
`backend/data/nasa_power/` y la carga. Con `--offline` recarga la última descarga sin internet.

### Variables y características derivadas

| Código | Unidad | Origen | Agregaciones que acepta `env_query` |
| --- | --- | --- | --- |
| `precip_mm` | mm | `PRECTOTCORR` | sum, mean, min, max |
| `humidity_pct` | % | `RH2M` | mean, min, max |
| `temp_mean_c` | °C | `T2M` | mean, min, max |
| `temp_max_c` | °C | `T2M_MAX` | mean, min, max |
| `temp_min_c` | °C | `T2M_MIN` | mean, min, max |

Características que alimentan el grafo y el modelo (`env.plot_summary`):

- `humidity_mean_14d`: humedad relativa media de los últimos 14 días con dato.
- `rain_anomaly_30d`: lluvia acumulada en 30 días dividida entre la normal 2001–2020 de esos mismos días (1.0 = normal).
- `temp_optimal_days_14d`: días de los últimos 14 con temperatura media entre 21 y 25 °C, el rango favorable para la roya que usa la regla de etiquetas sintéticas.

Si faltan más del 20 % de los días de la ventana, la característica queda en `null`: nunca se rellena con cero ni se extrapola.

## 2. Lo que nuestros datos **no** cubren

1. **Microclima de la parcela.** NASA POWER tiene celdas de unos 50 km (0.5° × 0.625°). Las parcelas 01–04 y 07
   caen en la misma celda y reciben exactamente los mismos valores; la sombra, la altitud y la orientación de la ladera
   no se ven. Por eso el asesor pregunta al agricultor `local_weather_perception` en vez de dar por buena la celda.
2. **Incidencia real de roya.** No tenemos registros de brotes confirmados por parcela. La prioridad de inspección
   sale de una regresión con etiquetas sintéticas: orienta a quién visitar primero, **no es una probabilidad de
   contagio** y no está validada en campo.
3. **Cobertura geográfica.** El sistema solo mapea parcelas dentro de la región de demo
   (lat 18.5–20.2, lon −97.6 a −96.2). Fuera de ella (por ejemplo, la parcela 08 en Chiapas) la respuesta es `null`
   con cobertura cero, no un valor de una celda lejana.
4. **Datos del día.** NASA POWER publica con 1–3 días de retraso. El resumen marca `data_freshness: stale` si el
   dato más reciente tiene más de 7 días.
5. **Normales sin desviación estándar.** La climatología de POWER solo trae medias mensuales; por eso las anomalías
   son cocientes (valor / normal) y no puntajes z.
6. **Lluvia convectiva local.** A 50 km de resolución, un aguacero localizado en una parcela puede no aparecer. CHIRPS
   (~5 km) lo mejoraría y es el siguiente paso propuesto; no está cargado.
7. **Imágenes.** No usamos imágenes de hojas ni satelitales: el diagnóstico por voz no confirma enfermedades y
   los datasets de hojas (PlantVillage y similares) son de fondo de estudio.
8. **Contexto externo.** `env.external_context` tiene 3 fuentes revisadas a mano (SENASICA, Cenicafé y Universidad
   de Puerto Rico; `backend/seed/external_context.sql`), resumidas por el equipo y aprobadas por el integrante 2.
   No hay extracción automática con Bright Data, y Cenicafé y la UPR no son fuentes mexicanas: describen la
   enfermedad y el manejo de sombra en general, no el centro de Veracruz.

## 3. Evidencia de que el problema existe

> Cifras tomadas de fuentes secundarias encontradas el 2026-10-04. **Verificar contra la fuente primaria (SAGARPA/USDA,
> GSMA) antes de citarlas en el video.**

- **Roya del café en México (2012–2013).** Chiapas produce ~40 % del café de México y Veracruz ~25 %. SAGARPA
  confirmó la roya en 30 % de la superficie de Chiapas y 10 % de la de Veracruz; la cosecha 2013-14 se pronosticó en
  3.9 millones de sacos, 14.5 % menos que los 4.653 millones de 2012-13
  ([spilling-the-beans](https://www.spilling-the-beans.net/?p=2420)). La crisis que inició la roya, junto con el
  clima y la broca, llevó a una caída de ~50 % de la producción en cuatro años
  ([Cafe Imports](https://www.cafeimports.com/north-america/blog/?p=48374)).
- **Teléfono básico frente a internet.** En México, 87 % de las mujeres tiene celular y 77 % usa internet móvil
  (GSMA Mobile Gender Gap Report 2024, vía
  [Telecom Review Americas](https://telecomreviewamericas.com/articles/reports-and-coverage/latin-american-gender-gap-vanishes-in-mobile-internet-adoption)).
  Alrededor de 1 de cada 9 mujeres con celular no usa internet móvil: llamadas y SMS llegan a más gente que una app.
  Son promedios nacionales; falta el dato rural.
- **Pendiente:** FAOSTAT (rendimiento de café en México por año) y OpenCelliD (antenas en la zona de demo) para
  mostrar la caída de rendimiento y la cobertura celular con datos primarios.
