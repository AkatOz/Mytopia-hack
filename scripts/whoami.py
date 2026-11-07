"""Print the AWS identity behind a profile in gateway/.aws-credentials, or a one-line reason it failed.

    .venv\\Scripts\\python scripts\\whoami.py          # profile ws
    .venv\\Scripts\\python scripts\\whoami.py gateway  # the narrow assumed-role profile, once provisioned
"""
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS = os.path.join(ROOT, "gateway", ".aws-credentials")
CONFIG = os.path.join(ROOT, "gateway", ".aws-config")
if os.path.exists(CREDS):
    os.environ.setdefault("AWS_SHARED_CREDENTIALS_FILE", CREDS)
if os.path.exists(CONFIG):
    os.environ.setdefault("AWS_CONFIG_FILE", CONFIG)
for v in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"):
    os.environ.pop(v, None)

import boto3  # noqa: E402
from botocore.exceptions import ClientError, NoCredentialsError, ProfileNotFound  # noqa: E402

HINTS = {
    "ExpiredToken": "The Workshop Studio keys expired: click 'Get AWS CLI credentials' again, copy, re-run scripts\\aws_creds.py.",
    "ExpiredTokenException": "The Workshop Studio keys expired: click 'Get AWS CLI credentials' again, copy, re-run scripts\\aws_creds.py.",
    "InvalidClientTokenId": "These keys are not valid: copy the whole block again from Workshop Studio and re-run scripts\\aws_creds.py.",
    "SignatureDoesNotMatch": "The secret key was copied wrong: copy the whole block again.",
}

profile = sys.argv[1] if len(sys.argv) > 1 else "ws"
try:
    ident = boto3.Session(profile_name=profile, region_name="us-east-1").client("sts").get_caller_identity()
    try:
        age = int((time.time() - os.path.getmtime(CREDS)) / 60)
        saved = f"; keys saved {age} min ago"
    except OSError:
        saved = ""
    print(f"OK [{profile}]: account {ident['Account']}, {ident['Arn']}{saved}")
except ClientError as e:
    code = e.response["Error"]["Code"]
    print(f"FAILED [{profile}]: {code}: {e.response['Error']['Message']}. {HINTS.get(code, '')}")
    sys.exit(1)
except (NoCredentialsError, ProfileNotFound) as e:
    print(f"FAILED [{profile}]: {e}. Run scripts\\aws_creds.py first.")
    sys.exit(1)
