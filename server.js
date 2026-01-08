import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import admin from "firebase-admin";

// ---------------- BASIC SETUP ----------------
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// ---------------- FIREBASE INIT ----------------
let db = null;

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
  });
  db = admin.firestore();
  console.log("✅ Firebase connected");
} catch (err) {
  console.error("❌ Firebase init failed:", err.message);
}

// ---------------- GAME STATE ----------------
const rooms = {};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------------- SOCKET LOGIC ----------------
io.on("connection", socket => {

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

  socket.on("join-room", ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players[socket.id] = name;
    room.scores[socket.id] = 0;
    socket.join(roomCode);

    io.to(roomCode).emit("player-update", Object.values(room.players));
  });

  socket.on("set-rounds", ({ roomCode, rounds }) => {
    if (rooms[roomCode]?.host === socket.id) {
      rooms[roomCode].maxRounds = rounds;
    }
  });

  socket.on("start-game", roomCode => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;
    room.round = 0;
    startRound(roomCode);
  });

  async function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = "answer";
    room.answers = [];
    room.submitted.clear();

    let questionText = "Say something funny 😄";

    if (db) {
      try {
        const snap = await db.collection("questions").get();
        const valid = snap.docs.map(d => d.data()).filter(q => q?.text);
        if (valid.length) {
          const q = valid[Math.floor(Math.random() * valid.length)];
          const names = Object.values(room.players);
          const randomName = names[Math.floor(Math.random() * names.length)];
          questionText = q.text.replace(/\{\{name\}\}/gi, randomName);
        }
      } catch {}
    }

    io.to(roomCode).emit("new-question", { text: questionText });

    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      forceVote(roomCode);
    }, 60000);
  }

  socket.on("submit-answer", ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "answer") return;
    if (room.submitted.has(socket.id)) return;

    room.submitted.add(socket.id);
    room.answers.push({ author: socket.id, text: answer || "🤡" });

    io.to(roomCode).emit("submission-update", {
      submitted: room.submitted.size,
      total: Object.keys(room.players).length
    });

    if (room.submitted.size === Object.keys(room.players).length) {
      forceVote(roomCode);
    }
  });

  // 🔥 FIXED: ALWAYS ENTER VOTING
  function forceVote(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== "answer") return;

    clearTimeout(room.timer);
    room.phase = "vote";

    io.to(roomCode).emit("phase-vote", room.answers);
  }

  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote") return;

    if (room.scores[votedFor] !== undefined) {
      room.scores[votedFor]++;
    }

    room.round++;

    room.round >= room.maxRounds
      ? endGame(roomCode)
      : startRound(roomCode);
  });

  function endGame(roomCode) {
    const room = rooms[roomCode];
    const scores = {};
    Object.keys(room.players).forEach(id => {
      scores[room.players[id]] = room.scores[id];
    });
    io.to(roomCode).emit("game-over", scores);
  }

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

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
});
