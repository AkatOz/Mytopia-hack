"""Offline tests for infra/host_ec2.py, its boot script infra/host_userdata.sh, and the hosting change in
infra/provision.py. They never call AWS: they check the placeholders and value checks, that the boot script traces no
secret and hardens the server, the settings and seed lines it reads (no other secrets), the password shape, the dry
run, the gateway-role trust edits on a fake IAM client, and that provisioning keeps the server in that trust."""
from __future__ import annotations

import importlib.util
import inspect
import json
import re
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "infra"))  # host_ec2.py does "import provision" like it does when run as a script


def load(rel: str) -> ModuleType:
    """Import a repo file by path without running its main()."""
    spec = importlib.util.spec_from_file_location(Path(rel).stem + "_under_test", ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


host = load("infra/host_ec2.py")
prov = load("infra/provision.py")
HASH = "$2a$12$" + "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0"   # bcrypt-shaped: 22-char salt + 31-char digest
VALUES = {"COGNITO_POOL_ID": "us-east-1_Abc123", "COGNITO_SCOPE": "mytopia/tools", "TABLE_AGENTS": "mytopia_agents",
          "TABLE_EVENTS": "mytopia_events", "TOOLS_FUNCTION": "mytopia-tools", "DEMO_PACE": "2.0",
          "BEDROCK_MODEL_ID": "us.amazon.nova-2-lite-v1:0", "HARNESS_POLL_MS": "250",
          "GATEWAY_ROLE_ARN": "arn:aws:iam::123456789012:role/mytopia-gateway-role",
          "REPO_URL": "https://github.com/AkatOz/Mytopia-hack.git", "BRANCH": "main",
          "SEED_PARAM": "/mytopia/seed-agent-lines", "BCRYPT": HASH}
TEMPLATE = host.USERDATA.read_text(encoding="utf-8")
OUT = host.render(TEMPLATE, VALUES)
PART = "arn:aws:iam::123456789012:role/WSParticipantRole"
SERVER = "arn:aws:iam::123456789012:role/mytopia-host-role"


def test_render_fills_every_placeholder_but_the_servers_own_address() -> None:
    assert set(re.findall(r"__([A-Z_]+)__", OUT)) == {"DASH"}
    assert OUT.startswith("#!/bin/bash\n") and "\r" not in OUT and len(OUT.encode()) < 16000
    assert "role_arn = arn:aws:iam::123456789012:role/mytopia-gateway-role" in OUT
    assert "git clone --depth 1 --branch main https://github.com/AkatOz/Mytopia-hack.git" in OUT
    assert "COGNITO_POOL_ID=us-east-1_Abc123" in OUT and "BEDROCK_MODEL_ID=us.amazon.nova-2-lite-v1:0" in OUT
    assert "--name /mytopia/seed-agent-lines --with-decryption" in OUT


def test_the_hash_sits_in_a_quoted_heredoc() -> None:
    """Its $ signs must reach Caddy untouched, so it may only appear inside <<'EOF' ... EOF."""
    start = OUT.index("cat > /etc/caddy/Caddyfile <<'EOF'")
    assert OUT.count(HASH) == 1 and start < OUT.index(HASH) < OUT.index("\nEOF\n", start)


def test_the_boot_script_traces_nothing_and_locks_its_log() -> None:
    """xtrace would print ADMIN=<token> into a world-readable log and the EC2 system log."""
    assert not re.search(r"set -[A-Za-z]*x|set\b.*-o xtrace", OUT)
    assert "set -euo pipefail" in OUT
    assert OUT.index("install -m 600 /dev/null /var/log/mytopia-setup.log") < OUT.index("exec > >(tee -a /var/log/mytopia-setup.log)")


def test_the_server_is_hardened() -> None:
    head = "cat > /etc/caddy/Caddyfile <<'EOF'\n"
    body = OUT[OUT.index(head) + len(head):OUT.index("\nEOF\n", OUT.index(head))]
    assert body.startswith("{\n\tadmin off\n}\n")                  # a global block, first, or Caddy refuses the file
    assert "basic_auth" in body and "header_up Host 127.0.0.1:8787" in body
    assert "ExecReload" not in OUT                                  # no admin API to reload through
    assert OUT.count("UMask=0077") == 2                             # the gateway and the key timer write mode-600 files
    assert OUT.index('chmod 700 "$APP"') < OUT.index('cat > "$APP/gateway/.env"')   # locked before any secret lands


@pytest.mark.parametrize("bad", ["two words", "a$b", "x\ny", "main\n", "it's", "`id`", ""])
def test_render_refuses_values_that_could_break_the_boot_script(bad: str) -> None:
    with pytest.raises(ValueError, match="COGNITO_POOL_ID"):
        host.render(TEMPLATE, {**VALUES, "COGNITO_POOL_ID": bad})


def test_render_refuses_a_hash_that_is_not_bcrypt() -> None:
    for bad in ("plain-password", HASH + "\n"):
        with pytest.raises(ValueError, match="BCRYPT"):
            host.render(TEMPLATE, {**VALUES, "BCRYPT": bad})


def test_render_refuses_a_missing_value() -> None:
    with pytest.raises(ValueError, match="TABLE_EVENTS"):
        host.render(TEMPLATE, {k: v for k, v in VALUES.items() if k != "TABLE_EVENTS"})


def test_settings_carry_plain_values_only(tmp_path: Path) -> None:
    g, a = tmp_path / "gateway.env", tmp_path / "agent.env"
    g.write_text("ADMIN_TOKEN=supersecret\nLOCAL_ISSUER_SECRET=alsosecret\nCOGNITO_POOL_ID=us-east-1_Abc123\n"
                 "TABLE_AGENTS=agents_x\n", encoding="utf-8")
    a.write_text("AWS_BEARER_TOKEN_BEDROCK=bedrock-api-key-xyz\nOPS_BOT_CLIENT_SECRET=s3cret\nBEDROCK_MODEL_ID=m.1:0\n",
                 encoding="utf-8")
    got = host.settings(g, a)
    assert got["COGNITO_POOL_ID"] == "us-east-1_Abc123" and got["TABLE_AGENTS"] == "agents_x"
    assert got["BEDROCK_MODEL_ID"] == "m.1:0" and got["TABLE_EVENTS"] == "mytopia_events" and got["HARNESS_POLL_MS"] == "250"
    assert not any(s in json.dumps(got) for s in ("supersecret", "alsosecret", "bedrock-api-key", "s3cret"))


def test_settings_need_provisioning_first(tmp_path: Path) -> None:
    (tmp_path / "g.env").write_text("MODE=local\n", encoding="utf-8")
    (tmp_path / "a.env").write_text("", encoding="utf-8")
    with pytest.raises(SystemExit, match="provision"):
        host.settings(tmp_path / "g.env", tmp_path / "a.env")


def test_seed_lines_are_the_four_seed_keys_and_nothing_else(tmp_path: Path) -> None:
    a = tmp_path / "agent.env"
    a.write_text("ADMIN_TOKEN=admintok\nRESEARCH_BOT_CLIENT_ID=rid\nRESEARCH_BOT_CLIENT_SECRET=rsec\n"
                 "OPS_BOT_CLIENT_ID=oid\nOPS_BOT_CLIENT_SECRET=osec\nBEN_CLIENT_SECRET=bsec\n"
                 "AWS_BEARER_TOKEN_BEDROCK=bedrock-api-key-xyz\nOPS_BOT_CLIENT_ID=\n", encoding="utf-8")
    got = host.seed_lines(a)
    assert got.splitlines() == ["RESEARCH_BOT_CLIENT_ID=rid", "RESEARCH_BOT_CLIENT_SECRET=rsec",
                                "OPS_BOT_CLIENT_ID=oid", "OPS_BOT_CLIENT_SECRET=osec"]
    assert host.seed_lines(tmp_path / "missing.env") == ""


def test_password_is_three_groups_without_look_alikes() -> None:
    pws = {host.new_password() for _ in range(50)}
    assert len(pws) == 50
    assert all(re.fullmatch(r"[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){2}", pw) for pw in pws)


def test_host_policy_reads_only_the_seed_parameter() -> None:
    seed_arn = "arn:aws:ssm:us-east-1:1:parameter/mytopia/seed-agent-lines"
    pol = host.host_policy("arn:gw", seed_arn)
    actions = lambda st: st["Action"] if isinstance(st["Action"], list) else [st["Action"]]  # noqa: E731
    ssm = [st for st in pol["Statement"] if any(a.startswith("ssm:") for a in actions(st))]
    assert len(ssm) == 1 and actions(ssm[0]) == ["ssm:GetParameter"] and ssm[0]["Resource"] == seed_arn


@pytest.fixture
def no_aws(monkeypatch):
    """main() with run() (the only path to AWS) replaced by a failure, so a broken guard cannot reach AWS from a test."""
    monkeypatch.setattr(host, "run", lambda args: pytest.fail("run() was reached: it would have called AWS"))


def test_dry_run_prints_the_plan_and_calls_nothing(no_aws, capsys) -> None:
    assert host.main(["--dry-run"]) == 0
    out = capsys.readouterr().out
    for name in ("DRY RUN", "mytopia-host-role", "mytopia-gateway-role", "mytopia-web", "80 and 443", "IMDSv2",
                 "/mytopia/seed-agent-lines"):
        assert name in out


def test_teardown_needs_yes(no_aws, capsys) -> None:
    assert host.main(["--teardown"]) == 2 and "--yes" in capsys.readouterr().out


def test_the_script_runs_as_a_program() -> None:
    """The file still starts as a script (its imports work outside pytest); --help never calls AWS."""
    r = subprocess.run([sys.executable, str(ROOT / "infra" / "host_ec2.py"), "--help"], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and "--teardown" in r.stdout


class FakeIam:
    """Just enough of the IAM client for the trust edits."""

    class exceptions:  # noqa: N801  (mirrors boto3's client.exceptions)
        class NoSuchEntityException(Exception):
            pass

    def __init__(self, statements: list[dict] | None = None, roles: dict[str, str] | None = None) -> None:
        self.doc = {"Version": "2012-10-17", "Statement": statements or []}
        self.roles = roles or {}
        self.updates = 0

    def get_role(self, RoleName: str) -> dict:  # noqa: N803  (boto3 argument name)
        if RoleName == "mytopia-gateway-role":
            return {"Role": {"Arn": "arn:gw", "AssumeRolePolicyDocument": json.loads(json.dumps(self.doc))}}
        if RoleName in self.roles:
            return {"Role": {"Arn": self.roles[RoleName]}}
        raise self.exceptions.NoSuchEntityException(RoleName)

    def update_assume_role_policy(self, RoleName: str, PolicyDocument: str) -> None:  # noqa: N803
        self.doc, self.updates = json.loads(PolicyDocument), self.updates + 1


def allow(principal) -> dict:
    return {"Effect": "Allow", "Principal": {"AWS": principal}, "Action": "sts:AssumeRole"}


def test_trust_adds_the_server_once_and_keeps_the_participant() -> None:
    iam = FakeIam([allow(PART)])
    assert host.trust_gateway(iam, SERVER) is True
    text = json.dumps(iam.doc)
    assert PART in text and SERVER in text
    assert host.trust_gateway(iam, SERVER) is False and iam.updates == 1


@pytest.mark.parametrize("statements", [[allow(PART), allow(SERVER)], [allow([PART, SERVER])]])
def test_untrust_removes_only_the_server(statements: list[dict]) -> None:
    iam = FakeIam(statements)
    assert host.untrust_gateway(iam, SERVER) is True
    text = json.dumps(iam.doc)
    assert SERVER not in text and PART in text
    assert host.untrust_gateway(iam, SERVER) is False


def test_provisioning_keeps_the_server_in_the_gateway_trust() -> None:
    assert prov.gateway_principals(FakeIam(roles={"mytopia-host-role": SERVER}), PART) == {"AWS": [PART, SERVER]}
    assert prov.gateway_principals(FakeIam(), PART) == {"AWS": PART}
    assert "trust(gateway_principals(iam, participant_arn))" in inspect.getsource(prov.provision)   # and it is used


def test_write_access_never_overwrites(tmp_path: Path) -> None:
    inst = {"InstanceId": "i-0abc", "PublicIpAddress": "100.58.243.79"}
    first = host.write_access(str(tmp_path / "ACCESS.txt"), inst, "aaaa-bbbb-cccc")
    second = host.write_access(str(tmp_path / "ACCESS.txt"), inst, "dddd-eeee-ffff")
    assert first != second and Path(second).name == "ACCESS-i-0abc.txt"
    text = Path(first).read_text(encoding="utf-8")
    assert "https://100-58-243-79.sslip.io" in text and "https://100-58-243-79.nip.io" in text and "aaaa-bbbb-cccc" in text
    assert "A reboot is safe" in text


def test_write_access_before_the_server_has_an_address(tmp_path: Path) -> None:
    """The password is written down even when the wait for the running state fails (no public IP yet)."""
    where = host.write_access(str(tmp_path / "ACCESS.txt"), {"InstanceId": "i-0def"}, "gggg-hhhh-jjjj")
    text = Path(where).read_text(encoding="utf-8")
    assert "(no public IP yet)" in text and "gggg-hhhh-jjjj" in text and "i-0def" in text
