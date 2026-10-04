import logging

from fastapi import APIRouter, Depends
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.tokens import make_candidate_token, read_candidate_token
from contracts.models import (
    ContactCandidate,
    ContactConfirmRequest,
    ContactConfirmResponse,
    ContactResolutionRequest,
    ContactResolutionResponse,
)

router = APIRouter(prefix="/v1/contact-resolution", tags=["contacts"])
log = logging.getLogger("api.contacts")


def mask_phone(phone: str) -> str:
    return phone[:4] + "*" * (len(phone) - 6) + phone[-2:]


@router.post("", response_model=ContactResolutionResponse)
def resolve_contact(body: ContactResolutionRequest, conn: Connection = Depends(get_conn)):
    """Caller ID is not proof of identity: always requires confirmation."""
    rows = conn.execute(
        """
        select f.id as farmer_id, string_agg(p.name, ' / ' order by p.name) as label
        from contacts c
        join farmers f on f.contact_id = c.id
        left join plots p on p.farmer_id = f.id
        where c.phone_e164 = %s
        group by f.id
        order by f.id
        """,
        (body.phone_e164,),
    ).fetchall()
    log.info("contact resolution phone=%s candidates=%d", mask_phone(body.phone_e164), len(rows))
    return ContactResolutionResponse(
        candidates=[
            ContactCandidate(
                candidate_token=make_candidate_token(r["farmer_id"], body.session_id),
                label=r["label"] or "Sin parcela registrada",
            )
            for r in rows
        ],
        requires_confirmation=True,
    )


@router.post("/confirm", response_model=ContactConfirmResponse)
def confirm_contact(body: ContactConfirmRequest, conn: Connection = Depends(get_conn)):
    farmer_id = read_candidate_token(body.candidate_token, body.session_id)
    if farmer_id is None:
        raise ApiError(403, "Token de candidato inválido, vencido o de otra sesión")
    farmer = conn.execute(
        """
        select f.id, f.name, f.preferred_language, c.notification_consent, c.followup_call_consent
        from farmers f join contacts c on c.id = f.contact_id
        where f.id = %s
        """,
        (farmer_id,),
    ).fetchone()
    if farmer is None:
        raise ApiError(404, "Agricultor no encontrado")
    plots = conn.execute(
        "select id as plot_id, name from plots where farmer_id = %s order by name", (farmer_id,)
    ).fetchall()
    return ContactConfirmResponse(
        farmer_id=farmer["id"],
        farmer_name=farmer["name"],
        preferred_language=farmer["preferred_language"],
        plots=plots,
        notification_consent=farmer["notification_consent"],
        followup_call_consent=farmer["followup_call_consent"],
    )
