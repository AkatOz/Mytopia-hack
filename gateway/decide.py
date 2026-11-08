"""The one function that decides whether an agent may use a tool, given its badge row (and, for send_email, where the
mail would go). Everything else in the gateway only gathers inputs for decide() and records what it returned."""

import re
from collections.abc import Iterable
from dataclasses import dataclass

MAX_LABEL_CHARS = 64   # caller-chosen text (X-Run-Id, Mcp-Name, a send_email `to`) is cut to this before the log
DEFAULT_EMAIL_DOMAINS = ("example.corp",)   # EMAIL_DOMAINS: the only domains send_email may write to
# The two egress reasons. "send_email to <to> refused: outside the company (only @example.corp)" pulls the badge at
# once; "send_email to <to> refused: not a valid company address (only @example.corp)" does not (it is counted).
EGRESS_PREFIX = "send_email to "
EGRESS_REFUSED = " refused: "
OUTSIDE_COMPANY = "outside the company"
NOT_A_COMPANY_ADDRESS = "not a valid company address"
NO_ADDRESS = "(no address)"                 # how a reason shows a missing, empty or blank `to`
DOMAIN_KEEP = 48   # a shortened address keeps its domain whole up to this length, else "…" and the domain's end
INSIDE, OUTSIDE, INVALID = "inside", "outside", "invalid"
SEPARATORS = re.compile(r"[,;]")            # recipients in one `to`
DISPLAY_FORM = re.compile(r"[^<>]*<([^<>]*)>")   # Display Name <addr>: the name may be empty and never holds < or >


@dataclass
class Decision:
    """The outcome of one check: ok, the rule that fired, and a sentence a human can read."""

    ok: bool
    rule: str  # allow-list | status-revoked | status-killed | token | registry-unavailable | header-mismatch | egress
    reason: str
    leak: bool = False  # egress only: a recipient outside the company, so the gateway pulls the badge at once


def short_time(iso_ts: str | None) -> str:
    """Return the HH:MM:SS part of an ISO timestamp like 2026-11-08T01:22:25.120Z (or the text as is)."""
    if iso_ts and "T" in iso_ts:
        return iso_ts.split("T", 1)[1][:8]
    return str(iso_ts)


def parse_domains(value: str | Iterable[str]) -> tuple[str, ...]:
    """EMAIL_DOMAINS as a tuple: comma-separated text or a list, each domain trimmed and lower-cased; empties and
    names with a space inside (no address could ever match them) dropped. Nothing left means no address is inside the
    company: every send_email is refused (fails closed)."""
    items = value.split(",") if isinstance(value, str) else value
    domains = (d.strip().lower() for d in items if isinstance(d, str))
    return tuple(d for d in domains if d and not any(ch.isspace() for ch in d))


def address_of(part: str) -> str | None:
    """The address in one recipient, `addr` or `Display Name <addr>`, trimmed; None unless it is well formed: exactly
    one "@", a non-empty local part without "%" or "!" (no relay routing through the company's server), a domain of
    non-empty dot-separated labels (so "ceo@" and "ceo@example.corp." are malformed, not outside), and no space or
    control character anywhere in the address."""
    part = part.strip()
    if "<" in part or ">" in part:
        bracketed = DISPLAY_FORM.fullmatch(part)
        if bracketed is None:
            return None
        part = bracketed.group(1).strip()
    if part.count("@") != 1 or " " in part or not part.isprintable():
        return None
    local, domain = part.split("@")
    if not local or "%" in local or "!" in local or "" in domain.split("."):
        return None
    return part


def recipient_class(to: object, domains: str | Iterable[str]) -> str:
    """Where a send_email would go. `to` lists recipients split by commas or semicolons, each a bare address or
    `Display Name <addr>`. OUTSIDE: at least one well-formed recipient in a domain that is not the company's (an
    attempt to send company data outside, whatever else is listed). INSIDE: every recipient is well formed and in an
    allowed domain. INVALID: nothing outside, but a malformed part, no recipient at all, or a `to` that is not text.
    Domains match exactly and case-insensitively in ASCII only, so no Unicode case folding (the Kelvin sign
    lower-cases to "k") can turn a look-alike domain into an allowed one."""
    if not isinstance(to, str):
        return INVALID
    allowed = parse_domains(domains)
    parts = [part for part in SEPARATORS.split(to) if part.strip()]
    found = INSIDE if parts else INVALID
    for part in parts:
        address = address_of(part)
        if address is None:
            found = INVALID  # keep looking: one recipient outside the company anywhere outranks a malformed part
            continue
        domain = address.split("@")[1]
        if not (domain.isascii() and domain.lower() in allowed):
            return OUTSIDE
    return found


def inside_company(to: object, domains: str | Iterable[str]) -> bool:
    """True when every recipient in `to` is a well-formed address in one of `domains`."""
    return recipient_class(to, domains) == INSIDE


def label(value: object) -> str:
    """Caller-chosen text as a reason shows it: cut to MAX_LABEL_CHARS, and any character that is not printable
    (a line break, a tab, a control character) shown as "?", so no argument can start a forged line in a log."""
    return "".join(ch if ch.isprintable() else "?" for ch in str(value)[:MAX_LABEL_CHARS])


def short_address(address: str, budget: int) -> str:
    """One address in at most `budget` characters with its domain kept: the local part is cut first ("…@" marks the
    cut), and a domain longer than DOMAIN_KEEP keeps "…" and its end, where the registrable name is. Text without an
    "@" is cut at the end ("…")."""
    if len(address) <= budget:
        return address
    if "@" not in address:
        return address[:budget - 1] + "…"
    local, domain = address.rsplit("@", 1)
    keep = max(2, min(DOMAIN_KEEP, budget - 3))  # room is left for one local character and "…@"
    if len(domain) > keep:
        domain = "…" + domain[-(keep - 1):]
    if len(local) + 1 + len(domain) <= budget:
        return f"{local}@{domain}"
    return f"{local[:budget - len(domain) - 2]}…@{domain}"


def address_label(to: object, domains: str | Iterable[str] = DEFAULT_EMAIL_DOMAINS) -> str:
    """The `to` of a send_email call as a reason shows it: the original text when it fits in MAX_LABEL_CHARS. A longer
    `to` shows one recipient with its domain kept (see short_address): the first one outside the company, else the
    first malformed one, else the first; " (+N more)" counts the others. Unprintable characters show as "?"."""
    if to is None or (isinstance(to, str) and not to.strip()):
        return NO_ADDRESS
    parts = [part.strip() for part in SEPARATORS.split(to) if part.strip()] if isinstance(to, str) else []
    if len(str(to)) <= MAX_LABEL_CHARS or not parts:
        return label(to)
    allowed = parse_domains(domains)
    found = [(address_of(part), part) for part in parts]
    focus = next((address for address, _ in found if address and recipient_class(address, allowed) == OUTSIDE),
                 next((part for address, part in found if address is None), found[0][0] or found[0][1]))
    more = f" (+{len(parts) - 1} more)" if len(parts) > 1 else ""
    return label(short_address(focus, MAX_LABEL_CHARS - len(more)) + more)


def egress_reason(to: object, domains: str | Iterable[str], outside: bool = True) -> str:
    """send_email to partner@rival.example refused: outside the company (only @example.corp), or, for a `to` with
    nothing outside but no valid company address either, "... refused: not a valid company address (only ...)"."""
    allowed = parse_domains(domains)
    where = "only " + " or ".join(f"@{d}" for d in allowed) if allowed else "no company domain is set"
    why = OUTSIDE_COMPANY if outside else NOT_A_COMPANY_ADDRESS
    return f"{EGRESS_PREFIX}{address_label(to, allowed)}{EGRESS_REFUSED}{why} ({where})"


def decide(row: dict | None, tool: str, arguments: dict | None = None,
           email_domains: str | Iterable[str] = DEFAULT_EMAIL_DOMAINS) -> Decision:
    """Decide one call; tool is a tool name or "tools/list" (allowed whenever the badge is ACTIVE). In order: the
    badge row, its status, its allow-list, then egress: a send_email the badge holds must still go only to company
    addresses (email_domains), or it is refused with rule egress. Pure: the arguments are the call's own."""
    if row is None:
        return Decision(False, "token", "client is not a registered agent")
    agent = row.get("agent", "?")
    status = row.get("status")
    if status == "KILLED":
        return Decision(False, "status-killed", "badge KILLED by operator; everything refused")
    if status == "REVOKED":
        when = short_time(row.get("revoked_at"))
        return Decision(False, "status-revoked", f"badge REVOKED at {when} by {row.get('revoked_by')}")
    if status != "ACTIVE":
        # Any other status (a typo, a hand-edited row) fails closed. The rule set is closed, so it is filed under
        # status-revoked: "the badge is not active", drawn by the island like a revoke; the reason names the real status.
        return Decision(False, "status-revoked", f"badge status {status} is not ACTIVE")
    allowed = list(row.get("allowed_tools") or [])
    if tool == "tools/list":
        return Decision(True, "allow-list", f"badge {agent}: {len(allowed)} tools")
    if tool not in allowed:
        return Decision(False, "allow-list", f"{tool} is not on badge {agent}")
    if tool == "send_email":
        # model behavior is not a security control: holding send_email never lets company data leave the company
        to = (arguments or {}).get("to")
        where = recipient_class(to, email_domains)
        if where == OUTSIDE:
            return Decision(False, "egress", egress_reason(to, email_domains), leak=True)
        if where == INVALID:
            return Decision(False, "egress", egress_reason(to, email_domains, outside=False))
    return Decision(True, "allow-list", f"{tool} is on badge {agent}")
