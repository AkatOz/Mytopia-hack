# MYTOPIA

Identity and access management for AI agents, drawn as an island. Every agent gets a badge, every tool is a building, a real MCP gateway backed by AWS decides every call, and when you pull a badge mid-task the very next call is refused at the gate, on the island and in the terminal.

AWS x A10 Hack 2026, Santa Clara University. A10 track, Prompt 1: Agentic Identity.

- `contract/` the fixed contract between the engine and the island (events, API, fixture)
- `docs/INTERFACES.md` how the components fit together; `docs/ISLAND_BRIEF.md` the island agent's brief; `docs/AWS_SETUP.md` the event account
- `gateway/` the MCP gateway (Starlette); `tools_lambda/` the six tools; `agent/` the Strands agent; `launcher/` the harness; `infra/` AWS provisioning; `island/` the face; `scripts/` setup, probe and demo scripts; `tests/`

Built Saturday 2026-11-07 during the event. Full README to follow in phase 5.
