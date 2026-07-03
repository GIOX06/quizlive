const assert = require("node:assert/strict");
const { io } = require("socket.io-client");

const serverUrl = process.env.SERVER_URL || "http://127.0.0.1:3000";

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

  try {
    await Promise.all([waitForConnect(host), waitForConnect(player)]);
    host.on("room:state", (state) => {
      host.latestState = state;
    });
    player.on("room:state", (state) => {
      player.latestState = state;
    });

    const created = await emitAck(host, "host:create", { quiz });
    assert.equal(created.ok, true);
    assert.match(created.code, /^\d{6}$/);

    await waitForState(host, (state) => state.role === "host" && state.status === "lobby");

    const joined = await emitAck(player, "player:join", {
      code: created.code,
      nickname: "Smoke Player"
    });
    assert.equal(joined.ok, true);

    await waitForState(host, (state) =>
      state.role === "host" &&
      Array.isArray(state.players) &&
      state.players.some((item) => item.nickname === "Smoke Player")
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

    console.log(JSON.stringify({
      ok: true,
      code: created.code,
      playerScore: playerReveal.player.score
    }, null, 2));
  } finally {
    host.close();
    player.close();
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
