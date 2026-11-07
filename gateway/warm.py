"""Warm-up and keep-warm for AWS mode, on daemon threads so startup and requests never wait for them.
Measured costs they move off the first agent call: credential_process 1.6 s, the JWKS fetch 0.3-0.6 s, a new TLS connection to DynamoDB, a cold Lambda 0.6 s.
They read badge rows only to warm the connection and seed the client -> agent map; no decision ever uses a row they read."""

import sys
import threading
import time
from typing import Any

from gateway.registry import KNOWN_AGENTS

KEEP_WARM_S = 60.0          # credentials refresh check + one discarded GetItem
LAMBDA_PING_S = 240.0       # an idle Lambda container is kept for minutes; ping well inside that
EARLY_REFRESH_S = 2 * KEEP_WARM_S  # refresh this long before botocore's own advisory window opens


def step(label: str, action: Any) -> str:
    """Run one warm-up step; return 'label N ms' or 'label FAILED (Error)'. Never raises."""
    t0 = time.perf_counter()
    try:
        action()
        return f"{label} {int((time.perf_counter() - t0) * 1000)} ms"
    except Exception as exc:  # noqa: BLE001 - a failed warm-up only means the first call is slower
        return f"{label} FAILED ({type(exc).__name__})"


def refresh_early(credentials: Any) -> None:
    """Refresh botocore credentials up to 2 min BEFORE its advisory window opens (15 min before expiry).
    Inside that window the first thread to sign a request runs credential_process itself (1.6 s); doing it here first
    means that thread is never a request. Uses botocore's own refresh lock, without blocking, as botocore does."""
    if not hasattr(credentials, "refresh_needed") or not hasattr(credentials, "_refresh_lock"):
        return  # static credentials: nothing ever expires
    advisory = getattr(credentials, "_advisory_refresh_timeout", 15 * 60)
    if credentials.refresh_needed(advisory + EARLY_REFRESH_S) and credentials._refresh_lock.acquire(False):
        try:
            credentials._protected_refresh(is_mandatory=False)  # on failure botocore keeps the current credentials
        finally:
            credentials._refresh_lock.release()


def refresh_credentials(session: Any) -> None:
    """Resolve (or refresh, shortly before botocore would) the gateway role's credentials now, off the request path."""
    credentials = session.get_credentials() if session is not None else None
    if credentials is None:
        raise RuntimeError("no credentials")
    credentials.get_frozen_credentials()  # the first resolution, or botocore's own refresh if it is already due
    refresh_early(credentials)


def warm_up(handler: Any, session: Any) -> None:
    """Once at startup: both badge rows (seeding the map, first so no agent waits on a slow JWKS), credentials,
    JWKS, and a no-op Lambda invoke. The registry step resolves the credentials itself if they are not yet there."""
    parts = [step("registry", handler.refresh_agents),
             step("credentials", lambda: refresh_credentials(session)),
             step("jwks", handler.verifier.warm),
             step("lambda", handler.tools.warm)]
    print("gateway: warm-up " + " | ".join(parts), file=sys.stderr)


def keep_warm(handler: Any, session: Any, stop: threading.Event) -> None:
    """Every 60 s: refresh credentials if due and do one discarded GetItem (or rebuild the client map while it is
    still empty, e.g. after a failed warm-up); every 4 min: ping the Lambda."""
    next_ping = time.monotonic() + LAMBDA_PING_S
    while not stop.wait(KEEP_WARM_S):
        step("credentials", lambda: refresh_credentials(session))
        if handler.agent_by_client:
            step("registry", lambda: handler.registry.get(KNOWN_AGENTS[0]))
        else:
            step("registry", handler.refresh_agents)
        if time.monotonic() >= next_ping:
            step("lambda", handler.tools.warm)
            next_ping = time.monotonic() + LAMBDA_PING_S


def start(handler: Any, session: Any) -> threading.Event:
    """Start both threads; set the returned event to stop the keep-warm loop."""
    stop = threading.Event()
    threading.Thread(target=warm_up, args=(handler, session), name="warm-up", daemon=True).start()
    threading.Thread(target=keep_warm, args=(handler, session, stop), name="keep-warm", daemon=True).start()
    return stop
