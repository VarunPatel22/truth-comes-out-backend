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
const rooms = {};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ================= SOCKET =================
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
      votes: new Set(),
      phase: "lobby",
      round: 0,
      maxRounds: 5,
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
    if (rooms[roomCode]?.host !== socket.id) return;
    rooms[roomCode].round = 0;
    startRound(roomCode);
  });

  // ================= ROUND =================
  async function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    clearTimeout(room.timer);

    room.phase = "answer";
    room.answers = [];
    room.submitted = new Set();
    room.votes = new Set();

    // Fetch question
    let questionText = "Say something funny 😄";
    const snap = await db.collection("questions").get();
    if (!snap.empty) {
      const valid = snap.docs.map(d => d.data()).filter(q => q?.text);
      if (valid.length) {
        const q = valid[Math.floor(Math.random() * valid.length)];
        const names = Object.values(room.players);
        const randomName = names[Math.floor(Math.random() * names.length)] || "someone";
        questionText = q.text.replace(/\{\{name\}\}/gi, randomName);
      }
    }

    io.to(roomCode).emit("new-question", { text: questionText });

    // Answer timer (60s)
    room.timer = setTimeout(() => {
      startVote(roomCode);
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
      text: answer || "🤡"
    });

    io.to(roomCode).emit("submission-update", {
      submitted: room.submitted.size,
      total: Object.keys(room.players).length
    });

    if (room.submitted.size === Object.keys(room.players).length) {
      startVote(roomCode);
    }
  });

  // ================= VOTING =================
  function startVote(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== "answer") return;

    clearTimeout(room.timer);
    room.phase = "vote";

    io.to(roomCode).emit("phase-vote", room.answers);

    // Vote timer (30s)
    room.timer = setTimeout(() => {
      endRound(roomCode);
    }, 30000);
  }

  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote") return;
    if (room.votes.has(socket.id)) return;

    room.votes.add(socket.id);
    room.scores[votedFor] = (room.scores[votedFor] || 0) + 1;

    if (room.votes.size === Object.keys(room.players).length) {
      endRound(roomCode);
    }
  });

  // ================= END ROUND =================
  function endRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    clearTimeout(room.timer);
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
  }

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.scores[socket.id];
        room.submitted.delete(socket.id);
        room.votes.delete(socket.id);
        io.to(code).emit("player-update", Object.values(room.players));
      }
    }
  });
});

server.listen(3000, () => console.log("✅ Server running on 3000"));
