"""Keep the demo path warm before judging: every --interval seconds (default 120) mint a Cognito token,
call tools/list and read_file through the gateway, and make one short Bedrock Converse call with the
short-term bearer token from agent/.env. One line per cycle; Ctrl-C stops it. It never prints a token.

What it warms: the Cognito token endpoint and the Bedrock route. It is optional: the gateway now warms its own
credentials, JWKS, DynamoDB connection and tools Lambda at startup and keeps them warm (gateway/warm.py). Its two gateway calls per cycle are real, logged calls (run id run-warm), so the island
shows it: stop warm.py before the demo starts.

The Bedrock call runs with AWS credentials removed from this process (no AWS_ACCESS_KEY_ID & co., no
AWS_PROFILE, config and credentials files pointed at an empty file), so it succeeds only on the bearer token.
Usage: python scripts/warm.py [--once] [--interval 120] [--agent research-bot] [--gateway-url URL]
"""

import argparse
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
EMPTY = ROOT / "scripts" / "scrubbed" / "aws_config.ini"
AWS_CRED_VARS = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
                 "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_CREDENTIAL_EXPIRATION")


def scrub_aws_env() -> None:
    """Drop every AWS credential source from this process so only the Bedrock bearer token can authenticate."""
    for k in AWS_CRED_VARS:
        os.environ.pop(k, None)
    EMPTY.parent.mkdir(parents=True, exist_ok=True)
    if not EMPTY.exists():
        EMPTY.write_text("", encoding="utf-8")
    os.environ["AWS_CONFIG_FILE"] = str(EMPTY)
    os.environ["AWS_SHARED_CREDENTIALS_FILE"] = str(EMPTY)


def ms_since(t0: float) -> int:
    return int((time.perf_counter() - t0) * 1000)


def short_error(e: Exception) -> str:
    """Exception type plus the first 100 characters of its message (no request bodies, so no tokens)."""
    return f"{type(e).__name__}: {str(e).splitlines()[0][:100] if str(e) else ''}"


def mint(cfg: dict[str, str], agent: str) -> str:
    """A Cognito access token from the unsigned GetClientToken call (no AWS credentials needed)."""
    import boto3
    from botocore import UNSIGNED
    from botocore.config import Config

    prefix = agent.upper().replace("-", "_")
    cognito = boto3.client("cognito-idp", region_name=cfg.get("AWS_REGION") or "us-east-1",
                           config=Config(signature_version=UNSIGNED))
    result = cognito.get_client_token(ClientId=cfg[prefix + "_CLIENT_ID"], Secret=cfg[prefix + "_CLIENT_SECRET"],
                                      Scopes=[cfg.get("COGNITO_SCOPE") or "mytopia/tools"])
    return result["ClientAuthenticationResult"]["AccessToken"]


def rpc(client: httpx.Client, token: str, msg_id: int, method: str, params: dict) -> httpx.Response:
    return client.post("/mcp", json={"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params},
                       headers={"Authorization": f"Bearer {token}", "X-Run-Id": "run-warm"})


def bedrock_client(cfg: dict[str, str]):
    """A bedrock-runtime client that can only authenticate with AWS_BEARER_TOKEN_BEDROCK."""
    import boto3

    os.environ["AWS_BEARER_TOKEN_BEDROCK"] = cfg.get("AWS_BEARER_TOKEN_BEDROCK") or ""
    return boto3.client("bedrock-runtime", region_name=cfg.get("AWS_REGION") or "us-east-1")


def cycle(n: int, cfg: dict[str, str], agent: str, client: httpx.Client, bedrock, model_id: str) -> bool:
    """One warm cycle; prints one line and returns True when every step answered as expected."""
    parts, ok = [], True
    t0 = time.perf_counter()
    try:
        token = mint(cfg, agent)
        parts.append(f"mint {ms_since(t0)} ms")
    except Exception as e:  # noqa: BLE001 - one bad cycle must not stop the loop
        token, ok = None, False
        parts.append(f"mint FAILED ({short_error(e)})")
    if token:
        t0 = time.perf_counter()
        try:
            r = rpc(client, token, 1, "tools/list", {})
            tools = r.json()["result"]["tools"] if r.status_code == 200 else None
            parts.append(f"tools/list {len(tools)} tools {ms_since(t0)} ms" if tools is not None
                         else f"tools/list HTTP {r.status_code}")
            ok = ok and bool(tools)
        except Exception as e:  # noqa: BLE001
            ok = False
            parts.append(f"tools/list FAILED ({short_error(e)})")
        t0 = time.perf_counter()
        try:
            r = rpc(client, token, 2, "tools/call", {"name": "read_file", "arguments": {"path": "/drive/q3-planning.md"}})
            res = r.json().get("result", {}) if r.status_code == 200 else {}
            if r.status_code != 200:
                ok = False
                parts.append(f"read_file HTTP {r.status_code}")
            elif res.get("isError"):
                ok = False
                parts.append(f"read_file DENIED {ms_since(t0)} ms ({res['content'][0]['text'][:60]})")
            else:
                parts.append(f"read_file ALLOW {ms_since(t0)} ms (includes the gateway's demo pace)")
        except Exception as e:  # noqa: BLE001
            ok = False
            parts.append(f"read_file FAILED ({short_error(e)})")
    t0 = time.perf_counter()
    try:
        resp = bedrock.converse(modelId=model_id,
                                messages=[{"role": "user", "content": [{"text": "Reply with the single word: ready"}]}],
                                inferenceConfig={"maxTokens": 10, "temperature": 0.0})
        text = "".join(c.get("text", "") for c in resp["output"]["message"]["content"]).strip()
        parts.append(f"bedrock {model_id} {ms_since(t0)} ms '{text[:20]}'")
    except Exception as e:  # noqa: BLE001
        ok = False
        parts.append(f"bedrock FAILED ({short_error(e)})")
    print(f"{time.strftime('%H:%M:%S')} cycle {n} {'OK  ' if ok else 'WARN'} | " + " | ".join(parts), flush=True)
    return ok


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Keep the MYTOPIA demo path warm.")
    p.add_argument("--interval", type=float, default=120.0, help="seconds between cycles (default 120)")
    p.add_argument("--once", action="store_true", help="one cycle, then exit (exit 1 if it was not all OK)")
    p.add_argument("--agent", default="research-bot", help="whose Cognito client to use (research-bot or ops-bot)")
    p.add_argument("--env-file", default=str(ROOT / "agent" / ".env"))
    p.add_argument("--gateway-url", default=None, help="overrides GATEWAY_URL from the env file")
    args = p.parse_args(argv)

    cfg = {k: v or "" for k, v in dotenv_values(args.env_file).items()}
    if not cfg.get("AWS_BEARER_TOKEN_BEDROCK"):
        print(f"warm: AWS_BEARER_TOKEN_BEDROCK is empty in {args.env_file}; the Bedrock step will fail", flush=True)
    url = (args.gateway_url or cfg.get("GATEWAY_URL") or "http://127.0.0.1:8787").rstrip("/")
    model_id = cfg.get("BEDROCK_MODEL_ID") or "us.amazon.nova-2-lite-v1:0"
    print("warm: optional now: the gateway warms its credentials, JWKS, DynamoDB connection and Lambda itself "
          "(startup + every 60 s); this script still warms Cognito and Bedrock", flush=True)
    scrub_aws_env()
    bedrock = bedrock_client(cfg)
    print(f"warm: {args.agent} via {url}, Bedrock {model_id}, "
          + ("one cycle" if args.once else f"every {args.interval:g} s (Ctrl-C stops)"), flush=True)
    n = 0
    with httpx.Client(base_url=url, timeout=30.0) as client:
        try:
            while True:
                n += 1
                ok = cycle(n, cfg, args.agent, client, bedrock, model_id)
                if args.once:
                    return 0 if ok else 1
                time.sleep(args.interval)
        except KeyboardInterrupt:
            print(f"warm: stopped after {n} cycles", flush=True)
            return 0


if __name__ == "__main__":
    sys.exit(main())
