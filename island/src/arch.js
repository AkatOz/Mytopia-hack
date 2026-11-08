// The architecture sheet (key A; docs/ISLAND_V2_ADDITIONS.md section 6). New today, round two.
// Who holds what and where the checks are, drawn once as inline SVG in the island's paper style: cream and paper fills,
// ink lines, and no colour but the state colours (green for the enforcement point, brick red dashes for the trust
// boundaries). Drawn 1:1 at 960 px wide so every word is at least 16 px; main.js puts ARCH_SHEET into #arch.
// Every fact below comes from the spec above (and the contract); nothing here is read from the gateway at runtime.

const INK = '#2b221e', PAPER = '#fbf7ee', CREAM = '#f3ead7', DIM = '#7a6f62', GOOD = '#3f8a56', BAD = '#b4553e';
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));

// a box: title (Pixelify Sans 20 px, or VT323 for a table inside a box) and fact lines (VT323 18 px, 21 px apart)
function box(x, y, w, h, title, lines, { stroke = INK, width = 2, titleClass = 'arch-t' } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${PAPER}" stroke="${stroke}" stroke-width="${width}"/>`
    + `<text class="${titleClass}" x="${x + 10}" y="${y + 24}">${esc(title)}</text>`
    + lines.map((l, i) => `<text class="arch-f" x="${x + 10}" y="${y + 48 + i * 21}">${esc(l)}</text>`).join('');
}
// an arrow from (x1, y1) to (x2, y2) through optional corner points, with a label on a paper patch at (lx, ly)
function arrow(pts, label, lx, ly) {
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  const w = label.length * 8 + 12; // VT323 18 px is about 7.2 px a character
  return `<path d="${d}" fill="none" stroke="${INK}" stroke-width="2" marker-end="url(#arch-head)"/>`
    + `<rect x="${lx - w / 2}" y="${ly - 12}" width="${w}" height="22" fill="${PAPER}"/>`
    + `<text class="arch-l" x="${lx}" y="${ly + 5}" text-anchor="middle">${esc(label)}</text>`;
}

// The 18 px facts and labels assume VT323's 0.4 em per character. AWS band: boxes y 34..174, arrow labels at y 189,
// the laptop/AWS boundary at y 206. Laptop band: boxes y 240..400, the badge-status route along y 424.
const AWS_Y = 34, AWS_H = 140, AWS_B = AWS_Y + AWS_H, LAB_Y = 189, LAP_Y = 240, LAP_H = 160, LAP_B = LAP_Y + LAP_H;
const DDB_B = AWS_Y + 134; // bottom of the two table boxes inside DynamoDB
const col = (x, lines) => lines.map((l, i) => `<text class="arch-f" x="${x}" y="${LAP_Y + 48 + i * 21}">${esc(l)}</text>`).join('');
const svg = `<svg class="arch-svg" viewBox="0 0 960 456" width="960" role="img" aria-label="MYTOPIA architecture: launcher, agent and gateway on the laptop; Cognito, DynamoDB, Lambda and Bedrock on AWS">
<style>
  .arch-t { font: 600 20px "Pixelify Sans", monospace; fill: ${INK}; }
  .arch-f { font: 18px "VT323", monospace; fill: ${INK}; }
  .arch-n { font: 19px "VT323", monospace; fill: ${INK}; text-decoration: underline; }
  .arch-l { font: 18px "VT323", monospace; fill: ${INK}; }
  .arch-z { font: 600 17px "Pixelify Sans", monospace; fill: ${DIM}; letter-spacing: 1px; }
  .arch-b { font: 18px "VT323", monospace; fill: ${BAD}; }
</style>
<defs><marker id="arch-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker></defs>
<rect x="0" y="0" width="960" height="202" fill="${CREAM}"/>
<text class="arch-z" x="16" y="24">AWS</text>
${box(16, AWS_Y, 208, AWS_H, 'Cognito', ['one machine client', 'per agent', 'cannot revoke a', 'machine token,', 'and we say so'])}
${box(240, AWS_Y, 200, AWS_H, 'Bedrock', ['the model:', 'Nova 2 Lite', 'no server-side tools'])}
<rect x="456" y="${AWS_Y}" width="320" height="${AWS_H}" fill="${PAPER}" stroke="${INK}" stroke-width="2"/>
<text class="arch-t" x="466" y="${AWS_Y + 24}">DynamoDB</text>
${box(464, AWS_Y + 34, 148, 100, 'mytopia_agents', ['the badge: status', 'and allowed tools,', 'read on every call'], { width: 1.5, titleClass: 'arch-n' })}
${box(620, AWS_Y + 34, 148, 100, 'mytopia_events', ["the chain's", 'durable copy,', 'PutItem only'], { width: 1.5, titleClass: 'arch-n' })}
${box(792, AWS_Y, 152, AWS_H, 'Lambda', ['mytopia-tools:', 'the six tools,', 'invokable only by', "the gateway's role"])}
<line x1="0" y1="206" x2="960" y2="206" stroke="${BAD}" stroke-width="3" stroke-dasharray="12 8"/>
<text class="arch-z" x="16" y="232">THIS LAPTOP</text>
${box(16, LAP_Y, 184, LAP_H, 'launcher', ['holds the client secret', 'mints the 5-min token', 'owns the agent process', 'polls the badge', 'every 250 ms', 'kills the process tree'])}
${box(256, LAP_Y, 180, LAP_H, 'agent', ['Strands, Nova 2 Lite', 'holds only the token', 'and a Bedrock-only', 'bearer token; its one', 'MCP server is the', 'gateway'])}
<line x1="477" y1="218" x2="477" y2="444" stroke="${BAD}" stroke-width="3" stroke-dasharray="12 8"/>
${box(522, LAP_Y, 422, LAP_H, 'gateway: the enforcement point', [], { stroke: GOOD, width: 4 })}
${col(532, ['five token checks', 'one strongly consistent', 'badge read per call', 'serves this island'])}
${col(742, ['decide(): allow or deny', 'the hash chain: every', 'decision, linked', 'by SHA-256'])}
${arrow([[170, AWS_B], [170, LAP_Y]], 'token', 170, LAB_Y)}
${arrow([[346, LAP_Y], [346, AWS_B]], 'converse', 346, LAB_Y)}
${arrow([[560, LAP_Y], [560, DDB_B]], 'GetItem consistent', 560, LAB_Y)}
${arrow([[694, LAP_Y], [694, DDB_B]], 'PutItem', 694, LAB_Y)}
${arrow([[868, LAP_Y], [868, AWS_B]], 'invoke', 868, LAB_Y)}
${arrow([[200, LAP_Y + 48], [256, LAP_Y + 48]], 'token', 228, LAP_Y + 30)}
${arrow([[436, LAP_Y + 78], [522, LAP_Y + 78]], 'tools/call', 479, LAP_Y + 60)}
${arrow([[108, LAP_B], [108, 424], [620, 424], [620, LAP_B]], 'badge status, every 250 ms', 330, 424)}
<line x1="700" y1="438" x2="744" y2="438" stroke="${BAD}" stroke-width="3" stroke-dasharray="12 8"/>
<text class="arch-b" x="752" y="444">trust boundary</text>
</svg>`;

// Under the drawing: which picture on the island proves which A10 step, and the honest limits in one line.
const MAP = [
  ['the ID card at the gatehouse window', 'authenticate'],
  ['gates that open', 'allow selected MCP tools'],
  ["the chief's escort to the pen", 'revoke mid-task'],
  ['stamps over the pen', 'block subsequent requests'],
  ['power-down', 'stop the run (borrowed from Prompt 2)'],
];
const table = `<table class="arch-map"><tr>${MAP.map(([p]) => `<td>${esc(p)}</td>`).join('')}</tr>`
  + `<tr class="step">${MAP.map(([, s]) => `<td>${esc(s)}</td>`).join('')}</tr></table>`;

export const ARCH_SHEET = `<h3>Who holds what, and where the checks are <span class="dim">A or Esc closes</span></h3>${svg}`
  + `<div class="arch-cap">what each picture on the island proves (A10 steps)</div>${table}`
  + `<p class="arch-limits"><b>Honest limits:</b> a call already in flight completes; the agent and the gateway run as the same OS user; the admin token is a demo shortcut; a client secret in a file stands in for an attested workload identity.</p>`;
