"""The local token issuer: mints HS256 access tokens with the same claims Cognito puts in its access tokens.
Used by the launcher and the curl demo when TOKEN_MODE=local; `python -m gateway.issuer_local research-bot` writes one token to stdout for scripts."""

import sys
import time

import jwt

LOCAL_CLIENT_IDS = {"research-bot": "local-research-bot", "ops-bot": "local-ops-bot"}


def mint_local_token(agent_id: str, client_id: str, secret: str, ttl_s: int = 300) -> str:
    """Return a signed HS256 token for client_id valid for ttl_s seconds (agent_id is resolved by the gateway, not a claim)."""
    now = int(time.time())
    claims = {"sub": client_id, "client_id": client_id, "token_use": "access", "scope": "mytopia/tools",
              "iss": "local-issuer", "iat": now, "exp": now + ttl_s}
    return jwt.encode(claims, secret, algorithm="HS256")


def main(argv: list[str]) -> int:
    """CLI for scripts: mint a token for the named agent with the secret from gateway/.env."""
    from gateway.config import Settings

    agent_id = argv[0] if argv else "research-bot"
    if agent_id not in LOCAL_CLIENT_IDS:
        print(f"unknown agent {agent_id}", file=sys.stderr)
        return 2
    secret = Settings.from_env().local_issuer_secret
    sys.stdout.write(mint_local_token(agent_id, LOCAL_CLIENT_IDS[agent_id], secret))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
