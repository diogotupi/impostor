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
const PALAVRAS_POR_JOGADOR = 3;
const TEXTO_CHAT_MAX = 80;

const app = express();
app.use(cors({ origin: true, credentials: true }));

/**
 * round:
 * @typedef {{
 *   word: string,
 *   impostorId: string,
 *   fase: 'pistas' | 'votacao' | 'resultado',
 *   ordemTurno: string[],
 *   indiceTurno: number,
 *   contagemPalavras: Record<string, number>,
 *   mensagens: Array<{ tipo: 'sistema' | 'pista', texto: string, autorId?: string, autorNome?: string, ts: number }>,
 *   votos: Map<string, string>,
 *   resultado: null | {
 *     impostorId: string,
 *     palavra: string,
 *     votosNoImpostor: number,
 *     votosPorJogador: Record<string, number>,
 *     impostorPerdeu: boolean,
 *   },
 * }} RoundState
 */

/** @type {Map<string, { hostId: string, players: Map<string, { name: string }>, round: RoundState | null, lobbyMsgs: Array<{ autorId: string, autorNome: string, texto: string, ts: number }> }>} */
const salas = new Map();

function codigoSala() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return salas.has(s) ? codigoSala() : s;
}

function embaralhar(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** @param {RoundState} round */
function jogadorDaVezId(round) {
  if (round.fase !== "pistas") return null;
  return round.ordemTurno[round.indiceTurno] ?? null;
}

/** @param {RoundState} round */
function todasPistasCompletas(round, playerIds) {
  return playerIds.every((id) => (round.contagemPalavras[id] ?? 0) >= PALAVRAS_POR_JOGADOR);
}

/** Após mensagem válida em pistas */
function avancarTurnoPistas(round) {
  const ids = round.ordemTurno;
  const n = ids.length;
  let idx = round.indiceTurno;
  for (let step = 0; step < n; step++) {
    idx = (idx + 1) % n;
    if ((round.contagemPalavras[ids[idx]] ?? 0) < PALAVRAS_POR_JOGADOR) {
      round.indiceTurno = idx;
      return;
    }
  }
  round.fase = "votacao";
  round.indiceTurno = 0;
}

/** @param {RoundState} round */
function iniciarResultado(round, sala) {
  const n = sala.players.size;
  const ids = [...sala.players.keys()];
  /** @type {Record<string, number>} */
  const votosPorJogador = {};
  for (const id of ids) votosPorJogador[id] = 0;
  for (const [, alvo] of round.votos) {
    if (alvo && votosPorJogador[alvo] !== undefined) votosPorJogador[alvo] += 1;
  }
  const votosNoImpostor = votosPorJogador[round.impostorId] ?? 0;
  const impostorPerdeu = votosNoImpostor > n / 2;

  round.fase = "resultado";
  round.resultado = {
    impostorId: round.impostorId,
    palavra: round.word,
    votosNoImpostor,
    votosPorJogador,
    impostorPerdeu,
  };

  round.mensagens.push({
    tipo: "sistema",
    texto: "Votação encerrada. Confira o resultado.",
    ts: Date.now(),
  });
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

  const extra = {
    lobbyMsgs: sala.round ? [] : sala.lobbyMsgs,
    faseRodada: /** @type {null | 'pistas' | 'votacao' | 'resultado'} */ (null),
    jogadorDaVezId: /** @type {string | null} */ (null),
    contagemPalavras: /** @type {Record<string, number>} */ ({}),
    mensagensRodada: /** @type {Array<{ tipo: string, texto: string, autorId?: string, autorNome?: string, ts: number }>} */ (
      []
    ),
    votacao: /** @type {null | { recebidos: number, total: number }} */ (null),
    resultado: /** @type {null | Record<string, unknown>} */ (null),
  };

  if (sala.round) {
    const r = sala.round;
    extra.faseRodada = r.fase;
    extra.jogadorDaVezId = jogadorDaVezId(r);
    extra.contagemPalavras = { ...r.contagemPalavras };
    extra.mensagensRodada = [...r.mensagens];
    extra.resultado = r.resultado;
    if (r.fase === "votacao") {
      extra.votacao = { recebidos: r.votos.size, total: sala.players.size };
    }
  }

  return {
    codigo,
    jogadores,
    donoId: sala.hostId,
    rodadaAtiva: !!sala.round,
    totalJogadores: sala.players.size,
    podeGerarPalavra:
      sala.players.size >= MIN_JOGADORES &&
      sala.players.size <= MAX_JOGADORES &&
      !sala.round,
    ...extra,
  };
}

function broadcastEstado(codigo) {
  const io = globalThis.__io;
  if (!io) return;
  const base = estadoPublicoDaSala(codigo);
  if (!base) return;
  io.to(codigo).emit("estadoSala", base);
}

function revelarParaSocket(socket, sala) {
  if (!sala.round) return { tipo: "aguardando" };
  if (socket.id === sala.round.impostorId) return { tipo: "impostor" };
  return { tipo: "palavra", palavra: sala.round.word };
}

function normalizarUmaPalavra(texto) {
  const t = String(texto ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!t) return "";
  const primeira = t.split(/\s+/)[0] ?? "";
  return primeira.slice(0, TEXTO_CHAT_MAX);
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
        sala.hostId = sala.players.keys().next().value;
      }
      if (sala.round && sala.round.fase === "pistas") {
        const ids = [...sala.players.keys()];
        if (todasPistasCompletas(sala.round, ids)) {
          sala.round.fase = "votacao";
        } else {
          while (
            jogadorDaVezId(sala.round) &&
            !sala.players.has(jogadorDaVezId(sala.round))
          ) {
            avancarTurnoPistas(sala.round);
            if (sala.round.fase !== "pistas") break;
          }
        }
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
      lobbyMsgs: [],
    });
    socket.join(codigo);
    salaAtual = codigo;
    broadcastEstado(codigo);
    const estado = estadoPublicoDaSala(codigo);
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

  socket.on("chatLobby", ({ texto }, cb) => {
    if (!salaAtual) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(salaAtual);
    if (!sala || sala.round) {
      cb?.({ ok: false, erro: "Chat livre só antes da rodada." });
      return;
    }
    const t = String(texto ?? "").trim().slice(0, TEXTO_CHAT_MAX);
    if (!t) {
      cb?.({ ok: false, erro: "Mensagem vazia." });
      return;
    }
    const p = sala.players.get(socket.id);
    sala.lobbyMsgs.push({
      autorId: socket.id,
      autorNome: p?.name ?? "Jogador",
      texto: t,
      ts: Date.now(),
    });
    if (sala.lobbyMsgs.length > 200) sala.lobbyMsgs.splice(0, sala.lobbyMsgs.length - 200);
    broadcastEstado(salaAtual);
    cb?.({ ok: true });
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
    const ordemTurno = embaralhar(ids);
    /** @type {Record<string, number>} */
    const contagemPalavras = {};
    for (const id of ids) contagemPalavras[id] = 0;

    sala.round = {
      word,
      impostorId,
      fase: "pistas",
      ordemTurno,
      indiceTurno: 0,
      contagemPalavras,
      mensagens: [
        {
          tipo: "sistema",
          texto: `Rodada de pistas: cada um envia ${PALAVRAS_POR_JOGADOR} palavras, uma de cada vez. Quem começa foi sorteado.`,
          ts: Date.now(),
        },
      ],
      votos: new Map(),
      resultado: null,
    };

    broadcastEstado(salaAtual);
    const rev = revelarParaSocket(socket, sala);
    io.to(salaAtual).emit("rodadaIniciada", { podeVerPalavra: true });
    socket.emit("revelacao", rev);
    cb?.({ ok: true, revelacao: rev });
  });

  socket.on("enviarPista", ({ texto }, cb) => {
    if (!salaAtual) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(salaAtual);
    if (!sala?.round || sala.round.fase !== "pistas") {
      cb?.({ ok: false, erro: "Não é hora de pistas." });
      return;
    }
    const ativo = jogadorDaVezId(sala.round);
    if (socket.id !== ativo) {
      cb?.({ ok: false, erro: "Aguarde a sua vez." });
      return;
    }
    const palavra = normalizarUmaPalavra(texto);
    if (!palavra) {
      cb?.({ ok: false, erro: "Digite uma palavra." });
      return;
    }
    const p = sala.players.get(socket.id);
    const nome = p?.name ?? "Jogador";
    sala.round.contagemPalavras[socket.id] =
      (sala.round.contagemPalavras[socket.id] ?? 0) + 1;
    sala.round.mensagens.push({
      tipo: "pista",
      autorId: socket.id,
      autorNome: nome,
      texto: palavra,
      ts: Date.now(),
    });

    const ids = [...sala.players.keys()];
    if (todasPistasCompletas(sala.round, ids)) {
      sala.round.fase = "votacao";
      sala.round.mensagens.push({
        tipo: "sistema",
        texto: "Todos deram suas pistas. Vote em quem acha que é o impostor.",
        ts: Date.now(),
      });
    } else {
      avancarTurnoPistas(sala.round);
    }

    broadcastEstado(salaAtual);
    cb?.({ ok: true });
  });

  socket.on("votar", ({ alvoId }, cb) => {
    if (!salaAtual) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(salaAtual);
    if (!sala?.round || sala.round.fase !== "votacao") {
      cb?.({ ok: false, erro: "Votação não está aberta." });
      return;
    }
    const alvo = String(alvoId || "");
    if (!sala.players.has(socket.id) || !sala.players.has(alvo)) {
      cb?.({ ok: false, erro: "Voto inválido." });
      return;
    }
    sala.round.votos.set(socket.id, alvo);
    broadcastEstado(salaAtual);

    if (sala.round.votos.size === sala.players.size) {
      iniciarResultado(sala.round, sala);
      broadcastEstado(salaAtual);
    }

    cb?.({ ok: true });
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
