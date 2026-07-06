# toggl-mcp

Remote Toggl MCP server — query your time tracking AND backfill past entries. Same deploy pattern as kie-mcpv2 (Render + secret path in URL).

## Tools

**Read:**
- `get_current_timer` — what's running now
- `get_time_entries` — entries in a date range
- `get_summary` — totals by project for a range
- `get_projects` — list project names/ids

**Write (the part no other toggl MCP has):**
- `create_time_entry` — backdated entry with explicit start + stop
- `create_entries_bulk` — paste a whole reconstructed day (up to 25 rows), fires all
- `update_time_entry` / `delete_time_entry` — fix mistakes
- `start_timer` / `stop_timer` — live timers

## Deploy on Render

1. Push this folder to a new GitHub repo.
2. Render → New → Web Service → connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Environment variables:
   - `TOGGL_API_TOKEN` — from https://track.toggl.com/profile → bottom → "Click to reveal"
   - `MCP_SECRET_PATH` — any long random string (this is your URL secret, like the kie one)
   - `DEFAULT_TZ_OFFSET` — optional, defaults to `-05:00` (Panama)
4. Deploy. Your MCP URL is:
   `https://YOUR-APP.onrender.com/YOUR_SECRET/mcp`
5. Claude → Settings → Connectors → Add custom connector → paste that URL.

## Time format

Pass local Panama times like `2026-07-03T20:26` — the server assumes -05:00. Full ISO with offset/Z also works. 24h format only (20:26 = 8:26pm), which kills the AM/PM ambiguity problem.

## Rate limit

Toggl free plan = 30 requests/hour per workspace. Bulk create spaces requests 1.2s apart and caps at 25 rows per call. Keep one reconstructed day per hour and you're fine.
