"""Bearer token checks: who is calling, proven by a signed JWT (signature, issuer, expiry, kind, scope, sub == client_id).
LocalVerifier checks HS256 tokens from issuer_local.py; CognitoVerifier checks Cognito RS256 access tokens against the pool's JWKS.
Neither reads the badge registry: mcp.py maps client_id to an agent in memory and then reads that one badge row (one read per call)."""

import time
from dataclasses import dataclass
from typing import Any, Protocol

import jwt

LOCAL_ISSUER = "local-issuer"


@dataclass
class TokenInfo:
    """What a valid token proved: which client signed in and until when."""

    client_id: str
    exp: int       # unix seconds

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


def check_claims(claims: dict, scope: str) -> TokenInfo:
    """The claim rules both verifiers share: access token, scope present, sub == client_id."""
    client_id = claims.get("client_id")
    if claims.get("token_use") != "access":
        raise TokenError("not an access token", client_id)
    if scope not in str(claims.get("scope", "")).split():
        raise TokenError(f"scope {scope} missing", client_id)
    if not client_id or claims.get("sub") != client_id:
        raise TokenError("sub does not match client_id", client_id)
    return TokenInfo(client_id=str(client_id), exp=int(claims["exp"]))


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

    def __init__(self, secret: str, scope: str = "mytopia/tools") -> None:
        self._secret = secret
        self._scope = scope

    def verify(self, authorization_header: str | None) -> TokenInfo:
        token = bearer_value(authorization_header)
        claims = decode_or_raise(token, self._secret, "HS256", LOCAL_ISSUER)
        return check_claims(claims, self._scope)

    def warm(self) -> None:
        """Nothing to fetch for a shared secret."""


JWKS_TIMEOUT_S = 2   # PyJWKClient's default is 30 s, and a fetch can sit on a request's path


class CognitoVerifier:
    """RS256 access tokens from the Cognito pool, keys fetched once from its JWKS and cached on the instance.
    Two caches: the whole key set (expires after 5 min) and a per-kid LRU (never expires); a request uses the LRU."""

    def __init__(self, pool_id: str, region: str, scope: str) -> None:
        self.issuer = f"https://cognito-idp.{region}.amazonaws.com/{pool_id}"
        self._jwks = jwt.PyJWKClient(self.issuer + "/.well-known/jwks.json", cache_keys=True,
                                     timeout=JWKS_TIMEOUT_S)
        self._scope = scope

    def verify(self, authorization_header: str | None) -> TokenInfo:
        token = bearer_value(authorization_header)
        try:
            key = self._jwks.get_signing_key_from_jwt(token).key
        except jwt.PyJWKClientError as exc:
            raise TokenError(f"signing key not found ({type(exc).__name__})", unverified_client_id(token)) from None
        except jwt.PyJWTError:
            raise TokenError("malformed token", None) from None
        claims = decode_or_raise(token, key, "RS256", self.issuer)
        return check_claims(claims, self._scope)

    def warm(self) -> None:
        """Fetch the JWKS now (0.3 to 0.6 s) and put every key in the per-kid LRU, which never expires:
        filling only the key-set cache would stop helping after its 5 min lifespan."""
        for key in self._jwks.get_signing_keys():
            self._jwks.get_signing_key(key.key_id)
