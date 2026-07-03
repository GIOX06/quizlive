const express = require("express");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, ".data");
const STORE_FILE = path.join(DATA_DIR, "quizlive-store.json");
const rooms = new Map();
const store = loadStore();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (/\.(html|css|js)$/i.test(filePath)) {
      res.setHeader("cache-control", "no-store");
    }
  }
}));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
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

app.get("/api/rooms/:code/export/results.csv", (req, res) => {
  const room = rooms.get(normalizeCode(req.params.code));
  if (!room) {
    res.status(404).send("Room not found");
    return;
  }

  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="quizlive-${room.code}-results.csv"`);
  res.send(resultsToCsv(room));
});

app.get("/api/rooms/:code/export/results.json", (req, res) => {
  const room = rooms.get(normalizeCode(req.params.code));
  if (!room) {
    res.status(404).json({ error: "Room not found" });
    return;
  }

  res.setHeader("content-disposition", `attachment; filename="quizlive-${room.code}-results.json"`);
  res.json(resultsToJson(room));
});

app.get("/api/archive/quizzes", (_req, res) => {
  res.json({
    quizzes: store.quizzes
      .map((item) => ({
        id: item.id,
        title: item.title,
        questionCount: item.questionCount,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        quiz: item.quiz
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  });
});

app.post("/api/archive/quizzes", (req, res) => {
  try {
    const quiz = normalizeQuiz(req.body && req.body.quiz);
    const id = normalizeArchiveId(req.body && req.body.id) || createArchiveId("quiz");
    const saved = saveQuizToStore(id, quiz);
    res.json({ ok: true, quiz: saved });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/api/archive/quizzes/:id", (req, res) => {
  const id = normalizeArchiveId(req.params.id);
  const index = store.quizzes.findIndex((item) => item.id === id);
  if (index < 0) {
    res.status(404).json({ ok: false, error: "Quiz non trovato" });
    return;
  }
  store.quizzes.splice(index, 1);
  persistStore();
  res.json({ ok: true });
});

app.get("/api/archive/results", (_req, res) => {
  res.json({
    results: store.results
      .map((item) => ({
        id: item.id,
        code: item.code,
        title: item.title,
        endedAt: item.endedAt,
        playerCount: item.leaderboard.length,
        winner: item.leaderboard[0] || null
      }))
      .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
  });
});

app.get("/api/archive/results/:id.json", (req, res) => {
  const result = findResult(req.params.id);
  if (!result) {
    res.status(404).json({ error: "Result not found" });
    return;
  }
  res.setHeader("content-disposition", `attachment; filename="quizlive-${result.code}-saved-results.json"`);
  res.json(result);
});

app.get("/api/archive/results/:id.csv", (req, res) => {
  const result = findResult(req.params.id);
  if (!result) {
    res.status(404).send("Result not found");
    return;
  }
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="quizlive-${result.code}-saved-results.csv"`);
  res.send(resultToCsv(result));
});

app.delete("/api/archive/results/:id", (req, res) => {
  const id = normalizeArchiveId(req.params.id);
  const index = store.results.findIndex((item) => item.id === id);
  if (index < 0) {
    res.status(404).json({ ok: false, error: "Risultato non trovato" });
    return;
  }
  store.results.splice(index, 1);
  persistStore();
  res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("host:create", (payload, ack) => {
    try {
      const quiz = normalizeQuiz(payload && payload.quiz);
      const room = createRoom(quiz, socket.id);
      socket.data.role = "host";
      socket.data.roomCode = room.code;
      socket.join(roomChannel(room.code));
      sendAck(ack, { ok: true, code: room.code });
      emitRoom(room);
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

  socket.on("host:next", (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }
    const nextIndex = room.currentIndex + 1;
    if (nextIndex >= room.quiz.questions.length) {
      endGame(room);
    } else {
      startQuestion(room, nextIndex);
    }
    sendAck(ack, { ok: true });
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

  socket.on("host:reset", (_payload, ack) => {
    const room = getHostRoom(socket);
    if (!room) {
      sendAck(ack, { ok: false, error: "Host room not found" });
      return;
    }
    resetRoom(room);
    sendAck(ack, { ok: true });
  });

  socket.on("player:join", (payload, ack) => {
    const code = normalizeCode(payload && payload.code);
    const room = rooms.get(code);
    if (!room) {
      sendAck(ack, { ok: false, error: "Partita non trovata" });
      return;
    }
    if (room.status !== "lobby") {
      sendAck(ack, { ok: false, error: "Partita gia iniziata" });
      return;
    }

    const nickname = normalizeNickname(payload && payload.nickname);
    const player = {
      id: socket.id,
      nickname,
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
    socket.join(roomChannel(code));
    sendAck(ack, { ok: true, code, playerId: socket.id });
    emitRoom(room);
  });

  socket.on("player:answer", (payload, ack) => {
    const room = getPlayerRoom(socket);
    const player = room && room.players.get(socket.data.playerId);
    if (!room || !player) {
      sendAck(ack, { ok: false, error: "Giocatore non trovato" });
      return;
    }
    const result = submitAnswer(room, player, Number(payload && payload.answerIndex));
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

function endGame(room) {
  clearRoomTimer(room);
  room.status = "ended";
  room.questionEndsAt = null;
  if (!room.resultId) {
    const saved = saveResultToStore(room);
    room.resultId = saved.id;
  }
  emitRoom(room);
}

function resetRoom(room) {
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

  emitRoom(room);
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

function submitAnswer(room, player, answerIndex) {
  if (room.status !== "question") {
    return { ok: false, error: "Domanda non attiva" };
  }
  if (!player.active) {
    return { ok: false, error: "Non sei in questa partita" };
  }
  if (!Number.isInteger(answerIndex)) {
    return { ok: false, error: "Risposta non valida" };
  }
  const question = room.quiz.questions[room.currentIndex];
  if (!question || answerIndex < 0 || answerIndex >= question.answers.length) {
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
  const isCorrect = answerIndex === question.correctIndex;
  const elapsed = Math.max(0, answeredAt - room.questionStartedAt);
  const duration = Math.max(1, question.timeLimit * 1000);
  const speedBonus = isCorrect ? Math.max(0, Math.round(500 * (1 - elapsed / duration))) : 0;

  if (isCorrect) {
    player.streak += 1;
  } else {
    player.streak = 0;
  }

  const streakBonus = isCorrect ? Math.min(250, Math.max(0, (player.streak - 1) * 50)) : 0;
  const points = isCorrect ? 500 + speedBonus + streakBonus : 0;
  player.score += points;

  answerMap.set(player.id, {
    answerIndex,
    answeredAt,
    correct: isCorrect,
    points,
    speedBonus,
    streakBonus
  });

  return { ok: true, correct: isCorrect, points };
}

async function emitRoom(room) {
  const sockets = await io.in(roomChannel(room.code)).fetchSockets();
  for (const target of sockets) {
    target.emit("room:state", serializeRoom(room, target));
  }
}

function serializeRoom(room, socket) {
  const role = socket.data.role === "host" ? "host" : "player";
  const question = room.currentIndex >= 0 ? room.quiz.questions[room.currentIndex] : null;
  const answerMap = room.currentIndex >= 0 ? room.answers.get(room.currentIndex) || new Map() : new Map();
  const playerId = socket.data.playerId;
  const playerAnswer = playerId && answerMap.get(playerId);
  const revealMode = room.status === "reveal" || room.status === "ended" || role === "host";

  return {
    code: room.code,
    role,
    status: room.status,
    title: room.quiz.title,
    totalQuestions: room.quiz.questions.length,
    currentIndex: room.currentIndex,
    questionEndsAt: room.questionEndsAt,
    player: playerId ? serializePlayer(room.players.get(playerId), room) : null,
    question: question
      ? {
          text: question.text,
          answers: question.answers.map((answer, index) => ({
            text: answer,
            index,
            correct: revealMode ? index === question.correctIndex : undefined,
            count: role === "host" || room.status === "reveal" ? countAnswers(answerMap, index) : undefined
          })),
          timeLimit: question.timeLimit,
          correctIndex: revealMode ? question.correctIndex : undefined,
          answered: Boolean(playerAnswer),
          playerAnswer: playerAnswer || null
        }
      : null,
    players: role === "host" ? hostPlayers(room, answerMap) : undefined,
    leaderboard: leaderboard(room).slice(0, 10),
    answerCount: answerMap.size,
    playerCount: activePlayers(room).length,
    pendingInviteCount: role === "host" ? pendingInviteCount(room) : undefined,
    exports: role === "host"
      ? {
          csv: `/api/rooms/${room.code}/export/results.csv`,
          json: `/api/rooms/${room.code}/export/results.json`
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
      score: player.score,
      streak: player.streak,
      connected: player.connected,
      active: player.active
    }))
    .sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname));
}

function countAnswers(answerMap, answerIndex) {
  let total = 0;
  for (const answer of answerMap.values()) {
    if (answer.answerIndex === answerIndex) total += 1;
  }
  return total;
}

function resultsToJson(room) {
  return {
    code: room.code,
    title: room.quiz.title,
    exportedAt: new Date().toISOString(),
    questions: room.quiz.questions.map((question, questionIndex) => ({
      text: question.text,
      answers: question.answers,
      correctIndex: question.correctIndex,
      responses: Array.from(room.answers.get(questionIndex) || new Map()).map(([playerId, answer]) => {
        const player = room.players.get(playerId);
        return {
          playerId,
          nickname: player ? player.nickname : "Unknown",
          answerIndex: answer.answerIndex,
          answerText: question.answers[answer.answerIndex],
          correct: answer.correct,
          points: answer.points,
          answeredAt: new Date(answer.answeredAt).toISOString()
        };
      })
    })),
    leaderboard: leaderboard(room)
  };
}

function resultsToCsv(room) {
  const rows = [
    ["Rank", "Nickname", "Score", "Streak", ...room.quiz.questions.flatMap((_question, index) => [
      `Q${index + 1} Answer`,
      `Q${index + 1} Correct`,
      `Q${index + 1} Points`
    ])]
  ];

  leaderboard(room).forEach((player, playerIndex) => {
    const row = [
      playerIndex + 1,
      player.nickname,
      player.score,
      player.streak
    ];
    room.quiz.questions.forEach((question, questionIndex) => {
      const answer = room.answers.get(questionIndex) && room.answers.get(questionIndex).get(player.id);
      row.push(
        answer ? question.answers[answer.answerIndex] : "",
        answer ? (answer.correct ? "yes" : "no") : "",
        answer ? answer.points : 0
      );
    });
    rows.push(row);
  });

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function saveQuizToStore(id, quiz) {
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

function saveResultToStore(room) {
  const result = resultFromRoom(room);
  store.results.unshift(result);
  store.results = store.results
    .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
    .slice(0, 200);
  persistStore();
  return result;
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
    createdAt: new Date(room.createdAt).toISOString(),
    endedAt,
    quiz: room.quiz,
    questions: room.quiz.questions.map((question, questionIndex) => {
      const answerMap = room.answers.get(questionIndex) || new Map();
      return {
        text: question.text,
        answers: question.answers,
        correctIndex: question.correctIndex,
        responses: Array.from(answerMap).map(([playerId, answer]) => {
          const player = room.players.get(playerId);
          return {
            playerId,
            nickname: player ? player.nickname : "Unknown",
            answerIndex: answer.answerIndex,
            answerText: question.answers[answer.answerIndex],
            correct: answer.correct,
            points: answer.points,
            answeredAt: new Date(answer.answeredAt).toISOString()
          };
        })
      };
    }),
    leaderboard: board
  };
}

function findResult(id) {
  const normalizedId = normalizeArchiveId(id);
  return store.results.find((item) => item.id === normalizedId) || null;
}

function resultToCsv(result) {
  const rows = [
    ["Rank", "Nickname", "Score", "Streak", ...result.questions.flatMap((_question, index) => [
      `Q${index + 1} Answer`,
      `Q${index + 1} Correct`,
      `Q${index + 1} Points`
    ])]
  ];

  result.leaderboard.forEach((player, playerIndex) => {
    const row = [
      player.rank || playerIndex + 1,
      player.nickname,
      player.score,
      player.streak
    ];

    result.questions.forEach((question) => {
      const answer = question.responses.find((item) => item.playerId === player.id);
      row.push(
        answer ? answer.answerText : "",
        answer ? (answer.correct ? "yes" : "no") : "",
        answer ? answer.points : 0
      );
    });

    rows.push(row);
  });

  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
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
    results: Array.isArray(source.results) ? source.results.filter(isStoredResult).slice(0, 200) : []
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
  const questions = Array.isArray(source.questions) ? source.questions : [];
  const normalizedQuestions = questions.slice(0, 50).map((item, index) => normalizeQuestion(item, index));

  if (!normalizedQuestions.length) {
    throw new Error("Il quiz deve avere almeno una domanda");
  }

  return { title, questions: normalizedQuestions };
}

function normalizeQuestion(item, index) {
  const text = String(item && item.text ? item.text : `Domanda ${index + 1}`).trim().slice(0, 240);
  const answers = Array.isArray(item && item.answers) ? item.answers : [];
  const normalizedAnswers = answers
    .map((answer) => String(answer || "").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 6);

  if (normalizedAnswers.length < 2) {
    throw new Error(`La domanda ${index + 1} deve avere almeno due risposte`);
  }

  const rawCorrect = Number(item && item.correctIndex);
  const correctIndex = Number.isInteger(rawCorrect) && rawCorrect >= 0 && rawCorrect < normalizedAnswers.length ? rawCorrect : 0;
  const rawTime = Number(item && item.timeLimit);
  const timeLimit = Number.isFinite(rawTime) ? Math.min(90, Math.max(5, Math.round(rawTime))) : 20;

  return {
    text,
    answers: normalizedAnswers,
    correctIndex,
    timeLimit
  };
}

function normalizeNickname(value) {
  const nickname = String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
  return nickname || `Player ${Math.floor(100 + Math.random() * 900)}`;
}

function normalizeCode(value) {
  return String(value || "").replace(/\D/g, "").slice(0, 6);
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
    questions: [
      {
        text: "Quale tecnologia permette risposte live tra host e telefoni?",
        answers: ["WebSocket", "Solo email", "PDF", "Bluetooth spento"],
        correctIndex: 0,
        timeLimit: 20
      },
      {
        text: "Quale formato e comodo per esportare risultati in un foglio di calcolo?",
        answers: ["CSV", "PNG", "MP3", "MOV"],
        correctIndex: 0,
        timeLimit: 18
      },
      {
        text: "Cosa serve ai giocatori per entrare nella partita?",
        answers: ["Codice stanza e nickname", "App store", "Cavo USB", "Account admin"],
        correctIndex: 0,
        timeLimit: 20
      }
    ]
  };
}
