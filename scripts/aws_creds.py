"""Save the Workshop Studio temporary AWS credentials for the MYTOPIA gateway, and nothing else.

Easiest way (no clipboard involved):
    1. In Workshop Studio click "Get AWS CLI credentials", select the lines, paste them into Notepad,
       save the file on your Desktop as  creds.txt
    2. From the repo root:   .venv\\Scripts\\python scripts\\aws_creds.py
       The script finds Desktop\\creds.txt by itself, saves the keys, verifies them with AWS, and
       DELETES creds.txt (pass --keep to keep it).

Other ways: --from-file PATH, --stdin (paste, then an empty line), or the clipboard (default when no
Desktop file exists). It writes profile [ws] into gateway\\.aws-credentials and gateway\\.aws-config
(both git-ignored) and never touches ~\\.aws, the registry or your PowerShell profile, so no other
process on this laptop (the agent included) inherits the credentials. Re-run it whenever Workshop
Studio shows new keys (they expire after a few hours; the error is ExpiredToken). It never prints a key.
"""
import argparse
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS = os.path.join(ROOT, "gateway", ".aws-credentials")
CONFIG = os.path.join(ROOT, "gateway", ".aws-config")
REGION = "us-east-1"
DESKTOP = os.environ.get("MYTOPIA_DESKTOP") or os.path.join(os.path.expanduser("~"), "Desktop")
DESKTOP_NAMES = ["creds.txt", "creds.txt.txt", "creds", "aws.txt", "aws-creds.txt", "aws_creds.txt", "credentials.txt"]
NEEDED = ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")
PREFIXES = re.compile(r"(\$Env:|\bexport\s+|\bset\s+-gx\s+|\bset\s+|\bsetx\s+)", re.IGNORECASE)
PAIR = re.compile(r'(AWS_[A-Z_]+)\s*[= ]\s*"?([^"\s]+)"?')


def read_clipboard() -> str:
    """Windows clipboard text via ctypes; falls back to a PowerShell command (no script file, so no policy)."""
    try:
        import ctypes
        from ctypes import wintypes
        u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
        u32.OpenClipboard.argtypes = [wintypes.HWND]
        u32.OpenClipboard.restype = wintypes.BOOL
        u32.GetClipboardData.argtypes = [wintypes.UINT]
        u32.GetClipboardData.restype = wintypes.HANDLE
        k32.GlobalLock.argtypes = [wintypes.HGLOBAL]
        k32.GlobalLock.restype = wintypes.LPVOID
        k32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
        k32.GlobalUnlock.restype = wintypes.BOOL
        if u32.OpenClipboard(None):
            try:
                h = u32.GetClipboardData(13)  # CF_UNICODETEXT
                if h:
                    p = k32.GlobalLock(h)
                    try:
                        text = ctypes.wstring_at(p)
                    finally:
                        k32.GlobalUnlock(h)
                    if text:
                        return text
            finally:
                u32.CloseClipboard()
    except Exception:  # noqa: BLE001
        pass
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"],
                           capture_output=True, text=True, timeout=20)
        return r.stdout or ""
    except Exception:  # noqa: BLE001
        return ""


def parse(text: str) -> dict:
    """Accept the PowerShell, cmd, bash and fish forms, on separate lines or all on one line."""
    cleaned = PREFIXES.sub(" ", text)
    return {m.group(1): m.group(2) for m in PAIR.finditer(cleaned)}


def find_desktop_file() -> str | None:
    for name in DESKTOP_NAMES:
        path = os.path.join(DESKTOP, name)
        if os.path.isfile(path):
            return path
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-file", help="read the block from this file instead of the Desktop file or the clipboard")
    ap.add_argument("--stdin", action="store_true", help="paste the block, then press Enter on an empty line")
    ap.add_argument("--keep", action="store_true", help="do not delete the Desktop file after saving")
    ap.add_argument("--profile", default="ws")
    args = ap.parse_args()

    source, used_file = "clipboard", None
    if args.from_file:
        used_file, source = args.from_file, args.from_file
        with open(used_file, encoding="utf-8-sig") as f:
            text = f.read()
    elif args.stdin:
        source = "stdin"
        print("Paste the credentials block, then press Enter on an empty line:")
        lines = []
        for line in sys.stdin:
            if not line.strip():
                break
            lines.append(line)
        text = "".join(lines)
    else:
        used_file = find_desktop_file()
        if used_file:
            source = used_file
            with open(used_file, encoding="utf-8-sig") as f:
                text = f.read()
        else:
            text = read_clipboard()

    creds = parse(text or "")
    missing = [k for k in NEEDED if k not in creds]
    if missing:
        found = ", ".join(sorted(creds)) or "no AWS_ variables at all"
        print(f"Read {source}: {len((text or '').splitlines())} line(s), found {found}; missing {', '.join(missing)}.")
        if source == "clipboard":
            print("The clipboard did not hold the block. Easiest fix: paste the lines into Notepad, save as "
                  f"{os.path.join(DESKTOP, 'creds.txt')}, and run this again; it finds that file by itself.")
        else:
            print("Save the whole block (the lines with AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN) and run this again.")
        return 1

    os.makedirs(os.path.dirname(CREDS), exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(CREDS, "w", encoding="ascii", newline="\n") as f:
        f.write(f"# Written by scripts/aws_creds.py at {stamp} (local time).\n"
                "# Temporary Workshop Studio credentials for the gateway only. They expire after a few hours;\n"
                "# re-run scripts/aws_creds.py with fresh keys when any call fails with ExpiredToken.\n"
                f"[{args.profile}]\n"
                f"aws_access_key_id = {creds['AWS_ACCESS_KEY_ID']}\n"
                f"aws_secret_access_key = {creds['AWS_SECRET_ACCESS_KEY']}\n"
                f"aws_session_token = {creds['AWS_SESSION_TOKEN']}\n")
    if not os.path.exists(CONFIG):
        with open(CONFIG, "w", encoding="ascii", newline="\n") as f:
            f.write("# Written by scripts/aws_creds.py. infra/provision.py adds [profile gateway] below.\n"
                    f"[profile {args.profile}]\nregion = {REGION}\noutput = json\n")
    print(f"Saved profile [{args.profile}] to {CREDS} (read from {source})", flush=True)

    if used_file and not args.from_file and not args.keep:
        try:
            os.remove(used_file)
            print(f"Deleted {used_file} (it held the keys; pass --keep next time to keep it)", flush=True)
        except OSError as e:
            print(f"Could not delete {used_file}: {e}. Delete it yourself.", flush=True)

    print("Verifying with AWS...", flush=True)
    r = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "whoami.py"), args.profile])
    if r.returncode == 0:
        print("Next: .venv\\Scripts\\python scripts\\probe.py   (tests every permission MYTOPIA needs)")
    return r.returncode


if __name__ == "__main__":
    sys.exit(main())
