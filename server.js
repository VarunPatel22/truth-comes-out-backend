import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 🔐 Firebase
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY)
  )
});

const db = admin.firestore();

// ---------------- GAME STATE ----------------
const rooms = {};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------------- SOCKET ----------------
io.on("connection", socket => {

  // CREATE ROOM
  socket.on("create-room", ({ name }) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      host: socket.id,
      players: { [socket.id]: name },
      scores: { [socket.id]: 0 },
      answers: [],
      submitted: new Set(),
      phase: "lobby",
      round: 0,
      maxRounds: 10,
      timer: null
    };

    socket.join(roomCode);

    socket.emit("room-created", {
      roomCode,
      players: Object.values(rooms[roomCode].players)
    });
  });

  // JOIN ROOM
  socket.on("join-room", ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players[socket.id] = name;
    room.scores[socket.id] = 0;

    socket.join(roomCode);
    io.to(roomCode).emit("player-update", Object.values(room.players));
  });

  // SET ROUNDS
  socket.on("set-rounds", ({ roomCode, rounds }) => {
    if (rooms[roomCode]?.host === socket.id) {
      rooms[roomCode].maxRounds = rounds;
    }
  });

  // START GAME
  socket.on("start-game", roomCode => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;

    room.round = 0;
    startRound(roomCode);
  });

  // ---------------- ROUND ----------------
  async function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = "answer";
    room.answers = [];
    room.submitted = new Set();

    clearTimeout(room.timer);

    // Get question
    const snap = await db.collection("questions").get();
    let questionText = "Say something funny 😄";

    if (!snap.empty) {
      const questions = snap.docs.map(d => d.data()).filter(q => q.text);
      const question = questions[Math.floor(Math.random() * questions.length)];

      const players = Object.values(room.players);
      const randomName =
        players[Math.floor(Math.random() * players.length)] || "someone";

      questionText = question.text.replace(/\{\{name\}\}/gi, randomName);
    }

    io.to(roomCode).emit("new-question", { text: questionText });

    // ⏱ Force vote after 60s
    room.timer = setTimeout(() => {
      forceVote(roomCode);
    }, 60000);
  }

  // SUBMIT ANSWER
  socket.on("submit-answer", ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "answer") return;
    if (room.submitted.has(socket.id)) return;

    room.submitted.add(socket.id);
    room.answers.push({
      author: socket.id,
      text: answer?.trim() || "🤡"
    });

    io.to(roomCode).emit("submission-update", {
      submitted: room.submitted.size,
      total: Object.keys(room.players).length
    });

    if (room.submitted.size === Object.keys(room.players).length) {
      forceVote(roomCode);
    }
  });

  // FORCE VOTE
  function forceVote(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== "answer") return;

    clearTimeout(room.timer);
    room.phase = "vote";

    if (room.answers.length === 0) {
      room.round++;
      return startRound(roomCode);
    }

    io.to(roomCode).emit("start-vote", room.answers);
  }

  // VOTE
  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote") return;

    room.scores[votedFor] = (room.scores[votedFor] || 0) + 1;
    room.round++;

    if (room.round >= room.maxRounds) {
      endGame(roomCode);
    } else {
      startRound(roomCode);
    }
  });

  // END GAME
  function endGame(roomCode) {
    const room = rooms[roomCode];
    const scores = {};

    Object.keys(room.players).forEach(id => {
      scores[room.players[id]] = room.scores[id];
    });

    io.to(roomCode).emit("game-over", scores);
  }

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.scores[socket.id];
        room.submitted.delete(socket.id);

        io.to(code).emit("player-update", Object.values(room.players));
      }
    }
  });
});

// ---------------- SERVER ----------------
server.listen(3000, () => {
  console.log("Server running on 3000");
});
