const assert = require("node:assert/strict");
const { io } = require("socket.io-client");

const serverUrl = process.env.SERVER_URL || "http://127.0.0.1:3000";
const expectedArchive = process.env.EXPECTED_ARCHIVE || "";

const quiz = {
  title: "Smoke Test",
  questions: [
    {
      text: "Ready?",
      answers: ["Yes", "No", "Maybe", "Later"],
      correctIndex: 0,
      timeLimit: 8
    }
  ]
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const host = io(serverUrl, { transports: ["websocket"], forceNew: true });
  const player = io(serverUrl, { transports: ["websocket"], forceNew: true });
  const decliningPlayer = io(serverUrl, { transports: ["websocket"], forceNew: true });

  try {
    await Promise.all([waitForConnect(host), waitForConnect(player), waitForConnect(decliningPlayer)]);
    host.on("room:state", (state) => {
      host.latestState = state;
    });
    player.on("room:state", (state) => {
      player.latestState = state;
    });
    decliningPlayer.on("room:state", (state) => {
      decliningPlayer.latestState = state;
    });

    const health = await getJson("/api/health");
    assert.equal(health.ok, true);
    if (expectedArchive) assert.equal(health.archive, expectedArchive);

    const savedQuiz = await postJson("/api/archive/quizzes", { quiz });
    assert.equal(savedQuiz.ok, true);
    assert.equal(savedQuiz.quiz.title, quiz.title);

    const archive = await getJson("/api/archive/quizzes");
    assert.ok(archive.quizzes.some((item) => item.id === savedQuiz.quiz.id));

    const created = await emitAck(host, "host:create", { quiz });
    assert.equal(created.ok, true);
    assert.match(created.code, /^\d{6}$/);

    await waitForState(host, (state) => state.role === "host" && state.status === "lobby");

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
      state.question.answers.length === 4
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

    const ended = await emitAck(host, "host:next", {});
    assert.equal(ended.ok, true);

    await waitForState(host, (state) => state.status === "ended");

    const reset = await emitAck(host, "host:reset", {});
    assert.equal(reset.ok, true);

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
    player.close();
    decliningPlayer.close();
  }
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
  const response = await fetch(new URL(path, serverUrl));
  assert.equal(response.ok, true);
  return response.json();
}

async function getText(path) {
  const response = await fetch(new URL(path, serverUrl));
  assert.equal(response.ok, true);
  return response.text();
}

async function postJson(path, payload) {
  const response = await fetch(new URL(path, serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  assert.equal(response.ok, true);
  return response.json();
}

async function deleteJson(path) {
  const response = await fetch(new URL(path, serverUrl), { method: "DELETE" });
  assert.equal(response.ok, true);
  return response.json();
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
