"""Fallback local HS256 token issuer for the launcher, used only when gateway/issuer_local.py cannot be imported.
It mints the same claims as INTERFACES.md section 6 (sub, client_id, token_use, scope, iss, iat, exp) so the gateway's LocalVerifier accepts it."""

import time

import jwt


def mint_local_token(agent_id: str, client_id: str, secret: str, ttl_s: int = 300) -> str:
    """Return a signed HS256 access token for client_id that expires in ttl_s seconds."""
    now = int(time.time())
    claims = {
        "sub": client_id,
        "client_id": client_id,
        "token_use": "access",
        "scope": "mytopia/tools",
        "iss": "local-issuer",
        "iat": now,
        "exp": now + ttl_s,
    }
    return jwt.encode(claims, secret, algorithm="HS256")
