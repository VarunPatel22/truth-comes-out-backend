import "dotenv/config";
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

const rooms = {};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on("connection", socket => {

  socket.on("create-room", ({ name }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      host: socket.id,
      players: { [socket.id]: name },
      scores: { [socket.id]: 0 },
      answers: [],
      submitted: new Set(),
      votedPlayers: new Set(), // Track who has voted
      phase: "lobby",
      round: 0,
      maxRounds: 10,
      timer: null,
      voteStarted: false
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
    room.votedPlayers.clear(); // Clear votes for new round

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
      } catch (err) { console.log("DB Error", err); }
    }

    io.to(roomCode).emit("new-question", { text: questionText });

    clearTimeout(room.timer);
    room.timer = setTimeout(() => forceVote(roomCode), 65000); // Buffer for network
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

    io.to(roomCode).emit("phase-vote", room.answers);
  }

  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote") return;
    if (room.votedPlayers.has(socket.id)) return; // Prevent double voting

    room.votedPlayers.add(socket.id);

    if (room.scores[votedFor] !== undefined) {
      room.scores[votedFor]++;
    }

    // Wait for ALL players to vote before moving on
    if (room.votedPlayers.size === Object.keys(room.players).length) {
      room.round++;
      if (room.round >= room.maxRounds) {
        endGame(roomCode);
      } else {
        // Small delay so players see the "Vote submitted" message
        setTimeout(() => startRound(roomCode), 2000);
      }
    }
  });

  function endGame(roomCode) {
    const room = rooms[roomCode];
    const scores = {};
    Object.keys(room.players).forEach(id => {
      scores[room.players[id]] = room.scores[id];
    });
    io.to(roomCode).emit("game-over", scores);
  }
});

server.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server running")
);