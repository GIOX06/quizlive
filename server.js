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
const PEXELS_API_KEY = String(process.env.PEXELS_API_KEY || "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const STORE_FILE = path.join(DATA_DIR, "quizlive-store.json");
const HOST_SESSION_COOKIE = "quizlive_host";
const HOST_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 1.5 * 1024 * 1024;
const QUESTION_TYPE_LABELS = {
  multiple: "Multipla",
  true_false: "Vero/Falso",
  speed: "Veloce",
  multiple_select: "Risposte multiple"
};
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
  fast: "speed"
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
      socket.data.role = "host";
      socket.data.roomCode = room.code;
      socket.join(roomChannel(room.code));
      await attachWaitingScreens(room);
      sendAck(ack, { ok: true, code: room.code });
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
    if (existingPlayer) {
      reattachPlayerSocket(room, existingPlayer, socket, nickname);
      sendAck(ack, { ok: true, code, playerId: existingPlayer.id, sessionToken: existingPlayer.sessionToken, rejoined: true });
      emitRoom(room);
      return;
    }

    const playerSessionToken = createPlayerSessionToken();
    const player = {
      id: socket.id,
      sessionToken: playerSessionToken,
      nickname,
      team: room.quiz.teamMode ? assignTeam(room) : "",
      score: 0,
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
      if (player) player.connected = false;
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
    timer: null,
    resultId: null,
    createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function startQuestion(room, index) {
  clearRoomTimer(room);
  removeInactivePlayers(room, "Invito scaduto");
  room.status = "question";
  room.currentIndex = index;
  room.questionStartedAt = Date.now();
  room.questionEndsAt = room.questionStartedAt + room.quiz.questions[index].timeLimit * 1000;
  room.answers.set(index, new Map());
  room.timer = setTimeout(() => revealQuestion(room), room.quiz.questions[index].timeLimit * 1000 + 250);
  emitRoom(room);
}

function revealQuestion(room) {
  if (!room || room.status !== "question") return;
  clearRoomTimer(room);
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

function removeInactivePlayers(room, message) {
  for (const player of Array.from(room.players.values())) {
    if (!player.active) removePlayer(room, player.id, message);
  }
}

function removePlayer(room, playerId, message) {
  room.players.delete(playerId);
  const target = io.sockets.sockets.get(playerId);
  if (!target) return;
  if (message) target.emit("player:removed", { message, code: room.code });
  target.leave(roomChannel(room.code));
  target.data.role = null;
  target.data.roomCode = null;
  target.data.playerId = null;
}

async function attachWaitingScreens(room) {
  const screens = await io.in(waitingScreenChannel()).fetchSockets();
  const matchingScreens = screens.filter((target) => {
    return !target.data.followRoomCode || target.data.followRoomCode === room.code;
  });
  await Promise.all(matchingScreens.map((target) => attachScreenToRoom(target, room)));
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

  const answerIndexes = selectedAnswerIndexes(payload, question);
  const requiredSelections = selectionCount(question);
  if (answerIndexes.length !== requiredSelections) {
    return { ok: false, error: `Seleziona ${requiredSelections} risposte` };
  }
  if (answerIndexes.some((answerIndex) => answerIndex < 0 || answerIndex >= question.answers.length)) {
    return { ok: false, error: "Risposta non valida" };
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
  const scoreProfile = questionScoreProfile(question.type);
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

  return { ok: true, correct: isCorrect, partial: isPartial, points };
}

async function emitRoom(room) {
  const sockets = await io.in(roomChannel(room.code)).fetchSockets();
  for (const target of sockets) {
    target.emit("room:state", serializeRoom(room, target));
  }
}

function serializeRoom(room, socket) {
  const role = socket.data.role === "host" ? "host" : socket.data.role === "screen" ? "screen" : "player";
  const question = room.currentIndex >= 0 ? room.quiz.questions[room.currentIndex] : null;
  const answerMap = room.currentIndex >= 0 ? room.answers.get(room.currentIndex) || new Map() : new Map();
  const playerId = socket.data.playerId;
  const playerAnswer = playerId && answerMap.get(playerId);
  const revealMode = room.status === "reveal" || room.status === "ended" || role === "host";
  const answerCountMode = role === "host" || room.status === "reveal" || room.status === "ended";

  return {
    code: room.code,
    role,
    status: room.status,
    title: room.quiz.title,
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
    question: question
      ? {
          type: question.type,
          typeLabel: QUESTION_TYPE_LABELS[question.type] || QUESTION_TYPE_LABELS.multiple,
          text: question.text,
          imageUrl: question.imageUrl,
          imageAlt: question.imageAlt,
          imageCredit: question.imageCredit,
          imageCreditUrl: question.imageCreditUrl,
          imageProvider: question.imageProvider,
          imagePageUrl: question.imagePageUrl,
          videoUrl: question.videoUrl,
          answers: question.answers.map((answer, index) => ({
            text: answer,
            index,
            correct: revealMode ? correctIndexes(question).includes(index) : undefined,
            count: answerCountMode ? countAnswers(answerMap, index) : undefined
          })),
          timeLimit: question.timeLimit,
          correctIndex: revealMode ? question.correctIndex : undefined,
          correctIndexes: revealMode ? correctIndexes(question) : undefined,
          selectionCount: selectionCount(question),
          answered: Boolean(playerAnswer),
          playerAnswer: playerAnswer || null
        }
      : null,
    players: role === "host" ? hostPlayers(room, answerMap) : undefined,
    leaderboard: leaderboard(room).slice(0, 10),
    teamLeaderboard: room.quiz.teamMode ? teamLeaderboard(room) : undefined,
    questionSummaries: role === "host" ? questionSummaries(room) : undefined,
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

function hostPlayers(room, answerMap) {
  return activePlayers(room)
    .map((player) => ({
      ...serializePlayer(player, room),
      answered: answerMap.has(player.id)
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
}

function serializePlayer(player, room) {
  if (!player) return null;
  const board = leaderboard(room);
  return {
    id: player.id,
    nickname: player.nickname,
    team: player.team || "",
    score: player.score,
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
      team: player.team || "",
      score: player.score,
      streak: player.streak,
      connected: player.connected,
      active: player.active
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
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

function selectedAnswerIndexes(payload, question) {
  const raw = question.type === "multiple_select" ? payload.answerIndexes : [payload.answerIndex];
  const source = Array.isArray(raw) ? raw : [raw];
  return uniqueAnswerIndexes(source);
}

function uniqueAnswerIndexes(values) {
  return Array.from(new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value))))
    .sort((a, b) => a - b);
}

function correctIndexes(question) {
  if (Array.isArray(question.correctIndexes) && question.correctIndexes.length) {
    return uniqueAnswerIndexes(question.correctIndexes);
  }
  return uniqueAnswerIndexes([question.correctIndex]);
}

function selectionCount(question) {
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

function questionScoreProfile(type) {
  if (type === "speed") {
    return { base: 250, speedBonus: 1000, streakStep: 30, maxStreakBonus: 150 };
  }
  if (type === "multiple_select") {
    return { base: 700, speedBonus: 450, streakStep: 40, maxStreakBonus: 220 };
  }
  if (type === "true_false") {
    return { base: 450, speedBonus: 450, streakStep: 40, maxStreakBonus: 200 };
  }
  return { base: 500, speedBonus: 500, streakStep: 50, maxStreakBonus: 250 };
}

function resultsToJson(room) {
  return {
    code: room.code,
    title: room.quiz.title,
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
      imageUrl: question.imageUrl,
      imageAlt: question.imageAlt,
      imageCredit: question.imageCredit,
      imageCreditUrl: question.imageCreditUrl,
      imageProvider: question.imageProvider,
      imagePageUrl: question.imagePageUrl,
      videoUrl: question.videoUrl,
      answers: question.answers,
      correctIndex: question.correctIndex,
      correctIndexes: correctIndexes(question),
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
        imageUrl: question.imageUrl,
        imageAlt: question.imageAlt,
        imageCredit: question.imageCredit,
        imageCreditUrl: question.imageCreditUrl,
        imageProvider: question.imageProvider,
        imagePageUrl: question.imagePageUrl,
        videoUrl: question.videoUrl,
        answers: question.answers,
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
    ["Materia", normalizedQuiz.subject],
    ["Livello", normalizedQuiz.level],
    ["Lingua", normalizedQuiz.language],
    ["Cartella", normalizedQuiz.folder],
    ["Visibilita", normalizedQuiz.visibility],
    ["Tag", normalizedQuiz.tags.join(", ")],
    ["Team mode", normalizedQuiz.teamMode ? "si" : "no"],
    [],
    ["Ordine", "Tipo", "Domanda", "Tempo secondi", "Corretta", "Immagine URL", "Alt immagine", "Credito immagine", "Link fotografo", "Link foto", "Video URL", "Risposta A", "Risposta B", "Risposta C", "Risposta D", "Risposta E", "Risposta F"]
  ];

  normalizedQuiz.questions.forEach((question, index) => {
    rows.push([
      index + 1,
      questionTypeForWorkbook(question.type),
      question.text,
      question.timeLimit,
      correctIndexes(question).map((answerIndex) => answerLetters[answerIndex] || "A").join(","),
      question.imageUrl || "",
      question.imageAlt || "",
      question.imageCredit || "",
      question.imageCreditUrl || "",
      question.imagePageUrl || "",
      question.videoUrl || "",
      ...Array.from({ length: 6 }, (_item, answerIndex) => question.answers[answerIndex] || "")
    ]);
  });

  const workbook = XLSX.utils.book_new();
  const quizSheet = XLSX.utils.aoa_to_sheet(rows);
  quizSheet["!cols"] = [
    { wch: 8 },
    { wch: 16 },
    { wch: 44 },
    { wch: 14 },
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
    { wch: 22 }
  ];
  XLSX.utils.book_append_sheet(workbook, quizSheet, "QuizLive");

  const instructions = XLSX.utils.aoa_to_sheet([
    ["Come compilare"],
    ["Titolo", "Scrivi il titolo nella cella B2 del foglio QuizLive."],
    ["Materia/Livello/Lingua/Tag", "Usa questi campi per ordinare la libreria quiz."],
    ["Team mode", "Scrivi si per dividere automaticamente i giocatori in squadre."],
    ["Tipo", "Usa multipla, vero_falso, veloce oppure risposte_multiple."],
    ["Corretta", "Scrivi A, B, C, D, E o F. Per risposte_multiple usa piu lettere, ad esempio A,C."],
    ["Libreria", "Cartella organizza l'archivio. Visibilita accetta privata o pubblica."],
    ["Media", "Immagine URL accetta link http/https o media caricati da QuizLive. Video URL accetta link http/https pubblici."],
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
  const timeIndex = indexFor("tempo_secondi", "tempo", "secondi");
  const correctIndex = indexFor("corretta", "risposta_corretta");
  const imageIndex = indexFor("immagine_url", "image_url", "immagine");
  const imageAltIndex = indexFor("alt_immagine", "image_alt");
  const imageCreditIndex = indexFor("credito_immagine", "image_credit");
  const imageCreditUrlIndex = indexFor("link_fotografo", "credito_url", "image_credit_url");
  const imagePageUrlIndex = indexFor("link_foto", "pagina_immagine", "image_page_url");
  const videoIndex = indexFor("video_url", "video");
  const answerIndexes = ["risposta_a", "risposta_b", "risposta_c", "risposta_d", "risposta_e", "risposta_f"].map((name) => indexFor(name));

  const questions = rows.slice(headerIndex + 1).map((row, index) => {
    const text = String(row[textIndex] || "").trim();
    if (!text) return null;
    const type = normalizeQuestionType(row[typeIndex]);
    const answers = answerIndexes
      .map((answerIndex) => answerIndex >= 0 ? String(row[answerIndex] || "").trim() : "")
      .filter(Boolean);
    const normalizedAnswers = type === "true_false" ? ["Vero", "Falso"] : answers;
    return {
      type,
      text,
      imageUrl: row[imageIndex] || "",
      imageAlt: row[imageAltIndex] || "",
      imageCredit: row[imageCreditIndex] || "",
      imageCreditUrl: row[imageCreditUrlIndex] || "",
      imagePageUrl: row[imagePageUrlIndex] || "",
      imageProvider: row[imageCreditIndex] ? "Pexels" : "",
      videoUrl: row[videoIndex] || "",
      answers: normalizedAnswers,
      correctIndexes: parseCorrectIndexes(row[correctIndex], normalizedAnswers, type),
      timeLimit: Number(row[timeIndex]) || 20
    };
  }).filter(Boolean);

  return normalizeQuiz({
    title,
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

  return { title, subject, level, language, folder, visibility, tags, teamMode, questions: normalizedQuestions };
}

function normalizeQuestion(item, index) {
  const type = normalizeQuestionType(item && item.type);
  const text = String(item && item.text ? item.text : `Domanda ${index + 1}`).trim().slice(0, 240);
  const answers = Array.isArray(item && item.answers) ? item.answers : [];
  let normalizedAnswers = answers
    .map((answer) => String(answer || "").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 6);

  if (type === "true_false") {
    normalizedAnswers = ["Vero", "Falso"];
  }

  if (normalizedAnswers.length < 2) {
    throw new Error(`La domanda ${index + 1} deve avere almeno due risposte`);
  }

  const normalizedCorrectIndexes = normalizeCorrectIndexes(item, normalizedAnswers, type);
  const correctIndex = normalizedCorrectIndexes[0] || 0;
  const rawTime = Number(item && item.timeLimit);
  const timeLimit = Number.isFinite(rawTime) ? Math.min(90, Math.max(5, Math.round(rawTime))) : 20;

  return {
    type,
    text,
    imageUrl: normalizeImageUrl(item && item.imageUrl),
    imageAlt: normalizeShortText(item && item.imageAlt, 160),
    imageCredit: normalizeShortText(item && item.imageCredit, 80),
    imageCreditUrl: normalizeMediaUrl(item && item.imageCreditUrl),
    imageProvider: normalizeShortText(item && item.imageProvider, 32),
    imagePageUrl: normalizeMediaUrl(item && item.imagePageUrl),
    videoUrl: normalizeMediaUrl(item && item.videoUrl),
    answers: normalizedAnswers,
    correctIndex,
    correctIndexes: normalizedCorrectIndexes,
    timeLimit
  };
}

function normalizeShortText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
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
