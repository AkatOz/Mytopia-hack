"""The runner: starts launcher/run.py for an agent the island asked to start (POST /agents/{id}/start) and owns that
launcher, so retire, /demo/reset and the gateway's shutdown can stop it. The launcher's environment holds the OS basics
and nothing else: it reads its own config (token secrets, admin token) from the launcher's env file, never from the
gateway's environment."""

import base64
import os
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import psutil
from dotenv import dotenv_values

from gateway.config import REPO_ROOT
from launcher.run import OS_BASICS, env_key, kill_tree, python_exe, remove_token_file

LOG_DIR = REPO_ROOT / "launcher" / "logs"   # one log per start, <agent>-<YYYYmmddTHHMMSS>.log (git-ignored)
TOKEN_DIR = REPO_ROOT / "launcher"          # where a launcher keeps .token-<run id> while it runs
START_CHECK_S = 5.0   # START waits at most this long for the launcher's "started" line (token minted, agent spawned)
START_POLL_S = 0.05   # how often it looks at the launcher's log and process meanwhile
REAP_S = 5.0          # after the kill, how long to wait for the launcher's exit code
MAX_LAUNCHERS = 6     # launchers working at once; a seventh START is refused, so a stray script cannot swamp the laptop
BRAINS = ("scripted", "model")
RUN_LINE = re.compile(r"launcher: (run-[0-9a-f]{4}) started ")   # the launcher's start line names its run
RESET_REFUSAL = "RESET in progress: press START again after the island reloads"
BUSY_REFUSAL = "six agents are already working: KILL one first"
# scripts/bedrock_key.py (aws-bedrock-token-generator 1.1.0): "bedrock-api-key-" + base64(SigV4 presigned URL)
BEDROCK_KEY_PREFIX = "bedrock-api-key-"


class RunnerError(Exception):
    """A start that did not happen: the HTTP status and the JSON body to answer with."""

    def __init__(self, status: int, body: dict) -> None:
        super().__init__(body.get("error", ""))
        self.status = status
        self.body = body


@dataclass
class Launch:
    proc: subprocess.Popen
    log: Path
    job: str
    brain: str
    stopping: bool = False                  # the runner is killing it (retire, reset, shutdown)
    watcher: threading.Thread | None = None


def launcher_env() -> dict[str, str]:
    """The launcher's whole environment: the OS basics plus two Python switches. No AWS_*, no ADMIN_TOKEN, nothing
    else of the gateway's."""
    env = {k: os.environ[k] for k in OS_BASICS if k in os.environ}
    env.update({"PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
    return env


def launcher_command(agent: str, job: str, brain: str, env_file: Path, gateway_url: str | None) -> list[str]:
    """The launcher's argv (a list: no shell ever parses it). Without a gateway URL the launcher takes GATEWAY_URL
    from its env file."""
    cmd = [python_exe(), str(REPO_ROOT / "launcher" / "run.py"), "--agent", agent, "--job", job,
           "--env-file", str(env_file)]
    if gateway_url:
        cmd += ["--gateway-url", gateway_url]
    return cmd + ["--scripted"] if brain == "scripted" else cmd


def bedrock_key_expiry(key: str) -> datetime | None:
    """When a short-term Bedrock key from scripts/bedrock_key.py stops working at the latest: the X-Amz-Date plus the
    X-Amz-Expires of the presigned URL inside it. None for a key in any other format, or one that does not parse:
    such a key is never refused here (a key that dies early is reported by the agent at run time, exit 4)."""
    if not key.startswith(BEDROCK_KEY_PREFIX):
        return None
    try:
        url = base64.b64decode(key[len(BEDROCK_KEY_PREFIX):], validate=True).decode("utf-8")
        query = parse_qs(url.partition("?")[2])
        signed = datetime.strptime(query["X-Amz-Date"][0], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        return signed + timedelta(seconds=int(query["X-Amz-Expires"][0]))
    except (ValueError, KeyError, IndexError, OverflowError):  # binascii and Unicode errors are ValueErrors
        return None


def missing_config(settings: Any, agent: str, brain: str) -> str | None:
    """Why the launcher could not run this agent from its env file, or None. Checks that the agent's lines are filled
    in and, for the model brain, that the Bedrock key is there and not past its expiry; no value is kept, returned or
    printed (only the key's expiry time)."""
    path = settings.agent_env
    if path is None or not Path(path).is_file():
        return "the launcher's env file is missing (AGENT_ENV): nothing to start the agent with"
    creds = {env_key(agent, "CLIENT_ID"), env_key(agent, "CLIENT_SECRET")}
    try:
        values = dotenv_values(path)
    except OSError:
        return "could not read the launcher's env file; try again"
    filled = {k for k in creds if values.get(k)}
    bedrock = values.get("AWS_BEARER_TOKEN_BEDROCK") or ""
    expires = bedrock_key_expiry(bedrock) if brain == "model" else None
    if settings.token_mode == "cognito" and filled != creds:
        return f"no credentials for {agent} in the launcher's env file"
    if brain == "model" and not bedrock:
        return "the AI brain needs a Bedrock key (scripts/bedrock_key.py); start it scripted instead"
    if expires is not None and expires <= datetime.now(timezone.utc):
        return f"the Bedrock key expired at {expires.astimezone().strftime('%H:%M')}; run scripts/bedrock_key.py"
    return None


def process_born(pid: object) -> float | None:
    """The create time of pid, noted at run_started so a reused pid can be told apart later (psutil tells processes
    apart by (pid, create time)); None when the pid is not a positive int or cannot be read."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    try:
        return psutil.Process(pid).create_time()
    except psutil.Error:
        return None


def agent_alive(pid: object, born: float | None = None) -> bool:
    """Is pid a running Python process whose command line runs agent/main.py, and (when born is known) the very process
    run_started named? A pid that is gone, one Windows has since handed to another program or to ANOTHER agent (pids
    are reused; the create time differs), or one we cannot read, is not: only that run's own agent holds the run."""
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        proc = psutil.Process(pid)
        name, cmd, created = proc.name(), proc.cmdline(), proc.create_time()
    except psutil.Error:  # gone, a zombie, or access denied (then it is not our agent either)
        return False
    if not name.lower().startswith("python"):
        return False
    if born is not None and abs(created - born) > 0.01:
        return False  # the pid now belongs to a newer process
    return any(arg.replace("/", "\\").lower().endswith("agent\\main.py") for arg in cmd[1:])


def open_run(runs: dict[str, dict], agent: str) -> tuple[str, dict] | None:
    """The newest run of this agent that posted run_started, never run_stopped, and whose agent process is still a
    running agent/main.py (a launcher someone started from a terminal), or None."""
    for run_id, run in reversed(list(runs.items())):
        if run.get("agent") == agent and not run.get("stopped") and agent_alive(run.get("pid"), run.get("born")):
            return run_id, run
    return None


def last_line(path: Path) -> str:
    """The last non-empty line of a launcher log, at most 200 characters."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return "(no log)"
    return next((line.strip() for line in reversed(lines) if line.strip()), "(no output)")[:200]


def run_id_in(path: Path) -> str | None:
    """The run id from the launcher's start line in its log ("launcher: run-ab12 started ..."), or None."""
    try:
        match = RUN_LINE.search(path.read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return None
    return match.group(1) if match else None


class Runner:
    """The launchers this gateway started, at most one per agent and MAX_LAUNCHERS in all; the table changes only
    under one lock, so two quick clicks cannot start two launchers for one agent, and no START spawns during a RESET."""

    def __init__(self, settings: Any) -> None:
        self.settings = settings
        self.lock = threading.Lock()
        self.launches: dict[str, Launch] = {}
        self.generation = 0   # moves when a RESET begins and when it ends: a START that read an older value is refused
        self.resetting = 0    # RESETs in progress; no START spawns while this is above 0

    def begin_reset(self) -> None:
        """POST /demo/reset, first thing: refuse every START until end_reset, including one already past its checks."""
        with self.lock:
            self.resetting += 1
            self.generation += 1

    def end_reset(self) -> None:
        """POST /demo/reset, last thing (in a finally). The generation moves again, so a START that began during the
        reset (its checks saw the old badges) is refused as well."""
        with self.lock:
            self.resetting = max(0, self.resetting - 1)
            self.generation += 1

    def _live(self, agent: str) -> Launch | None:
        """This agent's launcher if it is still running (call with the lock held)."""
        launch = self.launches.get(agent)
        return launch if launch is not None and launch.proc.poll() is None else None

    def running(self, agent: str) -> bool:
        with self.lock:
            return self._live(agent) is not None

    def pid(self, agent: str) -> int | None:
        """The pid of this agent's live launcher, or None."""
        with self.lock:
            launch = self._live(agent)
            return launch.proc.pid if launch is not None else None

    def start(self, agent: str, job: str, brain: str, gateway_url: str | None, name: str | None = None,
              generation: int | None = None) -> dict:
        """Spawn launcher/run.py for this agent and job, its output in launcher/logs/, and answer once it reports its
        run started. RunnerError: 409 during a RESET (or when one began since the route read `generation`) or when a
        launcher of this agent already runs, 429 at MAX_LAUNCHERS, 502 when it cannot start or exits before its
        "started" line. Returns the 202 body."""
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        log = LOG_DIR / f"{agent}-{time.strftime('%Y%m%dT%H%M%S')}.log"
        cmd = launcher_command(agent, job, brain, Path(self.settings.agent_env), gateway_url)
        # no console window pops up on stage, and Ctrl+C in the gateway's console never reaches the launcher
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        with self.lock:
            if self.resetting or (generation is not None and generation != self.generation):
                raise RunnerError(409, {"error": RESET_REFUSAL})
            live = self._live(agent)
            if live is not None:
                raise RunnerError(409, {"error": f"{name or agent} is already working (launcher pid {live.proc.pid})"})
            if sum(1 for other in list(self.launches) if self._live(other) is not None) >= MAX_LAUNCHERS:
                raise RunnerError(429, {"error": BUSY_REFUSAL})
            try:
                with open(log, "ab") as out:
                    proc = subprocess.Popen(cmd, cwd=str(REPO_ROOT), stdin=subprocess.DEVNULL, stdout=out,
                                            stderr=subprocess.STDOUT, env=launcher_env(), creationflags=flags,
                                            start_new_session=(os.name != "nt"))
            except OSError as exc:
                raise RunnerError(502, {"error": f"the launcher could not start: {type(exc).__name__}"}) from None
            launch = Launch(proc, log, job, brain)
            self.launches[agent] = launch
        if not self._started(launch):  # outside the lock: the launcher's own GET /agents asks running()
            with self.lock:
                if self.launches.get(agent) is launch:
                    del self.launches[agent]
            raise RunnerError(502, {"error": f"the launcher stopped: {last_line(log)}"})
        rel = f"launcher/logs/{log.name}"
        print(f"runner: started {agent} (job {job}, {brain}) launcher pid {proc.pid}, log {rel}",
              file=sys.stderr, flush=True)
        launch.watcher = threading.Thread(target=self._watch, args=(agent, launch), name=f"runner-{agent}",
                                          daemon=True)
        launch.watcher.start()
        return {"agent": agent, "job": job, "brain": brain, "pid": proc.pid, "log": rel}

    def _started(self, launch: Launch) -> bool:
        """Look every START_POLL_S, for at most START_CHECK_S: True as soon as the log shows the launcher's "started"
        line (its token was minted and its agent spawned), False when it exits before that line (a refused token, a
        bad flag), and True at the cap if it is still alive and quiet (a slow network: answered as before)."""
        deadline = time.monotonic() + START_CHECK_S
        while True:
            if run_id_in(launch.log) is not None:
                return True
            if launch.proc.poll() is not None:
                return run_id_in(launch.log) is not None  # it may have written the line just before it exited
            if time.monotonic() >= deadline:
                return True
            time.sleep(START_POLL_S)

    def _watch(self, agent: str, launch: Launch) -> None:
        """One line in the gateway console when a launcher ends without the runner stopping it (a KILL, a refused
        token, a crash after the start), with its last log line: the operator sees why a robot stopped."""
        code = launch.proc.wait()
        if not launch.stopping:
            print(f"runner: {agent}'s launcher ended (exit {code}): {last_line(launch.log)}", file=sys.stderr,
                  flush=True)

    def _stop(self, agent: str) -> tuple[bool, str | None]:
        """Kill this agent's launcher and everything under it (children first, psutil, then taskkill if needed), reap
        it and delete the token file the kill kept it from deleting: (whether one was running, its run id or None)."""
        with self.lock:
            launch = self.launches.pop(agent, None)
        if launch is None or launch.proc.poll() is not None:
            return False, None
        launch.stopping = True
        method = kill_tree(launch.proc.pid)
        try:
            launch.proc.wait(timeout=REAP_S)
        except subprocess.TimeoutExpired:
            method += f" (still exiting after {REAP_S:.0f} s)"
        run_id = run_id_in(launch.log)
        if run_id is not None:
            remove_token_file(TOKEN_DIR / f".token-{run_id}")
        print(f"runner: stopped {agent} (launcher pid {launch.proc.pid}, {method})", file=sys.stderr, flush=True)
        return True, run_id

    def stop(self, agent: str) -> str | None:
        """Kill this agent's launcher (retire); returns the id of the run it killed, which the gateway logs as
        stopped, or None when none of ours ran for it (or it died before naming its run)."""
        return self._stop(agent)[1]

    def stop_all(self) -> list[tuple[str, str | None]]:
        """Stop every launcher this gateway started (reset, shutdown), again until none is left, so a START that
        slipped in meanwhile is stopped too; returns (agent, run id or None) for each one it killed."""
        killed: list[tuple[str, str | None]] = []
        while True:
            with self.lock:
                agents = list(self.launches)
            if not agents:
                return killed
            for agent in agents:
                stopped, run_id = self._stop(agent)
                if stopped:
                    killed.append((agent, run_id))
