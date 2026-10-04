"""Collective alert proposals and human review (INSTRUCTIONS.md sections 6, 10.7 and 11).

- Proposed only for plots that rose to medium/high because of a NEIGHBOUR's case or the environment;
  a plot with its own active case already knows (it reported) and gets a follow-up instead.
- One alert per plot + threat + episode. A new episode is a neighbour case opened after the plot's
  last alert (any status, so a rejection is not re-proposed), or the ISO week for environment-only rises.
- No proposal without notification consent.
- Approval queues a voice notification in the same transaction (delivered by the communications "Alerts"
  voice agent, section 17); the backend never places the call.
"""

from datetime import UTC, datetime

from psycopg import Connection
from psycopg.types.json import Jsonb

from backend.app.errors import ApiError
from contracts.enums import EventType

DEFAULT_MESSAGE = (
    "Se reportaron síntomas de roya en la zona. Revisa tu parcela y responde si observas cambios. "
    "Este aviso no confirma afectación."
)
ALERTABLE = ("medium", "high")


def episode_key(conn: Connection, plot_id: str, threat_code: str, neighbor_case_ids: list[str]) -> str | None:
    """dedup_key for a new episode, or None if the plot was already alerted about these cases."""
    if not neighbor_case_ids:
        year, week, _ = datetime.now(UTC).isocalendar()
        return f"{plot_id}:{threat_code}:env-{year}-W{week:02d}"
    newest = conn.execute(
        """
        select c.id from cases c
        where c.id = any(%s)
          and c.opened_at > coalesce(
            (select max(a.created_at) from alerts a where a.plot_id = %s and a.threat_code = %s), '-infinity')
        order by c.opened_at desc limit 1
        """,
        (neighbor_case_ids, plot_id, threat_code),
    ).fetchone()
    return f"{plot_id}:{threat_code}:{newest['id']}" if newest else None


def propose_alerts(conn: Connection, threat_code: str, evaluations: list) -> list[str]:
    """Called inside the recalculation transaction with the evaluations that changed."""
    proposed = []
    for ev in evaluations:
        if ev.priority not in ALERTABLE or ev.has_own_case:
            continue
        consent = conn.execute(
            """
            select c.notification_consent from plots p
            join farmers f on f.id = p.farmer_id join contacts c on c.id = f.contact_id
            where p.id = %s
            """,
            (ev.plot_id,),
        ).fetchone()
        if not consent or not consent["notification_consent"]:
            continue

        key = episode_key(conn, ev.plot_id, threat_code, ev.neighbor_case_ids)
        if key is None:
            continue

        row = conn.execute(
            """
            insert into alerts (is_demo, plot_id, threat_code, risk_evaluation_id, message, dedup_key)
            values (%s, %s, %s, %s, %s, %s)
            on conflict (dedup_key) do nothing
            returning id
            """,
            (ev.is_demo, ev.plot_id, threat_code, ev.risk_evaluation_id, DEFAULT_MESSAGE, key),
        ).fetchone()
        if row:
            proposed.append(row["id"])
    return proposed


def review_alert(conn: Connection, alert_id: str, decision: str, expected_version: int,
                 reason: str | None, message: str | None, reviewer: str) -> str:
    """Approve or reject. Returns the alert id. Raises 404/409 on missing alert or stale state."""
    with conn.transaction():
        alert = conn.execute(
            "select id, plot_id, threat_code, status, version, message, is_demo from alerts where id = %s for update",
            (alert_id,),
        ).fetchone()
        if alert is None:
            raise ApiError(404, "Alerta no encontrada")
        if alert["status"] != "pending_review":
            raise ApiError(409, f"La alerta ya está en estado {alert['status']}", code="ALERT_ALREADY_REVIEWED")
        if alert["version"] != expected_version:
            raise ApiError(409, "La alerta cambió; recarga e intenta de nuevo", code="VERSION_CONFLICT")

        if decision == "reject":
            conn.execute(
                "update alerts set status = 'rejected', review_reason = %s where id = %s",
                (reason, alert_id),
            )
            return alert_id

        latest = conn.execute(
            """
            select inspection_priority from risk_evaluations
            where plot_id = %s and threat_code = %s order by created_at desc limit 1
            """,
            (alert["plot_id"], alert["threat_code"]),
        ).fetchone()
        if latest is None or latest["inspection_priority"] not in ALERTABLE:
            raise ApiError(409, "La evidencia cambió: la parcela ya no está en prioridad media o alta",
                           code="EVIDENCE_CHANGED")

        contact = conn.execute(
            """
            select c.id, c.notification_consent from plots p
            join farmers f on f.id = p.farmer_id join contacts c on c.id = f.contact_id
            where p.id = %s
            """,
            (alert["plot_id"],),
        ).fetchone()
        if not contact["notification_consent"]:
            raise ApiError(409, "El contacto no tiene consentimiento para avisos", code="NO_CONSENT")

        conn.execute(
            """
            update alerts set status = 'queued', message = %s, review_reason = %s,
                              approved_by = %s, approved_at = now()
            where id = %s
            """,
            (message or alert["message"], reason, reviewer, alert_id),
        )
        notification = conn.execute(
            """
            insert into notifications (is_demo, alert_id, contact_id, channel, status)
            values (%s, %s, %s, 'voice', 'queued')
            returning id
            """,
            (alert["is_demo"], alert_id, contact["id"]),
        ).fetchone()
        conn.execute(
            "insert into outbox_events (is_demo, event_type, aggregate_id, payload) values (%s, %s, %s, %s)",
            (alert["is_demo"], EventType.alert_approved, alert_id,
             Jsonb({"alert_id": alert_id, "notification_id": notification["id"], "plot_id": alert["plot_id"]})),
        )
    return alert_id
