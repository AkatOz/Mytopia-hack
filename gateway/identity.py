"""Agent identities for the Factory: one OAuth app client per agent.
CognitoIdentity creates and deletes Cognito app clients exactly as infra/provision.py ensure_client does; LocalIdentity names a local client id.
The client secret is returned to factory.py only, which writes it to the launcher's env file; it never reaches a response, an event or a log line."""

import sys
from typing import Any


class IdentityError(Exception):
    """The identity provider could not create (or reach) a client; the mint fails closed with 503."""


class LocalIdentity:
    """TOKEN_MODE=local: the client id is "local-<agent>" (what the launcher's local issuer signs), no secret."""

    def create(self, agent_id: str) -> tuple[str, str]:
        return "local-" + agent_id, ""

    def delete(self, client_id: str) -> bool:
        return True


class CognitoIdentity:
    """TOKEN_MODE=cognito: one M2M app client in the pool per agent (ClientName = agent id)."""

    def __init__(self, pool_id: str, session: Any, scope: str = "mytopia/tools") -> None:
        self.pool_id = pool_id
        self.scope = scope
        self._client = None
        if session is not None:
            try:
                from botocore.config import Config  # imported here so local mode never touches botocore

                config = Config(connect_timeout=2, read_timeout=5, retries={"mode": "standard", "total_max_attempts": 2})
                self._client = session.client("cognito-idp", config=config)
            except Exception as exc:  # noqa: BLE001 - any setup failure means every mint fails closed
                print(f"identity setup failed: {type(exc).__name__}", file=sys.stderr)

    def create(self, agent_id: str) -> tuple[str, str]:
        """create_user_pool_client with provision.py's exact parameters; returns (client id, secret)."""
        if self._client is None or not self.pool_id:
            raise IdentityError("no Cognito pool or session for the Factory")
        try:
            c = self._client.create_user_pool_client(
                UserPoolId=self.pool_id, ClientName=agent_id, GenerateSecret=True,
                ExplicitAuthFlows=["ALLOW_CLIENT_TOKEN_AUTH"], AllowedOAuthFlowsUserPoolClient=True,
                AllowedOAuthFlows=["client_credentials"], AllowedOAuthScopes=[self.scope],
                AccessTokenValidity=5, TokenValidityUnits={"AccessToken": "minutes"})["UserPoolClient"]
            return str(c["ClientId"]), str(c["ClientSecret"])
        except Exception as exc:  # noqa: BLE001 - every provider error fails closed; never echo the response
            raise IdentityError(type(exc).__name__) from None

    def delete(self, client_id: str) -> bool:
        """delete_user_pool_client, best effort: False (and one stderr line, no secret) when it failed."""
        if self._client is None or not self.pool_id:
            print(f"identity: cannot delete client {client_id[:8]}: no Cognito session", file=sys.stderr)
            return False
        try:
            self._client.delete_user_pool_client(UserPoolId=self.pool_id, ClientId=client_id)
            return True
        except Exception as exc:  # noqa: BLE001
            print(f"identity: delete of client {client_id[:8]} failed: {type(exc).__name__}", file=sys.stderr)
            return False
