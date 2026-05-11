import express from "express";
import http from "http";
import { fileURLToPath } from "url";
import path from "path";
import cors from "cors";
import { Server } from "socket.io";
import { palavraAleatoria } from "./palavras.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3001;

const MIN_JOGADORES = 3;
const MAX_JOGADORES = 10;

const app = express();
app.use(cors({ origin: true, credentials: true }));

/** @type {Map<string, { hostId: string, players: Map<string, { name: string }>, round: null | { word: string, impostorId: string } }>} */
const salas = new Map();

function codigoSala() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return salas.has(s) ? codigoSala() : s;
}

function estadoPublicoDaSala(codigo) {
  const sala = salas.get(codigo);
  if (!sala) return null;
  const jogadores = [];
  for (const [id, p] of sala.players) {
    jogadores.push({
      id,
      nome: p.name,
      dono: id === sala.hostId,
    });
  }
  return {
    codigo,
    jogadores,
    donoId: sala.hostId,
    rodadaAtiva: !!sala.round,
    totalJogadores: sala.players.size,
    podeGerarPalavra:
      sala.players.size >= MIN_JOGADORES && sala.players.size <= MAX_JOGADORES && !sala.round,
  };
}

function broadcastEstado(codigo) {
  const io = globalThis.__io;
  const estado = estadoPublicoDaSala(codigo);
  if (io && estado) io.to(codigo).emit("estadoSala", estado);
}

function revelarParaSocket(socket, sala) {
  if (!sala.round) return { tipo: "aguardando" };
  if (socket.id === sala.round.impostorId) return { tipo: "impostor" };
  return { tipo: "palavra", palavra: sala.round.word };
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});
globalThis.__io = io;

if (isProd) {
  const dist = path.join(__dirname, "..", "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

io.on("connection", (socket) => {
  /** @type {string | null} */
  let salaAtual = null;

  function sairDaSala() {
    if (!salaAtual) return;
    const sala = salas.get(salaAtual);
    if (!sala) {
      salaAtual = null;
      return;
    }
    sala.players.delete(socket.id);
    socket.leave(salaAtual);
    const codigo = salaAtual;
    if (sala.players.size === 0) {
      salas.delete(codigo);
    } else {
      if (sala.hostId === socket.id) {
        const primeiro = sala.players.keys().next().value;
        sala.hostId = primeiro;
      }
      broadcastEstado(codigo);
    }
    salaAtual = null;
  }

  socket.on("disconnect", () => {
    sairDaSala();
  });

  socket.on("criarSala", ({ nome }, cb) => {
    sairDaSala();
    const codigo = codigoSala();
    const name = (nome || "Jogador").trim().slice(0, 24) || "Jogador";
    salas.set(codigo, {
      hostId: socket.id,
      players: new Map([[socket.id, { name }]]),
      round: null,
    });
    socket.join(codigo);
    salaAtual = codigo;
    const estado = estadoPublicoDaSala(codigo);
    broadcastEstado(codigo);
    cb?.({ ok: true, codigo, estado, voceEhDono: true });
  });

  socket.on("entrarSala", ({ codigo, nome }, cb) => {
    const c = String(codigo || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!c || c.length !== 6) {
      cb?.({ ok: false, erro: "Código inválido. Use 6 caracteres." });
      return;
    }
    const sala = salas.get(c);
    if (!sala) {
      cb?.({ ok: false, erro: "Sala não encontrada." });
      return;
    }
    if (sala.players.size >= MAX_JOGADORES) {
      cb?.({ ok: false, erro: "Sala cheia (máximo 10 jogadores)." });
      return;
    }
    sairDaSala();
    const name = (nome || "Jogador").trim().slice(0, 24) || "Jogador";
    sala.players.set(socket.id, { name });
    socket.join(c);
    salaAtual = c;
    broadcastEstado(c);
    const estado = estadoPublicoDaSala(c);
    cb?.({
      ok: true,
      codigo: c,
      estado,
      voceEhDono: socket.id === sala.hostId,
    });
  });

  socket.on("gerarPalavra", (cb) => {
    if (!salaAtual) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(salaAtual);
    if (!sala || sala.hostId !== socket.id) {
      cb?.({ ok: false, erro: "Apenas o dono da sala pode gerar a palavra." });
      return;
    }
    if (sala.round) {
      cb?.({ ok: false, erro: "Já existe uma partida em andamento. Finalize antes." });
      return;
    }
    const n = sala.players.size;
    if (n < MIN_JOGADORES) {
      cb?.({
        ok: false,
        erro: `São necessários pelo menos ${MIN_JOGADORES} jogadores (há ${n}).`,
      });
      return;
    }
    if (n > MAX_JOGADORES) {
      cb?.({ ok: false, erro: "Sala com jogadores demais." });
      return;
    }
    const ids = [...sala.players.keys()];
    const impostorId = ids[Math.floor(Math.random() * ids.length)];
    const word = palavraAleatoria();
    sala.round = { word, impostorId };
    broadcastEstado(salaAtual);
    const rev = revelarParaSocket(socket, sala);
    io.to(salaAtual).emit("rodadaIniciada", { podeVerPalavra: true });
    socket.emit("revelacao", rev);
    cb?.({ ok: true, revelacao: rev });
  });

  socket.on("verPalavra", (cb) => {
    if (!salaAtual) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(salaAtual);
    if (!sala || !sala.round) {
      cb?.({ ok: false, erro: "Ainda não há palavra nesta rodada." });
      return;
    }
    if (socket.id === sala.hostId) {
      cb?.({ ok: false, erro: "O dono já vê o resultado ao gerar a palavra." });
      return;
    }
    const rev = revelarParaSocket(socket, sala);
    cb?.({ ok: true, revelacao: rev });
  });

  socket.on("finalizarPartida", (cb) => {
    if (!salaAtual) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(salaAtual);
    if (!sala || sala.hostId !== socket.id) {
      cb?.({ ok: false, erro: "Apenas o dono pode finalizar a partida." });
      return;
    }
    if (!sala.round) {
      cb?.({ ok: false, erro: "Não há partida ativa." });
      return;
    }
    sala.round = null;
    io.to(salaAtual).emit("rodadaEncerrada");
    broadcastEstado(salaAtual);
    cb?.({ ok: true });
  });

  socket.on("sairSala", () => {
    sairDaSala();
    socket.emit("saiuDaSala");
  });
});

server.listen(PORT, () => {
  console.log(
    isProd
      ? `Servidor em http://localhost:${PORT}`
      : `API/Socket.io em http://localhost:${PORT}`,
  );
});
