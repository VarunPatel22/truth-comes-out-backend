import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// 🔐 Firebase
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY)
  )
});

const db = admin.firestore();

// ---------------- GAME STATE ----------------
const rooms = {};

// Utility
function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ---------------- SOCKET LOGIC ----------------
io.on("connection", socket => {

  // CREATE ROOM
  socket.on("create-room", ({ name }) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      host: socket.id,
      players: {},
      scores: {},
      answers: [],
      round: 0,
      maxRounds: 10,
      gameStarted: false
    };

    rooms[roomCode].players[socket.id] = name;
    rooms[roomCode].scores[socket.id] = 0;

    socket.join(roomCode);

    socket.emit("room-created", { roomCode, players: Object.values(rooms[roomCode].players) });
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

  // SET ROUNDS (HOST ONLY)
  socket.on("set-rounds", ({ roomCode, rounds }) => {
    if (rooms[roomCode]?.host === socket.id) {
      rooms[roomCode].maxRounds = rounds;
    }
  });

  // START GAME
  socket.on("start-game", async roomCode => {
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id) return;

    room.gameStarted = true;
    room.round = 0;

    startRound(roomCode);
  });

  // START ROUND
  async function startRound(roomCode) {
    const room = rooms[roomCode];
    room.answers = [];

    const snap = await db.collection("questions").get();
    const questions = snap.docs.map(d => d.data());
    const q = questions[Math.floor(Math.random() * questions.length)];

    io.to(roomCode).emit("new-question", {
      text: q.text
    });
  }

  // SUBMIT ANSWER
  socket.on("submit-answer", ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.answers.push({
      author: socket.id,
      text: answer || "🤡"
    });

    if (room.answers.length === Object.keys(room.players).length) {
      io.to(roomCode).emit("start-vote", room.answers);
    }
  });

  // VOTE
  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.scores[votedFor] += 1;

    room.round++;

    if (room.round >= room.maxRounds) {
      const finalScores = {};
      Object.keys(room.players).forEach(id => {
        finalScores[room.players[id]] = room.scores[id];
      });

      io.to(roomCode).emit("game-over", finalScores);
    } else {
      startRound(roomCode);
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const code in rooms) {
      if (rooms[code].players[socket.id]) {
        delete rooms[code].players[socket.id];
        delete rooms[code].scores[socket.id];

        io.to(code).emit("player-update", Object.values(rooms[code].players));
      }
    }
  });
});

// ---------------- SERVER ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Backend running on", PORT);
});
