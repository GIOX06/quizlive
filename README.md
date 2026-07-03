# QuizLive

QuizLive is a portable Kahoot-like web app for live quiz games.

## What works now

- Host creates a room with a 6 digit code.
- Players join from any phone browser with code and nickname without seeing the host quiz builder.
- Host lobby shows a QR code for quick player entry.
- Questions run in realtime with a server-side timer.
- Scores include correctness, speed, and streak bonuses.
- Host sees answer stats and leaderboard.
- Players see answer buttons, feedback, score, and ranking.
- Results export as CSV or JSON while the room is active.
- Quiz export/import works as JSON from the host builder.
- Host can save quizzes to the archive and load them later.
- Finished games are saved to historical results with CSV/JSON export.

## Local setup

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

Host view:

```text
http://localhost:3000/#host
```

Phones on the same Wi-Fi can connect using the Mac local network address, for example:

```text
http://192.168.1.20:3000
```

When the host creates a room, the lobby shows a QR code that opens a player link like:

```text
http://192.168.1.20:3000/#join=123456
```

When the host opens the app on `localhost`, QuizLive automatically prefers the Mac LAN address for the QR code so phones do not scan a `localhost` link.

Local/LAN links only work for phones on the same Wi-Fi. For players outside the local network, run QuizLive on a public hosting service or expose it through a tunnel, then set:

```bash
PUBLIC_BASE_URL=https://your-public-url.example npm run dev
```

With `PUBLIC_BASE_URL`, the QR code and copied player link use the public URL.

## Persistence

QuizLive stores saved quizzes and historical results in a small JSON store. By default, local data is written to:

```text
.data/quizlive-store.json
```

For hosted deployments, set `DATA_DIR` to a persistent directory. On Render, the included `render.yaml` mounts a persistent disk at `/var/data` and sets:

```text
DATA_DIR=/var/data
```

## Online deployment

This app is intentionally small and portable. It can run on platforms that support a persistent Node server and WebSocket connections, such as Render, Railway, Fly.io, Replit, or a VPS.

### Render Blueprint

The repository includes `render.yaml` for a Render web service:

- Node runtime
- `npm install` build command
- `npm start` start command
- `/api/health` health check
- persistent disk mounted at `/var/data`

After the service is created, Render gives you a stable public URL. QuizLive automatically uses that URL for player QR codes and copied links.

If you later add a custom domain, set `PUBLIC_BASE_URL` to that exact origin, for example:

```text
https://quiz.example.com
```

Then redeploy. QR codes and copied player links will use the custom public URL.

For a production version, the next useful upgrades are:

- user accounts for hosts
- room reconnection by session token
- media uploads for questions
- public/private quiz library
- Dockerfile for consistent deployment
