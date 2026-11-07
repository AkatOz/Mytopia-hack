"""Offline tests for infra/provision.py, infra/teardown.py, infra/gateway_creds.py and scripts/bedrock_key.py.
They never call AWS: they check the dry-run plans, the Lambda zip, the gateway policy and the file-editing helpers on temp files."""
from __future__ import annotations

import importlib.util
import io
import json
import os
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "infra"))  # teardown.py does "import provision" like it does when run as a script


def load(rel: str) -> ModuleType:
    """Import a repo file by path without running its main()."""
    spec = importlib.util.spec_from_file_location(Path(rel).stem + "_under_test", ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


prov = load("infra/provision.py")
tear = load("infra/teardown.py")
creds = load("infra/gateway_creds.py")
bkey = load("scripts/bedrock_key.py")


def offline_env() -> dict[str, str]:
    """An environment with no AWS credentials at all, so an accidental AWS call would fail."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("AWS_")}
    env["AWS_EC2_METADATA_DISABLED"] = "true"
    return env


def test_provision_dry_run_prints_every_resource() -> None:
    r = subprocess.run([sys.executable, str(ROOT / "infra" / "provision.py"), "--dry-run"],
                       capture_output=True, text=True, env=offline_env(), timeout=60)
    assert r.returncode == 0, r.stderr
    for name in ("mytopia_agents", "mytopia_events", "mytopia-tools-exec", "mytopia-tools",
                 "mytopia-gateway-role", "mytopia/tools", "research-bot", "ops-bot", "[profile gateway]"):
        assert name in r.stdout


def test_teardown_without_yes_is_a_dry_run() -> None:
    for flags in (["--dry-run"], []):
        r = subprocess.run([sys.executable, str(ROOT / "infra" / "teardown.py"), *flags],
                           capture_output=True, text=True, env=offline_env(), timeout=60)
        assert r.returncode == 0, r.stderr
        assert "DRY RUN" in r.stdout and "mytopia-gateway-role" in r.stdout


def test_lambda_zip_holds_handler_at_root(tmp_path: Path) -> None:
    data, placeholder = prov.lambda_zip()
    names = zipfile.ZipFile(io.BytesIO(data)).namelist()
    assert names == ["handler.py"]
    assert placeholder is not (ROOT / "tools_lambda" / "handler.py").exists()
    data, placeholder = prov.lambda_zip(str(tmp_path / "missing.py"))
    assert placeholder
    assert "def handler" in zipfile.ZipFile(io.BytesIO(data)).read("handler.py").decode()


def test_gateway_policy_is_narrow() -> None:
    policy = prov.gateway_policy("123456789012")
    actions = sorted(a for s in policy["Statement"] for a in ([s["Action"]] if isinstance(s["Action"], str) else s["Action"]))
    assert actions == ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem",
                       "lambda:InvokeFunction"]
    resources = [s["Resource"] for s in policy["Statement"]]
    assert "arn:aws:dynamodb:us-east-1:123456789012:table/mytopia_agents" in resources
    assert "arn:aws:lambda:us-east-1:123456789012:function:mytopia-tools" in resources
    assert all("*" not in r for r in resources)


def test_update_env_file_replaces_and_appends(tmp_path: Path) -> None:
    template = tmp_path / ".env.example"
    template.write_text("# comment\nMODE=local\nADMIN_TOKEN=change-me\nCOGNITO_POOL_ID=\n")
    target = tmp_path / ".env"
    prov.update_env_file(str(target), {"MODE": "aws", "COGNITO_POOL_ID": "us-east-1_X", "NEW": "1"}, str(template))
    assert target.read_text() == "# comment\nMODE=aws\nADMIN_TOKEN=change-me\nCOGNITO_POOL_ID=us-east-1_X\nNEW=1\n"
    prov.update_env_file(str(target), {"MODE": "aws"})  # second run changes nothing
    assert target.read_text().count("MODE=") == 1


def test_config_section_is_replaced_not_duplicated(tmp_path: Path) -> None:
    cfg = tmp_path / ".aws-config"
    cfg.write_text("# keep me\n[profile ws]\nregion = us-east-1\n")
    for _ in range(2):
        prov.set_config_section(str(cfg), "profile gateway", prov.gateway_profile_lines())
    text = cfg.read_text()
    assert text.count("[profile gateway]") == 1 and "[profile ws]" in text and "# keep me" in text
    assert 'credential_process = "' in text and '" -I "' in text and "gateway_creds.py" in text
    tear.remove_config_section(str(cfg), "profile gateway")
    assert "[profile gateway]" not in cfg.read_text() and "[profile ws]" in cfg.read_text()


def test_gateway_creds_json_shape() -> None:
    out = json.loads(creds.to_process_json({"AccessKeyId": "A", "SecretAccessKey": "S", "SessionToken": "T",
                                            "Expiration": datetime(2026, 11, 8, 9, 0, tzinfo=timezone.utc)}))
    assert out == {"Version": 1, "AccessKeyId": "A", "SecretAccessKey": "S", "SessionToken": "T",
                   "Expiration": "2026-11-08T09:00:00+00:00"}


def test_bedrock_key_replaces_the_line() -> None:
    text = "GATEWAY_URL=x\nAWS_BEARER_TOKEN_BEDROCK=old\nADMIN_TOKEN=y\n"
    assert bkey.replace_line(text, "AWS_BEARER_TOKEN_BEDROCK", "new") == \
        "GATEWAY_URL=x\nAWS_BEARER_TOKEN_BEDROCK=new\nADMIN_TOKEN=y\n"
    assert bkey.replace_line("A=1\n", "AWS_BEARER_TOKEN_BEDROCK", "new") == "A=1\nAWS_BEARER_TOKEN_BEDROCK=new\n"


def test_short_never_reveals_more_than_4_chars() -> None:
    assert prov.short("abcdefghijklmnopqrstuvwxyz") == "abcd..."
