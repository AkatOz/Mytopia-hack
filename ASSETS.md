# Assets: what was made today, what was pre-existing, what is third-party

The AWS x A10 Hack 2026 rules allow AI tools but require the team to understand all submitted code and to say what was built during the event. This file draws that line for the whole repository. The island's file-by-file detail is in [island/ASSETS.md](island/ASSETS.md).

## Made today (Saturday 2026-11-07, during the event)

**Claude Code (Anthropic) wrote the engine's code today**, under the team's direction. The team chose the design, ran the AWS probe and the live run, reviewed the code, and studies it in [docs/EXPLAIN.md](docs/EXPLAIN.md). This covers:

- `gateway/`: the MCP gateway (Starlette app, hand-written JSON-RPC handler, `decide()`, badge registry, hash-chained event log, token verifiers, tool runners, `table.html`)
- `tools_lambda/`: the six fake tools and the fake Example Corp world
- `agent/`: the Strands agent
- `launcher/`: the harness that owns the agent's process
- `infra/`: AWS provisioning, teardown and the gateway's `credential_process`
- `scripts/`: credential setup, Bedrock key, probe, whoami, curl demos
- `tools/`: the mock gateway and the fixture checker
- `tests/`, `contract/`, `tasks/`, `replay/` (the recording of the 1:40 PM live run), `docs/`, this file and `README.md`

The island was also built today, by Ozi's Claude Code agent: the reducer, the island layout and gatehouse, plates, sparks, smoke and fire, the HUD, polling, replay, the buttons, the ledger room, and the tests. The list is in [island/ASSETS.md](island/ASSETS.md), section "New this weekend".

## Pre-existing (written before the event)

From **Mytopia**, Ozi's earlier personal project: a three.js pixel-art floating island, written with Claude Code in his own repository between 2026-10-07 and 2026-10-20. None of Mytopia's data, keys or other code came along.

- `island/three-d-stage.js`: the `<three-d-stage>` renderer component, byte-identical. Its header comments say it began as a copied starter component ("omelette starter", with an OBJ/GLB export toolbar this project does not use).
- In `island/src/scene.js`: the material palette, geometry helpers, terrain recipe, seeded random generator, window/door/roof/tree/lamp/fence recipes, the four building shapes, the robot body and the sky gradient. All were copied and trimmed.
- The visual language of the HUD (paper panels, smoke-then-fire ladder, mode badge, ticker). These are ideas only, re-implemented here.

Line-by-line origins are in [island/ASSETS.md](island/ASSETS.md), section "Pre-existing".

## Third-party

| What | Version | Licence | Where |
|---|---|---|---|
| three.js (`three.module.js`, `three.core.js`, `OrbitControls.js`) | 0.184.0 | MIT | vendored in `island/vendor/three/`, licence in `island/vendor/three/LICENSE` |
| Pixelify Sans (400, 600; latin), via Fontsource | | SIL Open Font License 1.1 | `island/fonts/`, licence in `island/fonts/OFL-PixelifySans.txt` and `island/fonts/OFL.txt` |
| VT323 (400; latin), via Fontsource | | SIL Open Font License 1.1 | `island/fonts/`, licence in `island/fonts/OFL-VT323.txt` |

Python packages, installed from PyPI into `.venv` and not committed (`requirements.txt`). Versions and licences were read from the installed package metadata.

| Package | Version | Licence | Used for |
|---|---|---|---|
| strands-agents | 1.64.0 | Apache-2.0 | the agent loop and its MCP client (`agent/main.py`) |
| mcp | 2.3.0 | MIT | the MCP client transport the agent uses; the gateway does not use its server |
| boto3 | 1.43.126 | Apache-2.0 | DynamoDB, Lambda, Cognito, STS, IAM calls |
| PyJWT (with cryptography) | 2.15.1 | MIT (cryptography: Apache-2.0 or BSD-3-Clause) | token verification against the JWKS; local HS256 tokens |
| starlette | 1.10.0 | BSD-3-Clause | the gateway's web app and the mock |
| uvicorn | 0.54.0 | BSD-3-Clause | serves the gateway |
| httpx | 0.28.1 | BSD-3-Clause | the launcher's calls to the gateway |
| httpx2 | 2.16.0 (installed as a dependency of mcp) | BSD-3-Clause | `agent/main.py` subclasses `httpx2.Auth` to send the current token |
| psutil | 7.2.2 | BSD-3-Clause | fallback process-tree kill in the launcher |
| aws-bedrock-token-generator | 1.1.0 | Apache-2.0 | mints the short-term Bedrock key (`scripts/bedrock_key.py`) |
| python-dotenv | 1.2.4 installed (unpinned) | BSD-3-Clause | reads the `.env` files |
| requests | 2.34.2 installed (unpinned) | Apache-2.0 | listed in `requirements.txt`; no file in the repo imports it directly |
| pytest | 9.2.0 | MIT | tests |

AWS services used (accounts and service terms provided by the event): Amazon Cognito, Amazon DynamoDB, AWS Lambda, AWS IAM and STS, Amazon Bedrock (Amazon Nova 2 Lite), Amazon CloudWatch Logs.

No images, sounds or 3D model files from third parties are used. The island's geometry is built in code.
