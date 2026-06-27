# ⚽ FIFA Watcher — World Cup 2026 Live Match Assistant

Ask natural-language questions about live FIFA World Cup 2026 matches. The backend
fetches live data from [football-data.org](https://www.football-data.org/) and uses
Anthropic's Claude (`claude-sonnet-4-6`) to turn the raw data into a friendly answer.

```
Browser (fetch)  →  Express backend  →  football-data.org  (live match data)
                                     →  Anthropic Claude    (natural-language answer)
```

API keys live **only** on the backend — the frontend never talks to either API directly.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your `.env` from the template and add your keys:
   ```bash
   cp .env.example .env
   ```
   - `ANTHROPIC_API_KEY` — from <https://console.anthropic.com/settings/keys>
   - `FOOTBALL_DATA_API_KEY` — free token from <https://www.football-data.org/client/register>

3. Start the server:
   ```bash
   npm start
   ```

4. Open <http://localhost:3000> and ask away — e.g. *"What's the score in the Brazil game?"*

## How it works

`POST /ask` with `{ "question": "..." }`:

1. Fetches today's / live World Cup matches from football-data.org.
2. Picks the match most relevant to your question by matching team names.
3. Fetches detailed data for that match (score, status, events).
4. Sends the raw data plus your question to Claude.
5. Returns `{ "reply": "..." }`.

## Notes

- **Rate limits:** football-data.org's free tier allows 10 requests/minute. The backend
  surfaces a friendly message when rate-limited (HTTP 429).
- **Off-season:** Outside the tournament window (June 11 – July 19, 2026) the app returns
  a helpful message instead of calling the APIs.
- **Free-tier data:** Match detail available on the free tier is limited; deep stats like
  possession or full lineups may not be present, and Claude will say so when data is missing.
