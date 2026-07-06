// Toggl MCP — remote server for Claude (same pattern as kie-mcpv2)
// Tools: query entries/summaries/projects, start/stop timers,
// AND the missing piece: create backdated entries (single + bulk), update, delete.

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const TOGGL_API_TOKEN = process.env.TOGGL_API_TOKEN;
const SECRET_PATH = process.env.MCP_SECRET_PATH || "changeme";
const DEFAULT_TZ = process.env.DEFAULT_TZ_OFFSET || "-05:00"; // Panama
const PORT = process.env.PORT || 3000;

if (!TOGGL_API_TOKEN) {
  console.error("Missing TOGGL_API_TOKEN env var");
  process.exit(1);
}

const BASE = "https://api.track.toggl.com/api/v9";
const AUTH = "Basic " + Buffer.from(`${TOGGL_API_TOKEN}:api_token`).toString("base64");

// ---------- tiny toggl client ----------
async function toggl(path, method = "GET", body = null) {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) throw new Error("Toggl rate limit hit (30 req/hr on free plan). Wait a bit and retry.");
  if (!res.ok) throw new Error(`Toggl API ${res.status}: ${await res.text()}`);
  if (res.status === 204 || res.headers.get("content-length") === "0") return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let cachedMe = null;
let cachedProjects = null;
let projectsCachedAt = 0;

async function me() {
  if (!cachedMe) cachedMe = await toggl("/me");
  return cachedMe;
}
async function defaultWorkspaceId() {
  return (await me()).default_workspace_id;
}
async function projects(force = false) {
  const STALE = 10 * 60 * 1000;
  if (force || !cachedProjects || Date.now() - projectsCachedAt > STALE) {
    cachedProjects = (await toggl("/me/projects")) || [];
    projectsCachedAt = Date.now();
  }
  return cachedProjects;
}
async function resolveProjectId(name) {
  if (!name) return null;
  const list = await projects();
  const exact = list.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (exact) return exact.id;
  const partial = list.find((p) => p.name.toLowerCase().includes(name.toLowerCase()));
  if (partial) return partial.id;
  throw new Error(
    `No project matching "${name}". Available: ${list.map((p) => p.name).join(", ")}`
  );
}
function projectNameById(list, id) {
  const p = list.find((x) => x.id === id);
  return p ? p.name : null;
}

// Accepts "2026-07-03T20:26" (assumes DEFAULT_TZ) or full ISO with offset/Z.
function toISO(t) {
  if (!t) return null;
  const hasOffset = /Z$|[+-]\d{2}:\d{2}$/.test(t);
  const iso = hasOffset ? t : `${t}${t.length === 16 ? ":00" : ""}${DEFAULT_TZ}`;
  const d = new Date(iso);
  if (isNaN(d)) throw new Error(`Bad time: "${t}". Use "2026-07-03T20:26" (assumes ${DEFAULT_TZ}) or full ISO.`);
  return d.toISOString();
}
function fmtDur(sec) {
  if (sec < 0) return "running";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function fmtEntry(e, plist) {
  return {
    id: e.id,
    description: e.description || "(no description)",
    project: e.project_id ? projectNameById(plist, e.project_id) : null,
    start: e.start,
    stop: e.stop || null,
    duration: fmtDur(e.duration),
    tags: e.tags || [],
  };
}
const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createEntry({ description, start, stop, project_name, tags }) {
  const wid = await defaultWorkspaceId();
  const startISO = toISO(start);
  const stopISO = toISO(stop);
  const durationSec = Math.round((new Date(stopISO) - new Date(startISO)) / 1000);
  if (durationSec <= 0) throw new Error(`stop must be after start (${description})`);
  const body = {
    description,
    start: startISO,
    stop: stopISO,
    duration: durationSec,
    workspace_id: wid,
    created_with: "toggl-mcp",
    ...(project_name ? { project_id: await resolveProjectId(project_name) } : {}),
    ...(tags?.length ? { tags } : {}),
  };
  return toggl(`/workspaces/${wid}/time_entries`, "POST", body);
}

// ---------- MCP server ----------
function buildServer() {
  const server = new McpServer({ name: "toggl-mcp", version: "1.0.0" });

  server.tool(
    "get_current_timer",
    "Get the currently running Toggl timer, if any.",
    {},
    async () => {
      const e = await toggl("/me/time_entries/current");
      if (!e) return ok({ running: false });
      return ok({ running: true, ...fmtEntry(e, await projects()) });
    }
  );

  server.tool(
    "get_time_entries",
    "Get time entries in a date range (max ~1000). Dates are YYYY-MM-DD.",
    {
      start_date: z.string().describe("YYYY-MM-DD (inclusive)"),
      end_date: z.string().describe("YYYY-MM-DD (exclusive — use the day AFTER the last day you want)"),
    },
    async ({ start_date, end_date }) => {
      const entries = (await toggl(`/me/time_entries?start_date=${start_date}&end_date=${end_date}`)) || [];
      const plist = await projects();
      return ok({ count: entries.length, entries: entries.map((e) => fmtEntry(e, plist)) });
    }
  );

  server.tool(
    "get_summary",
    "Total tracked time by project over a date range. Dates YYYY-MM-DD (end exclusive).",
    {
      start_date: z.string(),
      end_date: z.string(),
    },
    async ({ start_date, end_date }) => {
      const entries = (await toggl(`/me/time_entries?start_date=${start_date}&end_date=${end_date}`)) || [];
      const plist = await projects();
      const byProject = {};
      let total = 0;
      for (const e of entries) {
        if (e.duration < 0) continue; // skip running
        const name = e.project_id ? projectNameById(plist, e.project_id) || "Unknown" : "(no project)";
        byProject[name] = (byProject[name] || 0) + e.duration;
        total += e.duration;
      }
      const rows = Object.entries(byProject)
        .sort((a, b) => b[1] - a[1])
        .map(([project, sec]) => ({ project, time: fmtDur(sec) }));
      return ok({ total: fmtDur(total), entries: entries.length, by_project: rows });
    }
  );

  server.tool(
    "get_projects",
    "List all Toggl projects (names + ids).",
    {},
    async () => {
      const list = await projects(true);
      return ok(list.map((p) => ({ id: p.id, name: p.name, active: p.active })));
    }
  );

  server.tool(
    "start_timer",
    "Start a live timer now.",
    {
      description: z.string(),
      project_name: z.string().optional().describe("Toggl project name, e.g. 'Editing Work'"),
      tags: z.array(z.string()).optional(),
    },
    async ({ description, project_name, tags }) => {
      const wid = await defaultWorkspaceId();
      const body = {
        description,
        start: new Date().toISOString(),
        duration: -1,
        workspace_id: wid,
        created_with: "toggl-mcp",
        ...(project_name ? { project_id: await resolveProjectId(project_name) } : {}),
        ...(tags?.length ? { tags } : {}),
      };
      const e = await toggl(`/workspaces/${wid}/time_entries`, "POST", body);
      return ok({ started: true, id: e.id, description: e.description });
    }
  );

  server.tool(
    "stop_timer",
    "Stop the currently running timer.",
    {},
    async () => {
      const cur = await toggl("/me/time_entries/current");
      if (!cur) return ok({ stopped: false, reason: "no timer running" });
      const e = await toggl(`/workspaces/${cur.workspace_id}/time_entries/${cur.id}/stop`, "PATCH");
      return ok({ stopped: true, ...fmtEntry(e, await projects()) });
    }
  );

  server.tool(
    "create_time_entry",
    "Create a PAST (backdated) time entry with explicit start and stop. This is the backfill tool.",
    {
      description: z.string().describe("Entry name in M's style, e.g. 'Editing B97: Images'"),
      start: z.string().describe(`Start time, e.g. '2026-07-03T20:26' (assumes ${DEFAULT_TZ}) or full ISO`),
      stop: z.string().describe("Stop time, same format"),
      project_name: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async (args) => {
      const e = await createEntry(args);
      return ok({ created: true, id: e.id, description: e.description, start: e.start, stop: e.stop });
    }
  );

  server.tool(
    "create_entries_bulk",
    "Create MANY backdated entries in one call — paste a whole reconstructed day. Fires sequentially with a small delay to respect Toggl's rate limit (30/hr free plan; keep a single day under ~25 rows).",
    {
      entries: z
        .array(
          z.object({
            description: z.string(),
            start: z.string(),
            stop: z.string(),
            project_name: z.string().optional(),
            tags: z.array(z.string()).optional(),
          })
        )
        .min(1)
        .max(25),
    },
    async ({ entries }) => {
      const results = [];
      for (const entry of entries) {
        try {
          const e = await createEntry(entry);
          results.push({ ok: true, id: e.id, description: e.description });
        } catch (err) {
          results.push({ ok: false, description: entry.description, error: String(err.message || err) });
        }
        await sleep(1200);
      }
      const failed = results.filter((r) => !r.ok);
      return ok({ created: results.length - failed.length, failed: failed.length, results });
    }
  );

  server.tool(
    "update_time_entry",
    "Update an existing entry (fix description, times, or project).",
    {
      id: z.number().describe("Entry id (from get_time_entries)"),
      description: z.string().optional(),
      start: z.string().optional(),
      stop: z.string().optional(),
      project_name: z.string().optional(),
    },
    async ({ id, description, start, stop, project_name }) => {
      const wid = await defaultWorkspaceId();
      const body = {};
      if (description) body.description = description;
      if (start) body.start = toISO(start);
      if (stop) body.stop = toISO(stop);
      if (start && stop) body.duration = Math.round((new Date(body.stop) - new Date(body.start)) / 1000);
      if (project_name) body.project_id = await resolveProjectId(project_name);
      const e = await toggl(`/workspaces/${wid}/time_entries/${id}`, "PUT", body);
      return ok({ updated: true, ...fmtEntry(e, await projects()) });
    }
  );

  server.tool(
    "delete_time_entry",
    "Delete a time entry by id.",
    { id: z.number() },
    async ({ id }) => {
      const wid = await defaultWorkspaceId();
      await toggl(`/workspaces/${wid}/time_entries/${id}`, "DELETE");
      return ok({ deleted: true, id });
    }
  );

  return server;
}

// ---------- HTTP transport (stateless, like a simple remote MCP) ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.send("toggl-mcp up"));

app.post(`/${SECRET_PATH}/mcp`, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

// Reject GET/DELETE on the MCP path (stateless mode)
app.get(`/${SECRET_PATH}/mcp`, (_req, res) => res.status(405).send("POST only"));

app.listen(PORT, () => console.log(`toggl-mcp listening on :${PORT} at /${SECRET_PATH}/mcp`));
