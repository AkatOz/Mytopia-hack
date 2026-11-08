"""Badge tiers: the ceiling of tools a badge may ever hold, by rank. The gateway refuses a grant above the ceiling
(HTTP 403, no event) and trims a badge when it is demoted. island/src/tiers.js is the same table for the browser:
change both or neither. The six tools are listed in gateway/mcp.py (TOOL_NAMES); the ceilings are subsets of them."""

TIERS: dict[str, dict] = {
    "bronze": {"rank": 1, "name": "Bronze", "line": "looks, never changes anything",
               "ceiling": ["read_file", "search_files"]},
    "silver": {"rank": 2, "name": "Silver", "line": "reads and files tickets",
               "ceiling": ["read_file", "search_files", "create_issue", "list_issues"]},
    "gold": {"rank": 3, "name": "Gold", "line": "may speak for the company",
             "ceiling": ["read_file", "search_files", "create_issue", "list_issues", "send_email"]},
    "diamond": {"rank": 4, "name": "Diamond", "line": "may delete: the only tier that can",
                "ceiling": ["read_file", "search_files", "create_issue", "list_issues", "send_email", "delete_file"]},
}
TIER_ORDER = ("bronze", "silver", "gold", "diamond")
SEED_TIERS = {"research-bot": "silver", "ops-bot": "bronze"}  # the two demo badges; /demo/reset puts these back
# The colours a Factory-made robot may wear (the two seed robots are mustard and sage).
ROBOT_COLORS = ("mustard", "sage", "teal", "plum", "brick", "slate")


def ceiling(tier: str) -> list[str]:
    """The tools a badge of this tier may hold (empty for an unknown tier: fail closed)."""
    return list(TIERS.get(tier, {}).get("ceiling", []))


def infer_tier(allowed_tools: list[str]) -> str:
    """For a row written before tiers existed: the lowest tier whose ceiling holds every tool on the badge."""
    tools = set(allowed_tools or [])
    for key in TIER_ORDER:
        if tools <= set(TIERS[key]["ceiling"]):
            return key
    return "diamond"


def above_ceiling(tier: str, tools: list[str]) -> list[str]:
    """The tools in the list that this tier may not hold, in catalog order."""
    allowed = set(ceiling(tier))
    return [t for t in tools if t not in allowed]


def public_tiers() -> list[dict]:
    """The table GET /tiers returns, lowest rank first."""
    return [{"tier": key, **TIERS[key]} for key in TIER_ORDER]
