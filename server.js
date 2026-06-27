import express from "express";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const { ANTHROPIC_API_KEY, FOOTBALL_DATA_API_KEY, PORT = 3000 } = process.env;

if (!ANTHROPIC_API_KEY || !FOOTBALL_DATA_API_KEY) {
  console.error(
    "Missing API keys. Copy .env.example to .env and fill in ANTHROPIC_API_KEY and FOOTBALL_DATA_API_KEY."
  );
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const app = express();
app.use(express.json());
app.use(express.static("public"));

// --- Constants ---------------------------------------------------------------

const FOOTBALL_API_BASE = "https://api.football-data.org/v4";
const MODEL = "claude-haiku-4-5";

// Common competition codes used by football-data.org. The router maps natural
// language to these; the list also seeds Claude's extraction prompt.
const COMPETITIONS = {
  WC: "FIFA World Cup",
  EC: "UEFA European Championship (Euros)",
  CL: "UEFA Champions League",
  EL: "UEFA Europa League",
  PL: "Premier League (England)",
  ELC: "Championship (England)",
  BL1: "Bundesliga (Germany)",
  SA: "Serie A (Italy)",
  PD: "La Liga (Spain)",
  FL1: "Ligue 1 (France)",
  DED: "Eredivisie (Netherlands)",
  PPL: "Primeira Liga (Portugal)",
  BSA: "Brasileirão (Brazil)",
  CLI: "Copa Libertadores",
};

const LIVE_STATUSES = ["IN_PLAY", "PAUSED", "LIVE"];

// --- football-data.org helpers ----------------------------------------------

async function footballFetch(path) {
  const res = await fetch(`${FOOTBALL_API_BASE}${path}`, {
    headers: { "X-Auth-Token": FOOTBALL_DATA_API_KEY },
  });

  if (res.status === 429) {
    const err = new Error(
      "The football data service is rate-limited right now (free tier allows 10 requests/minute). Please wait a moment and try again."
    );
    err.statusCode = 429;
    throw err;
  }

  // 403/404 mean "no access / not found" — treat as empty rather than fatal so
  // the web-search fallback can take over.
  if (res.status === 403 || res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const err = new Error(
      `Football data service returned an error (HTTP ${res.status}).`
    );
    err.statusCode = 502;
    throw err;
  }

  return res.json();
}

// Build a querystring from a params object, skipping empty values.
function qs(params = {}) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ""
  );
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

// --- Query router (intent + entity extraction) -------------------------------

const ROUTER_SCHEMA = `{
  "intent": one of ["live_scores","past_results","standings","scorers","team_info","schedule","competition_list","general"],
  "competitionCode": a code from the list below, or null if none is clearly implied,
  "dateFrom": "YYYY-MM-DD" or null,
  "dateTo": "YYYY-MM-DD" or null,
  "teamName": string or null,
  "playerName": string or null
}`;

async function routeQuestion(question, today) {
  const compList = Object.entries(COMPETITIONS)
    .map(([code, name]) => `${code} = ${name}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 400,
    system:
      "You are a query router for a football data assistant. Given a user question, " +
      "extract structured search parameters. Respond with ONLY a JSON object, no prose, " +
      "no markdown fences.\n\n" +
      `Today's date is ${today}. Resolve relative dates ("yesterday", "last week", ` +
      `"this weekend", "last month") into absolute ISO dates relative to today.\n\n` +
      `Competition codes:\n${compList}\n\n` +
      `Output shape:\n${ROUTER_SCHEMA}`,
    messages: [{ role: "user", content: question }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim()
    // Strip accidental code fences.
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(text);
    return {
      intent: parsed.intent || "general",
      competitionCode: parsed.competitionCode || null,
      dateFrom: parsed.dateFrom || null,
      dateTo: parsed.dateTo || null,
      teamName: parsed.teamName || null,
      playerName: parsed.playerName || null,
    };
  } catch {
    // If routing fails, fall back to a generic live-scores lookup.
    return {
      intent: "general",
      competitionCode: null,
      dateFrom: null,
      dateTo: null,
      teamName: null,
      playerName: null,
    };
  }
}

// --- Data fetching layer -----------------------------------------------------

// Returns { data, empty } — `empty` signals the web-search fallback should run.
async function fetchData(route) {
  const { intent, competitionCode, dateFrom, dateTo } = route;
  const code = competitionCode; // may be null

  switch (intent) {
    case "live_scores": {
      const path = code
        ? `/competitions/${code}/matches${qs({ status: LIVE_STATUSES.join(",") })}`
        : `/matches${qs({ status: LIVE_STATUSES.join(",") })}`;
      const data = await footballFetch(path);
      return wrap(data, (d) => (d.matches || []).length > 0, "matches");
    }

    case "past_results": {
      if (!code) return { data: null, empty: true };
      const data = await footballFetch(
        `/competitions/${code}/matches${qs({
          status: "FINISHED",
          dateFrom,
          dateTo,
        })}`
      );
      return wrap(data, (d) => (d.matches || []).length > 0, "matches");
    }

    case "schedule": {
      const path = code
        ? `/competitions/${code}/matches${qs({
            status: "SCHEDULED",
            dateFrom,
            dateTo,
          })}`
        : `/matches${qs({ status: "SCHEDULED", dateFrom, dateTo })}`;
      const data = await footballFetch(path);
      return wrap(data, (d) => (d.matches || []).length > 0, "matches");
    }

    case "standings": {
      if (!code) return { data: null, empty: true };
      const data = await footballFetch(`/competitions/${code}/standings`);
      return wrap(data, (d) => (d.standings || []).length > 0, "standings");
    }

    case "scorers": {
      if (!code) return { data: null, empty: true };
      const data = await footballFetch(`/competitions/${code}/scorers`);
      return wrap(data, (d) => (d.scorers || []).length > 0, "scorers");
    }

    case "team_info": {
      if (!code) return { data: null, empty: true };
      const data = await footballFetch(`/competitions/${code}/teams`);
      return wrap(data, (d) => (d.teams || []).length > 0, "teams");
    }

    case "competition_list": {
      const data = await footballFetch(`/competitions`);
      return wrap(data, (d) => (d.competitions || []).length > 0, "competitions");
    }

    case "general":
    default: {
      // Best-effort: today's matches for the competition, or all competitions.
      const path = code
        ? `/competitions/${code}/matches`
        : `/matches`;
      const data = await footballFetch(path);
      return wrap(data, (d) => (d.matches || []).length > 0, "matches");
    }
  }
}

// Normalise an API response into { data, empty }. `hasData` decides emptiness;
// `key` optionally trims the payload to the relevant array to save tokens.
function wrap(data, hasData, key) {
  if (!data || !hasData(data)) return { data: null, empty: true };
  if (key && Array.isArray(data[key])) {
    // Cap large lists so we don't blow the context window.
    return { data: { ...data, [key]: data[key].slice(0, 60) }, empty: false };
  }
  return { data, empty: false };
}

// --- Claude answering layer --------------------------------------------------

const BASE_SYSTEM =
  "You are a friendly, knowledgeable football (soccer) assistant covering ALL " +
  "competitions worldwide — leagues, cups, and international tournaments — past " +
  "and present. Answer the user's question using the provided data. Be concise " +
  "and conversational.\n" +
  "- When presenting match results, format them as: Team A 2–1 Team B (YYYY-MM-DD).\n" +
  "- For standings, scorers, and squads, present clean, readable lists.\n" +
  "- For live matches, mention the score, minute, and notable events.\n" +
  "- If the data does not contain the answer, say so plainly instead of guessing.";

// Answer from football-data.org data.
async function askClaudeWithData(question, route, data) {
  const compName = route.competitionCode
    ? COMPETITIONS[route.competitionCode] || route.competitionCode
    : "unspecified";

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: BASE_SYSTEM,
    messages: [
      {
        role: "user",
        content:
          `Intent: ${route.intent}\nCompetition: ${compName}\n\n` +
          `Data (JSON):\n${JSON.stringify(data, null, 2)}\n\n` +
          `User question: ${question}`,
      },
    ],
  });

  return extractText(response);
}

function extractText(response) {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

// --- Routes ------------------------------------------------------------------

app.post("/ask", async (req, res) => {
  const question = (req.body?.question || "").trim();

  if (!question) {
    return res.status(400).json({ error: "Please ask a question." });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    // 1. Route the question into a structured intent + entities.
    const route = await routeQuestion(question, today);

    // 2. Try the football-data.org API.
    let result;
    try {
      result = await fetchData(route);
    } catch (err) {
      // Rate limits / upstream errors surface to the user directly.
      if (err.statusCode === 429) {
        return res.status(429).json({ error: err.message });
      }
      result = { data: null, empty: true };
    }

    // 3. Answer from the data, or report that none was found.
    let reply;
    if (!result.empty) {
      reply = await askClaudeWithData(question, route, result.data);
    } else {
      reply =
        "I couldn't find any football data for that question. Try specifying a " +
        "competition (e.g. Premier League, Champions League, World Cup) or a " +
        "different date range.";
    }

    res.json({ reply });
  } catch (err) {
    console.error("Error handling /ask:", err);
    res
      .status(err.statusCode || 500)
      .json({ error: err.message || "Something went wrong. Please try again." });
  }
});

app.listen(PORT, () => {
  console.log(`FIFA Watcher running at http://localhost:${PORT}`);
});
