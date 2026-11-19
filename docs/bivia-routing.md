# Bivia routing

When a Bivia API key is available, scode uses Bivia's fast decision API to
classify a task and choose a backend. The backend choice is still checked
against scode's availability, quota-floor, and task-policy rules. Manual
backend overrides remain authoritative.

scode reads the key from `SCODE_BIVIA_API_KEY`, `BIVIA_API_KEY`, or
`A8_API_KEY`, then from `~/.bivia/config` (the file written by the Bivia CLI).
Each route sends the task brief and available backend/quota summaries to
Articul8's Bivia API. The two decisions are metered separately. If the API
fails or returns an invalid or ineligible choice, scode falls back to its
local classifier and policy. A route may make only one Bivia decision when
backend selection is already determined by an override or a single available
backend.

Set `SCODE_BIVIA=false` to disable Bivia and keep routing local.
