# QuizLive

QuizLive is a portable Kahoot-like web app for live quiz games.

## What works now

- Host creates a room with a 6 digit code.
- Players join from any phone browser with code and nickname without seeing the host quiz builder.
- A public monitor view can show the lobby QR code, questions, answer reveal, and leaderboard on a TV or projector.
- Host lobby shows a QR code for quick player entry.
- Questions run in realtime with a server-side timer.
- Scores include correctness, speed, streak bonuses, a speed-focused question type, and multi-answer questions.
- Multi-answer questions support partial scoring: exact answers get full points, partly correct answers get half points, fully wrong answers get zero.
- Host sees answer stats, final dashboard, question accuracy, and leaderboard.
- Players see answer buttons, feedback, score, and ranking.
- Results export as CSV, JSON, or XLSX while the room is active.
- Quiz export/import works with an editable XLSX template from the host builder, including metadata and media URLs.
- Host can save quizzes to the archive, search by metadata/tags, load them later, or duplicate them as drafts.
- Optional team mode automatically assigns players to teams and shows a team leaderboard.
- Questions can include public image or video URLs.
- Finished games are saved to historical results with CSV/JSON/XLSX export.

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

Public monitor view:

```text
http://localhost:3000/#screen
```

Open the public monitor before creating a room to show the QuizLive waiting screen. When the host creates the room, waiting monitors attach automatically. A direct room monitor link also works:

```text
http://localhost:3000/#screen=123456
```

Phones on the same Wi-Fi can connect using the Mac local network address, for example:

```text
http://192.168.1.20:3000
```

When the host creates a room, the lobby shows a QR code that opens a player link like:

```text
http://192.168.1.20:3000/#join=123456
```

The host lobby also has a monitor link for a shared screen:

```text
http://192.168.1.20:3000/#screen=123456
```

On browsers that support the Presentation API, the host can use `Trasmetti TV` to open the native nearby display picker and send the public monitor URL to a Chromecast or compatible display. When the cast was started from QuizLive, the same control changes to `Scollega TV` so the host can stop the public monitor from the app. If the browser does not support this, use Chrome's built-in Cast menu or open the monitor URL directly on the TV browser.

When the host opens the app on `localhost`, QuizLive automatically prefers the Mac LAN address for the QR code so phones do not scan a `localhost` link.

Local/LAN links only work for phones on the same Wi-Fi. For players outside the local network, run QuizLive on a public hosting service or expose it through a tunnel, then set:

```bash
PUBLIC_BASE_URL=https://your-public-url.example npm run dev
```

With `PUBLIC_BASE_URL`, the QR code and copied player link use the public URL.

## Persistence

QuizLive can store saved quizzes and historical results in either Neon Postgres or a small local JSON store.

When `DATABASE_URL` is set, QuizLive uses Postgres and creates the archive tables automatically on startup. This is the recommended setup for Render Free because the database survives sleeps, restarts, and redeploys.

To use Neon Free with Render:

1. Create a free project on Neon.
2. Copy the Postgres connection string from Neon.
3. In Render, open the `quizlive` web service.
4. Go to Environment and add a secret variable named `DATABASE_URL`.
5. Paste the Neon connection string as the value.
6. Save and redeploy the Render service.

After redeploy, this URL should report `"archive":"postgres"`:

```text
https://your-render-url.onrender.com/api/health
```

Without `DATABASE_URL`, QuizLive falls back to the local JSON store. By default, local data is written to:

```text
.data/quizlive-store.json
```

On Render Free, this local store is temporary because free web services use an ephemeral filesystem. Saved quizzes and historical results can be lost when the service sleeps, restarts, or redeploys.

As another option, a paid Render service can use a persistent disk by setting `DATA_DIR` to the disk mount path, for example:

```text
DATA_DIR=/var/data
```

## Online deployment

This app is intentionally small and portable. It can run on platforms that support a persistent Node server and WebSocket connections, such as Render, Railway, Fly.io, Replit, or a VPS.

## Host password

For public deployments, protect the host area with a secret environment variable:

```text
HOST_PASSWORD=choose-a-private-password
```

When `HOST_PASSWORD` is set, opening `/#host` asks for the password before showing the quiz builder, archive, and result exports. Player links and QR codes keep working without a password.

On Render, add `HOST_PASSWORD` from the service Environment page, then redeploy. Do not commit the password to GitHub.

Host login sessions last up to 12 hours and reset when the service restarts.

### Render Blueprint

The repository includes `render.yaml` for a Render web service:

- Node runtime
- free instance
- `npm install` build command
- `npm start` start command
- `/api/health` health check

Render Free is enough to test the live quiz online with phones and QR codes. The archive UI still works, but saved data is temporary on the free instance.

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
