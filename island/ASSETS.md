# What in island/ was pre-existing, and what was made this weekend

The hackathon rules require the team to say exactly what was built during the event. The island's look comes from **Mytopia**, a teammate's (Ozi's) earlier personal project: a three.js pixel-art "floating island". It was written with Claude Code in Ozi's own repository between **2026-10-07 and 2026-10-20**, before this event. None of Mytopia's data, keys or other code came along.

## Pre-existing (copied from Mytopia)

| File / piece in island/ | Origin in Mytopia | Author, date | Changed here? |
|---|---|---|---|
| `three-d-stage.js` | `three-d-stage.js`: the `<three-d-stage>` web component (WebGL renderer, orthographic camera, orbit controls, half-resolution pixel render, ink-outline post-process shader) | Ozi with Claude Code, 2026-10-07 to 10-15 | No, byte-identical |
| `src/scene.js`: material list and palette, `mat`, `box`/`cyl`/`ball`/`grp`/`pyramid` helpers, `Batch` (vertex-colour mesh builder) | `campus.js` lines 21-90 | same, 2026-10-07 to 10-20 | Trimmed to what the scene uses |
| `src/scene.js`: the tile-terrain recipe (grass colours, dirt/rock layers, paving) and the seeded RNG | `campus.js` lines 12-15, 91-165 | same | Smaller island (radius 11.5 vs 19), new paths |
| `src/scene.js`: `windowOn`, `door`, `archWindow`, `gableRoof`, `tree`, `bush`, `lamp`, `fence` | `campus.js` lines 177-226, 630-720 | same | Minor simplifications |
| `src/scene.js`: the four building shapes. **Files** = Long-term Library, **GitHub** = Swing Studio, **Mail** = Welcome Center cottage, **Admin** = Quality Court courthouse | `campus.js` buildings 2, 3, 6 and the court islet | same | Scaled down, re-placed, decorations removed |
| `src/scene.js`: the small robot body (treads, body, head, eyes, antenna) | `campus.js` `smallRobot()` | same | Plate added, scale changed |
| `src/scene.js`: the sky gradient | `campus.js` `skyTex` | same | No |
| The visual language of the HUD: cream paper panels, 3px ink border, hard offset shadow, palette tokens; the trouble ladder (smoke, then fire); the mode badge; the ticker; the room card | Mytopia `Floating Island Campus.html`, `style.js`, `ladder.js` (ideas only, re-written here) | same | Re-implemented from scratch for this scene |

## Third-party (licences)

| Asset | Licence | File |
|---|---|---|
| three.js 0.184.0 (`vendor/three/three.module.js`, `three.core.js`, `OrbitControls.js`) | MIT | `vendor/three/LICENSE` |
| Pixelify Sans (400, 600; latin), via Fontsource | SIL Open Font License 1.1 | `fonts/OFL.txt`, `fonts/OFL-PixelifySans.txt` |
| VT323 (400; latin), via Fontsource | SIL Open Font License 1.1 | `fonts/OFL-VT323.txt` |

## New this weekend (Nov 7-8, 2026)

- `src/reducer.js`: the pure `apply(state, event)`, the badge rule, dedupe and ordering, the tool-to-building map.
- `tests/reducer.test.mjs`: 10 tests that run the 21-event fixture through the reducer.
- `src/main.js`: live polling with a cursor, replay at 1.5 s per event, the effects queue (at most three at once), the four buttons that only POST, the T table, R replay, robot click → raw JSON, and the overlays (name tags, speech bubbles, stamps, building labels, BLOCKED count).
- `src/scene.js` (new parts): the island layout, **the gatehouse** (lodges, arch, striped barrier that lifts for allowed calls, OFF LIMITS velvet-rope pen, BLOCKED bin that fills with red packets), the mailbox, the chest **plates** (grey, green, red, amber, dark with eyes out), roof **lamps**, green and red **sparks** with the fizzle at the barrier, the two-rung **smoke** plus **fire**, and robot **walking**.
- `index.html`: the paper HUD (mode badge, banner, agent card, ticker, operator panel, table sheet) and the responsive rules for 1280x720 and about 800 px wide.
- `config.example.js`, `README.md`, `ASSETS.md`, `CONTRACT_QUESTIONS.md`.
- `fixture.json` is a copy of `contract/fixture.json`, so **R** works when the gateway serves only `island/`.
