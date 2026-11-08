"""The job book: what an agent does once the Factory starts it, read once from contract/jobs.json.
The gateway checks a mint's or a start's job against it and serves it at GET /jobs; the launcher and the agent read the same file."""

import json
from pathlib import Path

from gateway.config import REPO_ROOT
from gateway.mcp import TOOL_NAMES

JOBS_FILE = REPO_ROOT / "contract" / "jobs.json"
DEFAULT_JOB = "patrol"   # what POST /agents/{id}/start runs when neither the request nor the badge names a job


def load_jobs(path: Path = JOBS_FILE) -> list[dict]:
    """The jobs in file order. A repeated key or a step naming a tool outside the six stops the gateway at startup."""
    jobs = json.loads(path.read_text(encoding="utf-8"))["jobs"]
    keys = [job["job"] for job in jobs]
    if len(set(keys)) != len(keys):
        raise ValueError(f"{path.name}: a job key is used twice")
    for job in jobs:
        for step in job.get("steps", []):
            if step.get("tool") not in TOOL_NAMES:
                raise ValueError(f"{path.name}: job {job['job']} uses {step.get('tool')}, which is not one of the six tools")
    return jobs


JOB_LIST = load_jobs()
JOBS: dict[str, dict] = {job["job"]: job for job in JOB_LIST}


def is_job(value: object) -> bool:
    """True for a key of the job book (and never raises, whatever the request body held)."""
    return isinstance(value, str) and value in JOBS


def job_error() -> str:
    return "job must be one of " + ", ".join(JOBS)


def job_tools(job: dict) -> list[str]:
    """The distinct tools the job's steps use, in catalog order; the patrol uses whatever the badge holds (all six)."""
    if job.get("patrol"):
        return list(TOOL_NAMES)
    used = {step["tool"] for step in job.get("steps", [])}
    return [tool for tool in TOOL_NAMES if tool in used]


def public_jobs() -> list[dict]:
    """GET /jobs: every job as the file has it, plus the tools it needs."""
    return [{**job, "tools": job_tools(job)} for job in JOB_LIST]
