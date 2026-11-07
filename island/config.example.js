// Copy to config.js for local development (config.js is git-ignored).
// When the gateway serves the island at http://127.0.0.1:8787/, it serves its own /config.js instead.
window.MYTOPIA = { api: "http://127.0.0.1:8787", adminToken: "dev-only-token", pollMs: 1000, staleAfterMs: 3000 };
