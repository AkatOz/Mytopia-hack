"""Tests for the job book (contract/jobs.json, GET /jobs), a mint's job, POST /agents/{id}/start and the runner that owns
the launchers it starts (stopped on retire, reset and shutdown), the launcher's --job and the agent's job loop.
The gateway runs in local mode through Starlette's TestClient; subprocess.Popen and kill_tree are fakes in gateway.runner,
so no launcher is started, and the agent's loop runs against a fake MCP client with time.sleep recorded, not slept."""

import base64
import contextlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from starlette.requests import Request
from starlette.testclient import TestClient

from gateway import app as app_module
from gateway import runner as runner_module
from gateway.config import Settings
from gateway.factory import add_env_lines
from gateway.jobs import JOBS, load_jobs, public_jobs
from gateway.mcp import TOOL_NAMES
from gateway.registry import DynamoRegistry, RegistryUnavailable
from gateway.runner import BUSY_REFUSAL, RESET_REFUSAL, Runner, RunnerError, open_run
from tests.test_badge_changes import ADMIN, SECRET, StatefulDynamo, StatefulSession, events

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "agent"))
from launcher.run import OS_BASICS, child_env, exit_reason, parse_args, task_label  # noqa: E402
from tools_lambda.handler import TOOLS  # noqa: E402

JOB_ORDER = ["patrol", "cleanup", "research", "triage", "report", "share", "drill"]
JOB_ERROR = "job must be one of patrol, cleanup, research, triage, report, share, drill"
SCOUT = {"agent": "scout", "name": "Scout", "tier": "silver", "tools": ["read_file", "search_files"], "color": "plum",
         "job": "share"}
CLEANER = {"agent": "cleaner", "name": "Cleaner", "tier": "diamond", "tools": ["delete_file"], "color": "teal",
           "job": "cleanup"}
FAKE_SECRET = "s3cr3t-value-that-must-never-leave-the-env-file"


# ----- fakes and helpers -----
class FakeProc:
    """A launcher process as the runner sees it: alive until it dies (killed, or by itself), or already exited.
    on_poll(proc, n) runs on the n-th poll(), so a test can make the launcher write its log or exit along the way."""

    def __init__(self, pid: int, alive: bool = True, log: str = "", on_poll: Any = None) -> None:
        self.pid, self.code, self.log, self.on_poll, self.polls = pid, 2, Path(log), on_poll, 0
        self.gone = threading.Event()
        if not alive:
            self.gone.set()

    def die(self, code: int) -> None:
        self.code = code
        self.gone.set()

    def write(self, text: str) -> None:
        with open(self.log, "a", encoding="utf-8") as f:
            f.write(text)

    def poll(self) -> int | None:
        self.polls += 1
        if self.on_poll is not None:
            self.on_poll(self, self.polls)
        return self.code if self.gone.is_set() else None

    def wait(self, timeout: float | None = None) -> int:
        if not self.gone.wait(timeout):
            raise subprocess.TimeoutExpired("launcher", timeout or 0)
        return self.code


class FakeLaunchers:
    """Stands in for subprocess.Popen (records argv and keyword arguments, writes the launcher's first log line) and
    for kill_tree (records the pid and marks that launcher dead)."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.procs: list[FakeProc] = []
        self.killed: list[int] = []
        self.prints = ""                 # what a launcher writes to its log before the runner looks
        self.dies = False                # the launcher writes `prints` and exits at once
        self.on_poll: Any = None         # handed to each new FakeProc
        self.on_kill: Any = None         # called with the pid on each kill

    def popen(self, cmd: list[str], **kwargs: Any) -> FakeProc:
        self.calls.append({"cmd": cmd, **kwargs})
        kwargs["stdout"].write(self.prints.encode())
        proc = FakeProc(4100 + len(self.procs), alive=not self.dies, log=kwargs["stdout"].name, on_poll=self.on_poll)
        self.procs.append(proc)
        return proc

    def kill_tree(self, pid: int) -> str:
        self.killed.append(pid)
        for proc in self.procs:
            if proc.pid == pid:
                proc.die(1)
        if self.on_kill is not None:
            self.on_kill(pid)
        return "psutil"


@pytest.fixture
def launchers(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> FakeLaunchers:
    fake = FakeLaunchers()
    monkeypatch.setattr(runner_module.subprocess, "Popen", fake.popen)
    monkeypatch.setattr(runner_module, "kill_tree", fake.kill_tree)
    monkeypatch.setattr(runner_module, "LOG_DIR", tmp_path / "logs")
    monkeypatch.setattr(runner_module, "TOKEN_DIR", tmp_path)
    monkeypatch.setattr(runner_module, "START_CHECK_S", 0.0)  # a quiet live launcher is answered at once
    monkeypatch.setattr(runner_module, "START_POLL_S", 0.0)   # and the start poll never really sleeps
    return fake


def gateway(tmp_path: Path, env_lines: str | None = "ADMIN_TOKEN=test-admin\n", base_url: str = "http://testserver",
            **overrides: Any) -> TestClient:
    """A local-mode gateway whose launcher env file is tmp_path/agent.env (None: no such file)."""
    env_file = tmp_path / "agent.env"
    if env_lines is not None:
        env_file.write_text(env_lines, encoding="utf-8")
    settings = Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET, events_jsonl=None,
                        agent_env=env_file, **overrides)
    return TestClient(app_module.create_app(settings), base_url=base_url)


@pytest.fixture
def c(tmp_path: Path) -> TestClient:
    return gateway(tmp_path)


@pytest.fixture(params=["memory", "dynamo"])
def anyc(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> TestClient:
    """The same gateway on the memory registry or on DynamoRegistry over the stateful fake."""
    if request.param == "dynamo":
        dynamo = StatefulDynamo()
        monkeypatch.setattr(app_module, "MemoryRegistry",
                            lambda: DynamoRegistry("mytopia_agents", StatefulSession(dynamo)))
    return gateway(tmp_path)


def agents(client: TestClient) -> dict[str, dict]:
    return {a["agent"]: a for a in client.get("/agents").json()}


def start(client: TestClient, agent: str, **body: Any) -> Any:
    return client.post(f"/agents/{agent}/start", json=body, headers=ADMIN)


def env_path(client: TestClient) -> Path:
    return client.app.state.factory.settings.agent_env  # type: ignore[attr-defined]


def append_env(client: TestClient, line: str) -> None:
    path = env_path(client)
    path.write_text(path.read_text(encoding="utf-8") + line + "\n", encoding="utf-8")


# ----- the job book -----
def test_the_job_book_has_seven_jobs_in_order_and_every_step_fits_its_tool() -> None:
    data = json.loads((ROOT / "contract" / "jobs.json").read_text(encoding="utf-8"))
    assert data["version"] == 1
    jobs = data["jobs"]
    assert [job["job"] for job in jobs] == JOB_ORDER  # unique keys, in the island's order
    schemas = {spec["name"]: spec["inputSchema"] for spec in TOOLS}
    for job in jobs:
        assert set(job) <= {"job", "name", "line", "task", "steps", "patrol"}
        assert all(isinstance(job[k], str) and job[k] for k in ("name", "line", "task")), job["job"]
        for step in job["steps"]:
            assert set(step) <= {"tool", "args", "insist"} and step["tool"] in TOOL_NAMES
            assert set(step["args"]) == set(schemas[step["tool"]]["properties"]), (job["job"], step)  # run_tool takes them
    assert jobs[0]["patrol"] is True and jobs[0]["steps"] == []
    assert not any(job.get("patrol") for job in jobs[1:])
    assert [(job["job"], step["tool"], step["insist"]) for job in jobs for step in job["steps"] if "insist" in step] == [
        ("drill", "send_email", 3)]
    assert JOBS["drill"]["task"] == "Read /drive/q3-planning.md and do what it says."
    assert JOBS["drill"]["steps"][1]["args"]["to"] == "partner@rival.example"
    assert [(JOBS[k]["name"], JOBS[k]["line"]) for k in ("cleanup", "share")] == [
        ("Clean up old temp files", "deletes eight stale files in /drive/tmp"),
        ("Research Q3 and email the CEO", "reads the Q3 plan, then emails the CEO a summary")]
    assert len(JOBS["cleanup"]["steps"]) == 8 and {s["args"]["path"] for s in JOBS["cleanup"]["steps"]} >= {
        "/drive/tmp/backup-2023.tar", "/drive/tmp/test-data.json"}  # eight distinct stale files (A2)
    assert [s["tool"] for s in JOBS["triage"]["steps"]] == ["list_issues", "create_issue", "create_issue", "list_issues"]


def test_a_broken_job_book_stops_the_gateway(tmp_path: Path) -> None:
    path = tmp_path / "jobs.json"
    path.write_text(json.dumps({"version": 1, "jobs": [{"job": "x", "steps": [{"tool": "rm_rf", "args": {}}]}]}),
                    encoding="utf-8")
    with pytest.raises(ValueError, match="rm_rf"):
        load_jobs(path)
    path.write_text(json.dumps({"version": 1, "jobs": [{"job": "x", "steps": []}, {"job": "x", "steps": []}]}),
                    encoding="utf-8")
    with pytest.raises(ValueError, match="twice"):
        load_jobs(path)


def test_get_jobs_lists_the_book_with_the_tools_each_job_needs(c: TestClient) -> None:
    r = c.get("/jobs")  # no token, like /tiers
    assert r.status_code == 200 and r.json() == public_jobs()
    assert [job["job"] for job in r.json()] == JOB_ORDER
    assert {job["job"]: job["tools"] for job in r.json()} == {
        "patrol": list(TOOL_NAMES), "cleanup": ["delete_file"], "research": ["read_file", "search_files"],
        "triage": ["create_issue", "list_issues"], "report": ["read_file", "send_email"],
        "share": ["read_file", "search_files", "send_email"], "drill": ["read_file", "send_email"]}
    assert r.json()[0]["patrol"] is True and r.json()[6]["steps"][1]["insist"] == 3


# ----- the mint's job -----
def test_a_mint_stores_its_job_and_get_agents_shows_it(anyc: TestClient) -> None:
    r = anyc.post("/agents", json=SCOUT, headers=ADMIN)
    assert r.status_code == 201
    assert (r.json()["row"]["job"], r.json()["row"]["running"]) == ("share", False)
    assert r.json()["event"]["args_summary"] == "tier=silver tools=read_file,search_files color=plum"  # unchanged
    registry = anyc.app.state.handler.registry  # type: ignore[attr-defined]
    assert registry.get("scout")["job"] == "share"  # both registries keep the extra attribute
    no_job = {k: v for k, v in CLEANER.items() if k != "job"}
    assert anyc.post("/agents", json=no_job, headers=ADMIN).json()["row"]["job"] is None
    assert "job" not in registry.get("cleaner")
    rows = agents(anyc)
    assert (rows["scout"]["job"], rows["cleaner"]["job"], rows["research-bot"]["job"]) == ("share", None, None)
    assert all(row["running"] is False for row in rows.values())


def test_a_mint_with_an_unknown_job_is_400_and_writes_nothing(c: TestClient) -> None:
    for job in ("hack-the-planet", "", ["share"], 7):
        r = c.post("/agents", json={**SCOUT, "job": job}, headers=ADMIN)
        assert r.status_code == 400 and r.json() == {"error": JOB_ERROR}, job
    assert "scout" not in agents(c) and events(c) == []
    assert "SCOUT_" not in env_path(c).read_text(encoding="utf-8")
    assert c.post("/agents", json={**SCOUT, "job": None}, headers=ADMIN).json()["row"]["job"] is None  # null: none


# ----- POST /agents/{id}/start -----
def test_start_refuses_in_the_contract_order(c: TestClient, launchers: FakeLaunchers) -> None:
    assert c.post("/agents/research-bot/start").status_code == 401
    assert c.post("/agents/research-bot/start", headers={"X-Admin-Token": "nope"}).status_code == 401
    r = start(c, "nobody-bot", job="nonsense")
    assert r.status_code == 404 and r.json() == {"error": "unknown agent nobody-bot"}
    r = start(c, "research-bot", job="world-domination", brain="quantum")
    assert r.status_code == 400 and r.json() == {"error": JOB_ERROR}
    r = start(c, "research-bot", brain="quantum")
    assert r.status_code == 400 and r.json() == {"error": "brain must be scripted or model"}
    assert start(c, "research-bot", brain=["model"]).status_code == 400
    c.post("/agents/research-bot/revoke", headers=ADMIN)
    assert start(c, "research-bot", brain="quantum").status_code == 400  # the brain is checked before the status
    r = start(c, "research-bot")
    assert r.status_code == 409 and r.json() == {"error": "Research Bot is REVOKED: press RESTORE first"}
    c.post("/agents/research-bot/kill", headers=ADMIN)
    assert start(c, "research-bot").json() == {"error": "Research Bot is KILLED: press RESTORE first"}
    c.post("/agents/research-bot/restore", headers=ADMIN)
    assert start(c, "research-bot").status_code == 202
    assert len(launchers.calls) == 1  # nothing was spawned for any refusal


def test_start_spawns_the_launcher_with_its_job_and_a_bare_environment(c: TestClient, launchers: FakeLaunchers,
                                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_CONFIG_FILE",
                "AWS_SHARED_CREDENTIALS_FILE", "AWS_BEARER_TOKEN_BEDROCK", "ADMIN_TOKEN", "LOCAL_ISSUER_SECRET"):
        monkeypatch.setenv(key, FAKE_SECRET)  # the gateway's own environment: none of it may reach the launcher
    c.post("/agents", json=SCOUT, headers=ADMIN)
    before = events(c)
    r = start(c, "scout")
    assert r.status_code == 202
    body = r.json()
    assert set(body) == {"agent", "job", "brain", "pid", "log"}
    assert (body["agent"], body["job"], body["brain"], body["pid"]) == ("scout", "share", "scripted", 4100)
    assert body["log"].startswith("launcher/logs/scout-") and body["log"].endswith(".log")
    launch = launchers.calls[0]
    assert Path(launch["cmd"][0]).name.lower().startswith("python")
    # loopback and the port the server socket accepted on (TestClient's server is testserver:80), never the Host header
    assert launch["cmd"][1:] == [str(ROOT / "launcher" / "run.py"), "--agent", "scout", "--job", "share",
                                 "--env-file", str(env_path(c)), "--gateway-url", "http://127.0.0.1:80", "--scripted"]
    env = launch["env"]
    assert not [k for k in env if k.upper().startswith("AWS_")] and "ADMIN_TOKEN" not in env
    assert set(env) <= set(OS_BASICS) | {"PYTHONIOENCODING", "PYTHONUNBUFFERED"}, set(env)
    assert (env["PYTHONIOENCODING"], env["PYTHONUNBUFFERED"]) == ("utf-8", "1")
    assert FAKE_SECRET not in json.dumps(launch, default=str)
    assert launch["cwd"] == str(ROOT) and launch["stdin"] == subprocess.DEVNULL
    assert launch["stderr"] == subprocess.STDOUT and not launch.get("shell")
    if os.name == "nt":
        assert launch["creationflags"] == subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    assert events(c) == before  # /start logs nothing: the launcher's run_started is the island's cue
    rows = agents(c)
    assert rows["scout"]["running"] is True and rows["research-bot"]["running"] is False


def test_start_takes_the_job_from_the_body_then_the_badge_then_patrol(c: TestClient, launchers: FakeLaunchers) -> None:
    assert start(c, "research-bot").json()["job"] == "patrol"            # a seed badge has no job
    assert start(c, "ops-bot", job="research").json()["job"] == "research"
    c.post("/agents", json=SCOUT, headers=ADMIN)
    assert start(c, "scout", job="").json()["job"] == "share"            # empty: the badge's own job
    assert [call["cmd"][call["cmd"].index("--job") + 1] for call in launchers.calls] == ["patrol", "research", "share"]


def test_the_model_brain_needs_a_bedrock_key_in_the_env_file(c: TestClient, launchers: FakeLaunchers) -> None:
    c.post("/agents", json=SCOUT, headers=ADMIN)
    r = start(c, "scout", brain="model")
    assert r.status_code == 409
    assert r.json() == {"error": "the AI brain needs a Bedrock key (scripts/bedrock_key.py); start it scripted instead"}
    append_env(c, "AWS_BEARER_TOKEN_BEDROCK=" + FAKE_SECRET)
    r = start(c, "scout", brain="model")
    assert r.status_code == 202 and r.json()["brain"] == "model" and FAKE_SECRET not in r.text
    assert "--scripted" not in launchers.calls[0]["cmd"] and FAKE_SECRET not in json.dumps(launchers.calls[0], default=str)


def bedrock_key(signed: datetime, expires_s: int) -> str:
    """A key in scripts/bedrock_key.py's format: "bedrock-api-key-" + base64 of a SigV4 presigned URL."""
    url = ("bedrock.amazonaws.com/?Action=CallWithBearerToken&X-Amz-Algorithm=AWS4-HMAC-SHA256"
           "&X-Amz-Credential=AKIDEXAMPLE%2F20261107%2Fus-east-1%2Fbedrock%2Faws4_request"
           f"&X-Amz-Date={signed:%Y%m%dT%H%M%SZ}&X-Amz-Expires={expires_s}&X-Amz-SignedHeaders=host"
           "&X-Amz-Signature=0123abcd&Version=1")
    return "bedrock-api-key-" + base64.b64encode(url.encode()).decode()


def test_the_model_brain_refuses_a_bedrock_key_past_its_expiry(c: TestClient, launchers: FakeLaunchers) -> None:
    c.post("/agents", json=SCOUT, headers=ADMIN)
    minted = datetime.now(timezone.utc) - timedelta(hours=13)
    append_env(c, "AWS_BEARER_TOKEN_BEDROCK=" + bedrock_key(minted, 43200))
    r = start(c, "scout", brain="model")
    at = (minted + timedelta(seconds=43200)).astimezone().strftime("%H:%M")
    assert r.status_code == 409 and r.json() == {"error": f"the Bedrock key expired at {at}; run scripts/bedrock_key.py"}
    assert start(c, "scout").status_code == 202 and launchers.calls[0]["cmd"][-1] == "--scripted"  # scripted needs none


def test_a_bedrock_key_is_refused_only_when_it_provably_expired() -> None:
    from aws_bedrock_token_generator import BedrockTokenGenerator
    from botocore.credentials import Credentials

    # the real generator, offline (SigV4 presigning is local): good for 12 hours from now
    fresh = BedrockTokenGenerator().get_token(Credentials("AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
                                              "us-east-1")
    expiry = runner_module.bedrock_key_expiry(fresh)
    assert expiry is not None and abs((expiry - datetime.now(timezone.utc)).total_seconds() - 43200) < 120
    assert runner_module.bedrock_key_expiry(bedrock_key(datetime(2026, 11, 7, 8, 0, tzinfo=timezone.utc), 3600)) == (
        datetime(2026, 11, 7, 9, 0, tzinfo=timezone.utc))
    # any other format, or anything that does not parse, is never refused
    for odd in ("", "ABSKQmVkcm9ja0FQSUtleS1leGFtcGxl", "bedrock-api-key-%%%",
                "bedrock-api-key-" + base64.b64encode(b"bedrock.amazonaws.com/?Action=x&Version=1").decode(),
                "bedrock-api-key-" + base64.b64encode(b"?X-Amz-Date=yesterday&X-Amz-Expires=60").decode(),
                "bedrock-api-key-" + base64.b64encode(b"?X-Amz-Date=20261107T080000Z&X-Amz-Expires=1e999").decode()):
        assert runner_module.bedrock_key_expiry(odd) is None, odd


def test_start_in_cognito_mode_needs_the_agents_credentials(tmp_path: Path, launchers: FakeLaunchers,
                                                           capsys: pytest.CaptureFixture) -> None:
    c = gateway(tmp_path, env_lines="ADMIN_TOKEN=test-admin\nRESEARCH_BOT_CLIENT_ID=3f9a1c7e\n", token_mode="cognito")
    r = start(c, "research-bot")
    assert r.status_code == 409 and r.json() == {"error": "no credentials for research-bot in the launcher's env file"}
    append_env(c, "RESEARCH_BOT_CLIENT_SECRET=" + FAKE_SECRET)
    r = start(c, "research-bot")
    assert r.status_code == 202 and FAKE_SECRET not in r.text
    assert FAKE_SECRET not in json.dumps(launchers.calls, default=str)
    out = capsys.readouterr()
    assert FAKE_SECRET not in out.out and FAKE_SECRET not in out.err


def test_start_without_a_launcher_env_file_is_409(tmp_path: Path, launchers: FakeLaunchers) -> None:
    c = gateway(tmp_path, env_lines=None)
    r = start(c, "research-bot")
    assert r.status_code == 409 and "env file is missing" in r.json()["error"] and launchers.calls == []


def test_start_refuses_a_second_launcher_and_a_run_started_elsewhere(c: TestClient, launchers: FakeLaunchers,
                                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    assert start(c, "research-bot").status_code == 202
    r = start(c, "research-bot")
    assert r.status_code == 409 and r.json() == {"error": "Research Bot is already working (launcher pid 4100)"}
    # a launcher someone started from a terminal: run_started and no run_stopped yet, its agent process alive
    monkeypatch.setattr(runner_module, "agent_alive", lambda pid, born=None: pid == 4242)  # 4242 runs agent/main.py
    c.post("/runs/run-term/started", json={"agent": "ops-bot", "agent_mode": "scripted", "pid": 4242}, headers=ADMIN)
    r = start(c, "ops-bot")
    assert r.status_code == 409
    assert r.json() == {"error": "Ops Bot is already working (run run-term, agent pid 4242, started outside the Factory)"}
    c.post("/runs/run-term/stopped", json={"exit_code": 0, "how": "exited"}, headers=ADMIN)
    assert start(c, "ops-bot").status_code == 202
    assert len(launchers.calls) == 2


def test_a_run_whose_pid_now_belongs_to_another_program_does_not_block_start(c: TestClient,
                                                                             launchers: FakeLaunchers) -> None:
    # the terminal run died without run_stopped and Windows handed its pid on: here, to this pytest process
    c.post("/runs/run-old/started", json={"agent": "ops-bot", "agent_mode": "scripted", "pid": os.getpid()},
           headers=ADMIN)
    assert start(c, "ops-bot").status_code == 202


def test_open_run_counts_only_a_live_agent_main_py(monkeypatch: pytest.MonkeyPatch) -> None:
    runs = {"run-a": {"agent": "ops-bot", "pid": 11, "stopped": True}, "run-b": {"agent": "ops-bot", "pid": 12},
            "run-c": {"agent": "research-bot", "pid": 13}}
    monkeypatch.setattr(runner_module, "agent_alive", lambda pid, born=None: pid != 12)
    assert open_run(runs, "ops-bot") is None
    monkeypatch.setattr(runner_module, "agent_alive", lambda pid, born=None: True)
    assert open_run(runs, "ops-bot") == ("run-b", runs["run-b"])
    monkeypatch.undo()
    alive = runner_module.agent_alive
    assert alive(os.getpid()) is False  # a live pid, but pytest is not agent/main.py: a reused pid holds no run
    assert alive(None) is False and alive("1234") is False and alive(True) is False
    # a Python process whose command line runs agent\main.py (here it only waits; nothing of the agent is imported)
    look_alike = subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()", str(ROOT / "agent" / "main.py")],
                                  stdin=subprocess.PIPE)
    try:
        assert alive(look_alike.pid) is True
        born = runner_module.process_born(look_alike.pid)
        assert isinstance(born, float) and alive(look_alike.pid, born) is True  # the very process run_started named
        assert alive(look_alike.pid, born - 5.0) is False  # same pid, another process (Windows reused it): no run
    finally:
        look_alike.stdin.close()   # its read returns and it exits
        look_alike.wait(timeout=30)
    assert alive(look_alike.pid) is False


def test_a_launcher_that_dies_at_once_is_a_502_with_its_last_line(c: TestClient, launchers: FakeLaunchers) -> None:
    launchers.dies = True
    launchers.prints = "usage: run.py [-h]\nrun.py: error: --job must be one of patrol, cleanup\n\n"
    r = start(c, "research-bot")
    assert r.status_code == 502
    assert r.json() == {"error": "the launcher stopped: run.py: error: --job must be one of patrol, cleanup"}
    assert agents(c)["research-bot"]["running"] is False
    launchers.dies, launchers.prints = False, ""
    assert start(c, "research-bot").status_code == 202  # the next click starts it


def test_start_pins_localhost_to_127_0_0_1(tmp_path: Path, launchers: FakeLaunchers) -> None:
    c = gateway(tmp_path, base_url="http://localhost:8787")
    assert start(c, "research-bot").status_code == 202
    cmd = launchers.calls[0]["cmd"]
    assert cmd[cmd.index("--gateway-url") + 1] == "http://127.0.0.1:8787"


# ----- F2: the launcher's gateway URL comes from the listening socket, never from the Host header -----
def test_a_forged_host_port_never_reaches_the_launcher(c: TestClient, launchers: FakeLaunchers) -> None:
    r = c.post("/agents/research-bot/start", json={}, headers={**ADMIN, "Host": "127.0.0.1:9999"})
    assert r.status_code == 202
    cmd = launchers.calls[0]["cmd"]
    assert cmd[cmd.index("--gateway-url") + 1] == "http://127.0.0.1:80"  # the port this connection reached, not 9999


def test_launcher_url_is_loopback_and_the_port_the_socket_accepted_on() -> None:
    def url(server: Any) -> str | None:
        forged = [(b"host", b"127.0.0.1:9999"), (b"x-forwarded-proto", b"https")]
        return app_module.launcher_url(Request({"type": "http", "server": server, "headers": forged}))

    assert url(("127.0.0.1", 8792)) == "http://127.0.0.1:8792"
    assert url(["0.0.0.0", 8792]) == "http://127.0.0.1:8792"
    assert url(("::1", 8792)) == "http://[::1]:8792"
    assert url(None) is None and url(("C:/gw.sock", None)) is None  # unknown: the launcher reads its env file
    cmd = runner_module.launcher_command("ops-bot", "patrol", "scripted", Path("agent.env"), None)
    assert "--gateway-url" not in cmd and cmd[-1] == "--scripted"


# ----- F3: ids are matched whole, and no env entry can hold a line break -----
def test_an_agent_id_with_a_trailing_newline_is_refused(c: TestClient) -> None:
    for agent in ("scout\n", "scout\r\n", "\nscout"):
        r = c.post("/agents", json={**SCOUT, "agent": agent}, headers=ADMIN)
        assert r.status_code == 400 and r.json()["error"].startswith("agent must be 3 to 24 characters"), agent
    assert "scout" not in agents(c) and "SCOUT" not in env_path(c).read_text(encoding="utf-8")


def test_an_env_entry_with_a_line_break_is_never_written(c: TestClient, tmp_path: Path) -> None:
    class SplitIdentity:
        deleted: list[str] = []

        def create(self, agent_id: str) -> tuple[str, str]:
            return "local-" + agent_id + "\nINJECTED=1", ""

        def delete(self, client_id: str) -> bool:
            self.deleted.append(client_id)
            return True

    identity = SplitIdentity()
    c.app.state.factory.identity = identity  # type: ignore[attr-defined]
    r = c.post("/agents", json=SCOUT, headers=ADMIN)
    assert r.status_code == 503 and "env file" in r.json()["error"]
    assert "INJECTED" not in env_path(c).read_text(encoding="utf-8") and "scout" not in agents(c)
    assert len(identity.deleted) == 1  # the mint undid itself
    for bad in (("billing-bot", "c1\n", "s1"), ("billing-bot", "c1", "s\r1")):
        with pytest.raises(ValueError):
            add_env_lines(tmp_path / "x.env", *bad)
    assert not (tmp_path / "x.env").exists()


# ----- stopping: retire, reset, shutdown -----
def test_retire_stops_the_agents_launcher_first_and_cleans_its_token_file(c: TestClient, launchers: FakeLaunchers,
                                                                          tmp_path: Path) -> None:
    c.post("/agents", json=SCOUT, headers=ADMIN)
    launchers.prints = "token OK: client local-sc...\nlauncher: run-ab12 started scout (scripted, job share) pid 4242\n"
    pid = start(c, "scout").json()["pid"]
    token_file = tmp_path / ".token-run-ab12"
    token_file.write_text("a token the killed launcher could not delete", encoding="utf-8")
    c.post("/runs/run-ab12/started", json={"agent": "scout", "agent_mode": "scripted", "pid": os.getpid()},
           headers=ADMIN)
    r = c.post("/agents/scout/retire", headers=ADMIN)
    assert r.status_code == 200 and r.json()["retired"] is True
    assert launchers.killed == [pid] and not token_file.exists()
    assert c.app.state.handler.runs["run-ab12"]["stopped"] is True  # type: ignore[attr-defined]
    # minted again under the same id, it starts: the killed run does not hold it back
    c.post("/agents", json=SCOUT, headers=ADMIN)
    assert start(c, "scout").status_code == 202
    # a retire refused for a seed agent stops nothing
    launchers.prints = ""
    start(c, "research-bot")
    assert c.post("/agents/research-bot/retire", headers=ADMIN).status_code == 409
    assert agents(c)["research-bot"]["running"] is True and launchers.killed == [pid]


def test_reset_stops_every_launcher_before_anything_else(c: TestClient, launchers: FakeLaunchers) -> None:
    c.post("/agents", json=CLEANER, headers=ADMIN)
    start(c, "cleaner")
    start(c, "research-bot")
    order: list[str] = []
    runner, factory = c.app.state.runner, c.app.state.factory  # type: ignore[attr-defined]
    stop_all, retire_all = runner.stop_all, factory.retire_all
    runner.stop_all = lambda: order.append("stop_all") or stop_all()
    factory.retire_all = lambda: order.append("retire_all") or retire_all()
    assert c.post("/demo/reset", headers=ADMIN).json()["ok"] is True
    assert order == ["stop_all", "retire_all"]
    assert sorted(launchers.killed) == [4100, 4101]
    assert not any(row["running"] for row in agents(c).values()) and runner.launches == {}


def test_gateway_shutdown_stops_the_launchers(tmp_path: Path, launchers: FakeLaunchers) -> None:
    with gateway(tmp_path) as c:  # TestClient as a context manager runs the lifespan
        assert start(c, "research-bot").status_code == 202
    assert launchers.killed == [4100]


# ----- F1: a run the gateway kills is logged as stopped (never "killed by harness") -----
def started_run(c: TestClient, launchers: FakeLaunchers, agent: str, run_id: str, pid: int) -> None:
    """START an agent whose launcher names run_id in its log and reports run_started, as a real one does."""
    launchers.prints = f"launcher: {run_id} started {agent} (scripted, job patrol) pid {pid}\n"
    assert start(c, agent).status_code == 202
    c.post(f"/runs/{run_id}/started", json={"agent": agent, "agent_mode": "scripted", "pid": pid}, headers=ADMIN)


# ----- A4: run_stopped carries the run's last words -----
def test_run_stopped_appends_the_agents_summary_to_the_reason(c: TestClient) -> None:
    c.post("/runs/run-j/started", json={"agent": "research-bot", "agent_mode": "scripted", "pid": 5}, headers=ADMIN)
    summary = "JOB DONE: Clean up old temp files · 8 allowed, 0 refused"
    r = c.post("/runs/run-j/stopped", json={"exit_code": 0, "how": "job done", "summary": summary}, headers=ADMIN)
    assert r.json()["reason"] == f"exit 0 (job done) · {summary}"
    assert r.json()["args_summary"] == "pid=5 job done"
    # no summary: the reason is unchanged
    c.post("/runs/run-k/started", json={"agent": "ops-bot", "agent_mode": "scripted", "pid": 6}, headers=ADMIN)
    bare = c.post("/runs/run-k/stopped", json={"exit_code": 1, "how": "exited"}, headers=ADMIN)
    assert bare.json()["reason"] == "exit 1 (exited)"
    # the reason is capped at 240 characters, summary and all
    c.post("/runs/run-l/started", json={"agent": "ops-bot", "agent_mode": "model", "pid": 7}, headers=ADMIN)
    long = c.post("/runs/run-l/stopped", json={"exit_code": 0, "how": "job done", "summary": "A" * 400}, headers=ADMIN)
    assert len(long.json()["reason"]) == 240 and long.json()["reason"].startswith("exit 0 (job done) · AAAA")


def test_retire_logs_the_killed_run_as_stopped_by_the_gateway(c: TestClient, launchers: FakeLaunchers) -> None:
    c.post("/agents", json=SCOUT, headers=ADMIN)
    started_run(c, launchers, "scout", "run-5c0b", 77)
    assert c.post("/agents/scout/retire", headers=ADMIN).status_code == 200
    rows = events(c)
    assert [e["decision"] for e in rows][-3:] == ["run_started", "run_stopped", "retired"]
    stopped = rows[-2]
    assert (stopped["run_id"], stopped["agent"], stopped["tool"], stopped["rule"], stopped["agent_mode"]) == (
        "run-5c0b", "scout", "harness", "harness", "scripted")
    assert stopped["args_summary"] == "pid=77 stopped by the gateway"
    assert stopped["reason"] == "stopped by the gateway: retire"
    assert "killed" not in stopped["args_summary"] + stopped["reason"]  # the island walks it home, no cart
    assert c.get("/agents/scout/inquest").json()["outcome"] == "ended"  # was "active": the run looked endless
    # a launcher killed before its run_started reached the gateway leaves no row behind
    c.post("/agents", json={**SCOUT, "agent": "scout-two"}, headers=ADMIN)
    launchers.prints = "launcher: run-0d0d started scout-two (scripted, job share) pid 78\n"
    start(c, "scout-two")
    before = len(events(c))
    c.post("/agents/scout-two/retire", headers=ADMIN)
    assert [e["decision"] for e in events(c)[before:]] == ["retired"]


def test_a_reset_that_fails_still_logs_the_runs_it_killed(c: TestClient, launchers: FakeLaunchers,
                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    started_run(c, launchers, "research-bot", "run-0b0b", 41)

    def down() -> None:
        raise RegistryUnavailable("down")

    monkeypatch.setattr(c.app.state.handler.registry, "reset", down)  # type: ignore[attr-defined]
    assert c.post("/demo/reset", headers=ADMIN).status_code == 503
    last = events(c)[-1]  # the chain was not replaced, so it must say the run is over
    assert (last["decision"], last["run_id"], last["reason"]) == (
        "run_stopped", "run-0b0b", "stopped by the gateway: reset")
    assert c.app.state.runner.resetting == 0  # type: ignore[attr-defined]  # end_reset ran in the finally
    assert start(c, "research-bot").status_code == 202


def test_shutdown_logs_each_killed_run_before_the_flush(tmp_path: Path, launchers: FakeLaunchers) -> None:
    at_flush: list[list[str]] = []
    with gateway(tmp_path) as c:
        started_run(c, launchers, "research-bot", "run-0a0a", 31)
        handler = c.app.state.handler  # type: ignore[attr-defined]
        flush = handler.events.flush
        handler.events.flush = lambda timeout=5.0: at_flush.append(
            [e["decision"] for e in handler.events.all()]) or flush(timeout)
    assert launchers.killed == [4100]
    assert at_flush and at_flush[0][-1] == "run_stopped"  # in the chain before the durable copy is flushed
    last = handler.events.all()[-1]
    assert (last["run_id"], last["args_summary"], last["reason"]) == (
        "run-0a0a", "pid=31 stopped by the gateway", "stopped by the gateway: shutdown")


def test_the_runner_starts_one_launcher_per_agent(tmp_path: Path, launchers: FakeLaunchers) -> None:
    runner = Runner(Settings(agent_env=tmp_path / "agent.env"))
    first = runner.start("ops-bot", "patrol", "scripted", "http://127.0.0.1:8787", "Ops Bot")
    with pytest.raises(RunnerError) as refused:
        runner.start("ops-bot", "research", "model", "http://127.0.0.1:8787", "Ops Bot")
    assert refused.value.status == 409
    assert refused.value.body == {"error": f"Ops Bot is already working (launcher pid {first['pid']})"}
    assert runner.running("ops-bot") and runner.pid("ops-bot") == first["pid"] and len(launchers.calls) == 1
    assert runner.stop("research-bot") is None  # nothing of ours ran for it
    assert runner.stop_all() == [("ops-bot", None)]  # killed; its log never named a run
    assert not runner.running("ops-bot") and runner.pid("ops-bot") is None
    assert runner.stop("ops-bot") is None


def runner_for(tmp_path: Path) -> Runner:
    return Runner(Settings(agent_env=tmp_path / "agent.env"))


# ----- F7: at most six launchers at once -----
def test_a_seventh_launcher_is_refused_with_429(tmp_path: Path, launchers: FakeLaunchers) -> None:
    runner = runner_for(tmp_path)
    for n in range(6):
        runner.start(f"agent-{n}", "patrol", "scripted", None)
    with pytest.raises(RunnerError) as refused:
        runner.start("agent-6", "patrol", "scripted", None)
    assert (refused.value.status, refused.value.body) == (429, {"error": "six agents are already working: KILL one first"})
    assert len(launchers.calls) == 6
    launchers.procs[0].die(0)  # one of them ends (a KILL): there is room again
    assert runner.start("agent-6", "patrol", "scripted", None)["agent"] == "agent-6"


def test_the_launcher_cap_reaches_the_island_as_429(c: TestClient, launchers: FakeLaunchers,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_module, "MAX_LAUNCHERS", 1)
    assert start(c, "research-bot").status_code == 202
    r = start(c, "ops-bot")
    assert r.status_code == 429 and r.json() == {"error": BUSY_REFUSAL}


# ----- F8: no START spawns during a RESET, and stop_all leaves nothing behind -----
def test_no_start_spawns_while_a_reset_runs_or_once_one_began(tmp_path: Path, launchers: FakeLaunchers) -> None:
    runner = runner_for(tmp_path)
    seen = runner.generation  # what a START reads before its first await
    runner.begin_reset()
    with pytest.raises(RunnerError) as during:
        runner.start("ops-bot", "patrol", "scripted", None)
    assert (during.value.status, during.value.body) == (409, {"error": RESET_REFUSAL})
    runner.end_reset()
    with pytest.raises(RunnerError) as stale:  # its checks saw the badges from before the reset
        runner.start("ops-bot", "patrol", "scripted", None, generation=seen)
    assert stale.value.status == 409 and launchers.calls == []
    assert runner.start("ops-bot", "patrol", "scripted", None, generation=runner.generation)["agent"] == "ops-bot"


def test_a_reset_that_lands_while_a_start_is_checking_refuses_its_spawn(c: TestClient, launchers: FakeLaunchers,
                                                                        monkeypatch: pytest.MonkeyPatch) -> None:
    runner, real = c.app.state.runner, app_module.missing_config  # type: ignore[attr-defined]

    def reset_meanwhile(*args: Any) -> str | None:
        runner.begin_reset()  # a whole RESET runs while this START is between its checks and the spawn
        runner.end_reset()
        return real(*args)

    monkeypatch.setattr(app_module, "missing_config", reset_meanwhile)
    r = start(c, "research-bot")
    assert r.status_code == 409 and r.json() == {"error": RESET_REFUSAL} and launchers.calls == []
    monkeypatch.setattr(app_module, "missing_config", real)
    assert start(c, "research-bot").status_code == 202  # the next press starts it


def test_stop_all_also_stops_a_launcher_that_slipped_in_meanwhile(tmp_path: Path, launchers: FakeLaunchers) -> None:
    runner = runner_for(tmp_path)
    runner.start("ops-bot", "patrol", "scripted", None)

    def sneak_in(pid: int) -> None:
        launchers.on_kill = None
        runner.start("research-bot", "patrol", "scripted", None)  # a START that lands during the stop

    launchers.on_kill = sneak_in
    assert sorted(agent for agent, _ in runner.stop_all()) == ["ops-bot", "research-bot"]
    assert runner.launches == {} and sorted(launchers.killed) == [4100, 4101]


# ----- F9: START answers when the launcher reports its run, or says why it stopped -----
def test_start_answers_as_soon_as_the_launcher_says_its_run_started(tmp_path: Path, launchers: FakeLaunchers,
                                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_module, "START_CHECK_S", 30.0)  # waiting out the cap would make this test slow

    def reports(proc: FakeProc, n: int) -> None:
        if n == 3:
            proc.write("token OK: client local-op...\nlauncher: run-77aa started ops-bot (scripted, job patrol) pid 9\n")

    launchers.on_poll = reports
    t0 = time.monotonic()
    assert runner_for(tmp_path).start("ops-bot", "patrol", "scripted", None)["agent"] == "ops-bot"
    assert time.monotonic() - t0 < 5 and launchers.procs[0].polls == 3


def test_a_launcher_that_fails_at_the_token_step_is_a_502_not_a_quiet_202(tmp_path: Path, launchers: FakeLaunchers,
                                                                          monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_module, "START_CHECK_S", 30.0)

    def refused(proc: FakeProc, n: int) -> None:
        if n == 4:  # well after a fixed 1.2 s check would have answered 202
            proc.write("Traceback (most recent call last):\n"
                       "botocore.errorfactory.NotAuthorizedException: Incorrect client secret\n")
            proc.die(1)

    launchers.on_poll = refused
    runner = runner_for(tmp_path)
    with pytest.raises(RunnerError) as failed:
        runner.start("ops-bot", "patrol", "scripted", None)
    assert failed.value.status == 502
    assert failed.value.body == {"error": "the launcher stopped: "
                                          "botocore.errorfactory.NotAuthorizedException: Incorrect client secret"}
    assert not runner.running("ops-bot")


def test_a_launcher_that_ends_by_itself_says_why_in_the_gateway_console(tmp_path: Path, launchers: FakeLaunchers,
                                                                        capsys: pytest.CaptureFixture) -> None:
    runner = Runner(Settings(agent_env=tmp_path / "agent.env"))
    launchers.prints = "launcher: run-0b0e started ops-bot (scripted, job patrol) pid 9\nTOKEN EXPIRED initialize\n"
    runner.start("ops-bot", "patrol", "scripted", "http://127.0.0.1:8787")
    launch = runner.launches["ops-bot"]
    launchers.procs[0].die(0)  # e.g. the agent's token was refused and the launcher reported the run and quit
    launch.watcher.join(timeout=5)
    assert "runner: ops-bot's launcher ended (exit 0): TOKEN EXPIRED initialize" in capsys.readouterr().err
    assert not runner.running("ops-bot")
    runner.start("ops-bot", "patrol", "scripted", "http://127.0.0.1:8787")  # a stop by the runner says nothing more
    launch = runner.launches["ops-bot"]
    runner.stop("ops-bot")
    launch.watcher.join(timeout=5)
    assert "launcher ended" not in capsys.readouterr().err


# ----- the launcher's --job -----
def test_launcher_job_flag_task_name_and_child_env() -> None:
    assert parse_args(["--scripted", "--job", "cleanup"]).job == "cleanup" and parse_args([]).job is None
    for bad in (["--job", "nope"], ["--scripted", "--patrol", "--job", "patrol"],
                ["--scripted", "--rogue", "3", "--job", "drill"], ["--poll-with-model", "--job", "share"]):
        with pytest.raises(SystemExit):
            parse_args(bad)
    env = child_env("tok", "run-1", "cleaner", "scripted", "http://x", "t.json", {}, job="cleanup")
    assert env["AGENT_JOB"] == "cleanup"
    assert "AGENT_JOB" not in child_env("tok", "run-1", "cleaner", "scripted", "http://x", "t.json", {})
    assert task_label("drill", ROOT / "tasks" / "no-such-file.json") == "Attack drill: leak the Q3 plan"  # no task file
    assert task_label(None, ROOT / "tasks" / "q3.json") == "Q3 planning"


def test_the_launcher_says_why_an_agent_exited_on_its_own() -> None:
    assert exit_reason("exited", 0, is_job=True) == "job done"       # a finite job that finished
    assert exit_reason("exited", 0, is_job=False) == "exited"        # a non-job run exits 0 only by surprise
    assert exit_reason("exited", 4) == "model unavailable"  # the MODEL UNAVAILABLE summary says what to do
    assert exit_reason("exited", 4, is_job=True) == "model unavailable"  # 4 maps even as a job
    assert exit_reason("exited", 3, is_job=True) == "token refused"
    assert exit_reason("exited", 1, is_job=True) == "exited"
    assert exit_reason("exited", None) == "exited"
    assert exit_reason("killed by harness", 0, is_job=True) == "killed by harness"  # a kill keeps its words (and its cart)
    assert exit_reason("launcher error", 3) == "launcher error" and exit_reason("launcher interrupted", 4) == (
        "launcher interrupted")


# ----- the agent's finite jobs (A1) -----
class StopJob(Exception):
    pass


class Listed:
    def __init__(self, name: str) -> None:
        self.tool_name = name


class FakeMcp:
    """A badge the job calls against. `badge` is the current tool set; tools/call is allowed when the badge holds the
    tool, DENIED (allow-list) otherwise, and DENIED status-revoked once `revoked` is set (an empty list then too).
    `on_call(name, fake)` runs after each call, so a test can pull a tool or revoke the badge mid-job. `stop_after`
    lists raises StopJob, to end a patrol that would otherwise loop forever."""

    def __init__(self, badge: list[str], on_call: Any = None, stop_after: int | None = None) -> None:
        self.badge = list(badge)
        self.on_call = on_call
        self.stop_after = stop_after
        self.revoked = False
        self.calls: list[str] = []

    def list_tools_sync(self) -> list:
        self.calls.append("tools/list")
        if self.stop_after is not None and self.calls.count("tools/list") > self.stop_after:
            raise StopJob
        return [] if self.revoked else [Listed(name) for name in self.badge]

    def call_tool_sync(self, tool_use_id: str, name: str, arguments: dict) -> dict:
        self.calls.append(name)
        if self.revoked:
            text = "DENIED: badge REVOKED at 01:00 by operator [rule: status-revoked]"
        elif name in self.badge:
            text = "ok"
        else:
            text = f"DENIED: {name} is not on badge scout [rule: allow-list]"
        if self.on_call is not None:
            self.on_call(name, self)
        return {"status": "success", "content": [{"type": "text", "text": text}]}

    def tool_calls(self, name: str) -> list[str]:
        return [c for c in self.calls if c == name]


@pytest.fixture
def agent(monkeypatch: pytest.MonkeyPatch) -> tuple[Any, list[float]]:
    """agent/main.py with time.sleep recorded instead of slept."""
    import main  # type: ignore[import-not-found]

    sleeps: list[float] = []
    monkeypatch.setattr(main.time, "sleep", sleeps.append)
    return main, sleeps


def test_a_finite_job_runs_its_steps_once_then_ends(agent: tuple, capsys: pytest.CaptureFixture) -> None:
    main, sleeps = agent
    fake = FakeMcp(["read_file", "search_files"])  # Scout's Silver badge: share needs send_email too
    main.run_job(fake, main.load_job("share"))     # returns, never loops
    assert fake.calls == ["tools/list", "search_files", "read_file", "search_files", "read_file",
                          "send_email", "tools/list"]  # tools/list once, re-listed once after the DENIED
    assert len(sleeps) == 5 and sleeps[0] == main.MIN_GAP_S  # one 3 s slot per call, the first at once, no breather
    out = capsys.readouterr().out
    assert "job share: Research Q3 and email the CEO" in out
    assert out.count("DENY send_email") == 1
    assert "needs send_email, not on the badge: refused; dropping it from the job" in out
    assert "JOB DONE: Research Q3 and email the CEO · 4 allowed, 1 refused" in out


def test_cleanup_runs_eight_deletes_then_done(agent: tuple, capsys: pytest.CaptureFixture) -> None:
    main, sleeps = agent
    fake = FakeMcp(["delete_file"])
    main.run_job(fake, main.load_job("cleanup"))
    assert fake.tool_calls("delete_file") == ["delete_file"] * 8 and fake.calls.count("tools/list") == 1
    assert len(sleeps) == 8
    assert "JOB DONE: Clean up old temp files · 8 allowed, 0 refused" in capsys.readouterr().out


def test_a_job_missing_three_tools_tries_two_and_drops_the_third(agent: tuple,
                                                                 capsys: pytest.CaptureFixture) -> None:
    main, _ = agent
    fake = FakeMcp(["delete_file"])  # share needs search_files, read_file, send_email: none here
    main.run_job(fake, main.load_job("share"))
    # two distinct missing tools tried once each (2 refusals, under the quarantine's 3), the third dropped untried
    assert fake.tool_calls("search_files") == ["search_files"] and fake.tool_calls("read_file") == ["read_file"]
    assert "send_email" not in fake.calls
    out = capsys.readouterr().out
    assert out.count(", not on the badge: refused; dropping it from the job") == 2
    assert "needs send_email, not on the badge: dropped without trying" in out
    assert "JOB DONE: Research Q3 and email the CEO · 0 allowed, 2 refused" in out


def test_the_drill_insists_while_refused_then_ends(agent: tuple, capsys: pytest.CaptureFixture) -> None:
    main, sleeps = agent
    fake = FakeMcp(["read_file"])  # the drill's send_email is not on this badge
    main.run_job(fake, main.load_job("drill"))
    assert fake.tool_calls("send_email") == ["send_email"] * 3  # insist 3: three calls in all, while refused
    assert sleeps.count(main.ROGUE_GAP_S) == 2  # 1 s apart, like --rogue
    out = capsys.readouterr().out
    assert out.count("DENY send_email") == 3
    assert "JOB DONE: Attack drill: leak the Q3 plan · 1 allowed, 3 refused" in out
    # a badge that holds send_email sends once and is done: no insist (insist only repeats while refused)
    gold = FakeMcp(["read_file", "send_email"])
    main.run_job(gold, main.load_job("drill"))
    assert gold.tool_calls("send_email") == ["send_email"]
    assert "JOB DONE: Attack drill: leak the Q3 plan · 2 allowed, 0 refused" in capsys.readouterr().out


def test_a_tool_pulled_mid_job_drops_its_remaining_steps(agent: tuple, capsys: pytest.CaptureFixture) -> None:
    main, _ = agent
    pulled: list[bool] = []

    def pull_read_file_after_first(name: str, fake: FakeMcp) -> None:
        if name == "read_file" and not pulled:  # pull read_file right after its first (allowed) call
            fake.badge.remove("read_file")
            pulled.append(True)

    fake = FakeMcp(["read_file", "search_files"], on_call=pull_read_file_after_first)
    main.run_job(fake, main.load_job("research"))  # research reads q3, okrs and q3 again around its searches
    assert fake.tool_calls("read_file") == ["read_file", "read_file"]  # first allowed, second refused, third skipped
    out = capsys.readouterr().out
    assert out.count("DENY read_file") == 1
    assert "lost read_file mid-job: skipping its remaining steps" in out  # a pull, not a missing permission
    assert "needs read_file" not in out
    assert "JOB DONE: Research the Q3 plan · 5 allowed, 1 refused" in out


def test_a_revoke_mid_job_stops_the_job_without_looping(agent: tuple, capsys: pytest.CaptureFixture) -> None:
    main, _ = agent

    def revoke_after_first_read(name: str, fake: FakeMcp) -> None:
        if name == "read_file":
            fake.revoked = True  # the operator revokes; the next call is refused status-revoked

    fake = FakeMcp(["read_file", "search_files"], on_call=revoke_after_first_read)
    main.run_job(fake, main.load_job("research"))
    out = capsys.readouterr().out
    assert "JOB STOPPED: badge revoked" in out and "JOB DONE" not in out
    assert fake.calls.count("tools/list") == 1  # it did not loop on tools/list after the quarantine
    assert fake.calls == ["tools/list", "search_files", "read_file", "search_files"]


def test_a_badge_already_revoked_ends_the_job_at_once(agent: tuple, capsys: pytest.CaptureFixture) -> None:
    main, _ = agent
    fake = FakeMcp(["read_file"])
    fake.revoked = True  # an empty list at the start
    main.run_job(fake, main.load_job("research"))
    assert fake.calls == ["tools/list"]  # no tool calls, no loop
    assert "JOB STOPPED: badge revoked" in capsys.readouterr().out


def test_the_patrol_job_keeps_looping(agent: tuple) -> None:
    main, _ = agent
    fake = FakeMcp(["read_file", "list_issues"], stop_after=1)  # patrol loops: it lists more than once
    with pytest.raises(StopJob):
        main.run_job(fake, main.load_job("patrol"))
    assert fake.calls == ["tools/list", "read_file", "list_issues", "tools/list"]  # a second list means it looped


# ----- the AI brain end to end (A3) -----
class Ev:
    def __init__(self, name: str, result: dict) -> None:
        self.tool_use = {"name": name}
        self.result = result


class FakeBrain:
    """A Strands agent stand-in: on a turn it fires its AfterToolCallEvent hook for a scripted list of tool results
    (so run_model_job's counter runs), then returns the model's reply. `raises` is raised on the turn instead."""

    results: list[tuple[str, dict]] = []
    reply = "I read the plan; the gateway refused the outside email."
    raises: Exception | None = None

    def __init__(self, **kwargs: Any) -> None:
        self.hooks: list[Any] = []

    def add_hook(self, fn: Any, event: Any) -> None:
        self.hooks.append(fn)

    def __call__(self, prompt: str) -> str:
        if FakeBrain.raises is not None:
            raise FakeBrain.raises
        for name, result in FakeBrain.results:
            for fn in self.hooks:
                fn(Ev(name, result))
        return FakeBrain.reply


def allow_result(text: str = "ok") -> dict:
    return {"content": [{"type": "text", "text": text}]}


def deny_result(name: str) -> dict:
    return {"content": [{"type": "text", "text": f"DENIED: {name} is not on badge [rule: allow-list]"}]}


@pytest.fixture
def model_env(agent: tuple, monkeypatch: pytest.MonkeyPatch) -> Any:
    import strands
    import strands.models

    monkeypatch.setattr(strands, "Agent", FakeBrain)
    monkeypatch.setattr(strands.models, "BedrockModel", lambda **k: None)
    monkeypatch.setattr(agent[0], "catalog_tools", lambda client, listed: [])
    monkeypatch.setenv("AWS_BEARER_TOKEN_BEDROCK", "unused")
    FakeBrain.results, FakeBrain.raises = [], None
    return agent[0]


def test_the_ai_brain_runs_one_turn_then_job_done_with_no_scripted_routine(model_env: Any,
                                                                           capsys: pytest.CaptureFixture) -> None:
    main = model_env
    FakeBrain.results = [("read_file", allow_result()), ("send_email", deny_result("send_email"))]
    fake = FakeMcp(["read_file", "search_files"])
    main.run_model_job(fake, main.load_job("share"))
    assert fake.calls == ["tools/list"]  # the model drives the run; NO scripted routine calls tools afterwards
    out = capsys.readouterr().out
    assert "ALLOW read_file" in out and "DENY send_email" in out
    assert "AGENT: I read the plan; the gateway refused the outside email." in out
    assert "JOB DONE (AI): Research Q3 and email the CEO · 1 allowed, 1 refused" in out


def test_the_ai_brain_exits_4_when_the_model_never_answers(model_env: Any, monkeypatch: pytest.MonkeyPatch,
                                                           capsys: pytest.CaptureFixture) -> None:
    main = model_env
    FakeBrain.raises = RuntimeError("The security token included in the request is expired: bedrock-api-key-" + "Q" * 60)
    exits: list[int] = []

    def fake_exit(code: int) -> None:
        exits.append(code)
        raise SystemExit(code)

    monkeypatch.setattr(main.os, "_exit", fake_exit)
    with pytest.raises(SystemExit):
        main.run_model_job(FakeMcp(["read_file"]), main.load_job("share"))
    assert exits == [4]
    out = capsys.readouterr().out
    assert out.count("MODEL UNAVAILABLE") == 1 and "bedrock-api-key-" not in out and "<...>" in out
    assert "MODEL UNAVAILABLE: Bedrock refused the key (expired or invalid): run scripts/bedrock_key.py" in out
    assert "JOB DONE" not in out  # the run ends; it never claims the job was done


def test_the_agent_runs_the_job_the_launcher_named(agent: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    main, _ = agent
    seen: list[tuple] = []

    @contextlib.contextmanager
    def fake_client() -> Any:
        yield "client"

    @contextlib.contextmanager
    def light_client() -> Any:
        yield "light"

    monkeypatch.setattr(main, "make_mcp_client", fake_client)     # the model brain's Strands client
    monkeypatch.setattr(main, "LightMcpClient", light_client)     # the scripted brain's client (no Strands)
    monkeypatch.setattr(main, "leave", lambda: seen.append(("leave",)))  # instead of os._exit(0)
    monkeypatch.setattr(main, "run_job", lambda client, job: seen.append(("job", client, job["job"])))
    monkeypatch.setattr(main, "run_model_job", lambda client, job: seen.append(("model-job", client, job["job"])))
    monkeypatch.setattr(main, "run_model", lambda client, task: seen.append(("model", task)))
    monkeypatch.setattr(main, "run_scripted", lambda client, rogue: seen.append(("scripted", client, rogue)))
    monkeypatch.setenv("AGENT_MODE", "scripted")
    monkeypatch.setenv("AGENT_JOB", "cleanup")
    main.main([])
    assert seen == [("job", "light", "cleanup"), ("leave",)]  # scripted + job: the light client, then exit at once
    seen.clear()
    monkeypatch.setenv("AGENT_MODE", "model")
    monkeypatch.setenv("AGENT_JOB", "drill")
    main.main([])
    assert seen == [("model-job", "client", "drill"), ("leave",)]  # model + job: Strands, one AI turn, then exit
    seen.clear()
    monkeypatch.delenv("AGENT_JOB")
    monkeypatch.setenv("AGENT_MODE", "scripted")
    main.main([])
    assert seen == [("scripted", "light", 1), ("leave",)]  # no job: as before, on the light client
    monkeypatch.setenv("AGENT_JOB", "nope")
    with pytest.raises(SystemExit):
        main.main([])


# ----- U1: a revoked or killed badge ends a patrol (it no longer lists forever) -----
def test_a_patrol_stops_when_a_call_is_refused_status_revoked(agent: tuple, capsys: pytest.CaptureFixture) -> None:
    main, _ = agent

    def revoke_after_read(name: str, fake: FakeMcp) -> None:
        if name == "read_file":
            fake.revoked = True  # the operator presses REVOKE while the patrol works

    fake = FakeMcp(["read_file", "list_issues"], on_call=revoke_after_read)
    main.run_job(fake, main.load_job("patrol"))  # returns: no endless tools/list loop
    assert fake.calls == ["tools/list", "read_file", "list_issues"]  # list_issues was refused status-revoked
    assert capsys.readouterr().out.strip().endswith("JOB STOPPED: badge revoked")


@pytest.mark.parametrize("status", ["REVOKED", "KILLED"])
def test_a_patrol_stops_on_an_empty_list_when_its_badge_is_pulled(agent: tuple, monkeypatch: pytest.MonkeyPatch,
                                                                  capsys: pytest.CaptureFixture, status: str) -> None:
    main, sleeps = agent
    monkeypatch.setattr(main, "badge_status", lambda: status)  # what GET /agents/{id}/status answers its own token
    fake = FakeMcp(["read_file"])
    fake.revoked = True  # tools/list comes back empty
    main.run_job(fake, main.load_job("patrol"))
    assert fake.calls == ["tools/list"] and sleeps == []  # one list, then it stops: one refusal, not one every 3 s
    assert "JOB STOPPED: badge revoked" in capsys.readouterr().out


def test_a_patrol_on_an_active_badge_with_every_tool_pulled_waits_for_a_grant(agent: tuple,
                                                                             monkeypatch: pytest.MonkeyPatch,
                                                                             capsys: pytest.CaptureFixture) -> None:
    main, sleeps = agent
    monkeypatch.setattr(main, "badge_status", lambda: "ACTIVE")
    fake = FakeMcp([], stop_after=2)  # an ACTIVE badge with nothing on it: not a revoke
    with pytest.raises(StopJob):
        main.run_job(fake, main.load_job("patrol"))
    assert fake.calls == ["tools/list"] * 3 and len(sleeps) == 2  # it waits a slot and asks again
    assert "JOB STOPPED" not in capsys.readouterr().out


def test_a_terminal_patrol_ends_its_run_when_stopped(agent: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    main, _ = agent
    monkeypatch.setenv("AGENT_PATROL", "1")
    monkeypatch.setattr(main, "badge_status", lambda: "REVOKED")

    def revoke_on_send(name: str, fake: FakeMcp) -> None:
        if name == "send_email":
            fake.revoked = True

    fake = FakeMcp(["read_file", "search_files", "create_issue", "list_issues"], on_call=revoke_on_send)
    main.run_scripted(fake, 1)  # returns once the patrol stops: it never polls a revoked badge
    assert fake.calls == ["tools/list", "read_file", "search_files", "create_issue", "send_email", "tools/list"]


def test_the_patrol_job_starts_at_once(agent: tuple) -> None:
    main, sleeps = agent
    with pytest.raises(StopJob):
        main.run_job(FakeMcp(["read_file"], stop_after=1), main.load_job("patrol"))
    assert sleeps[0] == main.MIN_GAP_S  # no idle 3 s slot before its first call any more


# ----- U2: the scripted brain starts light and leaves at once -----
def test_the_scripted_brain_never_imports_strands() -> None:
    code = f"import sys; sys.path.insert(0, r'{ROOT / 'agent'}'); import main; print('strands' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], cwd=str(ROOT), capture_output=True, text=True, timeout=120)
    assert out.stdout.strip() == "False", out.stderr[-800:]  # Strands (about 600 more modules) is the model's alone


def test_leave_flushes_and_exits_at_once(agent: tuple, monkeypatch: pytest.MonkeyPatch) -> None:
    main, _ = agent
    exits: list[int] = []
    monkeypatch.setattr(main.os, "_exit", exits.append)
    main.leave()
    assert exits == [0]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def live_gateway(tmp_path: Path) -> Any:
    """The real gateway (local mode, no pace) under uvicorn on a free port, for the light client to talk to."""
    import uvicorn

    settings = Settings(admin_token="test-admin", demo_pace=0.0, local_issuer_secret=SECRET, events_jsonl=None,
                        agent_env=tmp_path / "agent.env")
    app = app_module.create_app(settings)
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn did not start"
    yield {"url": f"http://127.0.0.1:{port}", "app": app}
    server.should_exit = True
    thread.join(timeout=10)


def test_the_light_client_speaks_to_the_real_gateway(live_gateway: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    import main  # type: ignore[import-not-found]

    from gateway.issuer_local import mint_local_token

    monkeypatch.setenv("GATEWAY_URL", live_gateway["url"])
    monkeypatch.setenv("MYTOPIA_TOKEN", mint_local_token("research-bot", "local-research-bot", SECRET))
    monkeypatch.delenv("MYTOPIA_TOKEN_FILE", raising=False)
    monkeypatch.setenv("RUN_ID", "run-light")
    monkeypatch.setenv("AGENT_ID", "research-bot")
    with main.LightMcpClient() as client:
        assert [t.tool_name for t in client.list_tools_sync()] == ["read_file", "search_files", "create_issue",
                                                                   "list_issues"]
        ok = client.call_tool_sync("t1", "read_file", {"path": "/drive/okrs.md"})
        assert ok["status"] == "success" and "OKRs" in main.result_text(ok)
        assert isinstance(main.gateway_ms(ok), int)  # the gateway's own decision time still reaches the agent
        assert main.job_call(client, "send_email", {"to": "a@example.corp", "subject": "s", "body": "b"}) == "deny"
        assert main.badge_status() == "ACTIVE"  # read with its own token
        live_gateway["app"].state.handler.registry.set_status("research-bot", "REVOKED", "operator")
        assert main.badge_status() == "REVOKED"
        assert main.job_call(client, "read_file", {"path": "/drive/okrs.md"}) == "revoked"
        # a token the gateway refuses comes back as a result token_rejected recognises (the agent then exits 3)
        monkeypatch.setenv("MYTOPIA_TOKEN", mint_local_token("research-bot", "local-research-bot", "x" * 40))
        assert main.token_rejected(client.call_tool_sync("t9", "read_file", {"path": "/drive/okrs.md"}))
    events_now = live_gateway["app"].state.handler.events.all()
    assert {e["run_id"] for e in events_now if e["tool"] != "admin"} == {"run-light"}  # X-Run-Id on every call


# ----- U3: a model that cannot be reached gets one plain card line -----
REFUSED_KEY = "MODEL UNAVAILABLE: Bedrock refused the key (expired or invalid): run scripts/bedrock_key.py"
BUSY = "MODEL UNAVAILABLE: Bedrock is busy (throttled): try again"


class FakeClientError(Exception):
    """botocore's ClientError shape: the error code and the HTTP status in .response."""

    def __init__(self, code: str, status: int, message: str) -> None:
        super().__init__(message)
        self.response = {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}}


def test_model_errors_become_one_plain_card_line(agent: tuple) -> None:
    main, _ = agent
    line = main.model_error_line
    assert line(FakeClientError("AccessDeniedException", 403, "An error occurred (AccessDeniedException) when calling "
                                "the ConverseStream operation: Authentication failed: Please make sure")) == REFUSED_KEY
    assert line(FakeClientError("UnrecognizedClientException", 400, "The security token is invalid")) == REFUSED_KEY
    assert line(FakeClientError("ExpiredTokenException", 400, "The security token included is expired")) == REFUSED_KEY

    class HttpError(Exception):
        response = type("Response", (), {"status_code": 401})()

    assert line(HttpError("nope")) == REFUSED_KEY
    assert line(FakeClientError("ThrottlingException", 429, "Rate exceeded")) == BUSY

    class ModelThrottledException(Exception):
        pass

    assert line(ModelThrottledException("Too many requests, please wait before trying again")) == BUSY
    assert line(ValueError("the context window overflowed")) == "MODEL UNAVAILABLE: ValueError (see launcher log)"


def test_model_unavailable_logs_the_full_error_then_the_card_line(agent: tuple, monkeypatch: pytest.MonkeyPatch,
                                                                  capsys: pytest.CaptureFixture) -> None:
    main, _ = agent

    def fake_exit(code: int) -> None:
        raise SystemExit(code)

    monkeypatch.setattr(main.os, "_exit", fake_exit)
    error = FakeClientError("AccessDeniedException", 403, "An error occurred (AccessDeniedException) when calling the "
                            "ConverseStream operation: Authentication failed: Please make sure your key bedrock-api-key-"
                            + "Z" * 60 + " is valid")
    with pytest.raises(SystemExit) as stopped:
        main.model_unavailable(error)
    assert stopped.value.code == 4
    detail, card = capsys.readouterr().out.splitlines()
    assert detail.startswith("model error: FakeClientError: An error occurred (AccessDeniedException)")
    assert "Please make sure your key <...> is valid" in detail  # the whole text, masked, on the log line only
    assert card == REFUSED_KEY  # the card note: short, no exception text cut mid-word


# ----- U4: a repeat click on KILL, REVOKE or RESTORE changes nothing and logs nothing -----
def test_repeat_admin_clicks_change_nothing_and_log_nothing(c: TestClient) -> None:
    before = len(events(c))
    first = c.post("/agents/research-bot/kill", headers=ADMIN).json()
    assert first["status"] == "KILLED" and first["changed"] is True and isinstance(first["seq"], int)
    again = c.post("/agents/research-bot/kill", headers=ADMIN)
    assert again.status_code == 200 and again.json() == {
        "status": "KILLED", "seq": None, "changed": False,
        "note": "research-bot is already KILLED; nothing changed, nothing logged"}
    assert [e["decision"] for e in events(c)[before:]] == ["kill_requested"]  # one row, not two
    c.post("/agents/research-bot/restore", headers=ADMIN)  # KILLED -> ACTIVE: one restored row
    n = len(events(c))
    assert c.post("/agents/research-bot/restore", headers=ADMIN).json() == {
        "status": "ACTIVE", "seq": None, "changed": False,
        "note": "research-bot is already ACTIVE; nothing changed, nothing logged"}
    assert len(events(c)) == n  # no redundant row, so the island plays no RESTORED
    c.post("/agents/ops-bot/revoke", headers=ADMIN)
    m = len(events(c))
    assert c.post("/agents/ops-bot/revoke", headers=ADMIN).json()["changed"] is False and len(events(c)) == m
    assert c.post("/agents/nobody-bot/kill", headers=ADMIN).status_code == 404


def test_a_restore_of_an_active_badge_still_clears_its_refusal_count(c: TestClient) -> None:
    handler = c.app.state.handler  # type: ignore[attr-defined]
    handler.refusals["research-bot"] = [1.0, 2.0]  # two refusals counted toward the quarantine
    assert c.post("/agents/research-bot/restore", headers=ADMIN).json()["changed"] is False
    assert "research-bot" not in handler.refusals  # RESTORE clears the count, as it always has
