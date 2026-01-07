import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import admin from "firebase-admin";
import fs from "fs";

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY)
  )
});

const db = admin.firestore();

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};

function genRoom() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on("connection", socket => {

  socket.on("create-room", ({ name, spicy }) => {
    const room = genRoom();
    rooms[room] = {
      host: socket.id,
      spicy,
      players: {},
      answers: [],
      target: null
    };

    rooms[room].players[socket.id] = { name, score: 0 };
    socket.join(room);

    socket.emit("room-created", { room, isHost: true });
  });

  socket.on("join-room", ({ room, name }) => {
    if (!rooms[room]) return;

    rooms[room].players[socket.id] = { name, score: 0 };
    socket.join(room);

    socket.emit("room-joined", { room, isHost: false });
  });

  socket.on("start-round", async room => {
    if (!rooms[room]) return;

    const allowed = rooms[room].spicy ? ["normal", "spicy"] : ["normal"];

    const snap = await db
      .collection("questions")
      .where("type", "in", allowed)
      .get();

    if (snap.empty) return;

    const qs = snap.docs.map(d => d.data());
    const q = qs[Math.floor(Math.random() * qs.length)];

    const ids = Object.keys(rooms[room].players);
    const target = ids[Math.floor(Math.random() * ids.length)];

    rooms[room].target = target;
    rooms[room].answers = [];

    io.to(room).emit("question", {
      text: q.text.replace("{{name}}", rooms[room].players[target].name)
    });
  });

  socket.on("submit-answer", ({ room, answer }) => {
    rooms[room].answers.push({ id: socket.id, answer });

    if (rooms[room].answers.length === Object.keys(rooms[room].players).length) {
      io.to(room).emit(
        "vote-phase",
        rooms[room].answers.sort(() => Math.random() - 0.5)
      );
    }
  });

  socket.on("vote", ({ room, picked }) => {
    if (picked === rooms[room].target)
      rooms[room].players[socket.id].score += 100;
    else
      rooms[room].players[picked].score += 50;

    io.to(room).emit("scores", rooms[room].players);
  });
});

server.listen(3000, () => console.log("Backend running on 3000"));
