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

## Online deployment

This app is intentionally small and portable. It can run on platforms that support a persistent Node server and WebSocket connections, such as Render, Railway, Fly.io, Replit, or a VPS.

For a production version, the next useful upgrades are:

- persistent database for quizzes and historical results
- user accounts for hosts
- room reconnection by session token
- media uploads for questions
- public/private quiz library
- Dockerfile for consistent deployment
