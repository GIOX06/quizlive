const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const QRCode = require("qrcode");
const { Server } = require("socket.io");
const XLSX = require("xlsx");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || "");
const DATABASE_URL = process.env.DATABASE_URL || "";
const HOST_PASSWORD = String(process.env.HOST_PASSWORD || "");
const PEXELS_API_KEY = normalizeSecretToken(process.env.PEXELS_API_KEY || "");
const IMAGE_GENERATION_PROVIDER = normalizeImageGenerationProvider(process.env.IMAGE_GENERATION_PROVIDER || "cloudflare");
const CLOUDFLARE_ACCOUNT_ID = normalizeCloudflareAccountId(process.env.CLOUDFLARE_ACCOUNT_ID || "");
const CLOUDFLARE_API_TOKEN = normalizeSecretToken(process.env.CLOUDFLARE_API_TOKEN || "");
const CLOUDFLARE_IMAGE_MODEL = normalizeCloudflareImageModel(process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell");
const CLOUDFLARE_IMAGE_STEPS = Math.min(8, Math.max(1, Math.round(Number(process.env.CLOUDFLARE_IMAGE_STEPS) || 4)));
const OPENAI_API_KEY = normalizeSecretToken(process.env.OPENAI_API_KEY || "");
const OPENAI_IMAGE_MODEL = normalizeShortText(process.env.OPENAI_IMAGE_MODEL || "gpt-image-1-mini", 40);
const OPENAI_IMAGE_SIZE = normalizeShortText(process.env.OPENAI_IMAGE_SIZE || "1536x1024", 20);
const OPENAI_IMAGE_QUALITY = normalizeShortText(process.env.OPENAI_IMAGE_QUALITY || "low", 20);
const OPENAI_IMAGE_FORMAT = normalizeOpenAIImageFormat(process.env.OPENAI_IMAGE_FORMAT || "jpeg");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const STORE_FILE = path.join(DATA_DIR, "quizlive-store.json");
const HOST_SESSION_COOKIE = "quizlive_host";
const HOST_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 1.5 * 1024 * 1024;
const MAX_AVATAR_DATA_URL_LENGTH = 280000;
const QUESTION_TYPE_LABELS = {
  multiple: "Multipla",
  true_false: "Vero/Falso",
  speed: "Veloce",
  multiple_select: "Risposte multiple",
  slide: "Slide"
};
const LIVE_EVENT_TONES = new Set(["spark", "drum", "success", "alert", "secret"]);
const LIVE_EVENT_TARGETS = new Set(["all", "players", "screen", "player"]);
const TRIO_CHOICES = {
  wolf: "Lupo",
  sheep: "Agnello",
  cabbage: "Cavolo"
};
const TRIO_BEATS = {
  wolf: "sheep",
  sheep: "cabbage",
  cabbage: "wolf"
};
const WEAPON_TYPES = new Set(["hide_answer", "invert_true_false"]);
const answerLetters = ["A", "B", "C", "D", "E", "F"];
const QUESTION_TYPE_ALIASES = {
  multipla: "multiple",
  multiple: "multiple",
  scelta_multipla: "multiple",
  risposte_multiple: "multiple_select",
  risposta_multipla: "multiple_select",
  multiple_select: "multiple_select",
  multiple_correct: "multiple_select",
  multi_select: "multiple_select",
  vero_falso: "true_false",
  verofalso: "true_false",
  vero_o_falso: "true_false",
  "vero/falso": "true_false",
  true_false: "true_false",
  truefalse: "true_false",
  veloce: "speed",
  risposta_veloce: "speed",
  speed: "speed",
  fast: "speed",
  slide: "slide",
  diapositiva: "slide",
  titolo: "slide"
};
const rooms = new Map();
const hostSessions = new Map();
const store = loadStore();
const pgPool = createPgPool(DATABASE_URL);
let archiveInitError = null;
const archiveReady = pgPool
  ? initPostgresArchive().catch((error) => {
      archiveInitError = error;
      console.error("Could not initialize Postgres archive:", error.message);
    })
  : Promise.resolve();

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|css|js)$/i.test(filePath)) {
      res.setHeader("cache-control", "no-store");
    }
  }
}));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, archive: pgPool ? "postgres" : "file" });
});

app.get("/api/host/auth", (req, res) => {
  res.json({
    enabled: isHostAuthEnabled(),
    authenticated: isHostHttpAuthorized(req)
  });
});

app.post("/api/host/login", (req, res) => {
  if (!isHostAuthEnabled()) {
    res.json({ ok: true, enabled: false, authenticated: true });
    return;
  }

  if (!passwordsMatch(req.body && req.body.password)) {
    res.status(401).json({ ok: false, error: "Password host non corretta" });
    return;
  }

  const token = createHostSession();
  setHostSessionCookie(req, res, token);
  res.json({ ok: true, enabled: true, authenticated: true });
});

app.post("/api/host/logout", (req, res) => {
  const token = getCookie(req, HOST_SESSION_COOKIE);
  if (token) hostSessions.delete(token);
  clearHostSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/api/network", (req, res) => {
  const currentOrigin = requestOrigin(req);
  const localOrigins = localNetworkOrigins();
  const preferredOrigin = preferredPlayerOrigin(currentOrigin, localOrigins, PUBLIC_BASE_URL);
  res.json({
    currentOrigin,
    publicOrigin: PUBLIC_BASE_URL,
    localOrigins,
    preferredOrigin,
    accessMode: playerAccessMode(currentOrigin, preferredOrigin, PUBLIC_BASE_URL)
  });
});

app.get("/api/qr.svg", async (req, res) => {
  const url = normalizeQrUrl(req.query.url);
  if (!url) {
    res.status(400).send("Invalid QR URL");
    return;
  }

  try {
    const svg = await QRCode.toString(url, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
      color: {
        dark: "#172026",
        light: "#ffffff"
      }
    });

    res.setHeader("content-type", "image/svg+xml; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.send(svg);
  } catch (error) {
    res.status(500).send("QR generation failed");
  }
});

app.get("/api/quiz-template.xlsx", requireHostHttp, (_req, res) => {
  const workbook = quizToWorkbook(defaultQuiz(), true);
  sendWorkbook(res, workbook, "quizlive-modello.xlsx");
});

app.post("/api/quiz/export.xlsx", requireHostHttp, (req, res) => {
  try {
    const quiz = normalizeQuiz(req.body && req.body.quiz);
    const workbook = quizToWorkbook(quiz, false);
    sendWorkbook(res, workbook, safeWorkbookName(quiz.title));
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/quiz/import.xlsx", requireHostHttp, (req, res) => {
  try {
    const file = String(req.body && req.body.file || "");
    const base64 = file.includes(",") ? file.split(",").pop() : file;
    if (!base64) throw new Error("File XLSX mancante");
    const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
    const quiz = workbookToQuiz(workbook);
    res.json({ ok: true, quiz });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/api/media", requireHostHttp, async (req, res) => {
  try {
    const parsed = parseImageDataUrl(req.body && req.body.file);
    const saved = await saveMediaToStore(parsed);
    res.json({ ok: true, url: `/api/media/${saved.id}`, id: saved.id, mime: saved.mime, size: saved.size });
  } catch (error) {
    if (isArchiveFailure(error)) {
      sendArchiveError(res, error);
      return;
    }
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/api/media/:id", async (req, res) => {
  try {
    const media = await findMedia(req.params.id);
    if (!media) {
      res.status(404).send("Media not found");
      return;
    }
    res.setHeader("content-type", media.mime);
    res.setHeader("cache-control", "public, max-age=31536000, immutable");
    res.send(Buffer.from(media.data, "base64"));
  } catch (error) {
    sendArchiveError(res, error);
  }
});

app.post("/api/images/search", requireHostHttp, async (req, res) => {
  try {
    const query = buildImageSearchQuery(req.body || {});
    if (!PEXELS_API_KEY) {
      res.status(501).json({ ok: false, error: "Aggiungi PEXELS_API_KEY su Render per usare la ricerca immagini", query });
      return;
    }

    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", query);
    url.searchParams.set("orientation", "landscape");
    url.searchParams.set("locale", "it-IT");
    url.searchParams.set("per_page", "12");

    const response = await fetch(url, {
      headers: { Authorization: PEXELS_API_KEY }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data && data.error ? String(data.error) : "Ricerca immagini non disponibile";
      res.status(response.status).json({ ok: false, error: message });
      return;
    }

    const images = Array.isArray(data.photos) ? data.photos.map(pexelsPhotoToImage).filter(Boolean) : [];
    res.json({
      ok: true,
      provider: "pexels",
      providerLabel: "Pexels",
      providerUrl: "https://www.pexels.com",
      query,
      images
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Ricerca immagini non disponibile" });
  }
});

app.post("/api/images/generate", requireHostHttp, async (req, res) => {
  try {
    const provider = normalizeImageGenerationProvider(req.body && req.body.provider || IMAGE_GENERATION_PROVIDER);
    const prompt = buildAiImagePrompt(req.body || {});
    if (req.body && req.body.dryRun) {
      res.json({
        ok: true,
        dryRun: true,
        ...imageGenerationProviderInfo(provider),
        prompt
      });
      return;
    }

    const generated = provider === "openai"
      ? await generateOpenAIImage(prompt)
      : await generateCloudflareImage(prompt);
    const saved = await saveMediaToStore(generated);
    res.json({
      ok: true,
      ...imageGenerationProviderInfo(provider),
      url: `/api/media/${saved.id}`,
      id: saved.id,
      mime: saved.mime,
      size: saved.size,
      prompt
    });
  } catch (error) {
    if (isArchiveFailure(error)) {
      sendArchiveError(res, error);
      return;
    }
    if (/CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN|OPENAI_API_KEY/.test(error.message || "")) {
      res.status(501).json({ ok: false, error: error.message, provider: IMAGE_GENERATION_PROVIDER });
      return;
    }
    res.status(500).json({ ok: false, error: error.message || "Generazione immagine non disponibile" });
  }
});

app.get("/api/rooms/:code/export/results.csv", requireHostHttp, (req, res) => {
  const room = rooms.get(normalizeCode(req.params.code));
  if (!room) {
    res.status(404).send("Room not found");
    return;
  }

  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="quizlive-${room.code}-results.csv"`);
  res.send(resultsToCsv(room));
});

app.get("/api/rooms/:code/export/results.json", requireHostHttp, (req, res) => {
  const room = rooms.get(normalizeCode(req.params.code));
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  res.setHeader("content-disposition", `attachment; filename="quizlive-${room.code}-results.json"`);
  res.json(resultsToJson(room));
});

app.get("/api/rooms/:code/export/results.xlsx", requireHostHttp, (req, res) => {
  const room = rooms.get(normalizeCode(req.params.code));
  if (!room) {
    res.status(404).send("Room not found");
    return;
  }

  sendWorkbook(res, resultToWorkbook(resultFromRoom(room)), `quizlive-${room.code}-results.xlsx`);
});

app.get("/api/archive/quizzes", requireHostHttp, async (_req, res) => {
  try {
    const quizzes = await listQuizzesFromStore();
    res.json({ quizzes });
  } catch (error) {
    sendArchiveError(res, error);
  }
});

app.post("/api/archive/quizzes", requireHostHttp, async (req, res) => {
  try {
    const quiz = normalizeQuiz(req.body && req.body.quiz);
    const id = normalizeArchiveId(req.body && req.body.id) || createArchiveId("quiz");
    const saved = await saveQuizToStore(id, quiz);
    res.json({ ok: true, quiz: saved });
  } catch (error) {
    if (isArchiveFailure(error)) {
      sendArchiveError(res, error);
      return;
    }
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/api/archive/quizzes/:id", requireHostHttp, async (req, res) => {
  try {
    const deleted = await deleteQuizFromStore(req.params.id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: "Quiz non trovato" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    sendArchiveError(res, error);
  }
});

app.get("/api/archive/results", requireHostHttp, async (_req, res) => {
  try {
    const results = await listResultsFromStore();
    res.json({ results });
  } catch (error) {
    sendArchiveError(res, error);
  }
});

app.get("/api/archive/results/:id.json", requireHostHttp, async (req, res) => {
  try {
    const result = await findResult(req.params.id);
    if (!result) {
      res.status(404).json({ error: "Result not found" });
      return;
    }
    res.setHeader("content-disposition", `attachment; filename="quizlive-${result.code}-saved-results.json"`);
    res.json(result);
  } catch (error) {
    sendArchiveError(res, error);
  }
});

app.get("/api/archive/results/:id.csv", requireHostHttp, async (req, res) => {
  try {
    const result = await findResult(req.params.id);
    if (!result) {
      res.status(404).send("Result not found");
      return;
    }
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="quizlive-${result.code}-saved-results.csv"`);
    res.send(resultToCsv(result));
  } catch (error) {
    sendArchiveError(res, error);
  }
});

app.get("/api/archive/results/:id.xlsx", requireHostHttp, async (req, res) => {
  try {
    const result = await findResult(req.params.id);
    if (!result) {
      res.status(404).send("Result not found");
      return;
    }
    sendWorkbook(res, resultToWorkbook(result), `quizlive-${result.code}-saved-results.xlsx`);
  } catch (error) {
    sendArchiveError(res, error);
  }
});

app.delete("/api/archive/results/:id", requireHostHttp, async (req, res) => {
  try {
    const deleted = await deleteResultFromStore(req.params.id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: "Risultato non trovato" });
      return;
    }
    res.json({ ok: true });
  } catch (error) {
    sendArchiveError(res, error);
  }
});

io.on("connection", (socket) => {
  socket.on("host:create", async (payload, ack) => {
    if (!isHostSocketAuthorized(socket)) {
      sendAck(ack, { ok: false, error: "Password host richiesta" });
      return;
    }

    try {
      const quiz = normalizeQuiz(payload && payload.quiz);
      const room = createRoom(quiz, socket.id);
      await attachHostToRoom(socket, room);
      await attachWaitingScreens(room);
      sendAck(ack, { ok: true, code: room.code });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:resume", async (payload, ack) => {
    if (!isHostSocketAuthorized(socket)) {
      sendAck(ack, { ok: false, error: "Password host richiesta" });
      return;
    }

    try {
      const code = normalizeCode(payload && payload.code);
      const room = rooms.get(code);
      if (!room) {
        sendAck(ack, { ok: false, error: "Stanza non trovata" });
        return;
      }

      await attachHostToRoom(socket, room);
      await attachWaitingScreens(room);
      sendAck(ack, { ok: true, code: room.code, status: room.status });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:start", (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }
    startQuestion(room, 0);
    sendAck(ack, { ok: true });
  });

  socket.on("host:next", async (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }
    try {
      const nextIndex = room.currentIndex + 1;
      if (nextIndex >= room.quiz.questions.length) {
        await endGame(room);
      } else {
        startQuestion(room, nextIndex);
      }
      sendAck(ack, { ok: true });
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:reveal", (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }
    revealQuestion(room);
    sendAck(ack, { ok: true });
  });

  socket.on("host:reset", async (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }
    try {
      await resetRoom(room);
      sendAck(ack, { ok: true });
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:update-quiz", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }
    if (room.status !== "lobby" && room.status !== "ended") {
      sendAck(ack, { ok: false, error: "Termina o resetta la partita prima di cambiare quiz" });
      return;
    }
    try {
      const quiz = normalizeQuiz(payload && payload.quiz);
      await updateRoomQuiz(room, quiz);
      sendAck(ack, { ok: true, code: room.code });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:release-screens", async (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const released = await releaseRoomScreens(room);
      sendAck(ack, { ok: true, released });
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:scan-screens", async (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      sendAck(ack, { ok: true, screens: await screenDiscovery(room) });
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:claim-screens", async (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const attached = await attachWaitingScreens(room, true);
      sendAck(ack, { ok: true, attached, screens: await screenDiscovery(room) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:live-event", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const event = normalizeLiveEvent(payload, room);
      const delivered = await dispatchLiveEvent(room, event);
      sendAck(ack, { ok: true, delivered, event });
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:wager-offer", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const offer = createWagerOffer(room, payload || {});
      const delivered = await dispatchLiveEvent(room, wagerOfferLiveEvent(room, offer));
      sendAck(ack, { ok: true, delivered, wager: serializeWagerOffer(offer, room) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:fifty-start", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const challenge = startFiftyChallenge(room, payload || {});
      const delivered = await dispatchLiveEvent(room, fiftyStartedLiveEvent(challenge));
      sendAck(ack, { ok: true, delivered, challenge: serializeFiftyChallenge(challenge) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:trio-start", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const challenge = startTrioChallenge(room, payload || {});
      const delivered = await dispatchLiveEvent(room, trioStartedLiveEvent(challenge));
      sendAck(ack, { ok: true, delivered, challenge: serializeTrioChallenge(challenge, "host") });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:tap-start", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const challenge = startTapChallenge(room, payload || {});
      const delivered = await dispatchLiveEvent(room, tapStartedLiveEvent(challenge));
      sendAck(ack, { ok: true, delivered, challenge: serializeTapChallenge(challenge) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:balance-start", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const challenge = startBalanceChallenge(room, payload || {});
      const delivered = await dispatchLiveEvent(room, balanceStartedLiveEvent(challenge));
      sendAck(ack, { ok: true, delivered, challenge: serializeBalanceChallenge(challenge) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:weapon", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const weapon = createMiniWeapon(room, payload || {});
      const delivered = await dispatchLiveEvent(room, weaponLiveEvent(room, weapon));
      sendAck(ack, { ok: true, delivered, weapon: serializeWeapon(weapon, room) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:tokens", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const player = adjustPlayerTokens(room, payload || {});
      sendAck(ack, { ok: true, player: serializePlayer(player, room) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("host:clandestina-start", async (payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }

    try {
      const challenge = startClandestina(room, payload || {});
      const delivered = await dispatchLiveEvent(room, clandestinaStartedLiveEvent(challenge));
      sendAck(ack, { ok: true, delivered, clandestina: serializeClandestina(room, "host") });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:weapon", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const weapon = createMiniWeapon(room, { ...(payload || {}), ownerId: player.id });
      const delivered = await dispatchLiveEvent(room, weaponLiveEvent(room, weapon));
      sendAck(ack, { ok: true, delivered, weapon: serializeWeapon(weapon, room, true) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:clandestina-bet", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const result = placeClandestinaBet(room, player, payload || {});
      sendAck(ack, { ok: true, bet: result.bet, clandestina: serializeClandestina(room, "player", player.id) });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:trio-choice", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const result = chooseTrioSymbol(room, player, payload || {});
      sendAck(ack, { ok: true, ...result });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:tap-west", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const result = recordTapWest(room, player, payload || {});
      sendAck(ack, { ok: true, ...result });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:balance-update", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const result = recordBalanceUpdate(room, player, payload || {});
      sendAck(ack, { ok: true, ...result });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("screen:watch", async (_payload, ack) => {
    try {
      await sendScreenToWaiting(socket);
      sendAck(ack, { ok: true, waiting: true });
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("screen:join", async (payload, ack) => {
    try {
      const code = normalizeCode(payload && payload.code);
      const room = rooms.get(code);
      if (!room) {
        sendAck(ack, { ok: false, error: "Partita non trovata" });
        return;
      }

      await attachScreenToRoom(socket, room);
      sendAck(ack, { ok: true, code });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:join", (payload, ack) => {
    const code = normalizeCode(payload && payload.code);
    const room = rooms.get(code);
    if (!room) {
      sendAck(ack, { ok: false, error: "Partita non trovata" });
      return;
    }
    const sessionToken = normalizePlayerSessionToken(payload && payload.sessionToken);
    const existingPlayer = sessionToken ? findPlayerBySessionToken(room, sessionToken) : null;
    if (room.status !== "lobby" && !existingPlayer) {
      sendAck(ack, { ok: false, error: "Partita gia iniziata" });
      return;
    }

    const nickname = normalizeNickname(payload && payload.nickname);
    const avatarUrl = normalizeAvatarDataUrl(payload && payload.avatarUrl);
    if (existingPlayer) {
      reattachPlayerSocket(room, existingPlayer, socket, nickname);
      if (avatarUrl) existingPlayer.avatarUrl = avatarUrl;
      sendAck(ack, { ok: true, code, playerId: existingPlayer.id, sessionToken: existingPlayer.sessionToken, rejoined: true });
      emitRoom(room);
      return;
    }

    const playerSessionToken = createPlayerSessionToken();
    const player = {
      id: socket.id,
      sessionToken: playerSessionToken,
      nickname,
      avatarUrl,
      team: room.quiz.teamMode ? assignTeam(room) : "",
      score: 0,
      tokens: 0,
      streak: 0,
      connected: true,
      active: true,
      rematch: null,
      joinedAt: Date.now()
    };

    room.players.set(socket.id, player);
    socket.data.role = "player";
    socket.data.roomCode = code;
    socket.data.playerId = socket.id;
    socket.data.playerSessionToken = playerSessionToken;
    socket.join(roomChannel(code));
    sendAck(ack, { ok: true, code, playerId: socket.id, sessionToken: playerSessionToken });
    emitRoom(room);
  });

  socket.on("player:avatar", (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }
    const avatarUrl = normalizeAvatarDataUrl(payload && payload.avatarUrl);
    player.avatarUrl = avatarUrl;
    if (room.fifty && room.fifty.active && room.fifty.active.participants[player.id]) {
      room.fifty.active.participants[player.id].avatarUrl = avatarUrl;
    }
    if (room.trio && room.trio.active && room.trio.active.participants[player.id]) {
      room.trio.active.participants[player.id].avatarUrl = avatarUrl;
    }
    sendAck(ack, { ok: true, player: serializePlayer(player, room) });
    emitRoom(room);
  });

  socket.on("player:answer", (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }
    const result = submitAnswer(room, player, payload || {});
    sendAck(ack, result);
    emitRoom(room);
  });

  socket.on("player:rematch", (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }
    if (room.status !== "lobby" || player.rematch !== "pending") {
      sendAck(ack, { ok: false, error: "Invito non attivo" });
      return;
    }

    if (payload && payload.accept) {
      player.active = true;
      player.rematch = "accepted";
      player.connected = true;
      player.joinedAt = Date.now();
      if (!room.quiz.teamMode) {
        player.team = "";
      } else if (!player.team) {
        player.team = assignTeam(room);
      }
      sendAck(ack, { ok: true });
      emitRoom(room);
      return;
    }

    removePlayer(room, player.id);
    sendAck(ack, { ok: true, left: true });
    emitRoom(room);
  });

  socket.on("player:wager-response", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const result = acceptOrDeclineWager(room, player, payload || {});
      sendAck(ack, { ok: true, ...result });
      if (result.accepted && result.wager) {
        await dispatchLiveEvent(room, wagerAcceptedLiveEvent(room, result.wager));
      }
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:fifty-hold", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const result = updateFiftyHold(room, player, payload || {});
      sendAck(ack, { ok: true, ...result });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("player:fifty-ready", async (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }

    try {
      const result = readyFiftyPlayer(room, player, payload || {});
      sendAck(ack, { ok: true, ...result });
      await emitRoom(room);
    } catch (error) {
      sendAck(ack, { ok: false, error: error.message });
    }
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.data.role === "host") {
      room.hostConnected = false;
    }
    if (socket.data.role === "player") {
      const player = room.players.get(socket.data.playerId);
      if (player) {
        player.connected = false;
        markFiftyPlayerDisconnected(room, player.id);
        markTrioPlayerDisconnected(room, player.id);
        markTapPlayerDisconnected(room, player.id);
        markBalancePlayerDisconnected(room, player.id);
      }
    }
    emitRoom(room);
  });
});

let usedHost = HOST;
let triedLocalhostFallback = false;

server.on("error", (error) => {
  if (error.code === "EPERM" && usedHost === "0.0.0.0" && !triedLocalhostFallback) {
    triedLocalhostFallback = true;
    usedHost = "127.0.0.1";
    server.listen(PORT, usedHost);
    return;
  }
  throw error;
});

server.listen(PORT, usedHost, () => {
  console.log(`QuizLive running on http://${usedHost === "0.0.0.0" ? "localhost" : usedHost}:${PORT}`);
});

function createRoom(quiz, hostSocketId) {
  const code = createRoomCode();
  const room = {
    code,
    quiz,
    hostSocketId,
    hostConnected: true,
    status: "lobby",
    currentIndex: -1,
    questionStartedAt: null,
    questionEndsAt: null,
    players: new Map(),
    answers: new Map(),
    wagers: createWagerState(),
    clandestina: createClandestinaState(),
    fifty: createFiftyState(),
    trio: createTrioState(),
    tap: createTapState(),
    balance: createBalanceState(),
    weapons: createWeaponState(),
    timer: null,
    resultId: null,
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

async function attachHostToRoom(socket, room) {
  const previousCode = socket.data.roomCode;
  if (previousCode && previousCode !== room.code) {
    await socket.leave(roomChannel(previousCode));
  }

  const previousHost = room.hostSocketId && room.hostSocketId !== socket.id
    ? io.sockets.sockets.get(room.hostSocketId)
    : null;
  if (previousHost && previousHost.data.role === "host" && previousHost.data.roomCode === room.code) {
    previousHost.data.role = null;
    previousHost.data.roomCode = null;
    previousHost.data.playerId = null;
    await previousHost.leave(roomChannel(room.code));
    previousHost.emit("host:detached", {
      code: room.code,
      message: "Stanza ripresa da un'altra finestra host"
    });
  }

  socket.data.role = "host";
  socket.data.roomCode = room.code;
  socket.data.playerId = null;
  room.hostSocketId = socket.id;
  room.hostConnected = true;
  await socket.join(roomChannel(room.code));
}

function startQuestion(room, index) {
  clearRoomTimer(room);
  removeInactivePlayers(room, "Invito scaduto");
  expireWagerOffersForQuestion(room, index);
  archivePastWeapons(room, index);
  const question = room.quiz.questions[index];
  room.status = "question";
  room.currentIndex = index;
  room.questionStartedAt = Date.now();
  room.questionEndsAt = question.type === "slide" ? null : room.questionStartedAt + question.timeLimit * 1000;
  room.answers.set(index, new Map());
  room.timer = question.type === "slide" ? null : setTimeout(() => revealQuestion(room), question.timeLimit * 1000 + 250);
  emitRoom(room);
}

function revealQuestion(room) {
  if (!room || room.status !== "question") return;
  clearRoomTimer(room);
  resolveUnansweredWagersForQuestion(room, room.currentIndex);
  resolveClandestinaBetsForQuestion(room, room.currentIndex);
  room.status = "reveal";
  room.questionEndsAt = null;
  emitRoom(room);
}

async function endGame(room) {
  clearRoomTimer(room);
  room.status = "ended";
  room.questionEndsAt = null;
  if (!room.resultId) {
    try {
      const saved = await saveResultToStore(room);
      room.resultId = saved.id;
    } catch (error) {
      console.error(`Could not save result for room ${room.code}:`, error.message);
    }
  }
  await emitRoom(room);
}

async function resetRoom(room) {
  const invitePreviousPlayers = room.status === "ended";
  clearRoomTimer(room);
  room.status = "lobby";
  room.currentIndex = -1;
  room.questionStartedAt = null;
  room.questionEndsAt = null;
  room.resultId = null;
  room.answers.clear();
  room.wagers = createWagerState();
  clearClandestinaTimer(room);
  room.clandestina = createClandestinaState();
  clearFiftyChallenge(room);
  room.fifty = createFiftyState();
  clearTrioChallenge(room);
  room.trio = createTrioState();
  clearTapChallenge(room);
  room.tap = createTapState();
  clearBalanceChallenge(room);
  room.balance = createBalanceState();
  room.weapons = createWeaponState();

  if (invitePreviousPlayers) {
    inviteRematchPlayers(room);
  } else {
    removeInactivePlayers(room, "Sei stato escluso dalla nuova partita");
    for (const player of activePlayers(room)) {
      resetPlayerForNewGame(player);
    }
  }

  await attachWaitingScreens(room);
  await emitRoom(room);
}

async function updateRoomQuiz(room, quiz) {
  const invitePreviousPlayers = room.status === "ended";
  clearRoomTimer(room);
  room.quiz = quiz;
  room.status = "lobby";
  room.currentIndex = -1;
  room.questionStartedAt = null;
  room.questionEndsAt = null;
  room.resultId = null;
  room.answers.clear();
  room.wagers = createWagerState();
  clearClandestinaTimer(room);
  room.clandestina = createClandestinaState();
  clearFiftyChallenge(room);
  room.fifty = createFiftyState();
  clearTrioChallenge(room);
  room.trio = createTrioState();
  clearTapChallenge(room);
  room.tap = createTapState();
  clearBalanceChallenge(room);
  room.balance = createBalanceState();
  room.weapons = createWeaponState();

  if (invitePreviousPlayers) {
    inviteRematchPlayers(room);
    await attachWaitingScreens(room);
    return;
  }

  removeInactivePlayers(room, "Sei stato escluso dalla nuova partita");
  for (const player of activePlayers(room)) {
    resetPlayerForNewGame(player);
    if (!room.quiz.teamMode) {
      player.team = "";
    } else if (!player.team) {
      player.team = assignTeam(room);
    }
  }
  await attachWaitingScreens(room);
}

function inviteRematchPlayers(room) {
  for (const player of Array.from(room.players.values())) {
    resetPlayerForNewGame(player);
    if (!player.connected) {
      removePlayer(room, player.id);
      continue;
    }
    player.active = false;
    player.rematch = "pending";
    player.invitedAt = Date.now();
  }
}

function resetPlayerForNewGame(player) {
  player.score = 0;
  player.streak = 0;
}

function findPlayerBySessionToken(room, sessionToken) {
  return Array.from(room.players.values()).find((player) => player.sessionToken === sessionToken) || null;
}

function reattachPlayerSocket(room, player, socket, nickname) {
  const previousId = player.id;
  const previousSocket = previousId && previousId !== socket.id ? io.sockets.sockets.get(previousId) : null;
  if (previousSocket) {
    previousSocket.leave(roomChannel(room.code));
    previousSocket.data.role = null;
    previousSocket.data.roomCode = null;
    previousSocket.data.playerId = null;
    previousSocket.data.playerSessionToken = null;
  }

  if (previousId !== socket.id) {
    room.players.delete(previousId);
    room.players.set(socket.id, player);
    for (const answerMap of room.answers.values()) {
      if (!answerMap.has(previousId)) continue;
      answerMap.set(socket.id, answerMap.get(previousId));
      answerMap.delete(previousId);
    }
    updateWagerPlayerId(room, previousId, socket.id);
    updateClandestinaPlayerId(room, previousId, socket.id);
    updateFiftyPlayerId(room, previousId, socket.id);
    updateTrioPlayerId(room, previousId, socket.id);
    updateTapPlayerId(room, previousId, socket.id);
    updateBalancePlayerId(room, previousId, socket.id);
    updateWeaponPlayerId(room, previousId, socket.id);
  }

  player.id = socket.id;
  player.nickname = nickname || player.nickname;
  player.connected = true;
  player.joinedAt = Date.now();
  socket.data.role = "player";
  socket.data.roomCode = room.code;
  socket.data.playerId = socket.id;
  socket.data.playerSessionToken = player.sessionToken;
  socket.join(roomChannel(room.code));
}

function activePlayers(room) {
  return Array.from(room.players.values()).filter((player) => player.active);
}

function pendingInviteCount(room) {
  return Array.from(room.players.values()).filter((player) => player.rematch === "pending").length;
}

function allConnectedPlayersAnswered(room, answerMap) {
  const expectedPlayers = activePlayers(room).filter((player) => player.connected);
  return expectedPlayers.length > 0 && expectedPlayers.every((player) => answerMap.has(player.id));
}

function removeInactivePlayers(room, message) {
  for (const player of Array.from(room.players.values())) {
    if (!player.active) removePlayer(room, player.id, message);
  }
}

function removePlayer(room, playerId, message) {
  cancelWagersForPlayer(room, playerId);
  cancelClandestinaForPlayer(room, playerId);
  cancelFiftyForPlayer(room, playerId);
  cancelTrioForPlayer(room, playerId);
  markTapPlayerDisconnected(room, playerId);
  markBalancePlayerDisconnected(room, playerId);
  cancelWeaponsForPlayer(room, playerId);
  room.players.delete(playerId);
  const target = io.sockets.sockets.get(playerId);
  if (!target) return;
  if (message) target.emit("player:removed", { message, code: room.code });
  target.leave(roomChannel(room.code));
  target.data.role = null;
  target.data.roomCode = null;
  target.data.playerId = null;
}

async function attachWaitingScreens(room, includeAll = false) {
  const screens = await io.in(waitingScreenChannel()).fetchSockets();
  const matchingScreens = screens.filter((target) => {
    return includeAll || !target.data.followRoomCode || target.data.followRoomCode === room.code;
  });
  await Promise.all(matchingScreens.map((target) => attachScreenToRoom(target, room)));
  return matchingScreens.length;
}

async function attachScreenToRoom(socket, room) {
  const previousCode = socket.data.roomCode;
  if (previousCode) await socket.leave(roomChannel(previousCode));
  await socket.leave(waitingScreenChannel());
  socket.data.role = "screen";
  socket.data.roomCode = room.code;
  socket.data.followRoomCode = room.code;
  socket.data.playerId = null;
  await socket.join(roomChannel(room.code));
}

async function releaseRoomScreens(room) {
  const sockets = await io.in(roomChannel(room.code)).fetchSockets();
  const screens = sockets.filter((target) => target.data.role === "screen");
  await Promise.all(screens.map(sendScreenToWaiting));
  return screens.length;
}

async function sendScreenToWaiting(socket) {
  const previousCode = socket.data.roomCode;
  if (previousCode) await socket.leave(roomChannel(previousCode));
  socket.data.role = "screen";
  socket.data.roomCode = null;
  socket.data.followRoomCode = previousCode || socket.data.followRoomCode || null;
  socket.data.playerId = null;
  await socket.join(waitingScreenChannel());
  socket.emit("screen:waiting", { waiting: true });
}

async function screenDiscovery(room) {
  const waiting = await io.in(waitingScreenChannel()).fetchSockets();
  const roomSockets = await io.in(roomChannel(room.code)).fetchSockets();
  const connected = roomSockets.filter((target) => target.data.role === "screen");
  return {
    waiting: waiting.length,
    connected: connected.length,
    total: waiting.length + connected.length
  };
}

function submitAnswer(room, player, payload) {
  if (room.status !== "question") {
    return { ok: false, error: "Domanda non attiva" };
  }
  if (!player.active) {
    return { ok: false, error: "Non sei in questa partita" };
  }
  const question = room.quiz.questions[room.currentIndex];
  if (!question) {
    return { ok: false, error: "Risposta non valida" };
  }
  if (question.type === "slide") {
    return { ok: false, error: "Questa slide non richiede risposta" };
  }

  const answerIndexes = selectedAnswerIndexes(payload, question, room, player);
  const requiredSelections = selectionCount(question);
  if (answerIndexes.length !== requiredSelections) {
    return { ok: false, error: `Seleziona ${requiredSelections} risposte` };
  }
  if (answerIndexes.some((answerIndex) => answerIndex < 0 || answerIndex >= question.answers.length)) {
    return { ok: false, error: "Risposta non valida" };
  }
  if (answerIndexes.some((answerIndex) => isAnswerHiddenForPlayer(room, player.id, room.currentIndex, answerIndex))) {
    return { ok: false, error: "Questa risposta e oscurata" };
  }
  if (Date.now() > room.questionEndsAt) {
    return { ok: false, error: "Tempo scaduto" };
  }

  const answerMap = room.answers.get(room.currentIndex);
  if (answerMap.has(player.id)) {
    return { ok: false, error: "Risposta gia inviata" };
  }

  const answeredAt = Date.now();
  const scoreResult = scoreAnswer(question, answerIndexes);
  const isCorrect = scoreResult.correct;
  const isPartial = scoreResult.partial;
  const elapsed = Math.max(0, answeredAt - room.questionStartedAt);
  const duration = Math.max(1, question.timeLimit * 1000);
  const scoreProfile = questionScoreProfile(question);
  const speedBonus = scoreResult.ratio > 0 ? Math.max(0, Math.round(scoreProfile.speedBonus * (1 - elapsed / duration))) : 0;

  if (isCorrect) {
    player.streak += 1;
  } else {
    player.streak = 0;
  }

  const streakBonus = isCorrect ? Math.min(scoreProfile.maxStreakBonus, Math.max(0, (player.streak - 1) * scoreProfile.streakStep)) : 0;
  const points = Math.round((scoreProfile.base + speedBonus + streakBonus) * scoreResult.ratio);
  player.score += points;

  answerMap.set(player.id, {
    answerIndex: answerIndexes[0],
    answerIndexes,
    answeredAt,
    correct: isCorrect,
    partial: isPartial,
    scoreRatio: scoreResult.ratio,
    points,
    speedBonus,
    streakBonus
  });

  const wagerResults = resolveWagersForAnswer(room, player, room.currentIndex, isCorrect);
  const completedByPlayers = allConnectedPlayersAnswered(room, answerMap);
  if (completedByPlayers) revealQuestion(room);

  return { ok: true, correct: isCorrect, partial: isPartial, points, wagerResults, completedByPlayers };
}

function createWagerState() {
  return {
    offers: new Map(),
    active: new Map(),
    history: []
  };
}

function createClandestinaState() {
  return {
    active: false,
    mode: "random",
    startedAt: null,
    endsAt: null,
    bets: [],
    history: [],
    timer: null
  };
}

function createFiftyState() {
  return {
    active: null,
    history: []
  };
}

function createTrioState() {
  return {
    active: null,
    history: []
  };
}

function createTapState() {
  return {
    active: null,
    history: []
  };
}

function createBalanceState() {
  return {
    active: null,
    history: []
  };
}

function createWeaponState() {
  return {
    active: [],
    history: []
  };
}

function createWagerOffer(room, payload) {
  const playerId = normalizeShortText(payload.playerId, 120);
  const player = playerId ? room.players.get(playerId) : null;
  if (!player || !player.active || !player.connected) {
    throw new Error("Giocatore non disponibile per la scommessa");
  }
  if (Number(player.tokens || 0) <= 0) {
    throw new Error("Il giocatore non ha token da scommettere");
  }
  if (hasOpenWagerForPlayer(room, player.id)) {
    throw new Error("Questo giocatore ha gia una scommessa aperta");
  }

  const questionIndex = nextAnswerQuestionIndex(room);
  if (questionIndex < 0) {
    throw new Error("Non ci sono altre domande su cui scommettere");
  }
  const targets = eligibleWagerTargets(room, player.id);
  if (!targets.length) {
    throw new Error("Serve almeno un altro giocatore collegato");
  }

  const stake = normalizeWagerStake(payload.stake, player.tokens);
  const offer = {
    id: createArchiveId("wager"),
    bettorId: player.id,
    bettorNickname: player.nickname,
    stake,
    questionIndex,
    status: "offered",
    createdAt: Date.now()
  };
  room.wagers.offers.set(offer.id, offer);
  return offer;
}

function acceptOrDeclineWager(room, player, payload) {
  const wagerId = normalizeShortText(payload.wagerId, 120);
  const offer = wagerId ? room.wagers.offers.get(wagerId) : null;
  if (!offer || offer.bettorId !== player.id) {
    throw new Error("Scommessa non trovata");
  }
  if (!payload.accept) {
    room.wagers.offers.delete(offer.id);
    return { accepted: false };
  }
  if (!player.active) {
    throw new Error("Non sei in questa partita");
  }
  if (room.currentIndex >= offer.questionIndex) {
    room.wagers.offers.delete(offer.id);
    throw new Error("Scommessa scaduta");
  }
  if (Number(player.tokens || 0) < offer.stake) {
    room.wagers.offers.delete(offer.id);
    throw new Error("Token insufficienti per questa scommessa");
  }

  const targets = eligibleWagerTargets(room, player.id);
  if (!targets.length) {
    room.wagers.offers.delete(offer.id);
    throw new Error("Nessun bersaglio disponibile");
  }

  const mode = payload.mode === "random" ? "random" : "chosen";
  const target = mode === "random"
    ? targets[Math.floor(Math.random() * targets.length)]
    : targets.find((item) => item.id === normalizeShortText(payload.targetPlayerId, 120));
  if (!target) {
    throw new Error("Scegli un giocatore valido");
  }

  const wager = {
    ...offer,
    status: "active",
    targetMode: mode,
    targetPlayerId: target.id,
    targetNickname: target.nickname,
    multiplier: mode === "random" ? 3 : 2,
    acceptedAt: Date.now()
  };
  room.wagers.offers.delete(offer.id);
  room.wagers.active.set(wager.id, wager);
  return { accepted: true, wager: serializeActiveWager(wager) };
}

function hasOpenWagerForPlayer(room, playerId) {
  for (const offer of room.wagers.offers.values()) {
    if (offer.bettorId === playerId) return true;
  }
  for (const wager of room.wagers.active.values()) {
    if (wager.bettorId === playerId) return true;
  }
  return false;
}

function nextAnswerQuestionIndex(room) {
  const start = Math.max(0, room.currentIndex + 1);
  for (let index = start; index < room.quiz.questions.length; index += 1) {
    if (room.quiz.questions[index] && room.quiz.questions[index].type !== "slide") return index;
  }
  return -1;
}

function normalizeWagerStake(value, maxScore) {
  const max = Math.max(0, Math.floor(Number(maxScore) || 0));
  const stake = Math.floor(Number(value) || 0);
  if (!stake || stake < 1) {
    throw new Error("Inserisci una puntata valida");
  }
  if (stake > max) {
    throw new Error(`Puntata massima: ${max} token`);
  }
  return stake;
}

function eligibleWagerTargets(room, bettorId) {
  return activePlayers(room)
    .filter((player) => player.id !== bettorId && player.connected)
    .map((player) => ({
      id: player.id,
      nickname: player.nickname,
      score: player.score,
      tokens: Number(player.tokens || 0)
    }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
}

function eligibleClandestinaTargets(room, bettorId) {
  return activePlayers(room)
    .filter((player) => player.id !== bettorId && player.connected)
    .map((player) => ({
      id: player.id,
      nickname: player.nickname,
      score: player.score,
      tokens: Number(player.tokens || 0),
      avatarUrl: player.avatarUrl || ""
    }))
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
}

function expireWagerOffersForQuestion(room, questionIndex) {
  for (const offer of Array.from(room.wagers.offers.values())) {
    if (offer.questionIndex > questionIndex) continue;
    room.wagers.offers.delete(offer.id);
    dispatchLiveEvent(room, {
      id: createArchiveId("live"),
      type: "message",
      target: "player",
      playerId: offer.bettorId,
      private: true,
      title: "Scommessa scaduta",
      message: "La domanda e partita prima della tua risposta.",
      tone: "alert",
      vibrate: true,
      vibrationPattern: defaultVibrationPattern("alert"),
      createdAt: Date.now()
    }).catch((error) => console.error("Could not announce expired wager:", error.message));
  }
}

function resolveWagersForAnswer(room, targetPlayer, questionIndex, correct) {
  const results = [];
  for (const wager of Array.from(room.wagers.active.values())) {
    if (wager.questionIndex !== questionIndex || wager.targetPlayerId !== targetPlayer.id) continue;
    results.push(resolveWager(room, wager, Boolean(correct), "answered"));
  }
  return results.map(serializeWagerResult);
}

function resolveUnansweredWagersForQuestion(room, questionIndex) {
  const answerMap = room.answers.get(questionIndex) || new Map();
  for (const wager of Array.from(room.wagers.active.values())) {
    if (wager.questionIndex !== questionIndex) continue;
    if (answerMap.has(wager.targetPlayerId)) continue;
    resolveWager(room, wager, false, "no_answer");
  }
}

function resolveWager(room, wager, correct, reason) {
  const bettor = room.players.get(wager.bettorId);
  const delta = correct ? wager.stake * wager.multiplier : -wager.stake;
  if (bettor && bettor.active) {
    bettor.tokens = Math.min(999, Math.max(0, Math.round(Number(bettor.tokens || 0) + delta)));
  }
  room.wagers.active.delete(wager.id);
  const result = {
    ...wager,
    status: correct ? "won" : "lost",
    correct,
    reason,
    delta,
    tokenDelta: delta,
    resolvedAt: Date.now()
  };
  room.wagers.history.push(result);
  room.wagers.history = room.wagers.history.slice(-12);
  dispatchLiveEvent(room, wagerResultLiveEvent(result))
    .catch((error) => console.error("Could not announce wager result:", error.message));
  return result;
}

function startClandestina(room, payload) {
  if (room.clandestina && room.clandestina.active) {
    throw new Error("C'e gia una Scommessa Clandestina in corso");
  }
  const players = activePlayers(room).filter((player) => player.connected);
  if (players.length < 2) {
    throw new Error("Servono almeno due giocatori collegati");
  }
  if (nextAnswerQuestionIndex(room) < 0) {
    throw new Error("Non ci sono altre domande su cui scommettere");
  }
  const now = Date.now();
  const durationMs = normalizeTimedMiniGameDuration(payload.durationMs, 15000, 5000, 30000);
  const state = createClandestinaState();
  state.active = true;
  state.mode = payload.mode === "all" ? "all" : "random";
  state.startedAt = now;
  state.endsAt = now + durationMs;
  state.durationMs = durationMs;
  state.timer = setTimeout(() => finishClandestinaBetting(room, "timer"), durationMs + 80);
  room.clandestina = state;
  return state;
}

function placeClandestinaBet(room, player, payload) {
  const state = room.clandestina || createClandestinaState();
  if (!state.active) {
    throw new Error("Nessuna Scommessa Clandestina attiva");
  }
  if (!player.active || !player.connected) {
    throw new Error("Non sei in questa partita");
  }
  if (state.bets.some((bet) => bet.bettorId === player.id)) {
    throw new Error("Hai gia piazzato una scommessa");
  }
  if (Number(player.tokens || 0) <= 0) {
    throw new Error("Non hai token da scommettere");
  }
  const targetId = normalizeShortText(payload.targetId, 120);
  const target = targetId ? room.players.get(targetId) : null;
  if (!target || !target.active || !target.connected || target.id === player.id) {
    throw new Error("Scegli un avversario valido");
  }
  const questionIndex = nextAnswerQuestionIndex(room);
  if (questionIndex < 0) {
    throw new Error("Non ci sono altre domande su cui scommettere");
  }
  const stake = normalizeWagerStake(payload.stake, player.tokens);
  const bet = {
    id: createArchiveId("clandestina"),
    bettorId: player.id,
    bettorNickname: player.nickname,
    targetId: target.id,
    targetNickname: target.nickname,
    stake,
    multiplier: 2,
    questionIndex,
    questionNumber: questionIndex + 1,
    mode: "chosen",
    createdAt: Date.now()
  };
  state.bets.push(bet);
  return { bet };
}

function finishClandestinaBetting(room, reason) {
  const state = room.clandestina;
  if (!state || !state.active) return null;
  clearClandestinaTimer(room);
  state.active = false;
  state.closedAt = Date.now();
  state.closeReason = reason;
  if (state.mode === "random") {
    const players = activePlayers(room).filter((player) => player.connected && Number(player.tokens || 0) > 0);
    const questionIndex = nextAnswerQuestionIndex(room);
    if (questionIndex >= 0) {
      for (const player of players) {
        if (state.bets.some((bet) => bet.bettorId === player.id)) continue;
        const targets = players.filter((target) => target.id !== player.id);
        if (!targets.length) continue;
        const target = targets[Math.floor(Math.random() * targets.length)];
        const stake = Math.min(1, Math.max(1, Number(player.tokens || 0)));
        state.bets.push({
          id: createArchiveId("clandestina"),
          bettorId: player.id,
          bettorNickname: player.nickname,
          targetId: target.id,
          targetNickname: target.nickname,
          stake,
          multiplier: 3,
          questionIndex,
          questionNumber: questionIndex + 1,
          mode: "random",
          createdAt: Date.now()
        });
      }
    }
  }
  emitRoom(room).catch((error) => console.error("Could not emit clandestina close:", error.message));
  return state;
}

function resolveClandestinaBetsForQuestion(room, questionIndex) {
  const state = room.clandestina;
  if (!state || !Array.isArray(state.bets) || !state.bets.length) return [];
  const answerMap = room.answers.get(questionIndex) || new Map();
  const results = [];
  const remaining = [];
  for (const bet of state.bets) {
    if (bet.questionIndex !== questionIndex) {
      remaining.push(bet);
      continue;
    }
    const targetAnswer = answerMap.get(bet.targetId);
    const correct = Boolean(targetAnswer && targetAnswer.correct);
    const delta = correct ? bet.stake * bet.multiplier : -bet.stake;
    const bettor = room.players.get(bet.bettorId);
    if (bettor && bettor.active) {
      bettor.tokens = Math.min(999, Math.max(0, Math.round(Number(bettor.tokens || 0) + delta)));
    }
    results.push({
      ...bet,
      status: correct ? "won" : "lost",
      correct,
      delta,
      tokenDelta: delta,
      resolvedAt: Date.now()
    });
  }
  state.bets = remaining;
  state.active = false;
  clearClandestinaTimer(room);
  if (results.length) {
    state.history.push(...results);
    state.history = state.history.slice(-12);
    dispatchLiveEvent(room, clandestinaResultLiveEvent(results))
      .catch((error) => console.error("Could not announce clandestina result:", error.message));
  }
  return results;
}

function clearClandestinaTimer(room) {
  if (!room || !room.clandestina || !room.clandestina.timer) return;
  clearTimeout(room.clandestina.timer);
  room.clandestina.timer = null;
}

function updateClandestinaPlayerId(room, previousId, nextId) {
  const state = room.clandestina;
  if (!state) return;
  for (const bet of [...(state.bets || []), ...(state.history || [])]) {
    if (bet.bettorId === previousId) bet.bettorId = nextId;
    if (bet.targetId === previousId) bet.targetId = nextId;
  }
}

function cancelClandestinaForPlayer(room, playerId) {
  const state = room.clandestina;
  if (!state) return;
  state.bets = (state.bets || []).filter((bet) => bet.bettorId !== playerId && bet.targetId !== playerId);
}

function updateWagerPlayerId(room, previousId, nextId) {
  for (const offer of room.wagers.offers.values()) {
    if (offer.bettorId === previousId) offer.bettorId = nextId;
  }
  for (const wager of room.wagers.active.values()) {
    if (wager.bettorId === previousId) wager.bettorId = nextId;
    if (wager.targetPlayerId === previousId) wager.targetPlayerId = nextId;
  }
}

function cancelWagersForPlayer(room, playerId) {
  for (const offer of Array.from(room.wagers.offers.values())) {
    if (offer.bettorId === playerId) room.wagers.offers.delete(offer.id);
  }
  for (const wager of Array.from(room.wagers.active.values())) {
    if (wager.bettorId === playerId || wager.targetPlayerId === playerId) {
      room.wagers.active.delete(wager.id);
    }
  }
}

function wagerOfferLiveEvent(room, offer) {
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "player",
    playerId: offer.bettorId,
    private: true,
    title: "Scommessa live",
    message: `Punta ${offer.stake} token sulla prossima risposta. Casuale x3, scelto x2.`,
    tone: "secret",
    vibrate: true,
    vibrationPattern: defaultVibrationPattern("secret"),
    createdAt: Date.now()
  };
}

function wagerAcceptedLiveEvent(room, wager) {
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "Scommessa accettata",
    message: `${wager.bettorNickname} punta ${wager.stake} token su ${wager.targetNickname}: premio x${wager.multiplier}.`,
    tone: "drum",
    vibrate: false,
    vibrationPattern: defaultVibrationPattern("drum"),
    createdAt: Date.now()
  };
}

function wagerResultLiveEvent(result) {
  const won = result.status === "won";
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: won ? "Scommessa vinta" : "Scommessa persa",
    message: won
      ? `${result.bettorNickname} vince ${result.delta} token: ${result.targetNickname} ha risposto giusto.`
      : `${result.bettorNickname} perde ${result.stake} token: ${result.targetNickname} non ha centrato la risposta.`,
    tone: won ? "success" : "alert",
    vibrate: false,
    vibrationPattern: defaultVibrationPattern(won ? "success" : "alert"),
    createdAt: Date.now()
  };
}

function clandestinaStartedLiveEvent(state) {
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "players",
    private: false,
    title: "Scommessa Clandestina",
    message: state.mode === "all"
      ? "Tutti possono puntare token sulla prossima risposta."
      : "Piazza una puntata o lascia scegliere il caso: premio x3.",
    tone: "secret",
    vibrate: true,
    vibrationPattern: defaultVibrationPattern("secret"),
    createdAt: Date.now()
  };
}

function clandestinaResultLiveEvent(results) {
  const winners = results.filter((item) => item.status === "won");
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "Scommessa Clandestina risolta",
    message: winners.length
      ? winners.map((item) => `${item.bettorNickname} +${item.tokenDelta} token`).join(", ")
      : "Nessuna puntata clandestina vinta.",
    tone: winners.length ? "success" : "alert",
    vibrate: false,
    vibrationPattern: defaultVibrationPattern(winners.length ? "success" : "alert"),
    createdAt: Date.now()
  };
}

function startFiftyChallenge(room, payload) {
  if (room.fifty && room.fifty.active) {
    throw new Error("C'e gia un 50 e 50 in corso");
  }

  const stake = normalizeFiftyStake(payload.stake);
  const eligible = eligibleFiftyPlayers(room, stake);
  if (eligible.length < 2) {
    throw new Error("Servono almeno due giocatori collegati con punti sufficienti");
  }

  const selected = pickRandomPlayers(eligible, 2);
  const now = Date.now();
  const durationMs = normalizeFiftyDuration(payload.durationMs);
  const countdownMs = normalizeFiftyCountdown(payload.countdownMs);
  const readyTimeoutMs = normalizeFiftyReadyTimeout(payload.readyTimeoutMs);
  const participants = Object.fromEntries(selected.map((player) => {
    return [player.id, {
      playerId: player.id,
      nickname: player.nickname,
      avatarUrl: player.avatarUrl || "",
      ready: false,
      readyAt: null,
      holding: false,
      updatedAt: null,
      leftAt: null
    }];
  }));

  const challenge = {
    id: createArchiveId("fifty"),
    status: "intro",
    stake,
    pot: stake * 2,
    playerIds: selected.map((player) => player.id),
    participants,
    createdAt: now,
    readyEndsAt: now + readyTimeoutMs,
    countdownStartedAt: null,
    pressStartsAt: null,
    endsAt: null,
    countdownMs,
    durationMs,
    readyTimer: null,
    startTimer: null,
    timer: null
  };

  challenge.readyTimer = setTimeout(() => {
    cancelFiftyChallenge(room, "timeout");
  }, readyTimeoutMs + 80);

  room.fifty.active = challenge;
  return challenge;
}

function readyFiftyPlayer(room, player, payload) {
  const challenge = room.fifty && room.fifty.active;
  const challengeId = normalizeShortText(payload.challengeId, 120);
  if (!challenge || challenge.id !== challengeId) {
    throw new Error("Sfida 50 e 50 non attiva");
  }
  if (challenge.status !== "intro") {
    return { challenge: serializePlayerFiftyChallenge(room, player.id) };
  }

  const participant = challenge.participants[player.id];
  if (!participant) {
    throw new Error("Non sei in questa sfida");
  }
  participant.ready = true;
  participant.readyAt = Date.now();
  participant.leftAt = null;
  participant.updatedAt = participant.readyAt;

  if (challenge.playerIds.every((playerId) => challenge.participants[playerId].ready)) {
    beginFiftyCountdown(room, challenge);
  }

  return { challenge: serializePlayerFiftyChallenge(room, player.id) };
}

function beginFiftyCountdown(room, challenge) {
  if (!challenge || challenge.status !== "intro") return;
  for (const playerId of challenge.playerIds) {
    const player = room.players.get(playerId);
    if (!player || !player.active || !player.connected || Number(player.score || 0) < challenge.stake) {
      cancelFiftyChallenge(room, "points");
      return;
    }
  }

  clearTimeout(challenge.readyTimer);
  challenge.readyTimer = null;
  const now = Date.now();
  challenge.status = "countdown";
  challenge.countdownStartedAt = now;
  challenge.pressStartsAt = now + challenge.countdownMs;
  challenge.endsAt = challenge.pressStartsAt + challenge.durationMs;

  for (const playerId of challenge.playerIds) {
    addFiftyScore(room, playerId, -challenge.stake);
  }

  challenge.startTimer = setTimeout(() => {
    activateFiftyChallenge(room);
  }, challenge.countdownMs);
  challenge.timer = setTimeout(() => {
    finishFiftyChallenge(room, "timer");
  }, challenge.countdownMs + challenge.durationMs + 80);
}

function activateFiftyChallenge(room) {
  const challenge = room.fifty && room.fifty.active;
  if (!challenge || challenge.status !== "countdown") return;
  challenge.status = "active";
  emitRoom(room)
    .catch((error) => console.error("Could not emit 50 e 50 start:", error.message));
}

function updateFiftyHold(room, player, payload) {
  const challenge = room.fifty && room.fifty.active;
  const challengeId = normalizeShortText(payload.challengeId, 120);
  if (!challenge || challenge.id !== challengeId) {
    throw new Error("Sfida 50 e 50 non attiva");
  }

  const participant = challenge.participants[player.id];
  if (!participant) {
    throw new Error("Non sei in questa sfida");
  }
  const now = Date.now();
  if (challenge.status === "countdown" && now >= Number(challenge.pressStartsAt || 0)) {
    challenge.status = "active";
  }
  if (challenge.status !== "active") {
    throw new Error("Aspetta il via");
  }
  if (now > challenge.endsAt) {
    finishFiftyChallenge(room, "timer");
    return { resolved: true };
  }

  const holding = Boolean(payload.holding);
  participant.holding = holding;
  participant.updatedAt = now;

  return { challenge: serializePlayerFiftyChallenge(room, player.id) };
}

function finishFiftyChallenge(room, reason) {
  const result = resolveFiftyChallenge(room, reason);
  if (!result) return null;
  dispatchLiveEvent(room, fiftyResultLiveEvent(result))
    .catch((error) => console.error("Could not announce 50 e 50 result:", error.message));
  emitRoom(room)
    .catch((error) => console.error("Could not emit 50 e 50 result:", error.message));
  return result;
}

function resolveFiftyChallenge(room, reason) {
  const challenge = room.fifty && room.fifty.active;
  if (!challenge) return null;
  clearFiftyTimers(challenge);

  const [firstId, secondId] = challenge.playerIds;
  const first = challenge.participants[firstId];
  const second = challenge.participants[secondId];
  const firstSaved = fiftyParticipantSaved(room, challenge, firstId);
  const secondSaved = fiftyParticipantSaved(room, challenge, secondId);
  const firstLeft = Boolean(first && first.leftAt);
  const secondLeft = Boolean(second && second.leftAt);
  const deltas = {
    [firstId]: -challenge.stake,
    [secondId]: -challenge.stake
  };

  let outcome = "both_drop";
  let winnerId = "";
  let loserId = "";

  if (firstLeft !== secondLeft) {
    outcome = "forfeit";
    winnerId = firstLeft ? secondId : firstId;
    loserId = firstLeft ? firstId : secondId;
    addFiftyScore(room, winnerId, challenge.pot);
    deltas[winnerId] = challenge.stake;
    deltas[loserId] = -challenge.stake;
  } else if (firstSaved && secondSaved) {
    outcome = "split";
    addFiftyScore(room, firstId, challenge.stake);
    addFiftyScore(room, secondId, challenge.stake);
    deltas[firstId] = 0;
    deltas[secondId] = 0;
  } else if (firstSaved !== secondSaved) {
    outcome = "drop_win";
    winnerId = firstSaved ? secondId : firstId;
    loserId = firstSaved ? firstId : secondId;
    addFiftyScore(room, winnerId, challenge.pot);
    deltas[winnerId] = challenge.stake;
    deltas[loserId] = -challenge.stake;
  }

  const result = {
    id: challenge.id,
    status: "resolved",
    outcome,
    reason,
    stake: challenge.stake,
    pot: challenge.pot,
    winnerId,
    winnerNickname: winnerId ? challenge.participants[winnerId].nickname : "",
    loserId,
    loserNickname: loserId ? challenge.participants[loserId].nickname : "",
    players: challenge.playerIds.map((playerId) => ({
      id: playerId,
      nickname: challenge.participants[playerId].nickname,
      avatarUrl: challenge.participants[playerId].avatarUrl || "",
      saved: playerId === firstId ? firstSaved : secondSaved,
      left: Boolean(challenge.participants[playerId].leftAt),
      delta: deltas[playerId],
      score: room.players.get(playerId) ? room.players.get(playerId).score : 0
    })),
    startedAt: challenge.countdownStartedAt || challenge.createdAt,
    resolvedAt: Date.now()
  };

  room.fifty.active = null;
  room.fifty.history.push(result);
  room.fifty.history = room.fifty.history.slice(-8);
  return result;
}

function fiftyParticipantSaved(room, challenge, playerId) {
  const participant = challenge.participants[playerId];
  const player = room.players.get(playerId);
  return Boolean(participant && participant.holding && !participant.leftAt && player && player.active && player.connected);
}

function addFiftyScore(room, playerId, delta) {
  const player = room.players.get(playerId);
  if (!player || !player.active) return;
  player.score = Math.max(0, Math.round(Number(player.score || 0) + delta));
}

function adjustPlayerTokens(room, payload) {
  const playerId = normalizeShortText(payload.playerId, 120);
  const player = playerId ? room.players.get(playerId) : null;
  if (!player || !player.active) {
    throw new Error("Giocatore non disponibile");
  }
  const delta = Math.round(Number(payload.delta) || 0);
  if (!delta) {
    throw new Error("Inserisci un numero di token");
  }
  player.tokens = Math.min(999, Math.max(0, Math.round(Number(player.tokens || 0) + delta)));
  return player;
}

function startTrioChallenge(room, payload) {
  if (room.trio && room.trio.active) {
    throw new Error("C'e gia una sfida a tre in corso");
  }
  const eligible = activePlayers(room).filter((player) => player.connected);
  if (eligible.length < 3) {
    throw new Error("Servono almeno tre giocatori collegati");
  }
  const selected = pickRandomPlayers(eligible, 3);
  const now = Date.now();
  const pot = normalizeTrioPot(payload.pot);
  const durationMs = normalizeTrioDuration(payload.durationMs);
  const participants = Object.fromEntries(selected.map((player) => [player.id, {
    playerId: player.id,
    nickname: player.nickname,
    avatarUrl: player.avatarUrl || "",
    choice: "",
    chosenAt: null,
    leftAt: null
  }]));
  const challenge = {
    id: createArchiveId("trio"),
    status: "choosing",
    variant: "wolf_sheep_cabbage",
    pot,
    playerIds: selected.map((player) => player.id),
    participants,
    createdAt: now,
    endsAt: now + durationMs,
    timer: null
  };
  challenge.timer = setTimeout(() => {
    finishTrioChallenge(room, "timeout");
  }, durationMs + 80);
  room.trio.active = challenge;
  return challenge;
}

function chooseTrioSymbol(room, player, payload) {
  const challenge = room.trio && room.trio.active;
  const challengeId = normalizeShortText(payload.challengeId, 120);
  if (!challenge || challenge.id !== challengeId) {
    throw new Error("Sfida a tre non attiva");
  }
  if (challenge.status !== "choosing") {
    return { challenge: serializePlayerTrioChallenge(room, player.id) };
  }
  const participant = challenge.participants[player.id];
  if (!participant) {
    throw new Error("Non sei in questa sfida");
  }
  const choice = normalizeTrioChoice(payload.choice);
  participant.choice = choice;
  participant.chosenAt = Date.now();
  participant.leftAt = null;
  if (challenge.playerIds.every((playerId) => Boolean(challenge.participants[playerId].choice))) {
    finishTrioChallenge(room, "complete");
  }
  return { challenge: serializePlayerTrioChallenge(room, player.id) };
}

function finishTrioChallenge(room, reason) {
  const result = resolveTrioChallenge(room, reason);
  if (!result) return null;
  dispatchLiveEvent(room, trioResultLiveEvent(result))
    .catch((error) => console.error("Could not announce trio result:", error.message));
  emitRoom(room)
    .catch((error) => console.error("Could not emit trio result:", error.message));
  return result;
}

function resolveTrioChallenge(room, reason) {
  const challenge = room.trio && room.trio.active;
  if (!challenge) return null;
  clearTimeout(challenge.timer);
  challenge.timer = null;

  const choices = challenge.playerIds
    .map((playerId) => ({ playerId, choice: challenge.participants[playerId].choice }))
    .filter((item) => item.choice);
  const uniqueChoices = Array.from(new Set(choices.map((item) => item.choice)));
  let winnerIds = [];
  let outcome = "no_choice";

  if (!uniqueChoices.length) {
    winnerIds = [];
  } else if (uniqueChoices.length === 1 || uniqueChoices.length === 3) {
    winnerIds = choices.map((item) => item.playerId);
    outcome = uniqueChoices.length === 3 ? "all_split" : "draw_split";
  } else {
    const [first, second] = uniqueChoices;
    const winningChoice = TRIO_BEATS[first] === second ? first : second;
    winnerIds = choices.filter((item) => item.choice === winningChoice).map((item) => item.playerId);
    outcome = winnerIds.length > 1 ? "team_win" : "single_win";
  }

  const prize = winnerIds.length ? Math.floor(challenge.pot / winnerIds.length) : 0;
  const players = challenge.playerIds.map((playerId) => {
    const participant = challenge.participants[playerId];
    const won = winnerIds.includes(playerId);
    const delta = won ? prize : 0;
    if (delta) addMiniGameScore(room, playerId, delta);
    return {
      id: playerId,
      nickname: participant.nickname,
      avatarUrl: participant.avatarUrl || "",
      choice: participant.choice || "",
      choiceLabel: participant.choice ? TRIO_CHOICES[participant.choice] : "Nessuna scelta",
      won,
      left: Boolean(participant.leftAt),
      delta,
      score: room.players.get(playerId) ? room.players.get(playerId).score : 0
    };
  });

  const result = {
    id: challenge.id,
    status: "resolved",
    outcome,
    reason,
    variant: challenge.variant,
    pot: challenge.pot,
    winners: players.filter((player) => player.won),
    players,
    startedAt: challenge.createdAt,
    resolvedAt: Date.now()
  };
  room.trio.active = null;
  room.trio.history.push(result);
  room.trio.history = room.trio.history.slice(-8);
  return result;
}

function clearTrioChallenge(room) {
  if (!room.trio || !room.trio.active) return;
  clearTimeout(room.trio.active.timer);
  room.trio.active = null;
}

function updateTrioPlayerId(room, previousId, nextId) {
  const challenge = room.trio && room.trio.active;
  if (!challenge || !challenge.participants[previousId]) return;
  challenge.participants[nextId] = {
    ...challenge.participants[previousId],
    playerId: nextId,
    leftAt: null
  };
  delete challenge.participants[previousId];
  challenge.playerIds = challenge.playerIds.map((playerId) => playerId === previousId ? nextId : playerId);
}

function markTrioPlayerDisconnected(room, playerId) {
  const challenge = room.trio && room.trio.active;
  if (!challenge || !challenge.participants[playerId]) return false;
  challenge.participants[playerId].leftAt = challenge.participants[playerId].leftAt || Date.now();
  return true;
}

function cancelTrioForPlayer(room, playerId) {
  const challenge = room.trio && room.trio.active;
  if (!challenge || !challenge.participants[playerId]) return;
  challenge.participants[playerId].leftAt = challenge.participants[playerId].leftAt || Date.now();
  if (challenge.playerIds.filter((item) => !challenge.participants[item].leftAt).length < 2) {
    finishTrioChallenge(room, "left");
  }
}

function startTapChallenge(room, payload) {
  if (room.tap && room.tap.active) {
    throw new Error("C'e gia un Tap West in corso");
  }
  const players = activePlayers(room).filter((player) => player.connected);
  if (!players.length) {
    throw new Error("Servono giocatori collegati");
  }
  const now = Date.now();
  const durationMs = normalizeTimedMiniGameDuration(payload.durationMs, 10000, 3000, 30000);
  const challenge = {
    id: createArchiveId("tap"),
    status: "active",
    durationMs,
    playerIds: players.map((player) => player.id),
    participants: Object.fromEntries(players.map((player) => [player.id, {
      playerId: player.id,
      nickname: player.nickname,
      avatarUrl: player.avatarUrl || "",
      taps: 0,
      lastTapAt: null,
      leftAt: null
    }])),
    createdAt: now,
    endsAt: now + durationMs,
    timer: null
  };
  challenge.timer = setTimeout(() => finishTapChallenge(room, "timer"), durationMs + 80);
  room.tap.active = challenge;
  return challenge;
}

function recordTapWest(room, player, payload) {
  const challenge = room.tap && room.tap.active;
  const challengeId = normalizeShortText(payload.challengeId, 120);
  if (!challenge || challenge.id !== challengeId) {
    throw new Error("Tap West non attivo");
  }
  const participant = challenge.participants[player.id];
  if (!participant) {
    throw new Error("Non sei in questo mini-gioco");
  }
  const now = Date.now();
  if (now > challenge.endsAt) {
    const result = finishTapChallenge(room, "timer");
    return { resolved: true, result: serializeTapResult(result) };
  }
  const count = Math.min(8, Math.max(1, Math.floor(Number(payload.count) || 1)));
  participant.taps = Math.max(0, Number(participant.taps || 0) + count);
  participant.lastTapAt = now;
  participant.leftAt = null;
  return { challenge: serializePlayerTapChallenge(room, player.id) };
}

function finishTapChallenge(room, reason) {
  const result = resolveTapChallenge(room, reason);
  if (!result) return null;
  dispatchLiveEvent(room, tapResultLiveEvent(result))
    .catch((error) => console.error("Could not announce Tap West result:", error.message));
  emitRoom(room)
    .catch((error) => console.error("Could not emit Tap West result:", error.message));
  return result;
}

function resolveTapChallenge(room, reason) {
  const challenge = room.tap && room.tap.active;
  if (!challenge) return null;
  clearTimeout(challenge.timer);
  challenge.timer = null;
  const ranked = challenge.playerIds
    .map((playerId) => challenge.participants[playerId])
    .filter(Boolean)
    .sort((a, b) => Number(b.taps || 0) - Number(a.taps || 0) || a.nickname.localeCompare(b.nickname));
  const prizes = new Map();
  if (ranked[0] && Number(ranked[0].taps || 0) > 0) prizes.set(ranked[0].playerId, 2);
  if (ranked[1] && Number(ranked[1].taps || 0) > 0) prizes.set(ranked[1].playerId, 1);
  const players = ranked.map((participant, index) => {
    const deltaTokens = prizes.get(participant.playerId) || 0;
    if (deltaTokens) addMiniGameTokens(room, participant.playerId, deltaTokens);
    const player = room.players.get(participant.playerId);
    return {
      id: participant.playerId,
      nickname: participant.nickname,
      avatarUrl: participant.avatarUrl || "",
      taps: Number(participant.taps || 0),
      rank: index + 1,
      deltaTokens,
      tokens: player ? Number(player.tokens || 0) : 0,
      left: Boolean(participant.leftAt)
    };
  });
  const result = {
    id: challenge.id,
    status: "resolved",
    type: "tap_west",
    title: "Il tap piu veloce del West",
    reason,
    durationMs: challenge.durationMs,
    winners: players.filter((player) => player.deltaTokens > 0),
    players,
    startedAt: challenge.createdAt,
    resolvedAt: Date.now()
  };
  room.tap.active = null;
  room.tap.history.push(result);
  room.tap.history = room.tap.history.slice(-8);
  return result;
}

function clearTapChallenge(room) {
  if (!room.tap || !room.tap.active) return;
  clearTimeout(room.tap.active.timer);
  room.tap.active = null;
}

function markTapPlayerDisconnected(room, playerId) {
  const challenge = room.tap && room.tap.active;
  if (!challenge || !challenge.participants[playerId]) return false;
  challenge.participants[playerId].leftAt = challenge.participants[playerId].leftAt || Date.now();
  return true;
}

function updateTapPlayerId(room, previousId, nextId) {
  const challenge = room.tap && room.tap.active;
  if (!challenge || !challenge.participants[previousId]) return;
  challenge.participants[nextId] = {
    ...challenge.participants[previousId],
    playerId: nextId,
    leftAt: null
  };
  delete challenge.participants[previousId];
  challenge.playerIds = challenge.playerIds.map((playerId) => playerId === previousId ? nextId : playerId);
}

function startBalanceChallenge(room, payload) {
  if (room.balance && room.balance.active) {
    throw new Error("C'e gia un In bilico in corso");
  }
  const players = activePlayers(room).filter((player) => player.connected);
  if (!players.length) {
    throw new Error("Servono giocatori collegati");
  }
  const now = Date.now();
  const durationMs = normalizeTimedMiniGameDuration(payload.durationMs, 15000, 5000, 45000);
  const challenge = {
    id: createArchiveId("balance"),
    status: "active",
    durationMs,
    playerIds: players.map((player) => player.id),
    participants: Object.fromEntries(players.map((player) => [player.id, {
      playerId: player.id,
      nickname: player.nickname,
      avatarUrl: player.avatarUrl || "",
      x: 0,
      y: 0,
      distance: 1,
      samples: 0,
      lastUpdateAt: null,
      leftAt: null
    }])),
    createdAt: now,
    endsAt: now + durationMs,
    timer: null
  };
  challenge.timer = setTimeout(() => finishBalanceChallenge(room, "timer"), durationMs + 80);
  room.balance.active = challenge;
  return challenge;
}

function recordBalanceUpdate(room, player, payload) {
  const challenge = room.balance && room.balance.active;
  const challengeId = normalizeShortText(payload.challengeId, 120);
  if (!challenge || challenge.id !== challengeId) {
    throw new Error("In bilico non attivo");
  }
  const participant = challenge.participants[player.id];
  if (!participant) {
    throw new Error("Non sei in questo mini-gioco");
  }
  const now = Date.now();
  if (now > challenge.endsAt) {
    const result = finishBalanceChallenge(room, "timer");
    return { resolved: true, result: serializeBalanceResult(result) };
  }
  const x = clampNumber(payload.x, -1, 1, 0);
  const y = clampNumber(payload.y, -1, 1, 0);
  participant.x = x;
  participant.y = y;
  participant.distance = Math.min(1, Math.sqrt((x * x) + (y * y)));
  participant.samples = Number(participant.samples || 0) + 1;
  participant.lastUpdateAt = now;
  participant.leftAt = null;
  return { challenge: serializePlayerBalanceChallenge(room, player.id) };
}

function finishBalanceChallenge(room, reason) {
  const result = resolveBalanceChallenge(room, reason);
  if (!result) return null;
  dispatchLiveEvent(room, balanceResultLiveEvent(result))
    .catch((error) => console.error("Could not announce In bilico result:", error.message));
  emitRoom(room)
    .catch((error) => console.error("Could not emit In bilico result:", error.message));
  return result;
}

function resolveBalanceChallenge(room, reason) {
  const challenge = room.balance && room.balance.active;
  if (!challenge) return null;
  clearTimeout(challenge.timer);
  challenge.timer = null;
  const ranked = challenge.playerIds
    .map((playerId) => challenge.participants[playerId])
    .filter(Boolean)
    .sort((a, b) => Number(a.distance == null ? 1 : a.distance) - Number(b.distance == null ? 1 : b.distance) || a.nickname.localeCompare(b.nickname));
  const winner = ranked[0] || null;
  const players = ranked.map((participant, index) => {
    const deltaTokens = winner && participant.playerId === winner.playerId ? 2 : 0;
    if (deltaTokens) addMiniGameTokens(room, participant.playerId, deltaTokens);
    const player = room.players.get(participant.playerId);
    return {
      id: participant.playerId,
      nickname: participant.nickname,
      avatarUrl: participant.avatarUrl || "",
      x: Number(participant.x || 0),
      y: Number(participant.y || 0),
      distance: Number(participant.distance == null ? 1 : participant.distance),
      samples: Number(participant.samples || 0),
      rank: index + 1,
      deltaTokens,
      tokens: player ? Number(player.tokens || 0) : 0,
      left: Boolean(participant.leftAt)
    };
  });
  const result = {
    id: challenge.id,
    status: "resolved",
    type: "balance",
    title: "In bilico",
    reason,
    durationMs: challenge.durationMs,
    winners: players.filter((player) => player.deltaTokens > 0),
    players,
    startedAt: challenge.createdAt,
    resolvedAt: Date.now()
  };
  room.balance.active = null;
  room.balance.history.push(result);
  room.balance.history = room.balance.history.slice(-8);
  return result;
}

function clearBalanceChallenge(room) {
  if (!room.balance || !room.balance.active) return;
  clearTimeout(room.balance.active.timer);
  room.balance.active = null;
}

function markBalancePlayerDisconnected(room, playerId) {
  const challenge = room.balance && room.balance.active;
  if (!challenge || !challenge.participants[playerId]) return false;
  challenge.participants[playerId].leftAt = challenge.participants[playerId].leftAt || Date.now();
  challenge.participants[playerId].distance = 1;
  return true;
}

function updateBalancePlayerId(room, previousId, nextId) {
  const challenge = room.balance && room.balance.active;
  if (!challenge || !challenge.participants[previousId]) return;
  challenge.participants[nextId] = {
    ...challenge.participants[previousId],
    playerId: nextId,
    leftAt: null
  };
  delete challenge.participants[previousId];
  challenge.playerIds = challenge.playerIds.map((playerId) => playerId === previousId ? nextId : playerId);
}

function addMiniGameTokens(room, playerId, delta) {
  const player = room.players.get(playerId);
  if (!player || !player.active) return;
  player.tokens = Math.min(999, Math.max(0, Math.round(Number(player.tokens || 0) + delta)));
}

function normalizeTimedMiniGameDuration(value, fallback, min, max) {
  const duration = Math.floor(Number(value) || fallback);
  return Math.min(max, Math.max(min, duration));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function createMiniWeapon(room, payload) {
  const type = normalizeShortText(payload.type, 40);
  if (!WEAPON_TYPES.has(type)) {
    throw new Error("Arma non valida");
  }
  const ownerId = normalizeShortText(payload.ownerId, 120);
  const owner = ownerId ? room.players.get(ownerId) : null;
  if (!owner || !owner.active || !owner.connected) {
    throw new Error("Giocatore arma non disponibile");
  }
  const targetIds = normalizeWeaponTargets(room, payload);
  if (!targetIds.length) {
    throw new Error("Scegli almeno un bersaglio");
  }
  const cost = normalizeWeaponCost(payload.cost);
  if (Number(owner.tokens || 0) < cost) {
    throw new Error(`Servono ${cost} token`);
  }
  const questionIndex = weaponQuestionIndex(room, type);
  if (questionIndex < 0) {
    throw new Error(type === "invert_true_false" ? "Non c'e una domanda vero/falso disponibile" : "Non c'e una domanda disponibile");
  }
  const question = room.quiz.questions[questionIndex];
  const answerIndex = type === "hide_answer" ? weaponAnswerIndex(payload.answerIndex, question) : -1;

  owner.tokens = Math.max(0, Math.round(Number(owner.tokens || 0) - cost));
  const weapon = {
    id: createArchiveId("weapon"),
    type,
    ownerId: owner.id,
    ownerNickname: owner.nickname,
    targetIds,
    targetNicknames: targetIds.map((playerId) => room.players.get(playerId)).filter(Boolean).map((player) => player.nickname),
    questionIndex,
    questionNumber: questionIndex + 1,
    answerIndex,
    answerLabel: answerIndex >= 0 ? answerLetters[answerIndex] || String(answerIndex + 1) : "",
    cost,
    status: "active",
    createdAt: Date.now()
  };
  room.weapons.active.push(weapon);
  return weapon;
}

function normalizeWeaponTargets(room, payload) {
  const mode = normalizeShortText(payload.targetMode, 20);
  const ownerId = normalizeShortText(payload.ownerId, 120);
  if (mode === "all") {
    return activePlayers(room)
      .filter((player) => player.active && player.connected && player.id !== ownerId)
      .map((player) => player.id);
  }
  const targetId = normalizeShortText(payload.targetId, 120);
  const target = targetId ? room.players.get(targetId) : null;
  return target && target.active && target.connected && target.id !== ownerId ? [target.id] : [];
}

function weaponQuestionIndex(room, type) {
  const current = room.status === "question" ? room.currentIndex : -1;
  const accepts = (question) => question && question.type !== "slide" && (type !== "invert_true_false" || question.type === "true_false");
  if (current >= 0 && accepts(room.quiz.questions[current])) return current;
  const start = Math.max(0, room.currentIndex + 1);
  for (let index = start; index < room.quiz.questions.length; index += 1) {
    if (accepts(room.quiz.questions[index])) return index;
  }
  return -1;
}

function normalizeWeaponAnswerIndex(value, question) {
  const answerIndex = Math.floor(Number(value) || 0);
  if (!question || !Array.isArray(question.answers) || answerIndex < 0 || answerIndex >= question.answers.length) {
    throw new Error("Risposta da oscurare non valida");
  }
  return answerIndex;
}

function weaponAnswerIndex(value, question) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 0) {
    return normalizeWeaponAnswerIndex(numeric, question);
  }
  if (!question || !Array.isArray(question.answers) || !question.answers.length) {
    throw new Error("Risposta da oscurare non valida");
  }
  return Math.floor(Math.random() * question.answers.length);
}

function normalizeWeaponCost(value) {
  const cost = Math.floor(Number(value) || 1);
  return Math.min(20, Math.max(1, cost));
}

function archivePastWeapons(room, nextQuestionIndex) {
  if (!room.weapons || !Array.isArray(room.weapons.active)) return;
  const stillActive = [];
  for (const weapon of room.weapons.active) {
    if (Number(weapon.questionIndex) >= nextQuestionIndex) {
      stillActive.push(weapon);
      continue;
    }
    room.weapons.history.push({ ...weapon, status: "used", usedAt: Date.now() });
  }
  room.weapons.active = stillActive;
  room.weapons.history = room.weapons.history.slice(-12);
}

function activeWeaponsForPlayerQuestion(room, playerId, questionIndex) {
  if (!room.weapons || !Array.isArray(room.weapons.active)) return [];
  return room.weapons.active.filter((weapon) =>
    weapon.status === "active" &&
    Number(weapon.questionIndex) === Number(questionIndex) &&
    Array.isArray(weapon.targetIds) &&
    weapon.targetIds.includes(playerId)
  );
}

function isAnswerHiddenForPlayer(room, playerId, questionIndex, answerIndex) {
  return activeWeaponsForPlayerQuestion(room, playerId, questionIndex)
    .some((weapon) => weapon.type === "hide_answer" && Number(weapon.answerIndex) === Number(answerIndex));
}

function shouldInvertTrueFalseForPlayer(room, playerId, questionIndex) {
  const question = room.quiz.questions[questionIndex];
  if (!question || question.type !== "true_false") return false;
  return activeWeaponsForPlayerQuestion(room, playerId, questionIndex)
    .some((weapon) => weapon.type === "invert_true_false");
}

function remapAnswerIndexForWeapons(room, player, question, displayIndex) {
  if (!room || !player || room.currentIndex < 0) return displayIndex;
  if (question.type === "true_false" && shouldInvertTrueFalseForPlayer(room, player.id, room.currentIndex)) {
    if (Number(displayIndex) === 0) return 1;
    if (Number(displayIndex) === 1) return 0;
  }
  return displayIndex;
}

function updateWeaponPlayerId(room, previousId, nextId) {
  if (!room.weapons) return;
  const update = (weapon) => {
    if (weapon.ownerId === previousId) weapon.ownerId = nextId;
    if (Array.isArray(weapon.targetIds)) {
      weapon.targetIds = weapon.targetIds.map((playerId) => playerId === previousId ? nextId : playerId);
    }
  };
  room.weapons.active.forEach(update);
  room.weapons.history.forEach(update);
}

function cancelWeaponsForPlayer(room, playerId) {
  if (!room.weapons || !Array.isArray(room.weapons.active)) return;
  room.weapons.active = room.weapons.active.filter((weapon) => {
    if (weapon.ownerId === playerId) return false;
    weapon.targetIds = weapon.targetIds.filter((targetId) => targetId !== playerId);
    return weapon.targetIds.length > 0;
  });
}

function normalizeTrioPot(value) {
  const pot = Math.floor(Number(value) || 600);
  return Math.min(10000, Math.max(30, pot));
}

function normalizeTrioDuration(value) {
  const duration = Math.floor(Number(value) || 45000);
  return Math.min(120000, Math.max(5000, duration));
}

function normalizeTrioChoice(value) {
  const choice = normalizeShortText(value, 20);
  if (!TRIO_CHOICES[choice]) {
    throw new Error("Scelta non valida");
  }
  return choice;
}

function addMiniGameScore(room, playerId, delta) {
  const player = room.players.get(playerId);
  if (!player || !player.active) return;
  player.score = Math.max(0, Math.round(Number(player.score || 0) + delta));
}

function normalizeFiftyStake(value) {
  const stake = Math.floor(Number(value) || 0);
  if (!stake || stake < 1) {
    throw new Error("Inserisci una posta valida");
  }
  return Math.min(50000, stake);
}

function normalizeFiftyDuration(value) {
  const duration = Math.floor(Number(value) || 5000);
  return Math.min(12000, Math.max(300, duration));
}

function normalizeFiftyCountdown(value) {
  const countdown = Math.floor(Number(value) || 3000);
  return Math.min(8000, Math.max(300, countdown));
}

function normalizeFiftyReadyTimeout(value) {
  const timeout = Math.floor(Number(value) || 45000);
  return Math.min(120000, Math.max(5000, timeout));
}

function eligibleFiftyPlayers(room, stake) {
  return activePlayers(room)
    .filter((player) => player.connected && Number(player.score || 0) >= stake)
    .sort((a, b) => a.nickname.localeCompare(b.nickname));
}

function pickRandomPlayers(players, count) {
  const list = players.slice();
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
  return list.slice(0, count);
}

function clearFiftyChallenge(room) {
  if (!room.fifty || !room.fifty.active) return;
  clearFiftyTimers(room.fifty.active);
  room.fifty.active = null;
}

function clearFiftyTimers(challenge) {
  if (!challenge) return;
  clearTimeout(challenge.readyTimer);
  clearTimeout(challenge.startTimer);
  clearTimeout(challenge.timer);
  challenge.readyTimer = null;
  challenge.startTimer = null;
  challenge.timer = null;
}

function updateFiftyPlayerId(room, previousId, nextId) {
  const challenge = room.fifty && room.fifty.active;
  if (!challenge || !challenge.participants[previousId]) return;
  challenge.participants[nextId] = {
    ...challenge.participants[previousId],
    playerId: nextId,
    holding: false,
    leftAt: null,
    updatedAt: Date.now()
  };
  delete challenge.participants[previousId];
  challenge.playerIds = challenge.playerIds.map((playerId) => playerId === previousId ? nextId : playerId);
}

function markFiftyPlayerDisconnected(room, playerId) {
  const challenge = room.fifty && room.fifty.active;
  if (!challenge || !challenge.participants[playerId]) return false;
  const participant = challenge.participants[playerId];
  const now = Date.now();
  participant.holding = false;
  participant.updatedAt = now;
  if (challenge.status === "intro") {
    participant.ready = false;
    participant.readyAt = null;
    return true;
  }
  participant.leftAt = participant.leftAt || now;
  return true;
}

function cancelFiftyForPlayer(room, playerId) {
  const challenge = room.fifty && room.fifty.active;
  if (!challenge || !challenge.participants[playerId]) return;
  const participant = challenge.participants[playerId];
  participant.holding = false;
  participant.leftAt = participant.leftAt || Date.now();
  participant.updatedAt = participant.leftAt;
  if (challenge.status === "intro") {
    cancelFiftyChallenge(room, "left");
    return;
  }
  finishFiftyChallenge(room, "left");
}

function cancelFiftyChallenge(room, reason) {
  const challenge = room.fifty && room.fifty.active;
  if (!challenge) return null;
  clearFiftyTimers(challenge);
  room.fifty.active = null;
  const result = {
    id: challenge.id,
    status: "cancelled",
    outcome: "cancelled",
    reason,
    stake: challenge.stake,
    pot: challenge.pot,
    winnerId: "",
    winnerNickname: "",
    loserId: "",
    loserNickname: "",
    players: challenge.playerIds.map((playerId) => ({
      id: playerId,
      nickname: challenge.participants[playerId].nickname,
      saved: false,
      delta: 0,
      score: room.players.get(playerId) ? room.players.get(playerId).score : 0
    })),
    startedAt: challenge.createdAt,
    resolvedAt: Date.now()
  };
  room.fifty.history.push(result);
  room.fifty.history = room.fifty.history.slice(-8);
  dispatchLiveEvent(room, fiftyCancelledLiveEvent(result))
    .catch((error) => console.error("Could not announce 50 e 50 cancellation:", error.message));
  emitRoom(room)
    .catch((error) => console.error("Could not emit 50 e 50 cancellation:", error.message));
  return result;
}

function fiftyStartedLiveEvent(challenge) {
  const names = challenge.playerIds.map((playerId) => challenge.participants[playerId].nickname);
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "50 e 50",
    message: `${names[0]} contro ${names[1]}: ${challenge.pot} punti in palio.`,
    tone: "drum",
    vibrate: true,
    vibrationPattern: defaultVibrationPattern("drum"),
    createdAt: Date.now()
  };
}

function fiftyResultLiveEvent(result) {
  let message = `Entrambi mollano: perdono ${result.stake} punti a testa.`;
  let tone = "alert";
  if (result.outcome === "split") {
    message = `${result.players[0].nickname} e ${result.players[1].nickname} si salvano: posta divisa.`;
    tone = "success";
  } else if (result.outcome === "drop_win") {
    message = `${result.winnerNickname} lascia cadere ${result.loserNickname} e prende ${result.pot} punti.`;
    tone = "drum";
  } else if (result.outcome === "forfeit") {
    message = `${result.loserNickname} esce dalla sfida: ${result.winnerNickname} prende la posta.`;
    tone = "success";
  }
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "50 e 50 risolto",
    message,
    tone,
    vibrate: false,
    vibrationPattern: defaultVibrationPattern(tone),
    createdAt: Date.now()
  };
}

function fiftyCancelledLiveEvent(result) {
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "50 e 50 annullato",
    message: result.reason === "timeout" ? "I giocatori non erano pronti in tempo." : "La sfida e stata interrotta.",
    tone: "alert",
    vibrate: false,
    vibrationPattern: defaultVibrationPattern("alert"),
    createdAt: Date.now()
  };
}

function trioStartedLiveEvent(challenge) {
  const names = challenge.playerIds.map((playerId) => challenge.participants[playerId].nickname);
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "Lupo, agnello, cavolo",
    message: `${names.join(" vs ")} entrano nella sfida segreta. Posta ${challenge.pot} punti.`,
    tone: "drum",
    vibrate: true,
    vibrationPattern: defaultVibrationPattern("drum"),
    createdAt: Date.now()
  };
}

function trioResultLiveEvent(result) {
  const winners = result.winners && result.winners.length
    ? result.winners.map((player) => player.nickname).join(", ")
    : "Nessun vincitore";
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "Sfida a tre risolta",
    message: `${winners}: ${trioOutcomeText(result)}.`,
    tone: result.winners && result.winners.length ? "success" : "alert",
    vibrate: false,
    vibrationPattern: defaultVibrationPattern(result.winners && result.winners.length ? "success" : "alert"),
    createdAt: Date.now()
  };
}

function trioOutcomeText(result) {
  if (result.outcome === "all_split") return "escono tutti e tre i simboli, posta divisa";
  if (result.outcome === "draw_split") return "pareggio, posta divisa";
  if (result.outcome === "team_win") return "due giocatori si dividono la posta";
  if (result.outcome === "single_win") return "un giocatore prende tutta la posta";
  return "nessuna scelta valida";
}

function tapStartedLiveEvent(challenge) {
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "Il tap piu veloce del West",
    message: `${challenge.playerIds.length} giocatori: 10 secondi di tap. Primo +2 token, secondo +1 token.`,
    tone: "drum",
    vibrate: true,
    vibrationPattern: defaultVibrationPattern("drum"),
    createdAt: Date.now()
  };
}

function tapResultLiveEvent(result) {
  const winners = result.winners && result.winners.length
    ? result.winners.map((player) => `${player.nickname} +${player.deltaTokens}`).join(", ")
    : "Nessun vincitore";
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "Tap West risolto",
    message: `${winners} token.`,
    tone: result.winners && result.winners.length ? "success" : "alert",
    vibrate: false,
    vibrationPattern: defaultVibrationPattern(result.winners && result.winners.length ? "success" : "alert"),
    createdAt: Date.now()
  };
}

function balanceStartedLiveEvent(challenge) {
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "In bilico",
    message: `${challenge.playerIds.length} giocatori sul tronco: resta al centro per 15 secondi. Premio: 2 token.`,
    tone: "drum",
    vibrate: true,
    vibrationPattern: defaultVibrationPattern("drum"),
    createdAt: Date.now()
  };
}

function balanceResultLiveEvent(result) {
  const winner = result.winners && result.winners[0];
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: "In bilico risolto",
    message: winner ? `${winner.nickname} resta piu al centro e prende 2 token.` : "Nessun vincitore.",
    tone: winner ? "success" : "alert",
    vibrate: false,
    vibrationPattern: defaultVibrationPattern(winner ? "success" : "alert"),
    createdAt: Date.now()
  };
}

function weaponLiveEvent(room, weapon) {
  return {
    id: createArchiveId("live"),
    type: "message",
    target: "all",
    private: false,
    title: weapon.type === "hide_answer" ? "Arma: risposta oscurata" : "Arma: vero/falso invertito",
    message: `${weapon.ownerNickname} spende ${weapon.cost} token contro ${weapon.targetNicknames.join(", ")} sulla domanda ${weapon.questionNumber}.`,
    tone: "secret",
    vibrate: true,
    vibrationPattern: defaultVibrationPattern("secret"),
    createdAt: Date.now()
  };
}

async function emitRoom(room) {
  const sockets = await io.in(roomChannel(room.code)).fetchSockets();
  for (const target of sockets) {
    target.emit("room:state", serializeRoom(room, target));
  }
}

async function dispatchLiveEvent(room, event) {
  const sockets = await io.in(roomChannel(room.code)).fetchSockets();
  let delivered = 0;
  for (const target of sockets) {
    if (!shouldReceiveLiveEvent(target, event)) continue;
    target.emit("live:event", event);
    delivered += 1;
  }
  return delivered;
}

function shouldReceiveLiveEvent(socket, event) {
  if (socket.data.role === "host") return false;
  if (event.target === "all") return socket.data.role === "player" || socket.data.role === "screen";
  if (event.target === "players") return socket.data.role === "player";
  if (event.target === "screen") return socket.data.role === "screen";
  if (event.target === "player") {
    return socket.data.role === "player" && socket.data.playerId === event.playerId;
  }
  return false;
}

function normalizeLiveEvent(payload, room) {
  const source = payload && typeof payload === "object" ? payload : {};
  const target = LIVE_EVENT_TARGETS.has(source.target) ? source.target : "all";
  const type = source.type === "message" ? "message" : "effect";
  const tone = LIVE_EVENT_TONES.has(source.tone) ? source.tone : target === "player" ? "secret" : "spark";
  const title = normalizeShortText(source.title, 60) || liveEventTitle(type, target, tone);
  const fallbackMessage = type === "message" ? "" : liveEventMessage(tone);
  const message = normalizeShortText(source.message, 160) || fallbackMessage;
  const vibrate = Boolean(source.vibrate);
  const vibrationPattern = normalizeVibrationPattern(source.vibrationPattern, tone);
  let playerId = "";

  if (target === "player") {
    playerId = normalizeShortText(source.playerId, 120);
    const player = playerId ? room.players.get(playerId) : null;
    if (!player || !player.active) {
      throw new Error("Giocatore non disponibile");
    }
  }

  if (type === "message" && !message) {
    throw new Error("Scrivi un messaggio live");
  }

  return {
    id: createArchiveId("live"),
    type,
    target,
    playerId,
    private: target === "player",
    title,
    message,
    tone,
    vibrate,
    vibrationPattern,
    createdAt: Date.now()
  };
}

function liveEventTitle(type, target, tone) {
  if (target === "player") return "Messaggio segreto";
  if (target === "screen") return "Evento monitor";
  if (type === "message") return "Messaggio live";
  if (tone === "drum") return "Colpo di scena";
  if (tone === "success") return "Momento bonus";
  if (tone === "alert") return "Attenzione";
  return "Evento live";
}

function liveEventMessage(tone) {
  if (tone === "drum") return "Sta per succedere qualcosa.";
  if (tone === "success") return "Momento bonus!";
  if (tone === "alert") return "Occhi aperti.";
  if (tone === "secret") return "Messaggio privato dall'host.";
  return "Evento QuizLive.";
}

function normalizeVibrationPattern(value, tone) {
  const source = Array.isArray(value) ? value : defaultVibrationPattern(tone);
  return source
    .map((item) => Math.min(600, Math.max(20, Math.round(Number(item) || 0))))
    .filter(Boolean)
    .slice(0, 8);
}

function defaultVibrationPattern(tone) {
  if (tone === "drum") return [120, 45, 160];
  if (tone === "success") return [60, 35, 60, 35, 140];
  if (tone === "alert") return [180, 60, 180];
  if (tone === "secret") return [45, 35, 45];
  return [70, 35, 110];
}

function serializeRoom(room, socket) {
  const role = socket.data.role === "host" ? "host" : socket.data.role === "screen" ? "screen" : "player";
  const question = room.currentIndex >= 0 ? room.quiz.questions[room.currentIndex] : null;
  const answerMap = room.currentIndex >= 0 ? room.answers.get(room.currentIndex) || new Map() : new Map();
  const playerId = socket.data.playerId;
  const playerAnswer = playerId && answerMap.get(playerId);
  const revealMode = room.status === "reveal" || room.status === "ended" || role === "host";
  const answerCountMode = role === "host" || room.status === "reveal" || room.status === "ended";

  const serializedQuestion = question
    ? serializeQuestionForRole(room, question, {
      role,
      playerId,
      playerAnswer,
      revealMode,
      answerCountMode,
      answerMap
    })
    : null;

  return {
    code: room.code,
    role,
    status: room.status,
    title: room.quiz.title,
    description: room.quiz.description,
    subject: room.quiz.subject,
    level: room.quiz.level,
    language: room.quiz.language,
    quiz: role === "host" ? room.quiz : undefined,
    tags: room.quiz.tags,
    teamMode: Boolean(room.quiz.teamMode),
    totalQuestions: room.quiz.questions.length,
    currentIndex: room.currentIndex,
    questionEndsAt: room.questionEndsAt,
    player: playerId ? serializePlayer(room.players.get(playerId), room) : null,
    question: serializedQuestion,
    players: role === "host" ? hostPlayers(room, answerMap) : undefined,
    leaderboard: leaderboard(room).slice(0, 10),
    teamLeaderboard: room.quiz.teamMode ? teamLeaderboard(room) : undefined,
    questionSummaries: role === "host" ? questionSummaries(room) : undefined,
    wagers: role === "host" ? serializeHostWagers(room) : undefined,
    wagerOffer: role === "player" ? serializePlayerWagerOffer(room, playerId) : undefined,
    activeWagers: serializePublicActiveWagers(room),
    wagerHistory: serializePublicWagerHistory(room),
    clandestina: serializeClandestina(room, role, playerId),
    fifty: role === "host" ? serializeHostFifty(room) : undefined,
    fiftyChallenge: role === "player" ? serializePlayerFiftyChallenge(room, playerId) : undefined,
    activeFifty: serializePublicActiveFifty(room),
    fiftyHistory: serializePublicFiftyHistory(room),
    trio: role === "host" ? serializeHostTrio(room) : undefined,
    trioChallenge: role === "player" ? serializePlayerTrioChallenge(room, playerId) : undefined,
    activeTrio: serializePublicActiveTrio(room),
    trioHistory: serializePublicTrioHistory(room),
    tap: role === "host" ? serializeHostTap(room) : undefined,
    tapChallenge: role === "player" ? serializePlayerTapChallenge(room, playerId) : undefined,
    activeTap: serializePublicActiveTap(room),
    tapHistory: serializePublicTapHistory(room),
    balance: role === "host" ? serializeHostBalance(room) : undefined,
    balanceChallenge: role === "player" ? serializePlayerBalanceChallenge(room, playerId) : undefined,
    activeBalance: serializePublicActiveBalance(room),
    balanceHistory: serializePublicBalanceHistory(room),
    weapons: role === "host" ? serializeHostWeapons(room) : undefined,
    playerWeapons: role === "player" ? serializePlayerWeapons(room, playerId) : undefined,
    cleanLeaderboard: cleanLeaderboard(room),
    timeline: room.status === "ended" || role === "host" ? gameTimeline(room) : undefined,
    answerCount: answerMap.size,
    playerCount: activePlayers(room).length,
    pendingInviteCount: role === "host" ? pendingInviteCount(room) : undefined,
    exports: role === "host"
      ? {
          csv: `/api/rooms/${room.code}/export/results.csv`,
          json: `/api/rooms/${room.code}/export/results.json`,
          xlsx: `/api/rooms/${room.code}/export/results.xlsx`
        }
      : undefined
  };
}

function serializeQuestionForRole(room, question, options) {
  const role = options.role;
  const playerId = options.playerId;
  const questionIndex = room.currentIndex;
  const answerMap = options.answerMap || new Map();
  const revealMode = Boolean(options.revealMode);
  const answerCountMode = Boolean(options.answerCountMode);
  const playerAnswer = options.playerAnswer || null;
  const transforms = role === "player" && playerId
    ? activeWeaponsForPlayerQuestion(room, playerId, questionIndex)
    : [];
  const invert = transforms.some((weapon) => weapon.type === "invert_true_false") && question.type === "true_false";
  const hiddenIndexes = new Set(transforms
    .filter((weapon) => weapon.type === "hide_answer")
    .map((weapon) => Number(weapon.answerIndex)));

  let answers = question.answers.map((answer, originalIndex) => serializeAnswerForQuestion(question, answerMap, originalIndex, originalIndex, {
    revealMode,
    answerCountMode,
    hidden: hiddenIndexes.has(originalIndex)
  }));

  if (invert && answers.length >= 2) {
    answers = [answers[1], answers[0]].map((answer, displayIndex) => ({
      ...answer,
      index: displayIndex,
      displayIndex,
      originalIndex: answer.originalIndex
    }));
  }
  const serializedPlayerAnswer = playerAnswer && invert ? remapPlayerAnswerForInvertedDisplay(playerAnswer) : playerAnswer;

  return {
    type: question.type,
    typeLabel: QUESTION_TYPE_LABELS[question.type] || QUESTION_TYPE_LABELS.multiple,
    text: question.text,
    subtitle: question.subtitle,
    imageUrl: question.imageUrl,
    imageAlt: question.imageAlt,
    imageCredit: question.imageCredit,
    imageCreditUrl: question.imageCreditUrl,
    imageProvider: question.imageProvider,
    imagePageUrl: question.imagePageUrl,
    videoUrl: question.videoUrl,
    answers,
    timeLimit: question.timeLimit,
    points: question.points || 0,
    correctIndex: revealMode ? question.correctIndex : undefined,
    correctIndexes: revealMode ? correctIndexes(question) : undefined,
    selectionCount: selectionCount(question),
    answered: Boolean(serializedPlayerAnswer),
    playerAnswer: serializedPlayerAnswer || null,
    weapons: transforms.length ? transforms.map((weapon) => serializeWeapon(weapon, room, true)) : undefined
  };
}

function serializeAnswerForQuestion(question, answerMap, originalIndex, displayIndex, options) {
  const hidden = Boolean(options.hidden);
  return {
    text: hidden ? "Risposta oscurata" : question.answers[originalIndex],
    imageUrl: hidden ? "" : answerImageUrl(question, originalIndex),
    imageLayout: hidden ? {} : answerImageLayout(question, originalIndex),
    index: displayIndex,
    displayIndex,
    originalIndex,
    blocked: hidden,
    correct: options.revealMode ? correctIndexes(question).includes(originalIndex) : undefined,
    count: options.answerCountMode ? countAnswers(answerMap, originalIndex) : undefined
  };
}

function remapPlayerAnswerForInvertedDisplay(playerAnswer) {
  const remap = (value) => Number(value) === 0 ? 1 : Number(value) === 1 ? 0 : value;
  const answerIndexes = Array.isArray(playerAnswer.answerIndexes)
    ? playerAnswer.answerIndexes.map(remap)
    : [remap(playerAnswer.answerIndex)];
  return {
    ...playerAnswer,
    answerIndex: answerIndexes[0],
    answerIndexes
  };
}

function hostPlayers(room, answerMap) {
  return activePlayers(room)
    .map((player) => ({
      ...serializePlayer(player, room),
      answered: answerMap.has(player.id)
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
}

function serializeHostWagers(room) {
  return {
    offers: Array.from(room.wagers.offers.values()).map((offer) => serializeWagerOffer(offer, room)),
    active: Array.from(room.wagers.active.values()).map(serializeActiveWager),
    history: serializePublicWagerHistory(room)
  };
}

function serializeClandestina(room, role, playerId = "") {
  const state = room.clandestina || createClandestinaState();
  const bets = Array.isArray(state.bets) ? state.bets : [];
  const history = Array.isArray(state.history) ? state.history : [];
  const publicState = {
    active: Boolean(state.active),
    mode: state.mode || "random",
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    durationMs: state.durationMs || 15000,
    betCount: bets.length,
    history: history.slice(-6).reverse().map(serializeClandestinaResult)
  };
  if (role === "host") {
    return {
      ...publicState,
      bets: bets.map(serializeClandestinaBet)
    };
  }
  if (role === "player" && playerId) {
    return {
      ...publicState,
      myBet: bets.find((bet) => bet.bettorId === playerId) ? serializeClandestinaBet(bets.find((bet) => bet.bettorId === playerId)) : null,
      eligibleTargets: eligibleClandestinaTargets(room, playerId)
    };
  }
  return publicState;
}

function serializeClandestinaBet(bet) {
  return {
    id: bet.id,
    bettorId: bet.bettorId,
    bettorNickname: bet.bettorNickname,
    targetId: bet.targetId,
    targetNickname: bet.targetNickname,
    stake: bet.stake,
    multiplier: bet.multiplier,
    mode: bet.mode,
    questionIndex: bet.questionIndex,
    questionNumber: bet.questionNumber || bet.questionIndex + 1,
    createdAt: bet.createdAt
  };
}

function serializeClandestinaResult(result) {
  return {
    ...serializeClandestinaBet(result),
    status: result.status,
    correct: Boolean(result.correct),
    delta: result.delta,
    tokenDelta: result.tokenDelta,
    resolvedAt: result.resolvedAt
  };
}

function serializeHostFifty(room) {
  return {
    active: serializeFiftyChallenge(room.fifty && room.fifty.active),
    history: serializePublicFiftyHistory(room)
  };
}

function serializeHostTrio(room) {
  return {
    active: serializeTrioChallenge(room.trio && room.trio.active, "host"),
    history: serializePublicTrioHistory(room)
  };
}

function serializeHostWeapons(room) {
  return {
    active: room.weapons && Array.isArray(room.weapons.active)
      ? room.weapons.active.map((weapon) => serializeWeapon(weapon, room))
      : [],
    history: room.weapons && Array.isArray(room.weapons.history)
      ? room.weapons.history.slice(-8).reverse().map((weapon) => serializeWeapon(weapon, room))
      : []
  };
}

function serializePlayerWagerOffer(room, playerId) {
  if (!playerId) return null;
  const offer = Array.from(room.wagers.offers.values()).find((item) => item.bettorId === playerId);
  return offer ? serializeWagerOffer(offer, room) : null;
}

function serializeWagerOffer(offer, room) {
  return {
    id: offer.id,
    bettorId: offer.bettorId,
    bettorNickname: offer.bettorNickname,
    stake: offer.stake,
    questionIndex: offer.questionIndex,
    questionNumber: offer.questionIndex + 1,
    status: offer.status,
    eligibleTargets: eligibleWagerTargets(room, offer.bettorId),
    createdAt: offer.createdAt
  };
}

function serializeActiveWager(wager) {
  return {
    id: wager.id,
    bettorId: wager.bettorId,
    bettorNickname: wager.bettorNickname,
    targetMode: wager.targetMode,
    targetPlayerId: wager.targetPlayerId,
    targetNickname: wager.targetNickname,
    stake: wager.stake,
    multiplier: wager.multiplier,
    questionIndex: wager.questionIndex,
    questionNumber: wager.questionIndex + 1,
    status: wager.status,
    acceptedAt: wager.acceptedAt
  };
}

function serializeWagerResult(result) {
  return {
    id: result.id,
    bettorNickname: result.bettorNickname,
    targetNickname: result.targetNickname,
    stake: result.stake,
    multiplier: result.multiplier,
    questionIndex: result.questionIndex,
    questionNumber: result.questionIndex + 1,
    status: result.status,
    correct: result.correct,
    delta: result.delta,
    tokenDelta: result.tokenDelta != null ? result.tokenDelta : result.delta,
    reason: result.reason,
    resolvedAt: result.resolvedAt
  };
}

function serializePublicActiveWagers(room) {
  return Array.from(room.wagers.active.values()).map(serializeActiveWager).slice(0, 5);
}

function serializePublicWagerHistory(room) {
  return room.wagers.history.slice(-5).reverse().map(serializeWagerResult);
}

function serializeFiftyChallenge(challenge) {
  if (!challenge) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    stake: challenge.stake,
    pot: challenge.pot,
    players: challenge.playerIds.map((playerId) => ({
      id: playerId,
      nickname: challenge.participants[playerId].nickname,
      avatarUrl: challenge.participants[playerId].avatarUrl || "",
      ready: Boolean(challenge.participants[playerId].ready),
      holding: Boolean(challenge.participants[playerId].holding),
      left: Boolean(challenge.participants[playerId].leftAt)
    })),
    createdAt: challenge.createdAt,
    readyEndsAt: challenge.readyEndsAt,
    countdownStartedAt: challenge.countdownStartedAt,
    pressStartsAt: challenge.pressStartsAt,
    endsAt: challenge.endsAt,
    countdownMs: challenge.countdownMs,
    durationMs: challenge.durationMs
  };
}

function serializePlayerFiftyChallenge(room, playerId) {
  if (!playerId || !room.fifty || !room.fifty.active) return null;
  const challenge = room.fifty.active;
  const participant = challenge.participants[playerId];
  if (!participant) return null;
  const opponentId = challenge.playerIds.find((item) => item !== playerId);
  const opponent = opponentId ? challenge.participants[opponentId] : null;
  return {
    id: challenge.id,
    status: challenge.status,
    stake: challenge.stake,
    pot: challenge.pot,
    opponentNickname: opponent ? opponent.nickname : "Avversario",
    ready: Boolean(participant.ready),
    opponentReady: Boolean(opponent && opponent.ready),
    holding: Boolean(participant.holding),
    left: Boolean(participant.leftAt),
    createdAt: challenge.createdAt,
    readyEndsAt: challenge.readyEndsAt,
    countdownStartedAt: challenge.countdownStartedAt,
    pressStartsAt: challenge.pressStartsAt,
    endsAt: challenge.endsAt,
    countdownMs: challenge.countdownMs,
    durationMs: challenge.durationMs
  };
}

function serializeFiftyResult(result) {
  return {
    id: result.id,
    status: result.status,
    outcome: result.outcome,
    stake: result.stake,
    pot: result.pot,
    winnerId: result.winnerId,
    winnerNickname: result.winnerNickname,
    loserId: result.loserId,
    loserNickname: result.loserNickname,
    reason: result.reason,
    players: result.players,
    resolvedAt: result.resolvedAt
  };
}

function serializePublicActiveFifty(room) {
  return serializeFiftyChallenge(room.fifty && room.fifty.active);
}

function serializePublicFiftyHistory(room) {
  return room.fifty && room.fifty.history
    ? room.fifty.history.slice(-5).reverse().map(serializeFiftyResult)
    : [];
}

function serializeTrioChallenge(challenge, role = "public") {
  if (!challenge) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    variant: challenge.variant,
    pot: challenge.pot,
    players: challenge.playerIds.map((playerId) => {
      const participant = challenge.participants[playerId];
      return {
        id: playerId,
        nickname: participant.nickname,
        avatarUrl: participant.avatarUrl || "",
        chosen: Boolean(participant.choice),
        choice: role === "host" ? participant.choice : "",
        choiceLabel: role === "host" && participant.choice ? TRIO_CHOICES[participant.choice] : "",
        left: Boolean(participant.leftAt)
      };
    }),
    createdAt: challenge.createdAt,
    endsAt: challenge.endsAt
  };
}

function serializePlayerTrioChallenge(room, playerId) {
  if (!playerId || !room.trio || !room.trio.active) return null;
  const challenge = room.trio.active;
  const participant = challenge.participants[playerId];
  if (!participant) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    variant: challenge.variant,
    pot: challenge.pot,
    choice: participant.choice || "",
    choiceLabel: participant.choice ? TRIO_CHOICES[participant.choice] : "",
    opponents: challenge.playerIds
      .filter((item) => item !== playerId)
      .map((item) => ({
        id: item,
        nickname: challenge.participants[item].nickname,
        avatarUrl: challenge.participants[item].avatarUrl || "",
        chosen: Boolean(challenge.participants[item].choice)
      })),
    createdAt: challenge.createdAt,
    endsAt: challenge.endsAt
  };
}

function serializeTrioResult(result) {
  return {
    id: result.id,
    status: result.status,
    outcome: result.outcome,
    reason: result.reason,
    variant: result.variant,
    pot: result.pot,
    winners: result.winners,
    players: result.players,
    resolvedAt: result.resolvedAt
  };
}

function serializePublicActiveTrio(room) {
  return serializeTrioChallenge(room.trio && room.trio.active, "public");
}

function serializePublicTrioHistory(room) {
  return room.trio && room.trio.history
    ? room.trio.history.slice(-5).reverse().map(serializeTrioResult)
    : [];
}

function serializeHostTap(room) {
  return {
    active: serializeTapChallenge(room.tap && room.tap.active),
    history: serializePublicTapHistory(room)
  };
}

function serializeTapChallenge(challenge) {
  if (!challenge) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    durationMs: challenge.durationMs,
    createdAt: challenge.createdAt,
    endsAt: challenge.endsAt,
    players: challenge.playerIds.map((playerId) => {
      const participant = challenge.participants[playerId];
      return {
        id: playerId,
        nickname: participant.nickname,
        avatarUrl: participant.avatarUrl || "",
        taps: Number(participant.taps || 0),
        left: Boolean(participant.leftAt)
      };
    })
  };
}

function serializePlayerTapChallenge(room, playerId) {
  if (!playerId || !room.tap || !room.tap.active) return null;
  const challenge = room.tap.active;
  const participant = challenge.participants[playerId];
  if (!participant) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    durationMs: challenge.durationMs,
    createdAt: challenge.createdAt,
    endsAt: challenge.endsAt,
    taps: Number(participant.taps || 0),
    players: challenge.playerIds.length
  };
}

function serializeTapResult(result) {
  if (!result) return null;
  return {
    id: result.id,
    status: result.status,
    type: result.type,
    title: result.title,
    reason: result.reason,
    durationMs: result.durationMs,
    winners: result.winners,
    players: result.players,
    startedAt: result.startedAt,
    resolvedAt: result.resolvedAt
  };
}

function serializePublicActiveTap(room) {
  return serializeTapChallenge(room.tap && room.tap.active);
}

function serializePublicTapHistory(room) {
  return room.tap && room.tap.history
    ? room.tap.history.slice(-5).reverse().map(serializeTapResult)
    : [];
}

function serializeHostBalance(room) {
  return {
    active: serializeBalanceChallenge(room.balance && room.balance.active),
    history: serializePublicBalanceHistory(room)
  };
}

function serializeBalanceChallenge(challenge) {
  if (!challenge) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    durationMs: challenge.durationMs,
    createdAt: challenge.createdAt,
    endsAt: challenge.endsAt,
    players: challenge.playerIds.map((playerId) => {
      const participant = challenge.participants[playerId];
      return {
        id: playerId,
        nickname: participant.nickname,
        avatarUrl: participant.avatarUrl || "",
        x: Number(participant.x || 0),
        y: Number(participant.y || 0),
        distance: Number(participant.distance == null ? 1 : participant.distance),
        samples: Number(participant.samples || 0),
        left: Boolean(participant.leftAt)
      };
    })
  };
}

function serializePlayerBalanceChallenge(room, playerId) {
  if (!playerId || !room.balance || !room.balance.active) return null;
  const challenge = room.balance.active;
  const participant = challenge.participants[playerId];
  if (!participant) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    durationMs: challenge.durationMs,
    createdAt: challenge.createdAt,
    endsAt: challenge.endsAt,
    x: Number(participant.x || 0),
    y: Number(participant.y || 0),
    distance: Number(participant.distance == null ? 1 : participant.distance),
    samples: Number(participant.samples || 0),
    players: challenge.playerIds.length
  };
}

function serializeBalanceResult(result) {
  if (!result) return null;
  return {
    id: result.id,
    status: result.status,
    type: result.type,
    title: result.title,
    reason: result.reason,
    durationMs: result.durationMs,
    winners: result.winners,
    players: result.players,
    startedAt: result.startedAt,
    resolvedAt: result.resolvedAt
  };
}

function serializePublicActiveBalance(room) {
  return serializeBalanceChallenge(room.balance && room.balance.active);
}

function serializePublicBalanceHistory(room) {
  return room.balance && room.balance.history
    ? room.balance.history.slice(-5).reverse().map(serializeBalanceResult)
    : [];
}

function serializeWeapon(weapon, room, privateView = false) {
  if (!weapon) return null;
  const typeLabel = weapon.type === "hide_answer" ? "Oscura risposta" : "Vero/Falso invertito";
  return {
    id: weapon.id,
    type: weapon.type,
    typeLabel,
    ownerId: weapon.ownerId,
    ownerNickname: weapon.ownerNickname,
    targetIds: privateView ? undefined : weapon.targetIds,
    targetNicknames: weapon.targetNicknames,
    questionIndex: weapon.questionIndex,
    questionNumber: weapon.questionNumber,
    answerIndex: weapon.answerIndex,
    answerLabel: weapon.answerLabel,
    cost: weapon.cost,
    status: weapon.status,
    createdAt: weapon.createdAt
  };
}

function serializePlayerWeapons(room, playerId) {
  if (!playerId || !room.weapons || !Array.isArray(room.weapons.active)) return [];
  return room.weapons.active
    .filter((weapon) => Array.isArray(weapon.targetIds) && weapon.targetIds.includes(playerId))
    .map((weapon) => serializeWeapon(weapon, room, true));
}

function serializePlayer(player, room) {
  if (!player) return null;
  const board = leaderboard(room);
  return {
    id: player.id,
    nickname: player.nickname,
    avatarUrl: player.avatarUrl || "",
    team: player.team || "",
    score: player.score,
    tokens: Number(player.tokens || 0),
    streak: player.streak,
    connected: player.connected,
    active: player.active,
    rematch: player.rematch,
    rank: board.findIndex((item) => item.id === player.id) + 1
  };
}

function leaderboard(room) {
  return activePlayers(room)
    .map((player) => ({
      id: player.id,
      nickname: player.nickname,
      avatarUrl: player.avatarUrl || "",
      team: player.team || "",
      score: player.score,
      tokens: Number(player.tokens || 0),
      streak: player.streak,
      connected: player.connected,
      active: player.active
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
}

function cleanLeaderboard(room) {
  return activePlayers(room)
    .map((player) => {
      let score = 0;
      for (const answerMap of room.answers.values()) {
        const answer = answerMap.get(player.id);
        if (answer) score += Number(answer.points || 0);
      }
      return {
        id: player.id,
        nickname: player.nickname,
        avatarUrl: player.avatarUrl || "",
        team: player.team || "",
        score,
        tokens: Number(player.tokens || 0),
        streak: player.streak,
        connected: player.connected,
        active: player.active
      };
    })
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
}

function gameTimeline(room) {
  const items = [];
  const push = (item) => {
    if (!item || !item.at) return;
    items.push(item);
  };
  for (const wager of room.wagers.history || []) {
    push({
      type: "wager",
      title: wager.status === "won" ? "Scommessa vinta" : "Scommessa persa",
      text: wager.status === "won"
        ? `${wager.bettorNickname} ha scommesso su ${wager.targetNickname} e vince ${Math.abs(Number(wager.tokenDelta != null ? wager.tokenDelta : wager.delta) || 0)} token.`
        : `${wager.bettorNickname} ha scommesso su ${wager.targetNickname} e perde ${Math.abs(Number(wager.tokenDelta != null ? wager.tokenDelta : wager.delta) || 0)} token.`,
      at: wager.resolvedAt
    });
  }
  for (const item of (room.clandestina && room.clandestina.history) || []) {
    push({
      type: "clandestina",
      title: item.status === "won" ? "Scommessa clandestina vinta" : "Scommessa clandestina persa",
      text: item.status === "won"
        ? `${item.bettorNickname} ha puntato su ${item.targetNickname} e vince ${Math.abs(Number(item.tokenDelta || 0))} token.`
        : `${item.bettorNickname} ha puntato su ${item.targetNickname} e perde ${Math.abs(Number(item.tokenDelta || 0))} token.`,
      at: item.resolvedAt
    });
  }
  for (const item of room.fifty.history || []) {
    push({
      type: "fifty",
      title: "50 e 50",
      text: fiftyTimelineText(item),
      at: item.resolvedAt
    });
  }
  for (const item of room.trio.history || []) {
    push({
      type: "trio",
      title: "Lupo/Agnello/Cavolo",
      text: trioTimelineText(item),
      at: item.resolvedAt
    });
  }
  for (const item of room.tap.history || []) {
    push({
      type: "tap",
      title: "Tap West",
      text: tokenWinnersTimelineText(item, "tap"),
      at: item.resolvedAt
    });
  }
  for (const item of room.balance.history || []) {
    push({
      type: "balance",
      title: "In bilico",
      text: tokenWinnersTimelineText(item, "balance"),
      at: item.resolvedAt
    });
  }
  const weaponEvents = [
    ...((room.weapons && room.weapons.history) || []),
    ...((room.weapons && room.weapons.active) || [])
  ];
  for (const weapon of weaponEvents) {
    push({
      type: "weapon",
      title: weapon.type === "hide_answer" ? "Malus: risposta oscurata" : "Malus: vero/falso invertito",
      text: `${weapon.ownerNickname} contro ${(weapon.targetNicknames || []).join(", ")} alla domanda ${weapon.questionNumber}.`,
      at: weapon.usedAt || weapon.createdAt
    });
  }
  return items
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    .map((item, index) => ({ ...item, index: index + 1 }));
}

function tokenWinnersTimelineText(result, type) {
  const winners = Array.isArray(result.winners) ? result.winners : [];
  if (!winners.length) return type === "balance" ? "Nessuno resta abbastanza centrale." : "Nessun token assegnato.";
  return winners.map((player) => `${player.nickname} +${player.deltaTokens} token`).join(", ");
}

function fiftyTimelineText(result) {
  if (result.outcome === "split") return "Entrambi salvano: posta divisa.";
  if (result.outcome === "drop_win") return `${result.winnerNickname} lascia cadere ${result.loserNickname} e prende il piatto.`;
  if (result.outcome === "forfeit") return `${result.loserNickname} esce: ${result.winnerNickname} vince.`;
  if (result.outcome === "cancelled") return "Sfida annullata.";
  return "Doppia caduta: entrambi perdono la posta.";
}

function trioTimelineText(result) {
  const winners = Array.isArray(result.winners) ? result.winners : [];
  if (!winners.length) return "Nessun punto assegnato.";
  return `${winners.map((player) => player.nickname).join(", ")}: ${trioOutcomeText(result)}.`;
}

function assignTeam(room) {
  const teams = ["Rosso", "Blu", "Verde", "Giallo"];
  const counts = Object.fromEntries(teams.map((team) => [team, 0]));
  for (const player of activePlayers(room)) {
    if (player.team && counts[player.team] != null) counts[player.team] += 1;
  }
  return teams
    .slice()
    .sort((a, b) => counts[a] - counts[b] || teams.indexOf(a) - teams.indexOf(b))[0];
}

function teamLeaderboard(room) {
  const teams = new Map();
  for (const player of activePlayers(room)) {
    const team = player.team || "Senza team";
    const current = teams.get(team) || { team, score: 0, playerCount: 0 };
    current.score += player.score;
    current.playerCount += 1;
    teams.set(team, current);
  }
  return Array.from(teams.values()).sort((a, b) => b.score - a.score || a.team.localeCompare(b.team));
}

function questionSummaries(room) {
  const playerCount = activePlayers(room).length;
  return room.quiz.questions.map((question, index) => {
    const answerMap = room.answers.get(index) || new Map();
    return {
      index,
      type: question.type,
      typeLabel: QUESTION_TYPE_LABELS[question.type] || QUESTION_TYPE_LABELS.multiple,
      text: question.text,
      subtitle: question.subtitle,
      stats: questionStats(question, answerMap, playerCount),
      correctAnswers: correctIndexes(question).map((answerIndex) => ({
        index: answerIndex,
        letter: answerLetters[answerIndex] || String(answerIndex + 1),
        text: question.answers[answerIndex] || ""
      }))
    };
  });
}

function countAnswers(answerMap, answerIndex) {
  let total = 0;
  for (const answer of answerMap.values()) {
    const indexes = Array.isArray(answer.answerIndexes) ? answer.answerIndexes : [answer.answerIndex];
    if (indexes.includes(answerIndex)) total += 1;
  }
  return total;
}

function selectedAnswerIndexes(payload, question, room = null, player = null) {
  const raw = question.type === "multiple_select" ? payload.answerIndexes : [payload.answerIndex];
  const source = Array.isArray(raw) ? raw : [raw];
  const displayIndexes = uniqueAnswerIndexes(source);
  if (!room || !player) return displayIndexes;
  return uniqueAnswerIndexes(displayIndexes.map((answerIndex) => remapAnswerIndexForWeapons(room, player, question, answerIndex)));
}

function uniqueAnswerIndexes(values) {
  return Array.from(new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))))
    .sort((a, b) => a - b);
}

function correctIndexes(question) {
  if (question && question.type === "slide") return [];
  if (Array.isArray(question.correctIndexes) && question.correctIndexes.length) {
    return uniqueAnswerIndexes(question.correctIndexes);
  }
  return uniqueAnswerIndexes([question.correctIndex]);
}

function selectionCount(question) {
  if (question.type === "slide") return 0;
  return question.type === "multiple_select" ? correctIndexes(question).length : 1;
}

function sameAnswerSet(left, right) {
  const a = uniqueAnswerIndexes(left);
  const b = uniqueAnswerIndexes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function scoreAnswer(question, answerIndexes) {
  const selected = uniqueAnswerIndexes(answerIndexes);
  const correct = correctIndexes(question);
  if (sameAnswerSet(selected, correct)) {
    return { correct: true, partial: false, ratio: 1 };
  }
  if (question.type === "multiple_select") {
    const selectedCorrect = selected.filter((index) => correct.includes(index)).length;
    if (selectedCorrect > 0) {
      return { correct: false, partial: true, ratio: 0.5 };
    }
  }
  return { correct: false, partial: false, ratio: 0 };
}

function questionScoreProfile(questionOrType) {
  const type = typeof questionOrType === "string" ? questionOrType : questionOrType && questionOrType.type;
  if (type === "slide") {
    return scoreProfileWithCustomBase({ base: 0, speedBonus: 0, streakStep: 0, maxStreakBonus: 0 }, questionOrType);
  }
  if (type === "speed") {
    return scoreProfileWithCustomBase({ base: 250, speedBonus: 1000, streakStep: 30, maxStreakBonus: 150 }, questionOrType);
  }
  if (type === "multiple_select") {
    return scoreProfileWithCustomBase({ base: 700, speedBonus: 450, streakStep: 40, maxStreakBonus: 220 }, questionOrType);
  }
  if (type === "true_false") {
    return scoreProfileWithCustomBase({ base: 450, speedBonus: 450, streakStep: 40, maxStreakBonus: 200 }, questionOrType);
  }
  return scoreProfileWithCustomBase({ base: 500, speedBonus: 500, streakStep: 50, maxStreakBonus: 250 }, questionOrType);
}

function scoreProfileWithCustomBase(profile, questionOrType) {
  const points = typeof questionOrType === "object" ? normalizeQuestionPoints(questionOrType.points) : 0;
  return points ? { ...profile, base: points } : profile;
}

function resultsToJson(room) {
  return {
    code: room.code,
    title: room.quiz.title,
    description: room.quiz.description,
    subject: room.quiz.subject,
    level: room.quiz.level,
    language: room.quiz.language,
    folder: room.quiz.folder,
    visibility: room.quiz.visibility,
    tags: room.quiz.tags,
    teamMode: Boolean(room.quiz.teamMode),
    exportedAt: new Date().toISOString(),
    questions: room.quiz.questions.map((question, questionIndex) => ({
      type: question.type,
      text: question.text,
      subtitle: question.subtitle,
      imageUrl: question.imageUrl,
      imageAlt: question.imageAlt,
      imageCredit: question.imageCredit,
      imageCreditUrl: question.imageCreditUrl,
      imageProvider: question.imageProvider,
      imagePageUrl: question.imagePageUrl,
      videoUrl: question.videoUrl,
      answers: question.answers,
      answerImages: normalizedAnswerImages(question, question.answers.length),
      answerImageLayouts: normalizedAnswerImageLayouts(question, question.answers.length),
      correctIndex: question.correctIndex,
      correctIndexes: correctIndexes(question),
      points: question.points || 0,
      stats: questionStats(question, room.answers.get(questionIndex) || new Map(), activePlayers(room).length),
      responses: Array.from(room.answers.get(questionIndex) || new Map()).map(([playerId, answer]) => {
        const player = room.players.get(playerId);
        return {
          playerId,
          nickname: player ? player.nickname : "Unknown",
          answerIndex: answer.answerIndex,
          answerIndexes: answer.answerIndexes || [answer.answerIndex],
          answerText: answerTextForIndexes(question, answer.answerIndexes || [answer.answerIndex]),
          correct: answer.correct,
          partial: Boolean(answer.partial),
          scoreRatio: Number(answer.scoreRatio || 0),
          points: answer.points,
          answeredAt: new Date(answer.answeredAt).toISOString()
        };
      })
    })),
    leaderboard: leaderboard(room),
    teamLeaderboard: room.quiz.teamMode ? teamLeaderboard(room) : []
  };
}

function resultsToCsv(room) {
  const rows = [
    ["Rank", "Nickname", "Team", "Score", "Streak", ...room.quiz.questions.flatMap((_question, index) => [
      `Q${index + 1} Answer`,
      `Q${index + 1} Correct`,
      `Q${index + 1} Points`
    ])]
  ];

  leaderboard(room).forEach((player, playerIndex) => {
    const row = [
      playerIndex + 1,
      player.nickname,
      player.team || "",
      player.score,
      player.streak
    ];
    room.quiz.questions.forEach((question, questionIndex) => {
      const answer = room.answers.get(questionIndex) && room.answers.get(questionIndex).get(player.id);
      row.push(
        answer ? answerTextForIndexes(question, answer.answerIndexes || [answer.answerIndex]) : "",
        answer ? answerOutcome(answer) : "",
        answer ? answer.points : 0
      );
    });
    rows.push(row);
  });

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

async function listQuizzesFromStore() {
  await ensureArchiveReady();
  if (pgPool) return listQuizzesFromPostgres();
  return store.quizzes
    .map((item) => ({
      id: item.id,
      title: item.title,
      questionCount: item.questionCount,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      folder: item.quiz && item.quiz.folder || "",
      visibility: item.quiz && item.quiz.visibility || "private",
      quiz: item.quiz
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function saveQuizToStore(id, quiz) {
  await ensureArchiveReady();
  if (pgPool) return saveQuizToPostgres(id, quiz);

  const now = new Date().toISOString();
  const existing = store.quizzes.find((item) => item.id === id);
  const saved = {
    id,
    title: quiz.title,
    questionCount: quiz.questions.length,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    quiz
  };

  if (existing) {
    Object.assign(existing, saved);
  } else {
    store.quizzes.unshift(saved);
  }

  store.quizzes = store.quizzes
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 100);
  persistStore();
  return saved;
}

async function deleteQuizFromStore(id) {
  await ensureArchiveReady();
  const normalizedId = normalizeArchiveId(id);
  if (pgPool) return deleteQuizFromPostgres(normalizedId);

  const index = store.quizzes.findIndex((item) => item.id === normalizedId);
  if (index < 0) return false;
  store.quizzes.splice(index, 1);
  persistStore();
  return true;
}

async function saveMediaToStore(media) {
  await ensureArchiveReady();
  const id = createArchiveId("media");
  const saved = {
    id,
    mime: media.mime,
    data: media.data,
    size: media.size,
    createdAt: new Date().toISOString()
  };
  if (pgPool) return saveMediaToPostgres(saved);

  store.media.unshift(saved);
  store.media = store.media
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 300);
  persistStore();
  return saved;
}

async function findMedia(id) {
  await ensureArchiveReady();
  const normalizedId = normalizeArchiveId(id);
  if (pgPool) return findMediaFromPostgres(normalizedId);
  return store.media.find((item) => item.id === normalizedId) || null;
}

async function listResultsFromStore() {
  await ensureArchiveReady();
  if (pgPool) return listResultsFromPostgres();
  return store.results
    .map(resultSummary)
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
}

async function saveResultToStore(room) {
  await ensureArchiveReady();
  const result = resultFromRoom(room);
  if (pgPool) return saveResultToPostgres(result);

  store.results.unshift(result);
  store.results = store.results
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
    .slice(0, 200);
  persistStore();
  return result;
}

async function findResult(id) {
  await ensureArchiveReady();
  const normalizedId = normalizeArchiveId(id);
  if (pgPool) return findResultFromPostgres(normalizedId);
  return store.results.find((item) => item.id === normalizedId) || null;
}

async function deleteResultFromStore(id) {
  await ensureArchiveReady();
  const normalizedId = normalizeArchiveId(id);
  if (pgPool) return deleteResultFromPostgres(normalizedId);

  const index = store.results.findIndex((item) => item.id === normalizedId);
  if (index < 0) return false;
  store.results.splice(index, 1);
  persistStore();
  return true;
}

function resultFromRoom(room) {
  const endedAt = new Date().toISOString();
  const board = leaderboard(room).map((player, index) => ({
    ...player,
    rank: index + 1
  }));

  return {
    id: createArchiveId("result"),
    code: room.code,
    title: room.quiz.title,
    subject: room.quiz.subject,
    level: room.quiz.level,
    language: room.quiz.language,
    tags: room.quiz.tags,
    teamMode: Boolean(room.quiz.teamMode),
    createdAt: new Date(room.createdAt).toISOString(),
    endedAt,
    quiz: room.quiz,
    questions: room.quiz.questions.map((question, questionIndex) => {
      const answerMap = room.answers.get(questionIndex) || new Map();
      return {
        type: question.type,
        text: question.text,
        subtitle: question.subtitle,
        imageUrl: question.imageUrl,
        imageAlt: question.imageAlt,
        imageCredit: question.imageCredit,
        imageCreditUrl: question.imageCreditUrl,
        imageProvider: question.imageProvider,
        imagePageUrl: question.imagePageUrl,
        videoUrl: question.videoUrl,
        answers: question.answers,
        answerImages: normalizedAnswerImages(question, question.answers.length),
        answerImageLayouts: normalizedAnswerImageLayouts(question, question.answers.length),
        correctIndex: question.correctIndex,
        correctIndexes: correctIndexes(question),
        stats: questionStats(question, answerMap, board.length),
        responses: Array.from(answerMap).map(([playerId, answer]) => {
          const player = room.players.get(playerId);
          return {
            playerId,
            nickname: player ? player.nickname : "Unknown",
            answerIndex: answer.answerIndex,
            answerIndexes: answer.answerIndexes || [answer.answerIndex],
            answerText: answerTextForIndexes(question, answer.answerIndexes || [answer.answerIndex]),
            correct: answer.correct,
            partial: Boolean(answer.partial),
            scoreRatio: Number(answer.scoreRatio || 0),
            points: answer.points,
            answeredAt: new Date(answer.answeredAt).toISOString()
          };
        })
      };
    }),
    leaderboard: board,
    cleanLeaderboard: cleanLeaderboard(room).map((player, index) => ({ ...player, rank: index + 1 })),
    timeline: gameTimeline(room),
    wagers: serializeHostWagers(room),
    clandestina: serializeClandestina(room, "host"),
    fifty: serializeHostFifty(room),
    trio: serializeHostTrio(room),
    tap: serializeHostTap(room),
    balance: serializeHostBalance(room),
    weapons: serializeHostWeapons(room),
    teamLeaderboard: room.quiz.teamMode ? teamLeaderboard(room) : []
  };
}

function resultToCsv(result) {
  const rows = [
    ["Rank", "Nickname", "Team", "Score", "Streak", ...result.questions.flatMap((_question, index) => [
      `Q${index + 1} Answer`,
      `Q${index + 1} Correct`,
      `Q${index + 1} Points`
    ])]
  ];

  result.leaderboard.forEach((player, playerIndex) => {
    const row = [
      player.rank || playerIndex + 1,
      player.nickname,
      player.team || "",
      player.score,
      player.streak
    ];

    result.questions.forEach((question) => {
      const answer = question.responses.find((item) => item.playerId === player.id);
      row.push(
        answer ? answer.answerText : "",
        answer ? answerOutcome(answer) : "",
        answer ? answer.points : 0
      );
    });

    rows.push(row);
  });

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function resultToWorkbook(result) {
  const normalized = result && typeof result === "object" ? result : {};
  const questions = Array.isArray(normalized.questions) ? normalized.questions : [];
  const leaderboardItems = Array.isArray(normalized.leaderboard) ? normalized.leaderboard : [];
  const teamItems = Array.isArray(normalized.teamLeaderboard) ? normalized.teamLeaderboard : [];
  const workbook = XLSX.utils.book_new();
  const averageAccuracy = questions.length
    ? Math.round(questions.reduce((sum, question) => sum + Number(question.stats && question.stats.accuracy || 0), 0) / questions.length)
    : 0;

  appendSheet(workbook, "Riepilogo", [
    ["QuizLive - risultati"],
    ["Titolo", normalized.title || ""],
    ["Codice stanza", normalized.code || ""],
    ["Materia", normalized.subject || ""],
    ["Livello", normalized.level || ""],
    ["Lingua", normalized.language || ""],
    ["Cartella", normalized.folder || ""],
    ["Visibilita", normalized.visibility || ""],
    ["Tag", Array.isArray(normalized.tags) ? normalized.tags.join(", ") : ""],
    ["Team mode", normalized.teamMode ? "si" : "no"],
    ["Creato", normalized.createdAt || ""],
    ["Concluso/esportato", normalized.endedAt || normalized.exportedAt || new Date().toISOString()],
    ["Giocatori", leaderboardItems.length],
    ["Squadre", teamItems.length],
    ["Domande", questions.length],
    ["Accuracy media %", averageAccuracy]
  ], [{ wch: 24 }, { wch: 60 }]);

  appendSheet(workbook, "Classifica", [
    ["Rank", "Nickname", "Team", "Punteggio", "Streak"],
    ...leaderboardItems.map((player, index) => [
      player.rank || index + 1,
      player.nickname || "",
      player.team || "",
      Number(player.score || 0),
      Number(player.streak || 0)
    ])
  ], [{ wch: 8 }, { wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 10 }]);

  appendSheet(workbook, "Squadre", [
    ["Rank", "Squadra", "Giocatori", "Punteggio"],
    ...teamItems.map((team, index) => [
      index + 1,
      team.team || "",
      Number(team.playerCount || 0),
      Number(team.score || 0)
    ])
  ], [{ wch: 8 }, { wch: 22 }, { wch: 12 }, { wch: 14 }]);

  appendSheet(workbook, "Domande", [
    ["#", "Tipo", "Domanda", "Risposte corrette", "Risposte ricevute", "Corrette", "Parziali", "Sbagliate", "Risposta %", "Accuracy %"],
    ...questions.map((question, index) => [
      index + 1,
      question.type || "",
      question.text || "",
      resultCorrectAnswerText(question),
      Number(question.stats && question.stats.responseCount || 0),
      Number(question.stats && question.stats.correctCount || 0),
      Number(question.stats && question.stats.partialCount || 0),
      Number(question.stats && question.stats.wrongCount || 0),
      Number(question.stats && question.stats.answerRate || 0),
      Number(question.stats && question.stats.accuracy || 0)
    ])
  ], [{ wch: 6 }, { wch: 18 }, { wch: 54 }, { wch: 34 }, { wch: 16 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }]);

  appendSheet(workbook, "Risposte", [
    ["Domanda", "Nickname", "Team", "Risposta", "Esito", "Punti", "Data risposta"],
    ...questions.flatMap((question, questionIndex) => {
      const responses = Array.isArray(question.responses) ? question.responses : [];
      return responses.map((response) => {
        const player = leaderboardItems.find((item) => item.id === response.playerId) || {};
        return [
          questionIndex + 1,
          response.nickname || player.nickname || "",
          player.team || "",
          response.answerText || "",
          answerOutcome(response),
          Number(response.points || 0),
          response.answeredAt || ""
        ];
      });
    })
  ], [{ wch: 8 }, { wch: 28 }, { wch: 18 }, { wch: 44 }, { wch: 12 }, { wch: 10 }, { wch: 26 }]);

  appendSheet(workbook, "Scelte", [
    ["Domanda", "Lettera", "Risposta", "Corretta", "Scelte", "Scelte %"],
    ...questions.flatMap((question, questionIndex) => {
      const answers = Array.isArray(question.answers) ? question.answers : [];
      const responses = Array.isArray(question.responses) ? question.responses : [];
      return answers.map((answer, answerIndex) => {
        const count = responses.filter((response) => {
          const indexes = Array.isArray(response.answerIndexes) ? response.answerIndexes : [response.answerIndex];
          return indexes.includes(answerIndex);
        }).length;
        return [
          questionIndex + 1,
          answerLetters[answerIndex] || String(answerIndex + 1),
          answer || "",
          resultCorrectIndexes(question).includes(answerIndex) ? "yes" : "no",
          count,
          responses.length ? Math.round((count / responses.length) * 100) : 0
        ];
      });
    })
  ], [{ wch: 8 }, { wch: 8 }, { wch: 44 }, { wch: 10 }, { wch: 10 }, { wch: 10 }]);

  return workbook;
}

function appendSheet(workbook, name, rows, columns) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (columns) sheet["!cols"] = columns;
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function resultCorrectIndexes(question) {
  if (question && question.type === "slide") return [];
  if (Array.isArray(question.correctIndexes) && question.correctIndexes.length) {
    return uniqueAnswerIndexes(question.correctIndexes);
  }
  return uniqueAnswerIndexes([question.correctIndex]);
}

function resultCorrectAnswerText(question) {
  const answers = Array.isArray(question.answers) ? question.answers : [];
  return resultCorrectIndexes(question)
    .map((index) => `${answerLetters[index] || index + 1} ${answers[index] || ""}`.trim())
    .filter(Boolean)
    .join("; ");
}

function answerTextForIndexes(question, indexes) {
  return uniqueAnswerIndexes(indexes)
    .map((index) => question.answers[index])
    .filter(Boolean)
    .join("; ");
}

function answerImageUrl(question, index) {
  const images = Array.isArray(question && question.answerImages) ? question.answerImages : [];
  return normalizeImageUrl(images[index]);
}

function answerImageLayout(question, index) {
  return normalizedAnswerImageLayouts(question, index + 1)[index] || defaultAnswerImageLayout();
}

function normalizedAnswerImages(question, count) {
  const images = Array.isArray(question && question.answerImages) ? question.answerImages : [];
  return Array.from({ length: Math.max(0, count) }, (_item, index) => normalizeImageUrl(images[index]));
}

function normalizedAnswerImageLayouts(question, count) {
  const layouts = Array.isArray(question && question.answerImageLayouts) ? question.answerImageLayouts : [];
  return Array.from({ length: Math.max(0, count) }, (_item, index) => normalizeAnswerImageLayout(layouts[index]));
}

function normalizeAnswerImageLayout(layout) {
  const source = layout && typeof layout === "object" ? layout : {};
  const fit = source.fit === "contain" ? "contain" : "cover";
  return {
    fit,
    x: clampNumber(source.x, 0, 100, 50),
    y: clampNumber(source.y, 0, 100, 50),
    zoom: clampNumber(source.zoom, 1, 3, 1)
  };
}

function defaultAnswerImageLayout() {
  return { fit: "cover", x: 50, y: 50, zoom: 1 };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function questionStats(question, answerMap, playerCount) {
  const answers = Array.from(answerMap.values());
  const correct = answers.filter((answer) => answer.correct).length;
  const partial = answers.filter((answer) => answer.partial).length;
  const responseCount = answers.length;
  return {
    responseCount,
    correctCount: correct,
    partialCount: partial,
    wrongCount: Math.max(0, responseCount - correct - partial),
    answerRate: playerCount ? Math.round((responseCount / playerCount) * 100) : 0,
    accuracy: responseCount ? Math.round(((correct + partial * 0.5) / responseCount) * 100) : 0,
    selectionCount: selectionCount(question)
  };
}

function answerOutcome(answer) {
  if (!answer) return "";
  if (answer.correct) return "yes";
  if (answer.partial) return "partial";
  return "no";
}

function quizToWorkbook(quiz, isTemplate) {
  const normalizedQuiz = normalizeQuiz(isTemplate ? templateQuiz() : quiz);
  const rows = [
    ["QuizLive - quiz"],
    ["Titolo", normalizedQuiz.title],
    ["Descrizione", normalizedQuiz.description],
    ["Materia", normalizedQuiz.subject],
    ["Livello", normalizedQuiz.level],
    ["Lingua", normalizedQuiz.language],
    ["Cartella", normalizedQuiz.folder],
    ["Visibilita", normalizedQuiz.visibility],
    ["Tag", normalizedQuiz.tags.join(", ")],
    ["Team mode", normalizedQuiz.teamMode ? "si" : "no"],
    [],
    ["Ordine", "Tipo", "Domanda", "Sottotitolo", "Tempo secondi", "Punti", "Corretta", "Immagine URL", "Alt immagine", "Credito immagine", "Link fotografo", "Link foto", "Video URL", "Risposta A", "Risposta B", "Risposta C", "Risposta D", "Risposta E", "Risposta F", "Immagine risposta A", "Immagine risposta B", "Immagine risposta C", "Immagine risposta D", "Immagine risposta E", "Immagine risposta F"]
  ];

  normalizedQuiz.questions.forEach((question, index) => {
    const answerImages = normalizedAnswerImages(question, 6);
    rows.push([
      index + 1,
      questionTypeForWorkbook(question.type),
      question.text,
      question.subtitle || "",
      question.timeLimit,
      question.points || "",
      correctIndexes(question).map((answerIndex) => answerLetters[answerIndex] || "A").join(","),
      question.imageUrl || "",
      question.imageAlt || "",
      question.imageCredit || "",
      question.imageCreditUrl || "",
      question.imagePageUrl || "",
      question.videoUrl || "",
      ...Array.from({ length: 6 }, (_item, answerIndex) => question.answers[answerIndex] || ""),
      ...answerImages
    ]);
  });

  const workbook = XLSX.utils.book_new();
  const quizSheet = XLSX.utils.aoa_to_sheet(rows);
  quizSheet["!cols"] = [
    { wch: 8 },
    { wch: 16 },
    { wch: 44 },
    { wch: 34 },
    { wch: 14 },
    { wch: 10 },
    { wch: 10 },
    { wch: 34 },
    { wch: 28 },
    { wch: 22 },
    { wch: 34 },
    { wch: 34 },
    { wch: 34 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 22 },
    { wch: 34 },
    { wch: 34 },
    { wch: 34 },
    { wch: 34 },
    { wch: 34 },
    { wch: 34 }
  ];
  XLSX.utils.book_append_sheet(workbook, quizSheet, "QuizLive");

  const instructions = XLSX.utils.aoa_to_sheet([
    ["Come compilare"],
    ["Titolo", "Scrivi il titolo nella cella B2 del foglio QuizLive."],
    ["Descrizione", "Scrivi una breve descrizione nella cella B3, se serve."],
    ["Materia/Livello/Lingua/Tag", "Usa questi campi per ordinare la libreria quiz."],
    ["Team mode", "Scrivi si per dividere automaticamente i giocatori in squadre."],
    ["Tipo", "Usa multipla, vero_falso, veloce, risposte_multiple oppure slide."],
    ["Slide", "Usa tipo slide per creare un passaggio con titolo, sottotitolo e foto, senza risposte."],
    ["Punti", "Lascia vuoto per standard oppure usa 250, 500, 750, 1000 o 1500."],
    ["Corretta", "Scrivi A, B, C, D, E o F. Per risposte_multiple usa piu lettere, ad esempio A,C."],
    ["Libreria", "Cartella organizza l'archivio. Visibilita accetta privata o pubblica."],
    ["Media", "Immagine URL accetta link http/https o media caricati da QuizLive. Puoi usare anche Immagine risposta A-F per immagini sui bottoni risposta."],
    ["Vero/Falso", "Per vero_falso usa A per Vero oppure B per Falso. Le risposte verranno normalizzate."],
    ["Limiti", "Massimo 50 domande, 2-6 risposte, tempo da 5 a 90 secondi."]
  ]);
  instructions["!cols"] = [{ wch: 18 }, { wch: 92 }];
  XLSX.utils.book_append_sheet(workbook, instructions, "Istruzioni");
  return workbook;
}

function workbookToQuiz(workbook) {
  const sheetName = workbook.SheetNames.includes("QuizLive") ? "QuizLive" : workbook.SheetNames[0];
  if (!sheetName) throw new Error("Il file XLSX non contiene fogli");
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" });
  const titleRow = rows.find((row) => normalizeCell(row[0]) === "titolo");
  const descriptionRow = rows.find((row) => normalizeCell(row[0]) === "descrizione" || normalizeCell(row[0]) === "description");
  const subjectRow = rows.find((row) => normalizeCell(row[0]) === "materia");
  const levelRow = rows.find((row) => normalizeCell(row[0]) === "livello");
  const languageRow = rows.find((row) => normalizeCell(row[0]) === "lingua");
  const folderRow = rows.find((row) => normalizeCell(row[0]) === "cartella");
  const visibilityRow = rows.find((row) => normalizeCell(row[0]) === "visibilita" || normalizeCell(row[0]) === "visibility");
  const tagsRow = rows.find((row) => normalizeCell(row[0]) === "tag");
  const teamModeRow = rows.find((row) => normalizeCell(row[0]) === "team_mode");
  const title = String(titleRow && titleRow[1] || "QuizLive").trim().slice(0, 80) || "QuizLive";
  const headerIndex = rows.findIndex((row) =>
    row.some((cell) => normalizeCell(cell) === "domanda") &&
    row.some((cell) => normalizeCell(cell) === "tipo")
  );
  if (headerIndex < 0) throw new Error("Intestazioni XLSX non trovate");

  const headers = rows[headerIndex].map(normalizeCell);
  const indexFor = (...names) => headers.findIndex((header) => names.includes(header));
  const typeIndex = indexFor("tipo");
  const textIndex = indexFor("domanda", "testo_domanda");
  const subtitleIndex = indexFor("sottotitolo", "subtitle");
  const timeIndex = indexFor("tempo_secondi", "tempo", "secondi");
  const pointsIndex = indexFor("punti", "points");
  const correctIndex = indexFor("corretta", "risposta_corretta");
  const imageIndex = indexFor("immagine_url", "image_url", "immagine");
  const imageAltIndex = indexFor("alt_immagine", "image_alt");
  const imageCreditIndex = indexFor("credito_immagine", "image_credit");
  const imageCreditUrlIndex = indexFor("link_fotografo", "credito_url", "image_credit_url");
  const imagePageUrlIndex = indexFor("link_foto", "pagina_immagine", "image_page_url");
  const videoIndex = indexFor("video_url", "video");
  const answerIndexes = ["risposta_a", "risposta_b", "risposta_c", "risposta_d", "risposta_e", "risposta_f"].map((name) => indexFor(name));
  const answerImageIndexes = [
    ["immagine_risposta_a", "image_answer_a", "answer_image_a"],
    ["immagine_risposta_b", "image_answer_b", "answer_image_b"],
    ["immagine_risposta_c", "image_answer_c", "answer_image_c"],
    ["immagine_risposta_d", "image_answer_d", "answer_image_d"],
    ["immagine_risposta_e", "image_answer_e", "answer_image_e"],
    ["immagine_risposta_f", "image_answer_f", "answer_image_f"]
  ].map((names) => indexFor(...names));

  const questions = rows.slice(headerIndex + 1).map((row, index) => {
    const text = String(row[textIndex] || "").trim();
    if (!text) return null;
    const type = normalizeQuestionType(row[typeIndex]);
    const answers = answerIndexes
      .map((answerIndex) => answerIndex >= 0 ? String(row[answerIndex] || "").trim() : "")
      .filter(Boolean);
    const normalizedAnswers = type === "true_false" ? ["Vero", "Falso"] : answers;
    const answerImages = type === "true_false"
      ? []
      : answerImageIndexes
        .map((answerImageIndex) => answerImageIndex >= 0 ? String(row[answerImageIndex] || "").trim() : "")
        .slice(0, normalizedAnswers.length);
    return {
      type,
      text,
      subtitle: subtitleIndex >= 0 ? row[subtitleIndex] || "" : "",
      imageUrl: row[imageIndex] || "",
      imageAlt: row[imageAltIndex] || "",
      imageCredit: row[imageCreditIndex] || "",
      imageCreditUrl: row[imageCreditUrlIndex] || "",
      imagePageUrl: row[imagePageUrlIndex] || "",
      imageProvider: row[imageCreditIndex] ? "Pexels" : "",
      videoUrl: row[videoIndex] || "",
      answers: normalizedAnswers,
      answerImages,
      correctIndexes: type === "slide" ? [] : parseCorrectIndexes(row[correctIndex], normalizedAnswers, type),
      points: pointsIndex >= 0 ? Number(row[pointsIndex]) || 0 : 0,
      timeLimit: Number(row[timeIndex]) || 20
    };
  }).filter(Boolean);

  return normalizeQuiz({
    title,
    description: descriptionRow && descriptionRow[1],
    subject: subjectRow && subjectRow[1],
    level: levelRow && levelRow[1],
    language: languageRow && languageRow[1],
    folder: folderRow && folderRow[1],
    visibility: visibilityRow && visibilityRow[1],
    tags: tagsRow && tagsRow[1],
    teamMode: yesValue(teamModeRow && teamModeRow[1]),
    questions
  });
}

function questionTypeForWorkbook(type) {
  if (type === "slide") return "slide";
  if (type === "true_false") return "vero_falso";
  if (type === "speed") return "veloce";
  if (type === "multiple_select") return "risposte_multiple";
  return "multipla";
}

function parseCorrectIndex(value, answers) {
  return parseCorrectIndexes(value, answers, "multiple")[0] || 0;
}

function parseCorrectIndexes(value, answers, type) {
  const parts = String(value || "")
    .split(/[,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const values = parts.length ? parts : [value];
  const indexes = values
    .map((item) => parseOneCorrectIndex(item, answers))
    .filter((index) => index >= 0);
  if (type === "multiple_select") {
    return normalizeCorrectIndexes({ correctIndexes: indexes }, answers, type);
  }
  return [indexes[0] >= 0 ? indexes[0] : 0];
}

function parseOneCorrectIndex(value, answers) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const index = Math.round(value) - 1;
    return index >= 0 && index < answers.length ? index : 0;
  }

  const raw = String(value || "").trim();
  const upper = raw.toUpperCase();
  const letterIndex = answerLetters.indexOf(upper);
  if (letterIndex >= 0 && letterIndex < answers.length) return letterIndex;
  const numericIndex = Number.parseInt(raw, 10) - 1;
  if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < answers.length) return numericIndex;
  const answerIndex = answers.findIndex((answer) => normalizeCell(answer) === normalizeCell(raw));
  return answerIndex >= 0 ? answerIndex : -1;
}

function normalizeCell(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/-/g, "_");
}

function yesValue(value) {
  const key = normalizeCell(value);
  return key === "si" || key === "sì" || key === "yes" || key === "true" || key === "1";
}

function sendWorkbook(res, workbook, filename) {
  const buffer = XLSX.write(workbook, { bookType: "xlsx", type: "buffer" });
  res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("content-disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

function safeWorkbookName(title) {
  const slug = String(title || "quizlive")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "quizlive";
  return `${slug}.xlsx`;
}

function templateQuiz() {
  return {
    title: "QuizLive modello",
    description: "Modello compilabile per importare domande in QuizLive.",
    subject: "Materia",
    level: "Classe o livello",
    language: "Italiano",
    folder: "Esempi",
    visibility: "private",
    tags: ["modello", "ripasso"],
    teamMode: false,
    questions: [
      {
        type: "multiple",
        text: "Quale formato usiamo per importare un quiz?",
        answers: ["XLSX", "MP3", "PNG", "ZIP vuoto"],
        correctIndex: 0,
        timeLimit: 20
      },
      {
        type: "true_false",
        text: "I telefoni entrano con codice stanza e nickname.",
        answers: ["Vero", "Falso"],
        correctIndex: 0,
        timeLimit: 15
      },
      {
        type: "speed",
        text: "Quale risposta premia di piu la rapidita?",
        answers: ["Veloce", "Archivio", "Monitor", "Logo"],
        correctIndex: 0,
        timeLimit: 10
      },
      {
        type: "multiple_select",
        text: "Quali elementi possono vedere il pubblico sul monitor?",
        answers: ["Domanda", "Classifica", "Password host", "QR lobby"],
        correctIndexes: [0, 1, 3],
        timeLimit: 18
      }
    ]
  };
}

async function ensureArchiveReady() {
  await archiveReady;
  if (archiveInitError) throw archiveInitError;
}

function createPgPool(databaseUrl) {
  if (!databaseUrl) return null;
  return new Pool({
    connectionString: databaseUrl,
    ssl: postgresSslConfig(databaseUrl)
  });
}

function postgresSslConfig(databaseUrl) {
  try {
    const hostname = new URL(databaseUrl).hostname;
    if (hostname === "localhost" || hostname === "127.0.0.1") return false;
  } catch (error) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: false };
}

async function initPostgresArchive() {
  await pgPool.query(`
    create table if not exists quizlive_quizzes (
      id text primary key,
      title text not null,
      question_count integer not null,
      created_at timestamptz not null,
      updated_at timestamptz not null,
      quiz jsonb not null
    )
  `);
  await pgPool.query(`
    create table if not exists quizlive_results (
      id text primary key,
      code text not null,
      title text not null,
      created_at timestamptz not null,
      ended_at timestamptz not null,
      result jsonb not null
    )
  `);
  await pgPool.query(`
    create table if not exists quizlive_media (
      id text primary key,
      mime text not null,
      data text not null,
      size integer not null,
      created_at timestamptz not null
    )
  `);
  await pgPool.query("create index if not exists quizlive_quizzes_updated_at_idx on quizlive_quizzes (updated_at desc)");
  await pgPool.query("create index if not exists quizlive_results_ended_at_idx on quizlive_results (ended_at desc)");
  await pgPool.query("create index if not exists quizlive_media_created_at_idx on quizlive_media (created_at desc)");
}

async function listQuizzesFromPostgres() {
  const response = await pgPool.query(`
    select id, title, question_count, created_at, updated_at, quiz
    from quizlive_quizzes
    order by updated_at desc
    limit 100
  `);
  return response.rows.map((row) => ({
    id: row.id,
    title: row.title,
    questionCount: row.question_count,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    folder: row.quiz && row.quiz.folder || "",
    visibility: row.quiz && row.quiz.visibility || "private",
    quiz: row.quiz
  }));
}

async function saveQuizToPostgres(id, quiz) {
  const now = new Date();
  const response = await pgPool.query(`
    insert into quizlive_quizzes (id, title, question_count, created_at, updated_at, quiz)
    values ($1, $2, $3, $4, $4, $5::jsonb)
    on conflict (id) do update set
      title = excluded.title,
      question_count = excluded.question_count,
      updated_at = excluded.updated_at,
      quiz = excluded.quiz
    returning id, title, question_count, created_at, updated_at, quiz
  `, [id, quiz.title, quiz.questions.length, now, JSON.stringify(quiz)]);
  const row = response.rows[0];
  return {
    id: row.id,
    title: row.title,
    questionCount: row.question_count,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    quiz: row.quiz
  };
}

async function deleteQuizFromPostgres(id) {
  const response = await pgPool.query("delete from quizlive_quizzes where id = $1", [id]);
  return response.rowCount > 0;
}

async function saveMediaToPostgres(media) {
  await pgPool.query(`
    insert into quizlive_media (id, mime, data, size, created_at)
    values ($1, $2, $3, $4, $5)
    on conflict (id) do update set
      mime = excluded.mime,
      data = excluded.data,
      size = excluded.size,
      created_at = excluded.created_at
  `, [media.id, media.mime, media.data, media.size, media.createdAt]);
  return media;
}

async function findMediaFromPostgres(id) {
  const response = await pgPool.query("select id, mime, data, size, created_at from quizlive_media where id = $1", [id]);
  if (!response.rows[0]) return null;
  const row = response.rows[0];
  return {
    id: row.id,
    mime: row.mime,
    data: row.data,
    size: row.size,
    createdAt: isoDate(row.created_at)
  };
}

async function listResultsFromPostgres() {
  const response = await pgPool.query(`
    select result
    from quizlive_results
    order by ended_at desc
    limit 200
  `);
  return response.rows.map((row) => resultSummary(row.result));
}

async function saveResultToPostgres(result) {
  await pgPool.query(`
    insert into quizlive_results (id, code, title, created_at, ended_at, result)
    values ($1, $2, $3, $4, $5, $6::jsonb)
    on conflict (id) do update set
      code = excluded.code,
      title = excluded.title,
      created_at = excluded.created_at,
      ended_at = excluded.ended_at,
      result = excluded.result
  `, [
    result.id,
    result.code,
    result.title,
    result.createdAt,
    result.endedAt,
    JSON.stringify(result)
  ]);
  return result;
}

async function findResultFromPostgres(id) {
  const response = await pgPool.query("select result from quizlive_results where id = $1", [id]);
  return response.rows[0] ? response.rows[0].result : null;
}

async function deleteResultFromPostgres(id) {
  const response = await pgPool.query("delete from quizlive_results where id = $1", [id]);
  return response.rowCount > 0;
}

function resultSummary(result) {
  const leaderboardItems = Array.isArray(result.leaderboard) ? result.leaderboard : [];
  return {
    id: result.id,
    code: result.code,
    title: result.title,
    endedAt: result.endedAt,
    playerCount: leaderboardItems.length,
    winner: leaderboardItems[0] || null
  };
}

function isoDate(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || "");
}

function isArchiveFailure(error) {
  return Boolean(pgPool && (error === archiveInitError || error.code || error.severity));
}

function sendArchiveError(res, error) {
  console.error("Archive error:", error.message);
  res.status(500).json({ ok: false, error: "Archivio non disponibile" });
}

function requireHostHttp(req, res, next) {
  if (isHostHttpAuthorized(req)) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: "Password host richiesta" });
}

function isHostAuthEnabled() {
  return HOST_PASSWORD.length > 0;
}

function isHostHttpAuthorized(req) {
  if (!isHostAuthEnabled()) return true;
  return isValidHostSession(getCookie(req, HOST_SESSION_COOKIE));
}

function isHostSocketAuthorized(socket) {
  if (!isHostAuthEnabled()) return true;
  return isValidHostSession(getCookieFromHeader(socket.handshake.headers.cookie, HOST_SESSION_COOKIE));
}

function passwordsMatch(input) {
  const actual = String(input || "");
  const expectedBuffer = Buffer.from(HOST_PASSWORD);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function createHostSession() {
  cleanupHostSessions();
  const token = crypto.randomBytes(32).toString("base64url");
  hostSessions.set(token, Date.now() + HOST_SESSION_TTL_MS);
  return token;
}

function isValidHostSession(token) {
  if (!token) return false;
  const expiresAt = hostSessions.get(token);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    hostSessions.delete(token);
    return false;
  }
  hostSessions.set(token, Date.now() + HOST_SESSION_TTL_MS);
  return true;
}

function cleanupHostSessions() {
  const now = Date.now();
  for (const [token, expiresAt] of hostSessions) {
    if (expiresAt <= now) hostSessions.delete(token);
  }
}

function setHostSessionCookie(req, res, token) {
  const attributes = [
    `${HOST_SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(HOST_SESSION_TTL_MS / 1000)}`
  ];
  if (isSecureRequest(req)) attributes.push("Secure");
  res.setHeader("set-cookie", attributes.join("; "));
}

function clearHostSessionCookie(req, res) {
  const attributes = [
    `${HOST_SESSION_COOKIE}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (isSecureRequest(req)) attributes.push("Secure");
  res.setHeader("set-cookie", attributes.join("; "));
}

function getCookie(req, name) {
  return getCookieFromHeader(req.headers.cookie, name);
}

function getCookieFromHeader(header, name) {
  const cookies = String(header || "").split(";");
  for (const cookie of cookies) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (rawName === name) return rawValue.join("=");
  }
  return "";
}

function isSecureRequest(req) {
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  return forwardedProto === "https" || req.secure;
}

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf8");
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`Could not load store from ${STORE_FILE}:`, error.message);
    }
    return normalizeStore(null);
  }
}

function persistStore() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tempFile = `${STORE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tempFile, JSON.stringify(store, null, 2));
    fs.renameSync(tempFile, STORE_FILE);
  } catch (error) {
    console.error(`Could not persist store to ${STORE_FILE}:`, error.message);
  }
}

function normalizeStore(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    version: 1,
    quizzes: Array.isArray(source.quizzes) ? source.quizzes.filter(isStoredQuiz).slice(0, 100) : [],
    results: Array.isArray(source.results) ? source.results.filter(isStoredResult).slice(0, 200) : [],
    media: Array.isArray(source.media) ? source.media.filter(isStoredMedia).slice(0, 300) : []
  };
}

function isStoredQuiz(item) {
  return item &&
    typeof item.id === "string" &&
    item.quiz &&
    Array.isArray(item.quiz.questions);
}

function isStoredResult(item) {
  return item &&
    typeof item.id === "string" &&
    typeof item.code === "string" &&
    Array.isArray(item.questions) &&
    Array.isArray(item.leaderboard);
}

function isStoredMedia(item) {
  return item &&
    typeof item.id === "string" &&
    /^image\/(?:png|jpeg|webp|gif)$/.test(item.mime || "") &&
    typeof item.data === "string";
}

function createArchiveId(prefix) {
  const stamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${random}`;
}

function normalizeArchiveId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

function csvCell(value) {
  const text = String(value == null ? "" : value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function getHostRoom(socket) {
  const code = socket.data.role === "host" && socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function getPlayerRoom(socket) {
  const code = socket.data.role === "player" && socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function normalizeQuiz(input) {
  const source = input && typeof input === "object" ? input : defaultQuiz();
  const title = String(source.title || "QuizLive").trim().slice(0, 80) || "QuizLive";
  const description = normalizeShortText(source.description, 220);
  const subject = normalizeShortText(source.subject, 40);
  const level = normalizeShortText(source.level, 40);
  const language = normalizeShortText(source.language || "Italiano", 32) || "Italiano";
  const folder = normalizeShortText(source.folder, 40);
  const visibility = normalizeQuizVisibility(source.visibility);
  const tags = normalizeTags(source.tags);
  const teamMode = Boolean(source.teamMode);
  const questions = Array.isArray(source.questions) ? source.questions : [];
  const normalizedQuestions = questions.slice(0, 50).map((item, index) => normalizeQuestion(item, index));

  if (!normalizedQuestions.length) {
    throw new Error("Il quiz deve avere almeno una domanda");
  }

  return { title, description, subject, level, language, folder, visibility, tags, teamMode, questions: normalizedQuestions };
}

function normalizeQuestion(item, index) {
  const type = normalizeQuestionType(item && item.type);
  const text = String(item && item.text ? item.text : `Domanda ${index + 1}`).trim().slice(0, 240);
  const subtitle = normalizeShortText(item && item.subtitle, 220);
  const answers = Array.isArray(item && item.answers) ? item.answers : [];
  let normalizedAnswers = type === "slide" ? [] : answers
    .map((answer) => String(answer || "").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 6);

  if (type === "true_false") {
    normalizedAnswers = ["Vero", "Falso"];
  }

  if (type !== "slide" && normalizedAnswers.length < 2) {
    throw new Error(`La domanda ${index + 1} deve avere almeno due risposte`);
  }

  const normalizedCorrectIndexes = type === "slide" ? [] : normalizeCorrectIndexes(item, normalizedAnswers, type);
  const correctIndex = normalizedCorrectIndexes[0] || 0;
  const rawTime = Number(item && item.timeLimit);
  const timeLimit = Number.isFinite(rawTime) ? Math.min(90, Math.max(5, Math.round(rawTime))) : 20;
  const points = type === "slide" ? 0 : normalizeQuestionPoints(item && item.points);

  return {
    type,
    text,
    subtitle,
    imageUrl: normalizeImageUrl(item && item.imageUrl),
    imageAlt: normalizeShortText(item && item.imageAlt, 160),
    imageCredit: normalizeShortText(item && item.imageCredit, 80),
    imageCreditUrl: normalizeMediaUrl(item && item.imageCreditUrl),
    imageProvider: normalizeShortText(item && item.imageProvider, 32),
    imagePageUrl: normalizeMediaUrl(item && item.imagePageUrl),
    videoUrl: type === "slide" ? "" : normalizeMediaUrl(item && item.videoUrl),
    answers: normalizedAnswers,
    answerImages: type === "true_false" || type === "slide" ? [] : normalizedAnswerImages(item, normalizedAnswers.length),
    answerImageLayouts: type === "true_false" || type === "slide" ? [] : normalizedAnswerImageLayouts(item, normalizedAnswers.length),
    correctIndex,
    correctIndexes: normalizedCorrectIndexes,
    points,
    timeLimit
  };
}

function normalizeShortText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeSecretToken(value) {
  let token = String(value || "").trim();
  if ((token.startsWith("\"") && token.endsWith("\"")) || (token.startsWith("'") && token.endsWith("'"))) {
    token = token.slice(1, -1).trim();
  }
  return token.replace(/^Bearer\s+/i, "").trim();
}

function validateSecretToken(token, name) {
  if (/\s/.test(String(token || "")) || /[\u0000-\u001F\u007F]/.test(String(token || ""))) {
    throw new Error(`${name} contiene spazi, a capo o caratteri invisibili: su Render incolla solo il token pulito`);
  }
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,;]+/);
  return Array.from(new Set(raw
    .map((tag) => normalizeShortText(tag, 24))
    .filter(Boolean)))
    .slice(0, 8);
}

function normalizeQuizVisibility(value) {
  const key = normalizeCell(value || "private");
  return key === "pubblica" || key === "public" ? "public" : "private";
}

function buildImageSearchQuery(payload) {
  const requested = normalizeShortText(payload && payload.query, 80);
  if (requested) return requested;

  const quiz = payload && payload.quiz && typeof payload.quiz === "object" ? payload.quiz : {};
  const question = payload && payload.question && typeof payload.question === "object" ? payload.question : {};
  const subjectWords = imageSearchKeywords(quiz.subject).slice(0, 3);
  const questionWords = imageSearchKeywords([
    question.text,
    correctAnswerTextForSearch(question)
  ].filter(Boolean).join(" ")).slice(0, 7);
  const queryWords = Array.from(new Set([...subjectWords, ...questionWords]));
  return queryWords.length ? queryWords.join(" ") : "education classroom";
}

function buildAiImagePrompt(payload) {
  const quiz = payload && payload.quiz && typeof payload.quiz === "object" ? payload.quiz : {};
  const question = payload && payload.question && typeof payload.question === "object" ? payload.question : {};
  const subject = normalizeShortText(quiz.subject, 80) || "materia scolastica";
  const level = normalizeShortText(quiz.level, 80) || "studenti";
  const language = normalizeShortText(quiz.language, 40) || "Italiano";
  const questionText = normalizeShortText(question.text, 320) || "domanda didattica";
  const answerText = normalizeShortText(payload && payload.answerText, 180);
  if (answerText) {
    return [
      "Crea una immagine didattica orizzontale per una singola opzione di risposta di QuizLive.",
      `Soggetto principale e unico dell'immagine: ${answerText}.`,
      `Materia: ${subject}.`,
      `Livello: ${level}.`,
      `Lingua del contesto: ${language}.`,
      `Domanda solo come contesto, non come soggetto: ${questionText}.`,
      `Opzione del tasto da rappresentare: ${answerText}.`,
      "Rappresenta il soggetto della risposta, non la domanda intera e non la risposta corretta se e diversa.",
      "Non aggiungere simboli di vero/falso, spunte, croci o indizi sul fatto che l'opzione sia corretta.",
      "Stile: chiaro, moderno, adatto a studenti, leggibile su telefono e monitor condiviso.",
      "Evita testo leggibile, watermark, loghi, brand e persone riconoscibili non necessarie."
    ].join(" ");
  }
  const correctText = normalizeShortText(correctAnswerTextForSearch(question), 180);
  const concept = correctText || normalizeShortText(buildImageSearchQuery(payload), 160) || questionText;
  return [
    "Crea una immagine didattica orizzontale per una domanda di QuizLive.",
    `Materia: ${subject}.`,
    `Livello: ${level}.`,
    `Lingua del contesto: ${language}.`,
    `Domanda: ${questionText}.`,
    `Concetto o risposta corretta da rappresentare: ${concept}.`,
    "Stile: chiaro, moderno, adatto a studenti, utile su un monitor condiviso.",
    "Evita testo leggibile, watermark, loghi, brand e persone riconoscibili non necessarie."
  ].join(" ");
}

function imageGenerationProviderInfo(provider) {
  if (provider === "openai") {
    return {
      provider: "openai",
      providerLabel: "OpenAI",
      model: OPENAI_IMAGE_MODEL,
      size: OPENAI_IMAGE_SIZE,
      quality: OPENAI_IMAGE_QUALITY,
      outputFormat: OPENAI_IMAGE_FORMAT
    };
  }

  return {
    provider: "cloudflare",
    providerLabel: "Cloudflare Workers AI",
    model: CLOUDFLARE_IMAGE_MODEL,
    steps: CLOUDFLARE_IMAGE_STEPS,
    outputFormat: "jpeg"
  };
}

async function generateCloudflareImage(prompt) {
  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error("Configura CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_API_TOKEN su Render per generare immagini gratis con Cloudflare Workers AI");
  }
  validateSecretToken(CLOUDFLARE_API_TOKEN, "CLOUDFLARE_API_TOKEN");

  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`
    },
    body: JSON.stringify({
      prompt,
      steps: CLOUDFLARE_IMAGE_STEPS,
      seed: Math.floor(Math.random() * 2147483647)
    })
  });

  const contentType = response.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("image/")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error("Generazione Cloudflare non disponibile");
    return mediaFromImageBuffer(buffer, contentType);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = cloudflareErrorMessage(data) || "Generazione Cloudflare non disponibile";
    throw new Error(message);
  }

  const base64 = data && data.result && data.result.image || data && data.image;
  if (!base64) throw new Error("Cloudflare non ha restituito un'immagine");
  return mediaFromImageBase64(base64, "image/jpeg");
}

function cloudflareErrorMessage(data) {
  const errors = data && Array.isArray(data.errors) ? data.errors : [];
  const firstError = errors.find(Boolean);
  if (firstError && firstError.message) return String(firstError.message);
  if (data && data.error) return String(data.error);
  return "";
}

async function generateOpenAIImage(prompt) {
  if (!OPENAI_API_KEY) {
    throw new Error("Aggiungi OPENAI_API_KEY su Render per generare immagini con OpenAI");
  }
  validateSecretToken(OPENAI_API_KEY, "OPENAI_API_KEY");

  const body = {
    model: OPENAI_IMAGE_MODEL,
    prompt,
    size: OPENAI_IMAGE_SIZE,
    quality: OPENAI_IMAGE_QUALITY,
    output_format: OPENAI_IMAGE_FORMAT
  };

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data && data.error && data.error.message
      ? String(data.error.message)
      : "Generazione immagine non disponibile";
    throw new Error(message);
  }

  const item = data && Array.isArray(data.data) ? data.data[0] : null;
  if (item && item.b64_json) return mediaFromImageBase64(item.b64_json, imageMimeFromOpenAIFormat(OPENAI_IMAGE_FORMAT));
  if (item && item.url) return mediaFromImageUrl(item.url);
  throw new Error("OpenAI non ha restituito un'immagine");
}

async function mediaFromImageUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Download immagine generata non riuscito");
  const mime = normalizeGeneratedImageMime(response.headers.get("content-type"));
  const buffer = Buffer.from(await response.arrayBuffer());
  return mediaFromImageBuffer(buffer, mime);
}

function mediaFromImageBase64(base64, mime) {
  return mediaFromImageBuffer(Buffer.from(String(base64 || ""), "base64"), mime);
}

function mediaFromImageBuffer(buffer, mime) {
  if (!buffer.length) throw new Error("Immagine generata vuota");
  return {
    mime: normalizeGeneratedImageMime(mime),
    data: buffer.toString("base64"),
    size: buffer.length
  };
}

function normalizeGeneratedImageMime(value) {
  const mime = String(value || "").split(";")[0].trim().toLowerCase();
  return /^image\/(?:png|jpeg|webp)$/.test(mime) ? mime : "image/png";
}

function normalizeOpenAIImageFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  return ["png", "jpeg", "webp"].includes(format) ? format : "jpeg";
}

function normalizeImageGenerationProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return provider === "openai" ? "openai" : "cloudflare";
}

function normalizeCloudflareAccountId(value) {
  const accountId = String(value || "").trim();
  return /^[a-f0-9]{32}$/i.test(accountId) ? accountId : "";
}

function normalizeCloudflareImageModel(value) {
  const model = String(value || "").trim();
  return /^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model)
    ? model
    : "@cf/black-forest-labs/flux-1-schnell";
}

function imageMimeFromOpenAIFormat(value) {
  const format = String(value || "").trim().toLowerCase();
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

function correctAnswerTextForSearch(question) {
  const answers = Array.isArray(question && question.answers) ? question.answers : [];
  const indexes = Array.isArray(question && question.correctIndexes) && question.correctIndexes.length
    ? question.correctIndexes
    : [question && question.correctIndex];
  return uniqueAnswerIndexes(indexes)
    .map((index) => answers[index])
    .filter(Boolean)
    .join(" ");
}

function imageSearchKeywords(text) {
  const stopwords = new Set([
    "che", "chi", "cosa", "come", "dove", "quando", "quale", "quali", "quanto", "perche", "perché",
    "sono", "essere", "vero", "falso", "risposta", "risposte", "corretta", "corrette", "sbagliata",
    "scegli", "seleziona", "indica", "trova", "domanda", "quiz", "live", "classe", "livello",
    "the", "and", "for", "with", "what", "which", "where", "when", "answer", "correct"
  ]);
  return Array.from(new Set(String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !stopwords.has(word))))
    .slice(0, 12);
}

function pexelsPhotoToImage(photo) {
  if (!photo || !photo.src) return null;
  const imageUrl = photo.src.large || photo.src.landscape || photo.src.medium || photo.src.original || "";
  const thumbUrl = photo.src.tiny || photo.src.small || imageUrl;
  if (!imageUrl || !thumbUrl) return null;
  return {
    id: String(photo.id || ""),
    provider: "Pexels",
    imageUrl,
    thumbUrl,
    alt: normalizeShortText(photo.alt, 160),
    avgColor: normalizeShortText(photo.avg_color, 16),
    pageUrl: normalizeMediaUrl(photo.url),
    photographer: normalizeShortText(photo.photographer, 80),
    photographerUrl: normalizeMediaUrl(photo.photographer_url)
  };
}

function parseImageDataUrl(value) {
  const raw = String(value || "");
  const match = raw.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=\s]+)$/);
  if (!match) throw new Error("Carica un'immagine PNG, JPG, WebP o GIF");
  const data = match[2].replace(/\s/g, "");
  const buffer = Buffer.from(data, "base64");
  if (!buffer.length) throw new Error("Immagine vuota");
  if (buffer.length > MAX_MEDIA_BYTES) throw new Error("Immagine troppo grande: massimo 1.5 MB");
  return {
    mime: match[1],
    data: buffer.toString("base64"),
    size: buffer.length
  };
}

function normalizeImageUrl(value) {
  const raw = normalizeShortText(value, 500);
  if (!raw) return "";
  if (/^\/api\/media\/[a-zA-Z0-9_-]{8,80}$/.test(raw)) return raw;
  return normalizeMediaUrl(raw);
}

function normalizeMediaUrl(value) {
  const raw = normalizeShortText(value, 500);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function normalizeCorrectIndexes(item, answers, type) {
  if (type === "slide") return [];
  const source = Array.isArray(item && item.correctIndexes) && item.correctIndexes.length
    ? item.correctIndexes
    : [item && item.correctIndex];
  let indexes = uniqueAnswerIndexes(source).filter((index) => index >= 0 && index < answers.length);
  if (!indexes.length) indexes = [0];
  if (type === "multiple_select" && indexes.length < 2 && answers.length >= 2) {
    const fallback = answers.findIndex((_answer, index) => !indexes.includes(index));
    indexes = Array.from(new Set([...indexes, fallback >= 0 ? fallback : 0])).sort((a, b) => a - b);
  }
  return type === "multiple_select" ? indexes : [indexes[0]];
}

function normalizeQuestionPoints(value) {
  const points = Math.round(Number(value) || 0);
  return [0, 250, 500, 750, 1000, 1500].includes(points) ? points : 0;
}

function normalizeQuestionType(value) {
  const key = String(value || "multiple")
    .trim()
    .toLowerCase()
    .replace(/[\/\s]+/g, "_")
    .replace(/-/g, "_");
  return QUESTION_TYPE_ALIASES[key] || "multiple";
}

function normalizeNickname(value) {
  const nickname = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  return nickname || `Player ${Math.floor(100 + Math.random() * 900)}`;
}

function normalizeAvatarDataUrl(value) {
  const dataUrl = String(value || "").trim();
  if (!dataUrl) return "";
  if (dataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) return "";
  return /^data:image\/(png|jpe?g|webp);base64,[a-z0-9+/=]+$/i.test(dataUrl) ? dataUrl : "";
}

function normalizeCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 6);
}

function createPlayerSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

function normalizePlayerSessionToken(value) {
  const token = String(value || "").trim();
  return /^[a-f0-9]{48}$/i.test(token) ? token.toLowerCase() : "";
}

function normalizeQrUrl(value) {
  const url = String(value || "").trim();
  if (url.length < 8 || url.length > 500) return "";
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return "";
  return url;
}

function normalizePublicBaseUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  if (!url) return "";
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return "";
  return url;
}

function requestOrigin(req) {
  const forwardedHost = String(req.get("x-forwarded-host") || "").split(",")[0].trim();
  const host = forwardedHost || req.get("host");
  if (!host) return "";
  const forwardedProto = String(req.get("x-forwarded-proto") || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  return `${proto}://${host}`;
}

function localNetworkOrigins() {
  const origins = [];
  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      if (address.address.startsWith("169.254.")) continue;
      origins.push({
        name,
        address: address.address,
        origin: `http://${address.address}:${PORT}`,
        private: isPrivateIPv4(address.address)
      });
    }
  }

  return origins.sort((a, b) => {
    if (a.private !== b.private) return a.private ? -1 : 1;
    return a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  });
}

function preferredPlayerOrigin(currentOrigin, localOrigins, publicOrigin) {
  if (publicOrigin) return publicOrigin;
  if (isLoopbackOrigin(currentOrigin) && localOrigins.length) {
    return localOrigins[0].origin;
  }
  return currentOrigin || (localOrigins[0] && localOrigins[0].origin) || "";
}

function playerAccessMode(currentOrigin, preferredOrigin, publicOrigin) {
  if (publicOrigin) return "public";
  if (preferredOrigin && !isLoopbackOrigin(preferredOrigin) && !isPrivateOrigin(preferredOrigin)) {
    return "public";
  }
  if (isLoopbackOrigin(currentOrigin) || isPrivateOrigin(preferredOrigin) || isPrivateOrigin(currentOrigin)) {
    return "local";
  }
  return "unknown";
}

function isLoopbackOrigin(origin) {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch (error) {
    return false;
  }
}

function isPrivateOrigin(origin) {
  try {
    const hostname = new URL(origin).hostname;
    return isPrivateIPv4(hostname) || hostname.endsWith(".local");
  } catch (error) {
    return false;
  }
}

function isPrivateIPv4(address) {
  return /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function createRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) return code;
  }
  throw new Error("Impossibile creare un codice stanza");
}

function roomChannel(code) {
  return `room:${code}`;
}

function waitingScreenChannel() {
  return "screen:waiting";
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

function sendAck(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function defaultQuiz() {
  return {
    title: "Demo QuizLive",
    description: "Quiz dimostrativo per provare host, telefoni e monitor pubblico.",
    subject: "Tecnologia",
    level: "Demo",
    language: "Italiano",
    folder: "Demo",
    visibility: "private",
    tags: ["demo", "live"],
    teamMode: false,
    questions: [
      {
        type: "multiple",
        text: "Quale tecnologia permette risposte live tra host e telefoni?",
        answers: ["WebSocket", "Solo email", "PDF", "Bluetooth spento"],
        correctIndex: 0,
        timeLimit: 20
      },
      {
        type: "speed",
        text: "Quale formato e comodo per esportare risultati in un foglio di calcolo?",
        answers: ["XLSX", "PNG", "MP3", "MOV"],
        correctIndex: 0,
        timeLimit: 12
      },
      {
        type: "true_false",
        text: "I giocatori entrano con codice stanza e nickname.",
        answers: ["Vero", "Falso"],
        correctIndex: 0,
        timeLimit: 15
      },
      {
        type: "multiple_select",
        text: "Quali schermate sono pensate per il pubblico?",
        answers: ["Monitor", "Classifica", "Password host", "Domanda live"],
        correctIndexes: [0, 1, 3],
        timeLimit: 18
      }
    ]
  };
}
