import logging

from fastapi import APIRouter, Depends, Header
from psycopg import Connection

from backend.app.db import get_conn
from backend.app.errors import ApiError
from backend.app.idempotency import idempotent
from backend.app.tokens import make_candidate_token, read_candidate_token
from contracts.models import (
    ConfirmedFarmer,
    ConsentRecorded,
    ConsentRequest,
    ConsentRevocationRequest,
    ConsentRevoked,
    ContactCandidate,
    ContactConsent,
    ContactResolutionRequest,
    ContactResolutionResponse,
)

router = APIRouter(prefix="/v1", tags=["contacts"])
log = logging.getLogger("api.contacts")


def mask_phone(phone: str) -> str:
    return phone[:4] + "*" * (len(phone) - 6) + phone[-2:]


def consent_of(contact: dict) -> ContactConsent:
    if contact["consent_at"] is None:  # never asked
        return ContactConsent(reports=None, notifications=None, followup_calls=None, consent_at=None)
    return ContactConsent(
        reports=contact["report_consent"],
        notifications=contact["notification_consent"],
        followup_calls=contact["followup_call_consent"],
        consent_at=contact["consent_at"],
    )


def confirmed_farmer(conn: Connection, farmer_id: str) -> ConfirmedFarmer:
    farmer = conn.execute(
        """
        select f.id, f.preferred_language, f.timezone, c.report_consent, c.notification_consent,
               c.followup_call_consent, c.consent_at
        from farmers f join contacts c on c.id = f.contact_id where f.id = %s
        """,
        (farmer_id,),
    ).fetchone()
    if farmer is None:
        raise ApiError(404, "Agricultor no encontrado")
    plots = conn.execute(
        "select id as plot_id, name as label from plots where farmer_id = %s order by name", (farmer_id,)
    ).fetchall()
    return ConfirmedFarmer(farmer_id=farmer["id"], preferred_language=farmer["preferred_language"],
                           timezone=farmer["timezone"], consent=consent_of(farmer), plots=plots)


@router.post("/contact-resolution", response_model=ContactResolutionResponse)
def resolve_contact(body: ContactResolutionRequest, conn: Connection = Depends(get_conn)):
    """Caller ID is not proof of identity: candidates first, data only after confirmation."""
    matches = conn.execute(
        """
        select f.id as farmer_id, f.name, c.is_shared
        from contacts c join farmers f on f.contact_id = c.id
        where c.phone_e164 = %s order by f.id
        """,
        (body.phone_e164,),
    ).fetchall()
    response = ContactResolutionResponse(
        session_id=body.session_id, resolution_status="no_match", requires_confirmation=False,
        is_shared_phone=len(matches) > 1 or any(m["is_shared"] for m in matches),
        candidates=[], confirmed=None, is_demo=body.is_demo,
    )

    if body.confirm_candidate_token is not None:
        farmer_id = read_candidate_token(body.confirm_candidate_token, body.session_id, body.phone_e164)
        if farmer_id is None:
            raise ApiError(403, "El candidato no es válido para esta sesión", code="CANDIDATE_TOKEN_INVALID")
        response.resolution_status = "confirmed"
        response.confirmed = confirmed_farmer(conn, farmer_id)
    elif matches:
        response.resolution_status = "candidates"
        response.requires_confirmation = True
        response.candidates = [
            ContactCandidate(candidate_token=make_candidate_token(m["farmer_id"], body.session_id, body.phone_e164),
                             label=m["name"])
            for m in matches
        ]

    log.info("contact resolution phone=%s outcome=%s candidates=%d",
             mask_phone(body.phone_e164), response.resolution_status, len(response.candidates))
    return response


@router.post("/consents", response_model=ConsentRecorded)
def record_consent(body: ConsentRequest, idempotency_key: str = Header(min_length=8, max_length=200),
                   conn: Connection = Depends(get_conn)):
    def run() -> tuple[int, dict]:
        contact = conn.execute(
            """
            update contacts c set
              report_consent = coalesce(%(reports)s, c.report_consent),
              notification_consent = coalesce(%(notifications)s, c.notification_consent),
              followup_call_consent = coalesce(%(followup_calls)s, c.followup_call_consent),
              consent_at = now()
            from farmers f where f.contact_id = c.id and f.id = %(farmer)s
            returning c.report_consent, c.notification_consent, c.followup_call_consent, c.consent_at
            """,
            {"reports": body.reports, "notifications": body.notifications,
             "followup_calls": body.followup_calls, "farmer": body.farmer_id},
        ).fetchone()
        if contact is None:
            raise ApiError(404, "Agricultor no encontrado")
        log.info("consent recorded farmer=%s", body.farmer_id)
        return 200, ConsentRecorded(farmer_id=body.farmer_id, consent=consent_of(contact),
                                    is_demo=body.is_demo).model_dump(mode="json")

    return idempotent(conn, idempotency_key, "consents.record", body, run)


@router.post("/consents/revocations", response_model=ConsentRevoked)
def revoke_consent(body: ConsentRevocationRequest, idempotency_key: str = Header(min_length=8, max_length=200),
                   conn: Connection = Depends(get_conn)):
    def run() -> tuple[int, dict]:
        updated = conn.execute(
            """
            update contacts set
              notification_consent = case when %(n)s then false else notification_consent end,
              followup_call_consent = case when %(f)s then false else followup_call_consent end,
              consent_at = now()
            where phone_e164 = %(phone)s
            """,
            {"n": "notifications" in body.scopes, "f": "followup_calls" in body.scopes, "phone": body.phone_e164},
        ).rowcount
        log.info("consent revoked phone=%s contacts=%d", mask_phone(body.phone_e164), updated)
        return 200, ConsentRevoked(contacts_updated=updated, scopes=body.scopes,
                                   is_demo=body.is_demo).model_dump(mode="json")

    return idempotent(conn, idempotency_key, "consents.revoke", body, run)
