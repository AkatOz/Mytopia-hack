"""The MYTOPIA harness: mints the agent's token, starts agent/main.py with a scrubbed environment and owns that process.
It reports run_started and run_stopped to the gateway and kills the whole process tree as soon as the badge status reads KILLED (INTERFACES.md section 10)."""

import argparse
import json
import os
import secrets
import subprocess
import sys
import time
import warnings
from pathlib import Path

import httpx
from dotenv import dotenv_values

ROOT = Path(__file__).resolve().parent.parent
EMPTY_INI = ROOT / "launcher" / "empty.ini"
OS_BASICS = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT"]
DEFAULT_POLL_MS = 250   # how often the badge status is read; the worst case from KILL to the kill starting
KILL_WAIT_S = 2.0       # how long psutil waits for the tree to die before taskkill gets a second go
HTTP_TIMEOUT_S = 2.0    # control API calls go to 127.0.0.1; a slow answer must not hold up the kill loop


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    """Read the command line."""
    p = argparse.ArgumentParser(description="Start one MYTOPIA agent run and own its process.")
    p.add_argument("--agent", default="research-bot")
    p.add_argument("--task", default="tasks/q3.json")
    p.add_argument("--scripted", action="store_true", help="no model: the fixed tool sequence")
    p.add_argument("--env-file", default=str(ROOT / "agent" / ".env"))
    p.add_argument("--gateway-url", default=None, help="overrides GATEWAY_URL from the env file")
    p.add_argument("--token-mode", choices=["local", "cognito"], default=None, help="overrides TOKEN_MODE")
    p.add_argument("--poll-ms", type=int, default=None, help="overrides HARNESS_POLL_MS")
    p.add_argument("--token-ttl", type=int, default=300, metavar="SECONDS",
                   help="lifetime of each local-mode token (Cognito decides its own); rotation keeps the run alive")
    p.add_argument("--poll-with-model", action="store_true",
                   help="model mode: one model turn per poll instead of the in-code read_file")
    return p.parse_args(argv)


def short(secret: str) -> str:
    """Printable form of a secret: the first 12 characters plus '...'."""
    return secret[:12] + "..."


def env_key(agent_id: str, suffix: str) -> str:
    """research-bot + CLIENT_ID -> RESEARCH_BOT_CLIENT_ID."""
    return agent_id.upper().replace("-", "_") + "_" + suffix


def mint_token(agent_id: str, mode: str, cfg: dict[str, str], ttl_s: int = 300) -> tuple[str, str, int]:
    """Return (access_token, client_id, expires_in_seconds) from Cognito or the local issuer (ttl_s is local only)."""
    if mode == "cognito":
        import boto3
        from botocore import UNSIGNED
        from botocore.config import Config

        client_id = cfg.get(env_key(agent_id, "CLIENT_ID"), "")
        secret = cfg.get(env_key(agent_id, "CLIENT_SECRET"), "")
        if not client_id or not secret:
            sys.exit(f"launcher: {env_key(agent_id, 'CLIENT_ID')} or _CLIENT_SECRET is missing from the env file")
        cognito = boto3.client("cognito-idp", region_name=cfg.get("AWS_REGION") or "us-east-1",
                               config=Config(signature_version=UNSIGNED))
        scope = cfg.get("COGNITO_SCOPE") or "mytopia/tools"
        result = cognito.get_client_token(ClientId=client_id, Secret=secret, Scopes=[scope])
        auth = result["ClientAuthenticationResult"]
        return auth["AccessToken"], client_id, int(auth.get("ExpiresIn", 300))
    try:
        from gateway.issuer_local import mint_local_token
    except ImportError:
        from launcher.local_token import mint_local_token  # same claims; used until the gateway's issuer exists
    client_id = "local-" + agent_id
    warnings.filterwarnings("ignore", message="The HMAC key")  # the demo's short shared secret; keep the stage terminal clean
    token = mint_local_token(agent_id, client_id, cfg.get("LOCAL_ISSUER_SECRET") or "change-me-too", ttl_s=ttl_s)
    return token, client_id, ttl_s


def rotation_interval(ttl_s: int) -> float:
    """Seconds between re-mints: max(30, 80% of the TTL), but never 30 s or more when that would outlive the token."""
    interval = max(30.0, ttl_s * 0.8)
    return interval if interval < ttl_s else ttl_s * 0.8


def write_token_file(path: Path, token: str) -> None:
    """Atomically replace the token file (temp file + os.replace); retried because Windows refuses a replace while the agent reads."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(token, encoding="utf-8")
    for attempt in range(40):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 39:
                raise
            time.sleep(0.05)


def remove_token_file(path: Path) -> None:
    """Delete the token file and any leftover temp file at the end of the run."""
    for p in (path, path.with_name(path.name + ".tmp")):
        for _ in range(20):
            try:
                p.unlink(missing_ok=True)
                break
            except PermissionError:
                time.sleep(0.05)


def child_env(token: str, run_id: str, agent_id: str, mode: str, gateway_url: str,
              task_file: str, cfg: dict[str, str], token_file: str = "",
              poll_with_model: bool = False) -> dict[str, str]:
    """Build the agent's whole environment: the variables INTERFACES.md section 2 allows and nothing else
    (plus MYTOPIA_TOKEN_FILE for rotation and AGENT_POLL_WITH_MODEL when asked)."""
    env = {k: os.environ[k] for k in OS_BASICS if k in os.environ}
    env.update({
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
        "MYTOPIA_TOKEN": token,
        "RUN_ID": run_id,
        "AGENT_ID": agent_id,
        "AGENT_MODE": mode,
        "GATEWAY_URL": gateway_url,
        "TASK_FILE": task_file,
        "AWS_BEARER_TOKEN_BEDROCK": cfg.get("AWS_BEARER_TOKEN_BEDROCK") or "",
        "BEDROCK_MODEL_ID": cfg.get("BEDROCK_MODEL_ID") or "us.amazon.nova-2-lite-v1:0",
        "AWS_REGION": cfg.get("AWS_REGION") or "us-east-1",
        # Point boto at an empty file so no ~/.aws profile can leak into the agent.
        "AWS_CONFIG_FILE": str(EMPTY_INI),
        "AWS_SHARED_CREDENTIALS_FILE": str(EMPTY_INI),
    })
    if token_file:
        env["MYTOPIA_TOKEN_FILE"] = token_file
    if poll_with_model:
        env["AGENT_POLL_WITH_MODEL"] = "1"
    return env


def python_exe() -> str:
    """The venv interpreter if it exists, else the one running the launcher."""
    venv = ROOT / ".venv" / "Scripts" / "python.exe"
    return str(venv) if venv.exists() else sys.executable


def post(client: httpx.Client, path: str, body: dict) -> None:
    """POST to the control API; a failure is printed, never fatal (the run matters more than the log)."""
    try:
        r = client.post(path, json=body)
        if r.status_code >= 300:
            print(f"launcher: POST {path} -> HTTP {r.status_code}", file=sys.stderr, flush=True)
    except httpx.HTTPError as e:
        print(f"launcher: POST {path} failed: {e}", file=sys.stderr, flush=True)


def read_status(client: httpx.Client, agent_id: str) -> str | None:
    """GET /agents/{id}/status; None when the gateway does not answer."""
    try:
        r = client.get(f"/agents/{agent_id}/status")
        return r.json().get("status") if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


def kill_with_psutil(pid: int) -> bool:
    """Kill pid's children (all levels) and then pid itself, and wait up to 2 s; True when every one of them is gone.
    Measured on the demo laptop: 23-28 ms, against 350-450 ms for taskkill /T /F (which starts a new process)."""
    import psutil

    try:
        parent = psutil.Process(pid)
        procs = parent.children(recursive=True) + [parent]  # children first: listed while the parent still exists
    except psutil.NoSuchProcess:
        return True
    except psutil.Error:
        return False  # AccessDenied or similar: never raise out of a kill, let the taskkill pass have its go
    for p in procs:
        try:
            p.kill()
        except psutil.Error:
            pass  # already gone, or denied: wait_procs reports a survivor and the taskkill pass follows
    try:
        _, alive = psutil.wait_procs(procs, timeout=KILL_WAIT_S)
    except psutil.Error:
        return False
    return not alive


def kill_tree(pid: int) -> str:
    """Kill pid and all its children: psutil first, then taskkill /T /F (Windows) or killpg as a second pass."""
    if kill_with_psutil(pid):
        return "psutil"
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.killpg(os.getpgid(pid), 9)
        except OSError:
            pass
    return "psutil+taskkill" if os.name == "nt" else "psutil+killpg"


def stop_child(proc: subprocess.Popen) -> str:
    """Kill the agent's process tree and reap it; returns how it was killed. Never raises on a slow exit."""
    method = kill_tree(proc.pid)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        method += " (still exiting after 15 s)"
    return method


def stop_if_unowned(proc: subprocess.Popen, how: str) -> str:
    """After the watch loop: if no kill was done yet ("exited") and the agent still runs, an unexpected error left the
    loop, so kill it now. After a kill that was merely slow, never kill twice or replace the real reason."""
    if how == "exited" and proc.poll() is None:
        stop_child(proc)
        return "launcher error"
    return how


def main(argv: list[str] | None = None) -> int:
    """Run one agent from token to exit; returns the launcher's own exit code."""
    args = parse_args(argv)
    env_file = Path(args.env_file)
    cfg = {k: v or "" for k, v in dotenv_values(env_file).items()} if env_file.exists() else {}
    gateway_url = (args.gateway_url or cfg.get("GATEWAY_URL") or "http://127.0.0.1:8787").rstrip("/")
    token_mode = args.token_mode or cfg.get("TOKEN_MODE") or "local"
    poll_s = (args.poll_ms or int(cfg.get("HARNESS_POLL_MS") or DEFAULT_POLL_MS)) / 1000
    mode = "scripted" if args.scripted else "model"
    task_path = Path(args.task) if Path(args.task).is_absolute() else ROOT / args.task
    if mode == "model" and not cfg.get("AWS_BEARER_TOKEN_BEDROCK"):
        sys.exit(f"launcher: AWS_BEARER_TOKEN_BEDROCK is empty in {env_file}; run scripts/bedrock_key.py or use --scripted")
    task_name = json.loads(task_path.read_text(encoding="utf-8")).get("name", task_path.stem)

    ttl_s = max(1, args.token_ttl)
    token, client_id, expires_in = mint_token(args.agent, token_mode, cfg, ttl_s)
    print(f"token OK: client {client_id[:8]}..., scope mytopia/tools, expires in {expires_in} s "
          f"[{token_mode} token {short(token)}]", flush=True)

    EMPTY_INI.write_text("", encoding="utf-8")
    run_id = "run-" + secrets.token_hex(2)
    token_file = ROOT / "launcher" / f".token-{run_id}"
    write_token_file(token_file, token)
    try:
        return own_run(args, cfg, token, client_id, expires_in, token_mode, ttl_s, run_id, token_file,
                       gateway_url, poll_s, mode, task_path, task_name)
    finally:
        remove_token_file(token_file)


def own_run(args: argparse.Namespace, cfg: dict[str, str], token: str, client_id: str, expires_in: int,
            token_mode: str, ttl_s: int, run_id: str, token_file: Path, gateway_url: str, poll_s: float,
            mode: str, task_path: Path, task_name: str) -> int:
    """Start the agent, report it, rotate its token, watch the badge and kill or reap it; returns 0."""
    env = child_env(token, run_id, args.agent, mode, gateway_url, str(task_path), cfg,
                    token_file=str(token_file), poll_with_model=args.poll_with_model)
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    proc = subprocess.Popen([python_exe(), str(ROOT / "agent" / "main.py")], env=env, cwd=str(ROOT),
                            creationflags=flags, start_new_session=(os.name != "nt"))
    print(f"launcher: {run_id} started {args.agent} ({mode}) pid {proc.pid}", flush=True)

    admin = {"X-Admin-Token": cfg.get("ADMIN_TOKEN") or "change-me"}
    with httpx.Client(base_url=gateway_url, headers=admin, timeout=HTTP_TIMEOUT_S) as client:
        post(client, f"/runs/{run_id}/started",
             {"agent": args.agent, "task": task_name, "agent_mode": mode, "pid": proc.pid,
              "client_id": client_id, "expires_in": expires_in})
        how, kill_ms = "exited", None
        next_rotation = time.monotonic() + rotation_interval(expires_in)
        try:
            while proc.poll() is None:
                if read_status(client, args.agent) == "KILLED":
                    t0 = time.monotonic()
                    method = stop_child(proc)
                    kill_ms = int((time.monotonic() - t0) * 1000)
                    how = "killed by harness"
                    print(f"launcher: KILLED -> {method} in {kill_ms} ms (kill to process gone)", flush=True)
                    break
                if time.monotonic() >= next_rotation:
                    next_rotation = rotate(args.agent, token_mode, cfg, ttl_s, token_file)
                time.sleep(poll_s)
        except KeyboardInterrupt:
            stop_child(proc)
            how = "launcher interrupted"
        finally:  # run_stopped is posted on every path, so the island never waits for a run that is gone
            how = stop_if_unowned(proc, how)  # never leave an agent running unowned
            code = proc.poll()
            post(client, f"/runs/{run_id}/stopped", {"exit_code": code, "how": how, "kill_ms": kill_ms})
    print(f"launcher: {run_id} stopped, exit {code} ({how})", flush=True)
    return 0


def rotate(agent_id: str, token_mode: str, cfg: dict[str, str], ttl_s: int, token_file: Path) -> float:
    """Mint a fresh token, rewrite the token file and return when the next rotation is due.
    A failed mint is printed and retried in 5 s; the agent keeps the old token until it expires."""
    try:
        token, client_id, expires_in = mint_token(agent_id, token_mode, cfg, ttl_s)
        write_token_file(token_file, token)
    except Exception as e:  # noqa: BLE001 - Cognito or disk trouble must not kill the run
        print(f"launcher: token rotation failed ({type(e).__name__}: {str(e)[:120]}); retrying in 5 s", flush=True)
        return time.monotonic() + 5
    print(f"token rotated: client {client_id[:8]}..., expires in {expires_in} s", flush=True)
    return time.monotonic() + rotation_interval(expires_in)


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT))  # so gateway.issuer_local and launcher.local_token import from the repo root
    sys.exit(main())
