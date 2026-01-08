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
} catch (e) {
  console.log("⚠ Firebase disabled");
}

// ---------------- GAME STATE ----------------
const rooms = {};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper to broadcast name->score mapping
function emitScores(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const mapping = {};
  Object.keys(room.players).forEach(id => {
    mapping[room.players[id]] = room.scores[id] || 0;
  });
  io.to(roomCode).emit("scores-update", mapping);
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
      timer: null,
      voteStarted: false,
      votes: {} // voterId => votedForId
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
    if (rooms[roomCode]?.host !== socket.id) return;
    rooms[roomCode].round = 0;
    startRound(roomCode);
  });

  async function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = "answer";
    room.voteStarted = false;
    room.answers = [];
    room.submitted.clear();
    room.votes = {}; // reset votes for this round

    let questionText = "Say something funny 😄";

    if (db) {
      const snap = await db.collection("questions").get();
      const valid = snap.docs.map(d => d.data()).filter(q => q?.text);
      if (valid.length) {
        const q = valid[Math.floor(Math.random() * valid.length)];
        const names = Object.values(room.players);
        const randomName = names[Math.floor(Math.random() * names.length)];
        questionText = q.text.replace(/\{\{name\}\}/gi, randomName);
      }
    }

    io.to(roomCode).emit("new-question", { text: questionText });

    clearTimeout(room.timer);
    room.timer = setTimeout(() => forceVote(roomCode), 60000);
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

  function forceVote(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.voteStarted) return;

    room.voteStarted = true;
    room.phase = "vote";
    clearTimeout(room.timer);

    console.log("🗳 Entering vote phase", roomCode);

    // ensure votes object exists for this round
    room.votes = {};

    io.to(roomCode).emit("phase-vote", room.answers);
    // Also send current scores to clients
    emitScores(roomCode);
  }

  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote") return;

    // Prevent multiple votes from same socket this round
    if (room.votes[socket.id]) return;

    // Prevent voting for yourself (defensive)
    if (votedFor === socket.id) return;

    // record the vote
    room.votes[socket.id] = votedFor;

    // increment score immediately so players see points as votes arrive
    if (room.scores[votedFor] !== undefined) {
      room.scores[votedFor]++;
    }

    // broadcast updated scores to all clients
    emitScores(roomCode);

    // Check if all players have voted (one vote per player)
    const totalPlayers = Object.keys(room.players).length;
    const votesCount = Object.keys(room.votes).length;

    if (votesCount >= totalPlayers) {
      // All votes in: advance round (or end game).
      room.round++;
      if (room.round >= room.maxRounds) {
        // small delay so clients can see final votes/score
        setTimeout(() => endGame(roomCode), 2000);
      } else {
        // delay a moment to show scores to players before starting next round
        setTimeout(() => startRound(roomCode), 2000);
      }
    }
  });

  function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const scores = {};
    Object.keys(room.players).forEach(id => {
      scores[room.players[id]] = room.scores[id];
    });
    io.to(roomCode).emit("game-over", scores);
  }

  // handle disconnect: remove player and notify room (basic)
  socket.on("disconnect", () => {
    // find any room containing this socket
    Object.keys(rooms).forEach(rc => {
      const room = rooms[rc];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.scores[socket.id];
        // If host left, optionally reassign host to another player
        if (room.host === socket.id) {
          const remaining = Object.keys(room.players);
          room.host = remaining.length ? remaining[0] : null;
        }
        io.to(rc).emit("player-update", Object.values(room.players));
      }
    });
  });
});

server.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server running")
);