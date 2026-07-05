const assert = require("node:assert/strict");
const { io } = require("socket.io-client");

const serverUrl = process.env.SERVER_URL || "http://127.0.0.1:3000";
const expectedArchive = process.env.EXPECTED_ARCHIVE || "";
const hostPassword = process.env.HOST_PASSWORD || "";
let authCookie = "";

const quiz = {
  title: "Smoke Test",
  questions: [
    {
      type: "speed",
      text: "Ready?",
      answers: ["Yes", "No", "Maybe", "Later"],
      correctIndex: 0,
      timeLimit: 8
    },
    {
      type: "multiple_select",
      text: "Pick the live parts",
      answers: ["Host", "Phone", "Wallpaper", "Public screen"],
      correctIndexes: [0, 1, 3],
      timeLimit: 8
    }
  ]
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const health = await getJson("/api/health");
  assert.equal(health.ok, true);
  if (expectedArchive) assert.equal(health.archive, expectedArchive);

  await ensureHostAccess();

  const host = createSocket(true);
  const screen = createSocket(false);
  const player = createSocket(false);
  const decliningPlayer = createSocket(false);

  try {
    await Promise.all([waitForConnect(host), waitForConnect(screen), waitForConnect(player), waitForConnect(decliningPlayer)]);
    host.on("room:state", (state) => {
      host.latestState = state;
    });
    screen.on("room:state", (state) => {
      screen.latestState = state;
    });
    screen.on("screen:waiting", () => {
      screen.waitingEvents = (screen.waitingEvents || 0) + 1;
    });
    player.on("room:state", (state) => {
      player.latestState = state;
    });
    decliningPlayer.on("room:state", (state) => {
      decliningPlayer.latestState = state;
    });

    const screenWatching = await emitAck(screen, "screen:watch", {});
    assert.equal(screenWatching.ok, true);
    assert.equal(screenWatching.waiting, true);

    const savedQuiz = await postJson("/api/archive/quizzes", { quiz });
    assert.equal(savedQuiz.ok, true);
    assert.equal(savedQuiz.quiz.title, quiz.title);

    const exportedQuizXlsx = await postBinary("/api/quiz/export.xlsx", { quiz });
    assert.ok(exportedQuizXlsx.length > 1000);
    const importedQuiz = await postJson("/api/quiz/import.xlsx", {
      file: exportedQuizXlsx.toString("base64")
    });
    assert.equal(importedQuiz.ok, true);
    assert.equal(importedQuiz.quiz.title, quiz.title);
    assert.equal(importedQuiz.quiz.questions[0].type, "speed");
    assert.equal(importedQuiz.quiz.questions[0].answers[0], "Yes");
    assert.equal(importedQuiz.quiz.questions[1].type, "multiple_select");
    assert.deepEqual(importedQuiz.quiz.questions[1].correctIndexes, [0, 1, 3]);

    const templateXlsx = await getBinary("/api/quiz-template.xlsx");
    assert.ok(templateXlsx.length > 1000);

    const archive = await getJson("/api/archive/quizzes");
    assert.ok(archive.quizzes.some((item) => item.id === savedQuiz.quiz.id));

    const created = await emitAck(host, "host:create", { quiz });
    assert.equal(created.ok, true);
    assert.match(created.code, /^\d{6}$/);

    await waitForState(host, (state) => state.role === "host" && state.status === "lobby");

    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "lobby" &&
      state.code === created.code &&
      !state.players &&
      !state.exports
    );

    const joined = await emitAck(player, "player:join", {
      code: created.code,
      nickname: "Smoke Player"
    });
    assert.equal(joined.ok, true);

    const decliningJoined = await emitAck(decliningPlayer, "player:join", {
      code: created.code,
      nickname: "Smoke Decliner"
    });
    assert.equal(decliningJoined.ok, true);

    await waitForState(host, (state) =>
      state.role === "host" &&
      Array.isArray(state.players) &&
      state.players.some((item) => item.nickname === "Smoke Player") &&
      state.players.some((item) => item.nickname === "Smoke Decliner")
    );

    const started = await emitAck(host, "host:start", {});
    assert.equal(started.ok, true);

    await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "question" &&
      state.question &&
      state.question.type === "speed" &&
      state.question.answers.length === 4
    );
    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "question" &&
      state.question &&
      state.question.answers.length === 4 &&
      state.question.answers.every((answer) => answer.correct === undefined && answer.count === undefined)
    );

    const answered = await emitAck(player, "player:answer", { answerIndex: 0 });
    assert.equal(answered.ok, true);
    assert.equal(answered.correct, true);

    await waitForState(host, (state) => state.status === "question" && state.answerCount === 1);

    const revealed = await emitAck(host, "host:reveal", {});
    assert.equal(revealed.ok, true);

    const playerReveal = await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "reveal" &&
      state.question &&
      state.question.playerAnswer &&
      state.question.playerAnswer.correct === true
    );
    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "reveal" &&
      state.question &&
      state.question.answers.some((answer) => answer.correct === true && answer.count === 1)
    );

    const nextQuestion = await emitAck(host, "host:next", {});
    assert.equal(nextQuestion.ok, true);

    await waitForState(player, (state) =>
      state.role === "player" &&
      state.status === "question" &&
      state.question &&
      state.question.type === "multiple_select" &&
      state.question.selectionCount === 3
    );

    const incompleteMultiAnswered = await emitAck(player, "player:answer", { answerIndexes: [0, 1] });
    assert.equal(incompleteMultiAnswered.ok, false);

    const multiAnswered = await emitAck(player, "player:answer", { answerIndexes: [0, 1, 3] });
    assert.equal(multiAnswered.ok, true);
    assert.equal(multiAnswered.correct, true);

    const wrongMultiAnswered = await emitAck(decliningPlayer, "player:answer", { answerIndexes: [0, 2, 3] });
    assert.equal(wrongMultiAnswered.ok, true);
    assert.equal(wrongMultiAnswered.correct, false);

    const multiReveal = await emitAck(host, "host:reveal", {});
    assert.equal(multiReveal.ok, true);

    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "reveal" &&
      state.question &&
      state.question.type === "multiple_select" &&
      state.question.answers.filter((answer) => answer.correct === true).length === 3 &&
      state.question.answers.some((answer) => answer.index === 2 && answer.count === 1) &&
      state.question.answers.some((answer) => answer.correct === false)
    );

    const ended = await emitAck(host, "host:next", {});
    assert.equal(ended.ok, true);

    await waitForState(host, (state) => state.status === "ended");
    await waitForState(screen, (state) => state.status === "ended" && state.leaderboard.length >= 1);

    screen.waitingEvents = 0;
    const releasedScreens = await emitAck(host, "host:release-screens", {});
    assert.equal(releasedScreens.ok, true);
    assert.equal(releasedScreens.released, 1);
    await waitForCondition(() => screen.waitingEvents >= 1, "Timeout waiting for screen waiting state");

    const reset = await emitAck(host, "host:reset", {});
    assert.equal(reset.ok, true);
    await waitForState(screen, (state) =>
      state.role === "screen" &&
      state.status === "lobby" &&
      state.code === created.code
    );

    await waitForState(player, (state) =>
      state.status === "lobby" &&
      state.player &&
      state.player.rematch === "pending" &&
      state.player.active === false
    );
    await waitForState(decliningPlayer, (state) =>
      state.status === "lobby" &&
      state.player &&
      state.player.rematch === "pending" &&
      state.player.active === false
    );
    await waitForState(host, (state) =>
      state.status === "lobby" &&
      state.playerCount === 0 &&
      state.pendingInviteCount === 2
    );

    const accepted = await emitAck(player, "player:rematch", { accept: true });
    assert.equal(accepted.ok, true);

    const declined = await emitAck(decliningPlayer, "player:rematch", { accept: false });
    assert.equal(declined.ok, true);
    assert.equal(declined.left, true);

    await waitForState(host, (state) =>
      state.status === "lobby" &&
      state.playerCount === 1 &&
      state.pendingInviteCount === 0 &&
      state.players.some((item) => item.nickname === "Smoke Player") &&
      !state.players.some((item) => item.nickname === "Smoke Decliner")
    );

    const resultArchive = await getJson("/api/archive/results");
    const savedResult = resultArchive.results.find((item) => item.code === created.code);
    assert.ok(savedResult);

    const savedResultJson = await getJson(`/api/archive/results/${savedResult.id}.json`);
    assert.equal(savedResultJson.code, created.code);
    assert.ok(savedResultJson.leaderboard.some((item) => item.nickname === "Smoke Player"));

    const savedResultCsv = await getText(`/api/archive/results/${savedResult.id}.csv`);
    assert.match(savedResultCsv, /Smoke Player/);

    const deletedResult = await deleteJson(`/api/archive/results/${savedResult.id}`);
    assert.equal(deletedResult.ok, true);

    const deletedQuiz = await deleteJson(`/api/archive/quizzes/${savedQuiz.quiz.id}`);
    assert.equal(deletedQuiz.ok, true);

    console.log(JSON.stringify({
      ok: true,
      code: created.code,
      playerScore: playerReveal.player.score
    }, null, 2));
  } finally {
    host.close();
    screen.close();
    player.close();
    decliningPlayer.close();
  }
}

function createSocket(includeHostCookie) {
  const options = {
    transports: ["websocket"],
    forceNew: true
  };
  if (includeHostCookie && authCookie) {
    options.extraHeaders = { Cookie: authCookie };
  }
  return io(serverUrl, options);
}

async function ensureHostAccess() {
  const auth = await getJson("/api/host/auth");
  if (!auth.enabled) return;
  if (!hostPassword) {
    throw new Error("HOST_PASSWORD is required to run smoke tests against a protected host.");
  }

  const lockedResponse = await fetch(new URL("/api/archive/quizzes", serverUrl), { cache: "no-store" });
  assert.equal(lockedResponse.status, 401);

  const unauthorizedHost = createSocket(false);
  try {
    await waitForConnect(unauthorizedHost);
    const deniedCreate = await emitAck(unauthorizedHost, "host:create", { quiz });
    assert.equal(deniedCreate.ok, false);
    assert.match(deniedCreate.error, /Password host/);
  } finally {
    unauthorizedHost.close();
  }

  await loginHost();
}

async function loginHost() {
  const response = await fetch(new URL("/api/host/login", serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: hostPassword })
  });
  const data = await response.json();
  assert.equal(response.ok, true, data.error || "Host login failed");
  authCookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(authCookie);

  const auth = await getJson("/api/host/auth");
  assert.equal(auth.authenticated, true);
}

function emitAck(socket, eventName, payload) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), 4000);
    socket.emit(eventName, payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

async function getJson(path) {
  const response = await fetch(new URL(path, serverUrl), {
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function getText(path) {
  const response = await fetch(new URL(path, serverUrl), {
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return response.text();
}

async function getBinary(path) {
  const response = await fetch(new URL(path, serverUrl), {
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return Buffer.from(await response.arrayBuffer());
}

async function postJson(path, payload) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function postBinary(path, payload) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(payload)
  });
  assert.equal(response.ok, true);
  return Buffer.from(await response.arrayBuffer());
}

async function deleteJson(path) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "DELETE",
    headers: authHeaders()
  });
  assert.equal(response.ok, true);
  return response.json();
}

function authHeaders() {
  return authCookie ? { Cookie: authCookie } : {};
}

function waitForConnect(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Socket connection timeout")), 4000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", reject);
  });
}

function waitForState(socket, predicate) {
  if (socket.latestState && predicate(socket.latestState)) {
    return Promise.resolve(socket.latestState);
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("room:state", onState);
      reject(new Error("Timeout waiting for room state"));
    }, 4000);

    function onState(state) {
      socket.latestState = state;
      if (!predicate(state)) return;
      clearTimeout(timeout);
      socket.off("room:state", onState);
      resolve(state);
    }

    socket.on("room:state", onState);
  });
}

function waitForCondition(predicate, message) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() - startedAt > 4000) {
        clearInterval(interval);
        reject(new Error(message));
      }
    }, 25);
  });
}
