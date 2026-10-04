"""Catálogos versionados que el asesor puede usar.

No contienen preguntas literales: ElevenLabs (dev 1) convierte ``farmer_hint``
en una pregunta natural para el agricultor.
"""

from __future__ import annotations

from .contracts import AnswerType, NeedDefinition


THREAT_CODE = "coffee_leaf_rust"
PROTOCOL_VERSION = "coffee-rust-demo-v1"

NEED_CATALOG: dict[str, NeedDefinition] = {
    "leaf_underside": NeedDefinition(
        need_code="leaf_underside",
        variable="Aspecto del " \
        "envés de las hojas afectadas",
        reason="Distingue roya, ojo de gallo y minador.",
        farmer_hint="Preguntar qué ve debajo de la hoja: polvito, pelusa, bichitos o nada.",
        answer_type=AnswerType.choice,
        options=["polvo naranja o amarillo", "pelusa blanca", "insectos o galerías", "nada", "no sé"],
        priority=1,
        can_be_unknown=True,
    ),
    "spot_appearance": NeedDefinition(
        need_code="spot_appearance",
        variable="Aspecto de las manchas",
        reason="Ayuda a distinguir roya de cercospora y ojo de gallo.",
        farmer_hint="Pedir que describa color y forma de las manchas.",
        answer_type=AnswerType.choice,
        options=["manchas amarillas o naranjas", "manchas cafés con centro claro", "manchas redondas grises", "otro"],
        priority=2,
        can_be_unknown=True,
    ),
    "affected_extent": NeedDefinition(
        need_code="affected_extent",
        variable="Extensión de plantas afectadas",
        reason="Determina la urgencia del caso.",
        farmer_hint="Preguntar si ve pocas plantas, un sector o casi toda la parcela afectada.",
        answer_type=AnswerType.choice,
        options=["pocas plantas", "un sector", "casi toda la parcela", "no sé"],
        priority=3,
        can_be_unknown=True,
    ),
    "leaf_drop": NeedDefinition(
        need_code="leaf_drop",
        variable="Caída de hojas",
        reason="La defoliación es una señal de severidad.",
        farmer_hint="Preguntar si las plantas están tirando hojas afectadas.",
        answer_type=AnswerType.yes_no,
        options=None,
        priority=4,
        can_be_unknown=True,
    ),
    "symptom_onset_days": NeedDefinition(
        need_code="symptom_onset_days",
        variable="Tiempo desde el inicio de los síntomas",
        reason="Da contexto temporal a la evaluación.",
        farmer_hint="Preguntar desde hace cuántos días notó el problema.",
        answer_type=AnswerType.number_with_unit,
        options=None,
        priority=5,
        can_be_unknown=True,
    ),
    "coffee_variety": NeedDefinition(
        need_code="coffee_variety",
        variable="Variedad de café",
        reason="Hay variedades con diferente susceptibilidad.",
        farmer_hint="Preguntar qué variedad de café tiene sembrada, si la conoce.",
        answer_type=AnswerType.free_text,
        options=None,
        priority=6,
        can_be_unknown=True,
    ),
    "shade_level": NeedDefinition(
        need_code="shade_level",
        variable="Nivel de sombra",
        reason="La sombra modifica el microclima de la parcela.",
        farmer_hint="Preguntar si el cafetal tiene mucha, poca o nada de sombra.",
        answer_type=AnswerType.choice,
        options=["sin sombra", "poca", "mucha", "no sé"],
        priority=7,
        can_be_unknown=True,
    ),
    "local_weather_perception": NeedDefinition(
        need_code="local_weather_perception",
        variable="Percepción del clima local",
        reason="Confirma si la parcela coincide con datos de una celda cercana.",
        farmer_hint="Preguntar cómo han estado la lluvia, nubes y humedad en la parcela.",
        answer_type=AnswerType.free_text,
        options=None,
        priority=8,
        can_be_unknown=True,
    ),
    "actions_taken": NeedDefinition(
        need_code="actions_taken",
        variable="Acciones ya realizadas",
        reason="Evita repetir acciones y ayuda a decidir si se deriva el caso.",
        farmer_hint="Preguntar qué ha hecho ya para atender las plantas.",
        answer_type=AnswerType.free_text,
        options=None,
        priority=9,
        can_be_unknown=True,
    ),
}

