"""Versioned catalogs the advisor may use, in every supported language.

They hold no literal questions: the voice agent and SMS (member 1) turn ``farmer_hint``
into a natural question. Codes and option order are the same in every language, so
communications and the dashboard can rely on them whatever the call language is.
"""

from __future__ import annotations

from typing import Literal

from .contracts import AnswerType, NeedDefinition


THREAT_CODE = "coffee_leaf_rust"
PROTOCOL_VERSION = "coffee-rust-demo-v1"
MODEL_SNAPSHOT = "gpt-4.1-mini-2025-04-14"

Language = Literal["en", "es"]
DEFAULT_LANGUAGE: Language = "en"


def normalize_language(language: str | None) -> Language:
    """``es``, ``es-MX`` → es; anything else → en (the product runs in English)."""
    return "es" if (language or "").lower().startswith("es") else DEFAULT_LANGUAGE


# need_code → answer type, catalog priority and per-language text. Options keep the same
# order in both languages: index i means the same thing in en and es.
_NEEDS: dict[str, dict] = {
    "leaf_underside": {
        "answer_type": AnswerType.choice,
        "priority": 1,
        "en": {
            "variable": "Appearance of the underside of affected leaves",
            "reason": "Tells rust apart from American leaf spot and leaf miner",
            "farmer_hint": "Ask what they see on the underside of the leaves: orange powder, white fuzz, little bugs or nothing",
            "options": ["orange or yellow powder", "white fuzz", "insects or tunnels", "nothing", "don't know"],
        },
        "es": {
            "variable": "Aspecto del envés de las hojas afectadas",
            "reason": "Distingue roya, ojo de gallo y minador.",
            "farmer_hint": "Preguntar qué ve debajo de la hoja: polvito, pelusa, bichitos o nada.",
            "options": ["polvo naranja o amarillo", "pelusa blanca", "insectos o galerías", "nada", "no sé"],
        },
    },
    "spot_appearance": {
        "answer_type": AnswerType.choice,
        "priority": 2,
        "en": {
            "variable": "Color and shape of the spots",
            "reason": "Tells rust apart from brown eye spot and American leaf spot",
            "farmer_hint": "Ask what color and shape the spots are on the top of the leaf",
            "options": ["yellow or orange spots", "brown spots with a light center", "round gray spots", "other"],
        },
        "es": {
            "variable": "Aspecto de las manchas",
            "reason": "Ayuda a distinguir roya de cercospora y ojo de gallo.",
            "farmer_hint": "Pedir que describa color y forma de las manchas.",
            "options": ["manchas amarillas o naranjas", "manchas cafés con centro claro", "manchas redondas grises", "otro"],
        },
    },
    "affected_extent": {
        "answer_type": AnswerType.choice,
        "priority": 3,
        "en": {
            "variable": "How widespread the problem is on the plot",
            "reason": "Sets the urgency of the case",
            "farmer_hint": "Ask whether it is a few plants, one section or almost the whole plot",
            "options": ["a few plants", "one section", "almost the whole plot", "don't know"],
        },
        "es": {
            "variable": "Extensión de plantas afectadas",
            "reason": "Determina la urgencia del caso.",
            "farmer_hint": "Preguntar si ve pocas plantas, un sector o casi toda la parcela afectada.",
            "options": ["pocas plantas", "un sector", "casi toda la parcela", "no sé"],
        },
    },
    "leaf_drop": {
        "answer_type": AnswerType.yes_no,
        "priority": 4,
        "en": {
            "variable": "Leaf drop",
            "reason": "Leaf drop is a sign of severity",
            "farmer_hint": "Ask whether the plants are dropping the affected leaves",
            "options": None,
        },
        "es": {
            "variable": "Caída de hojas",
            "reason": "La defoliación es una señal de severidad.",
            "farmer_hint": "Preguntar si las plantas están tirando hojas afectadas.",
            "options": None,
        },
    },
    "symptom_onset_days": {
        "answer_type": AnswerType.number_with_unit,
        "priority": 5,
        "en": {
            "variable": "Days since the symptoms started",
            "reason": "Gives the assessment a time frame",
            "farmer_hint": "Ask how many days ago they first noticed the problem",
            "options": None,
        },
        "es": {
            "variable": "Tiempo desde el inicio de los síntomas",
            "reason": "Da contexto temporal a la evaluación.",
            "farmer_hint": "Preguntar desde hace cuántos días notó el problema.",
            "options": None,
        },
    },
    "coffee_variety": {
        "answer_type": AnswerType.free_text,
        "priority": 6,
        "en": {
            "variable": "Coffee variety",
            "reason": "Some varieties are more susceptible than others",
            "farmer_hint": "Ask which coffee variety is planted, if they know it",
            "options": None,
        },
        "es": {
            "variable": "Variedad de café",
            "reason": "Hay variedades con diferente susceptibilidad.",
            "farmer_hint": "Preguntar qué variedad de café tiene sembrada, si la conoce.",
            "options": None,
        },
    },
    "shade_level": {
        "answer_type": AnswerType.choice,
        "priority": 7,
        "en": {
            "variable": "Shade level",
            "reason": "Shade changes the plot's microclimate",
            "farmer_hint": "Ask whether the coffee has a lot of shade, a little or none",
            "options": ["no shade", "a little", "a lot", "don't know"],
        },
        "es": {
            "variable": "Nivel de sombra",
            "reason": "La sombra modifica el microclima de la parcela.",
            "farmer_hint": "Preguntar si el cafetal tiene mucha, poca o nada de sombra.",
            "options": ["sin sombra", "poca", "mucha", "no sé"],
        },
    },
    "local_weather_perception": {
        "answer_type": AnswerType.free_text,
        "priority": 8,
        "en": {
            "variable": "Recent rain and humidity on the plot",
            "reason": "Confirms whether the plot matches the data from a nearby cell",
            "farmer_hint": "Ask how the weather has been these days: whether it has rained, been cloudy or humid",
            "options": None,
        },
        "es": {
            "variable": "Percepción del clima local",
            "reason": "Confirma si la parcela coincide con datos de una celda cercana.",
            "farmer_hint": "Preguntar cómo han estado la lluvia, nubes y humedad en la parcela.",
            "options": None,
        },
    },
    "actions_taken": {
        "answer_type": AnswerType.free_text,
        "priority": 9,
        "en": {
            "variable": "Actions already taken",
            "reason": "Avoids repeating actions and helps decide whether to refer the case",
            "farmer_hint": "Ask what they have already done to look after the plants",
            "options": None,
        },
        "es": {
            "variable": "Acciones ya realizadas",
            "reason": "Evita repetir acciones y ayuda a decidir si se deriva el caso.",
            "farmer_hint": "Preguntar qué ha hecho ya para atender las plantas.",
            "options": None,
        },
    },
}

NEED_CODES: tuple[str, ...] = tuple(_NEEDS)


def need_definition(
    need_code: str,
    language: str | None = DEFAULT_LANGUAGE,
    *,
    reason: str | None = None,
    priority: int | None = None,
) -> NeedDefinition:
    """Canonical need; only ``reason`` (contextual) and ``priority`` (turn order) may vary."""
    entry = _NEEDS[need_code]
    text = entry[normalize_language(language)]
    return NeedDefinition(
        need_code=need_code,
        variable=text["variable"],
        reason=reason or text["reason"],
        farmer_hint=text["farmer_hint"],
        answer_type=entry["answer_type"],
        options=list(text["options"]) if text["options"] is not None else None,
        priority=priority or entry["priority"],
        can_be_unknown=True,
    )


# Kept for existing callers: the Spanish catalog by code.
NEED_CATALOG: dict[str, NeedDefinition] = {code: need_definition(code, "es") for code in NEED_CODES}


# Protocol coffee-rust-demo-v1: cultural practices only. Any fungicide, product or dose → refer.
# "text" is what the farmer hears or reads; "done" completes "improved after …" in a resolved case.
PRACTICES: dict[str, dict[str, dict[str, str]]] = {
    "remove_affected_leaves": {
        "en": {"text": "Remove the leaves with spots and bury them away from the plants.", "done": "removing the affected leaves"},
        "es": {"text": "Retirar las hojas con manchas y enterrarlas lejos de las plantas.", "done": "retirar las hojas afectadas"},
    },
    "regulate_shade": {
        "en": {"text": "Adjust the shade so the plants get some sun and the plot dries faster.", "done": "adjusting the shade"},
        "es": {"text": "Regular la sombra para que entre algo de sol y la parcela se seque más rápido.", "done": "regular la sombra"},
    },
    "prune_for_ventilation": {
        "en": {"text": "Prune the plants so air moves between them.", "done": "pruning for better air flow"},
        "es": {"text": "Podar las plantas para que circule el aire entre ellas.", "done": "podar para ventilar"},
    },
    "weed_control": {
        "en": {"text": "Keep weeds down around the coffee plants.", "done": "controlling the weeds"},
        "es": {"text": "Mantener controlada la maleza alrededor de los cafetos.", "done": "controlar la maleza"},
    },
    "nutrition": {
        "en": {"text": "Keep the plants well fed so they can recover.", "done": "improving the plants' nutrition"},
        "es": {"text": "Cuidar la nutrición de las plantas para que se recuperen.", "done": "cuidar la nutrición"},
    },
    "monitor_neighbor_plants": {
        "en": {"text": "Check the neighboring plants over the next few days.", "done": "watching the neighboring plants"},
        "es": {"text": "Revisar las plantas vecinas en los próximos días.", "done": "vigilar las plantas vecinas"},
    },
}
PRACTICE_CODES: tuple[str, ...] = tuple(PRACTICES)


# Hypotheses the advisor must tell apart (INSTRUCTIONS.md §17). Labels never confirm a disease.
ISSUES: dict[str, dict[str, str]] = {
    "coffee_leaf_rust": {"en": "Possible coffee leaf rust", "es": "Posible roya del café"},
    "american_leaf_spot": {"en": "Possible American leaf spot", "es": "Posible ojo de gallo"},
    "brown_eye_spot": {"en": "Possible brown eye spot", "es": "Posible mancha de hierro"},
    "coffee_leaf_miner": {"en": "Possible coffee leaf miner", "es": "Posible minador de la hoja"},
}
ISSUE_CODES: tuple[str, ...] = tuple(ISSUES)


# The backend returns Spanish distance bands; the mention is spoken in the call language.
_DISTANCE_BANDS = {
    "menos de 5 km": {"en": "less than 5 km away", "es": "a menos de 5 km"},
    "entre 5 y 10 km": {"en": "5 to 10 km away", "es": "a entre 5 y 10 km"},
    "entre 10 y 20 km": {"en": "10 to 20 km away", "es": "a entre 10 y 20 km"},
    "más de 20 km": {"en": "in the wider area", "es": "en la región"},
}


def _join(items: list[str], language: Language) -> str:
    if len(items) <= 1:
        return "".join(items)
    return f"{', '.join(items[:-1])} {'and' if language == 'en' else 'y'} {items[-1]}"


def resolved_case_speech(solution_codes: list[str], distance_band: str | None, language: str | None) -> str | None:
    """Spoken summary built only from protocol practices, so it can never carry a product or dose.

    No trailing period: SMS appends one.
    """
    lang = normalize_language(language)
    done = [PRACTICES[code][lang]["done"] for code in solution_codes if code in PRACTICES]
    if not done:
        return None
    band = _DISTANCE_BANDS.get((distance_band or "").strip().lower(), {"en": "in the area", "es": "de la zona"})[lang]
    if lang == "es":
        return f"Un agricultor con un caso parecido {band} contó que sus plantas mejoraron al {_join(done, lang)}"
    return f"A farmer with a similar case {band} said their plants improved after {_join(done, lang)}"
