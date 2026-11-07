"""Bearer token checks: who is calling, proven by a signed JWT, and which badge row it maps to.
LocalVerifier checks HS256 tokens from issuer_local.py; CognitoVerifier checks Cognito RS256 access tokens against the pool's JWKS."""

import time
from dataclasses import dataclass
from typing import Any, Protocol

import jwt

from gateway.registry import Registry

LOCAL_ISSUER = "local-issuer"


@dataclass
class TokenInfo:
    """What a valid token proved."""

    client_id: str
    agent_id: str
    exp: int
    scope: str
    mode: str      # "cognito" | "local"

    def expires_in(self) -> int:
        """Seconds of validity left."""
        return max(0, self.exp - int(time.time()))


class TokenError(Exception):
    """A rejected token; str(error) is the reason. client_id is an unverified hint, used only to label the log."""

    def __init__(self, reason: str, client_id: str | None = None) -> None:
        super().__init__(reason)
        self.client_id = client_id


class TokenVerifier(Protocol):
    def verify(self, authorization_header: str | None) -> TokenInfo: ...


def bearer_value(authorization_header: str | None) -> str:
    """Return the token from 'Bearer <token>' or raise TokenError."""
    if not authorization_header:
        raise TokenError("missing bearer token")
    parts = authorization_header.split()
    if len(parts) != 2 or parts[0].lower() != "bearer" or parts[1].count(".") != 2:
        raise TokenError("malformed authorization header")
    return parts[1]


def unverified_client_id(token: str) -> str | None:
    """Read client_id without checking anything; only for labelling a deny in the log."""
    try:
        return jwt.decode(token, options={"verify_signature": False}).get("client_id")
    except jwt.PyJWTError:
        return None


def check_claims(claims: dict, scope: str, registry: Registry, mode: str) -> TokenInfo:
    """The claim rules both verifiers share: access token, scope, sub == client_id, registered client."""
    client_id = claims.get("client_id")
    if claims.get("token_use") != "access":
        raise TokenError("not an access token", client_id)
    if scope not in str(claims.get("scope", "")).split():
        raise TokenError(f"scope {scope} missing", client_id)
    if not client_id or claims.get("sub") != client_id:
        raise TokenError("sub does not match client_id", client_id)
    row = registry.by_client_id(client_id)  # may raise RegistryUnavailable; the caller fails closed
    if row is None:
        raise TokenError("client is not a registered agent", client_id)
    return TokenInfo(client_id=client_id, agent_id=row["agent"], exp=int(claims["exp"]),
                     scope=str(claims["scope"]), mode=mode)


def decode_or_raise(token: str, key: Any, algorithm: str, issuer: str) -> dict:
    """jwt.decode with readable reasons for the usual failures."""
    try:
        return jwt.decode(token, key, algorithms=[algorithm], issuer=issuer,
                          options={"verify_aud": False, "require": ["exp", "iat"]})
    except jwt.ExpiredSignatureError:
        raise TokenError("token expired", unverified_client_id(token)) from None
    except jwt.InvalidSignatureError:
        raise TokenError("signature verification failed", unverified_client_id(token)) from None
    except jwt.InvalidIssuerError:
        raise TokenError("wrong issuer", unverified_client_id(token)) from None
    except jwt.PyJWTError as exc:
        raise TokenError(f"bad token ({type(exc).__name__})", unverified_client_id(token)) from None


class LocalVerifier:
    """HS256 tokens signed with LOCAL_ISSUER_SECRET, issuer local-issuer."""

    def __init__(self, secret: str, registry: Registry, scope: str = "mytopia/tools") -> None:
        self._secret = secret
        self._registry = registry
        self._scope = scope

    def verify(self, authorization_header: str | None) -> TokenInfo:
        token = bearer_value(authorization_header)
        claims = decode_or_raise(token, self._secret, "HS256", LOCAL_ISSUER)
        return check_claims(claims, self._scope, self._registry, "local")


class CognitoVerifier:
    """RS256 access tokens from the Cognito pool, keys fetched once from its JWKS and cached on the instance."""

    def __init__(self, pool_id: str, region: str, scope: str, registry: Registry) -> None:
        self.issuer = f"https://cognito-idp.{region}.amazonaws.com/{pool_id}"
        self._jwks = jwt.PyJWKClient(self.issuer + "/.well-known/jwks.json", cache_keys=True)
        self._scope = scope
        self._registry = registry

    def verify(self, authorization_header: str | None) -> TokenInfo:
        token = bearer_value(authorization_header)
        try:
            key = self._jwks.get_signing_key_from_jwt(token).key
        except jwt.PyJWKClientError as exc:
            raise TokenError(f"signing key not found ({type(exc).__name__})", unverified_client_id(token)) from None
        except jwt.PyJWTError:
            raise TokenError("malformed token", None) from None
        claims = decode_or_raise(token, key, "RS256", self.issuer)
        return check_claims(claims, self._scope, self._registry, "cognito")
