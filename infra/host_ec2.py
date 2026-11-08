"""Host MYTOPIA on one EC2 server in the team's AWS account (us-east-1), so the demo is a website, not a laptop.

The server runs the same code a laptop runs: the gateway on 127.0.0.1:8787, the island it serves, and the agents its
runner starts. In front of it Caddy serves HTTPS (a Let's Encrypt certificate for <ip>.sslip.io, so no domain is
needed) and asks for a team password, because the island hands the admin token to whoever loads it. The server has
its own role, mytopia-host-role: an inline policy that may assume mytopia-gateway-role, call Bedrock on any model
(for the agents' short-term key) and read one SSM parameter, plus the AWS managed policy AmazonSSMManagedInstanceCore
(Session Manager, and ssm:GetParameter on any parameter). Nothing on the server needs the Workshop keys refreshed.
The first boot is infra/host_userdata.sh.

    .venv\\Scripts\\python -m pip install bcrypt               # only this script needs it (Caddy wants a bcrypt hash)
    .venv\\Scripts\\python infra\\host_ec2.py --dry-run         # the plan, no AWS calls
    .venv\\Scripts\\python infra\\host_ec2.py                   # role, trust, firewall, seed lines, server; prints the address
    .venv\\Scripts\\python infra\\host_ec2.py --status          # the server and its address
    .venv\\Scripts\\python infra\\host_ec2.py --teardown --yes  # terminate it and delete what this script made

Run it as profile ws from gateway\\.aws-credentials (scripts\\aws_creds.py), after infra\\provision.py. The server
clones the pushed branch from GitHub (main by default), not this folder. The script reads the non-secret settings from
gateway\\.env and agent\\.env, stores the two seed agents' Cognito lines from agent\\.env in an encrypted SSM parameter
(user data carries no secret), writes the address and a new password to a file outside the repo
(Desktop\\MYTOPIA_SITE_ACCESS.txt) and prints no secret. A second run finds the running server and launches nothing
unless --new is given."""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "infra"))
import provision as p  # noqa: E402  same constants, profile handling and error helper as provisioning

USERDATA = ROOT / "infra" / "host_userdata.sh"
HOST_ROLE = p.HOST_ROLE        # named in provision.py, so a re-run there keeps the server in the gateway role's trust
GROUP = "mytopia-web"
NAME = "mytopia-gateway"
REPO = "https://github.com/AkatOz/Mytopia-hack.git"
SEED_PARAM = "/mytopia/seed-agent-lines"       # SecureString: the seed agents' four Cognito lines
SEED_KEYS = re.compile(r"^(RESEARCH_BOT|OPS_BOT)_CLIENT_(ID|SECRET)=\S+$")
TYPES = ("t3.medium", "t3.small", "t2.medium")   # the first one the account allows
AMI_PARAM = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
SSM_POLICY = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
USERNAME = "mytopia"
DESKTOP = os.environ.get("MYTOPIA_DESKTOP") or os.path.join(os.path.expanduser("~"), "Desktop")
ACCESS_FILE = os.path.join(DESKTOP, "MYTOPIA_SITE_ACCESS.txt")
SAFE = re.compile(r"[A-Za-z0-9._:/@+-]+")      # what may land in the boot script's unquoted heredocs (fullmatch)
BCRYPT = re.compile(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}")
PLACEHOLDER = re.compile(r"__([A-Z_]+)__")
SERVER_FILLED = {"DASH"}                       # the server's own public IP, filled on the server
USERDATA_LIMIT = 16000                         # EC2 refuses user data over 16 KB
LIVE_STATES = ["pending", "running"]


def settings(gateway_env: Path = ROOT / "gateway" / ".env", agent_env: Path = ROOT / "agent" / ".env") -> dict[str, str]:
    """The non-secret values the server needs, read from the env files provision.py wrote. No token, secret or key is
    read into the result: the server makes its own admin token and Bedrock key."""
    from dotenv import dotenv_values
    g, a = dotenv_values(gateway_env), dotenv_values(agent_env)
    out = {
        "COGNITO_POOL_ID": g.get("COGNITO_POOL_ID") or "",
        "COGNITO_SCOPE": g.get("COGNITO_SCOPE") or p.SCOPE,
        "TABLE_AGENTS": g.get("TABLE_AGENTS") or p.AGENTS_TABLE,
        "TABLE_EVENTS": g.get("TABLE_EVENTS") or p.EVENTS_TABLE,
        "TOOLS_FUNCTION": g.get("TOOLS_FUNCTION") or p.FUNCTION,
        "DEMO_PACE": g.get("DEMO_PACE") or "2.0",
        "BEDROCK_MODEL_ID": a.get("BEDROCK_MODEL_ID") or "us.amazon.nova-2-lite-v1:0",
        "HARNESS_POLL_MS": a.get("HARNESS_POLL_MS") or "250",
    }
    if not out["COGNITO_POOL_ID"]:
        raise SystemExit(f"{gateway_env} has no COGNITO_POOL_ID: run infra/provision.py first")
    return out


def seed_lines(agent_env: Path = ROOT / "agent" / ".env") -> str:
    """The seed agents' four Cognito lines (RESEARCH_BOT_/OPS_BOT_ CLIENT_ID/CLIENT_SECRET) from agent/.env, and
    nothing else; "" when they are missing. They go to an encrypted SSM parameter, never into user data."""
    if not Path(agent_env).is_file():
        return ""
    lines = [ln.strip() for ln in Path(agent_env).read_text(encoding="utf-8").splitlines()]
    return "\n".join(ln for ln in lines if SEED_KEYS.match(ln))


def render(template: str, values: dict[str, str]) -> str:
    """Fill the boot script's __NAME__ placeholders. Every value but the bcrypt hash must be plain (no $, quotes,
    spaces or newlines), because it lands in an unquoted heredoc; the hash lands in a quoted one. Returns LF-only text
    under EC2's 16 KB limit, or raises ValueError."""
    for key, value in values.items():
        if not (BCRYPT if key == "BCRYPT" else SAFE).fullmatch(value or ""):
            raise ValueError(f"unsafe value for {key}")
        template = template.replace(f"__{key}__", value)
    left = set(PLACEHOLDER.findall(template)) - SERVER_FILLED
    if left:
        raise ValueError("placeholders left unfilled: " + ", ".join(sorted(left)))
    text = template.replace("\r\n", "\n")
    if len(text.encode("utf-8")) >= USERDATA_LIMIT:
        raise ValueError("user data over EC2's 16 KB limit")
    return text


def new_password() -> str:
    """Three groups of four letters and digits without look-alikes (about 60 bits): easy to type in front of judges."""
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "-".join("".join(secrets.choice(alphabet) for _ in range(4)) for _ in range(3))


def bcrypt_hash(password: str) -> str:
    """The bcrypt hash Caddy's basic_auth wants; the password itself never leaves this machine."""
    try:
        import bcrypt
    except ImportError:
        raise SystemExit("this script needs bcrypt for Caddy's password hash: .venv\\Scripts\\python -m pip install bcrypt")
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12, prefix=b"2a")).decode()


def host_policy(gateway_arn: str, seed_param_arn: str) -> dict:
    """The server role's inline policy: step into the gateway role, call Bedrock for the agents' key, read the seed
    lines. AmazonSSMManagedInstanceCore is attached beside it for Session Manager."""
    return {"Version": "2012-10-17", "Statement": [
        {"Sid": "AssumeTheGatewayRole", "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": gateway_arn},
        {"Sid": "BedrockKeysForAgents", "Effect": "Allow", "Resource": "*",
         "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:CallWithBearerToken"]},
        {"Sid": "ReadTheSeedAgentLines", "Effect": "Allow", "Action": "ssm:GetParameter", "Resource": seed_param_arn}]}


def plan_lines() -> list[str]:
    """What a run creates or finds, as printable lines (no AWS calls)."""
    return [
        f"region {p.REGION}, profile ws from {p.CREDS_FILE}",
        f"iam role '{HOST_ROLE}' (trust ec2.amazonaws.com) and an instance profile of the same name: may assume "
        f"'{p.GATEWAY_ROLE}', call Bedrock (InvokeModel, CallWithBearerToken), read {SEED_PARAM}; "
        "plus AmazonSSMManagedInstanceCore",
        f"add '{HOST_ROLE}' to the trust of '{p.GATEWAY_ROLE}' (the participant role stays)",
        f"security group '{GROUP}' in the default VPC: tcp 80 and 443 from anywhere, nothing else",
        f"ssm parameter {SEED_PARAM} (SecureString): the seed agents' four Cognito lines from agent/.env",
        f"EC2 instance '{NAME}' ({TYPES[0]}, Amazon Linux 2023, IMDSv2 only, 20 GB gp3); its first boot "
        f"({USERDATA.name}) clones {REPO} (the pushed branch), installs Python 3.14 with uv, Caddy and the systemd units",
        f"write the address and a new password to {ACCESS_FILE} (outside the repo); print no secret",
        f"launch nothing when a server tagged Name={NAME}, project=mytopia is already up (--new launches another)",
    ]


def trust_gateway(iam, host_arn: str) -> bool:
    """Add the server's role to the gateway role's trust, keeping every principal already there; True when it changed."""
    doc = iam.get_role(RoleName=p.GATEWAY_ROLE)["Role"]["AssumeRolePolicyDocument"]
    if host_arn in json.dumps(doc):
        return False
    statements = doc["Statement"] if isinstance(doc["Statement"], list) else [doc["Statement"]]
    doc["Statement"] = statements + [{"Sid": "MytopiaServer", "Effect": "Allow", "Principal": {"AWS": host_arn},
                                      "Action": "sts:AssumeRole"}]
    for attempt in range(15):
        try:
            iam.update_assume_role_policy(RoleName=p.GATEWAY_ROLE, PolicyDocument=json.dumps(doc))
            return True
        except Exception as e:  # noqa: BLE001
            if p.error_code(e) != "MalformedPolicyDocument" or attempt == 14:
                raise
            time.sleep(4)  # IAM takes a few seconds to accept a brand-new role as a principal
    return False


def untrust_gateway(iam, host_arn: str) -> bool:
    """Take the server's role out of the gateway role's trust and keep everything else; True when it changed."""
    try:
        doc = iam.get_role(RoleName=p.GATEWAY_ROLE)["Role"]["AssumeRolePolicyDocument"]
    except iam.exceptions.NoSuchEntityException:
        return False
    kept, changed = [], False
    for st in doc["Statement"] if isinstance(doc["Statement"], list) else [doc["Statement"]]:
        aws = st.get("Principal", {}).get("AWS")
        if aws == host_arn:
            changed = True
            continue
        if isinstance(aws, list) and host_arn in aws:
            rest, changed = [a for a in aws if a != host_arn], True
            if not rest:
                continue
            st = {**st, "Principal": {**st["Principal"], "AWS": rest[0] if len(rest) == 1 else rest}}
        kept.append(st)
    if changed:
        doc["Statement"] = kept
        iam.update_assume_role_policy(RoleName=p.GATEWAY_ROLE, PolicyDocument=json.dumps(doc))
    return changed


def ensure_host_role(iam, gateway_arn: str, seed_param_arn: str) -> str:
    """Find or create the server's role, its inline policy, the SSM policy and the instance profile; returns the ARN."""
    trust = json.dumps({"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]})
    try:
        arn = iam.get_role(RoleName=HOST_ROLE)["Role"]["Arn"]
    except iam.exceptions.NoSuchEntityException:
        arn = iam.create_role(RoleName=HOST_ROLE, AssumeRolePolicyDocument=trust, Tags=p.TAGS,
                              Description="MYTOPIA server: assumes mytopia-gateway-role, mints Bedrock keys, SSM")["Role"]["Arn"]
        iam.get_waiter("role_exists").wait(RoleName=HOST_ROLE)
    iam.put_role_policy(RoleName=HOST_ROLE, PolicyName="mytopia-host",
                        PolicyDocument=json.dumps(host_policy(gateway_arn, seed_param_arn)))
    iam.attach_role_policy(RoleName=HOST_ROLE, PolicyArn=SSM_POLICY)
    try:
        iam.create_instance_profile(InstanceProfileName=HOST_ROLE, Tags=p.TAGS)
    except iam.exceptions.EntityAlreadyExistsException:
        pass
    if not iam.get_instance_profile(InstanceProfileName=HOST_ROLE)["InstanceProfile"]["Roles"]:
        iam.add_role_to_instance_profile(InstanceProfileName=HOST_ROLE, RoleName=HOST_ROLE)
    return arn


def default_vpc(ec2) -> str:
    vpcs = ec2.describe_vpcs(Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        raise SystemExit(f"no default VPC in {p.REGION}: this script launches into the default VPC")
    return vpcs[0]["VpcId"]


def find_group(ec2, vpc: str) -> str | None:
    found = ec2.describe_security_groups(Filters=[{"Name": "group-name", "Values": [GROUP]},
                                                  {"Name": "vpc-id", "Values": [vpc]}])["SecurityGroups"]
    return found[0]["GroupId"] if found else None


def ensure_group(ec2, vpc: str) -> str:
    """Find or create the firewall: 80 (the certificate check and the redirect) and 443 (the site), nothing else."""
    sg = find_group(ec2, vpc)
    if sg:
        return sg
    sg = ec2.create_security_group(GroupName=GROUP, VpcId=vpc,
                                   Description="MYTOPIA site: 80 for the certificate check and the redirect, 443 for the site",
                                   TagSpecifications=[{"ResourceType": "security-group", "Tags": p.TAGS}])["GroupId"]
    ec2.authorize_security_group_ingress(GroupId=sg, IpPermissions=[
        {"IpProtocol": "tcp", "FromPort": port, "ToPort": port, "IpRanges": [{"CidrIp": "0.0.0.0/0", "Description": "MYTOPIA site"}]}
        for port in (80, 443)])
    return sg


def store_seed_lines(ssm, text: str) -> None:
    """Put the seed agents' lines in the SecureString parameter (encrypted with the account's aws/ssm key)."""
    ssm.put_parameter(Name=SEED_PARAM, Value=text, Type="SecureString", Overwrite=True,
                      Description="MYTOPIA: the seed agents' Cognito lines for the hosted server's agent/.env")


def servers(ec2, states: list[str] = LIVE_STATES) -> list[dict]:
    """The MYTOPIA servers in the given states, found by their tags."""
    found = ec2.describe_instances(Filters=[{"Name": "tag:Name", "Values": [NAME]},
                                            {"Name": "tag:project", "Values": ["mytopia"]},
                                            {"Name": "instance-state-name", "Values": states}])["Reservations"]
    return [i for r in found for i in r["Instances"]]


def address(instance: dict) -> str:
    ip = instance.get("PublicIpAddress")
    return f"https://{ip.replace('.', '-')}.sslip.io" if ip else "(no public IP yet)"


def launch(ec2, ssm, sg: str, vpc: str, userdata: str) -> dict:
    """Start one server, retrying while the new instance profile propagates and falling back to smaller types."""
    ami = ssm.get_parameter(Name=AMI_PARAM)["Parameter"]["Value"]
    subnets = sorted((n for n in ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc]},
                                                               {"Name": "default-for-az", "Values": ["true"]}])["Subnets"]
                      if n["AvailabilityZone"] != "us-east-1e"),   # us-east-1e lacks the newer instance types
                     key=lambda n: n["AvailabilityZone"])
    last = None
    for itype in TYPES:
        for subnet in subnets[:3]:
            for attempt in range(12):
                try:
                    return ec2.run_instances(
                        ImageId=ami, InstanceType=itype, MinCount=1, MaxCount=1, UserData=userdata,
                        IamInstanceProfile={"Name": HOST_ROLE},
                        NetworkInterfaces=[{"DeviceIndex": 0, "SubnetId": subnet["SubnetId"], "Groups": [sg],
                                            "AssociatePublicIpAddress": True}],
                        MetadataOptions={"HttpTokens": "required", "HttpEndpoint": "enabled", "HttpPutResponseHopLimit": 1},
                        BlockDeviceMappings=[{"DeviceName": "/dev/xvda",
                                              "Ebs": {"VolumeSize": 20, "VolumeType": "gp3", "DeleteOnTermination": True}}],
                        TagSpecifications=[{"ResourceType": "instance",
                                            "Tags": p.TAGS + [{"Key": "Name", "Value": NAME}]}])["Instances"][0]
                except Exception as e:  # noqa: BLE001
                    last = e
                    if "instance profile" in str(e).lower() and attempt < 11:
                        time.sleep(5)  # EC2 does not see a brand-new instance profile for a few seconds
                        continue
                    print(f"{itype} in {subnet['AvailabilityZone']} refused: {p.error_code(e) or type(e).__name__}", flush=True)
                    break
    raise SystemExit(f"no server launched: {last}")


def write_access(path: str, instance: dict, password: str) -> str:
    """Write the address and the password to a file outside the repo, never over an existing one; returns the path."""
    target = Path(path)
    if target.exists():
        target = target.with_name(f"{target.stem}-{instance['InstanceId']}{target.suffix}")
    target.parent.mkdir(parents=True, exist_ok=True)
    url = address(instance)
    target.write_text(
        "MYTOPIA website: the gateway, the island and the agents run on one AWS EC2 server (us-east-1).\n\n"
        f"Address:  {url}\nUsername: {USERNAME}\nPassword: {password}\n\n"
        f"Backup address (same server): {url.replace('.sslip.io', '.nip.io')}\n"
        f"Server: EC2 instance {instance['InstanceId']}, role {HOST_ROLE}, firewall {GROUP}.\n"
        "Do not stop the server: a stop and start changes its IP, and the site stays down until the Caddyfile is fixed "
        "by hand (docs/HOSTING.md, After a stop and start). A reboot is safe.\n"
        "Share the password only with the team, in a private message.\n", encoding="utf-8")
    return str(target)


def delete_host_role(iam) -> str:
    """Delete the instance profile, the SSM attachment, the inline policies and the role (each step skips what is gone)."""
    for step in (lambda: iam.remove_role_from_instance_profile(InstanceProfileName=HOST_ROLE, RoleName=HOST_ROLE),
                 lambda: iam.delete_instance_profile(InstanceProfileName=HOST_ROLE),
                 lambda: iam.detach_role_policy(RoleName=HOST_ROLE, PolicyArn=SSM_POLICY)):
        try:
            step()
        except iam.exceptions.NoSuchEntityException:
            pass
    try:
        for policy in iam.list_role_policies(RoleName=HOST_ROLE)["PolicyNames"]:
            iam.delete_role_policy(RoleName=HOST_ROLE, PolicyName=policy)
        iam.delete_role(RoleName=HOST_ROLE)
    except iam.exceptions.NoSuchEntityException:
        return f"iam role {HOST_ROLE}: already gone"
    return f"iam role {HOST_ROLE} and its instance profile: deleted"


def teardown(iam, ec2, ssm) -> None:
    """Terminate every MYTOPIA server, then delete the firewall, the seed parameter, the trust line and the role."""
    ids = [i["InstanceId"] for i in servers(ec2, ["pending", "running", "stopping", "stopped"])]
    if ids:
        ec2.terminate_instances(InstanceIds=ids)
        print(f"terminating {', '.join(ids)}", flush=True)
        ec2.get_waiter("instance_terminated").wait(InstanceIds=ids)
    sg = find_group(ec2, default_vpc(ec2))
    for attempt in range(20):
        if not sg:
            break
        try:
            ec2.delete_security_group(GroupId=sg)
            print(f"security group {sg}: deleted", flush=True)
            break
        except Exception as e:  # noqa: BLE001
            if p.error_code(e) != "DependencyViolation" or attempt == 19:
                raise
            time.sleep(5)  # the terminated server's network interface lets go a little after it stops
    try:
        ssm.delete_parameter(Name=SEED_PARAM)
        print(f"ssm parameter {SEED_PARAM}: deleted", flush=True)
    except Exception as e:  # noqa: BLE001
        if p.error_code(e) != "ParameterNotFound":
            raise
    try:
        host_arn = iam.get_role(RoleName=HOST_ROLE)["Role"]["Arn"]
    except iam.exceptions.NoSuchEntityException:
        host_arn = None
    if host_arn and untrust_gateway(iam, host_arn):
        print(f"{p.GATEWAY_ROLE}: no longer trusts {HOST_ROLE}", flush=True)
    print(delete_host_role(iam), flush=True)


def run(args) -> int:
    p.use_ws_profile()
    import boto3
    s = boto3.Session(profile_name="ws", region_name=p.REGION)
    iam, ec2, ssm = s.client("iam"), s.client("ec2"), s.client("ssm")
    if args.status:
        found = servers(ec2, ["pending", "running", "stopping", "stopped"])
        for i in found:
            print(f"{i['InstanceId']} {i['InstanceType']} {i['State']['Name']} since {i['LaunchTime']:%Y-%m-%d %H:%M} UTC: {address(i)}")
        if not found:
            print("no MYTOPIA server")
        return 0
    if args.teardown:
        teardown(iam, ec2, ssm)
        return 0
    values = settings()   # fails early when provisioning has not run
    account = s.client("sts").get_caller_identity()["Account"]
    gateway_arn = f"arn:aws:iam::{account}:role/{p.GATEWAY_ROLE}"
    host_arn = ensure_host_role(iam, gateway_arn, f"arn:aws:ssm:{p.REGION}:{account}:parameter{SEED_PARAM}")
    print(f"role {host_arn} and its instance profile: ready", flush=True)
    print(f"{p.GATEWAY_ROLE}: " + ("now trusts the server role" if trust_gateway(iam, host_arn) else "already trusts the server role"),
          flush=True)
    vpc = default_vpc(ec2)
    sg = ensure_group(ec2, vpc)
    print(f"security group {sg} ({GROUP}): 80 and 443 open", flush=True)
    seed = seed_lines()
    if seed:
        store_seed_lines(ssm, seed)
        print(f"ssm parameter {SEED_PARAM}: {seed.count(chr(10)) + 1} seed lines stored, encrypted", flush=True)
    else:
        print("no seed lines in agent/.env: Research Bot and Ops Bot will not START on the server", flush=True)
    up = servers(ec2)
    if up and not args.new:
        for i in up:
            print(f"already up: {i['InstanceId']} at {address(i)} (nothing launched; --new launches another)")
        return 0
    password = new_password()
    values.update(GATEWAY_ROLE_ARN=gateway_arn, REPO_URL=REPO, BRANCH=args.branch, SEED_PARAM=SEED_PARAM,
                  BCRYPT=bcrypt_hash(password))
    instance = launch(ec2, ssm, sg, vpc, render(USERDATA.read_text(encoding="utf-8"), values))
    print(f"instance {instance['InstanceId']} ({instance['InstanceType']}) launching", flush=True)
    try:   # write the password down as soon as the instance exists, even if the wait below fails
        ec2.get_waiter("instance_running").wait(InstanceIds=[instance["InstanceId"]])
        instance = ec2.describe_instances(InstanceIds=[instance["InstanceId"]])["Reservations"][0]["Instances"][0]
    finally:
        where = write_access(args.access_file, instance, password)
        print(f"address and password written to {where}", flush=True)   # a path, not a secret
    print(f"running: {address(instance)} (first boot takes a few minutes; address and password in {where})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Host MYTOPIA on one EC2 server behind HTTPS and a team password.")
    ap.add_argument("--dry-run", action="store_true", help="print the plan and exit without calling AWS")
    ap.add_argument("--status", action="store_true", help="show the MYTOPIA server and its address")
    ap.add_argument("--new", action="store_true", help="launch another server even when one is up")
    ap.add_argument("--teardown", action="store_true", help="terminate the server and delete what this script made")
    ap.add_argument("--yes", action="store_true", help="confirm --teardown")
    ap.add_argument("--access-file", default=ACCESS_FILE, help=f"where the address and password go (default {ACCESS_FILE})")
    ap.add_argument("--branch", default="main", help="the pushed branch the server clones (default main)")
    args = ap.parse_args(argv)
    if args.dry_run:
        print("DRY RUN: would find-or-create:")
        for line in plan_lines():
            print("  " + line)
        return 0
    if args.teardown and not args.yes:
        print("--teardown terminates the server and deletes its role, firewall and seed parameter; add --yes to do it")
        return 2
    try:
        return run(args)
    except Exception as e:  # noqa: BLE001
        if p.error_code(e) in ("ExpiredToken", "ExpiredTokenException"):
            print("FAILED: ExpiredToken. The Workshop Studio keys expired: get new ones and re-run scripts\\aws_creds.py.",
                  file=sys.stderr)
            return 2
        raise


if __name__ == "__main__":
    sys.exit(main())
