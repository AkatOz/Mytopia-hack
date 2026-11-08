// Badge tiers, the same table as gateway/tiers.py (change both or neither). A tier is the ceiling of tools a badge
// may ever hold; the gateway refuses a grant above it and trims a badge that is demoted. Colours are Mytopia's muted
// palette, never neon: the medal on the agent card and the stripe on the ID card use `hex`.
export const TIERS = {
  bronze:  { rank: 1, name: 'Bronze',  line: 'looks, never changes anything',       hex: '#a7714a', ceiling: ['read_file', 'search_files'] },
  silver:  { rank: 2, name: 'Silver',  line: 'reads and files tickets',             hex: '#9a9a92', ceiling: ['read_file', 'search_files', 'create_issue', 'list_issues'] },
  gold:    { rank: 3, name: 'Gold',    line: 'may speak for the company',           hex: '#d9a032', ceiling: ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email'] },
  diamond: { rank: 4, name: 'Diamond', line: 'may delete: the only tier that can',  hex: '#6fa7c2', ceiling: ['read_file', 'search_files', 'create_issue', 'list_issues', 'send_email', 'delete_file'] },
};
export const TIER_ORDER = ['bronze', 'silver', 'gold', 'diamond'];
export const SEED_TIERS = { 'research-bot': 'silver', 'ops-bot': 'bronze' };
// the colours a Factory-made robot may wear (hex for the HUD; actors.js has the matching materials)
export const ROBOT_COLORS = { mustard: '#e0b347', sage: '#9cc29c', teal: '#4f8a8b', plum: '#7a4e6d', brick: '#b4553e', slate: '#63738a' };

export const ceiling = (tier) => (TIERS[tier] ? TIERS[tier].ceiling.slice() : []);
// for a badge row written before tiers existed: the lowest tier whose ceiling holds every tool on the badge
export function inferTier(allowedTools) {
  const tools = new Set(allowedTools || []);
  for (const key of TIER_ORDER) if ([...tools].every((t) => TIERS[key].ceiling.includes(t))) return key;
  return 'diamond';
}
// the lowest tier that may hold this tool (for the chip's "Gold+" hint)
export function tierFor(tool) {
  for (const key of TIER_ORDER) if (TIERS[key].ceiling.includes(tool)) return key;
  return 'diamond';
}
export const aboveCeiling = (tier, tools) => tools.filter((t) => !ceiling(tier).includes(t));
