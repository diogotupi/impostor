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
/** Tempo que o jogador permanece na sala sem socket (aba em segundo plano / rede instável). */
const GRACE_MS = Number(process.env.SALA_GRACE_MS) || 8 * 60 * 1000;

const app = express();
app.use(cors({ origin: true, credentials: true }));

/**
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

/**
 * @typedef {{
 *   hostSessionId: string,
 *   players: Map<string, { name: string }>,
 *   sessionSocket: Map<string, string>,
 *   disconnectTimers: Map<string, ReturnType<typeof setTimeout>>,
 *   round: RoundState | null,
 *   lobbyMsgs: Array<{ autorId: string, autorNome: string, texto: string, ts: number }>,
 * }} SalaState
 */

/** @type {Map<string, SalaState>} */
const salas = new Map();

function codigoSala() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return salas.has(s) ? codigoSala() : s;
}

function normalizarSessionId(s) {
  const t = String(s ?? "").trim();
  if (t.length < 8 || t.length > 120) return null;
  return t;
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
function todasPistasCompletas(round, sessionIds) {
  return sessionIds.every((id) => (round.contagemPalavras[id] ?? 0) >= PALAVRAS_POR_JOGADOR);
}

/** @param {RoundState} round */
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

/**
 * Se quem deveria jogar está sem socket, passa o turno até alguém online ou fim da fase.
 * @param {SalaState} sala
 */
function garantirTurnoComSocket(sala) {
  const r = sala.round;
  if (!r || r.fase !== "pistas") return;
  if (sala.sessionSocket.size === 0) return;
  let guard = 0;
  while (guard++ <= r.ordemTurno.length + 2) {
    const cur = jogadorDaVezId(r);
    if (!cur) return;
    if (sala.sessionSocket.has(cur)) return;
    avancarTurnoPistas(r);
    if (r.fase !== "pistas") {
      if (r.fase === "votacao") {
        r.mensagens.push({
          tipo: "sistema",
          texto: "Todos deram suas pistas. Vote em quem acha que é o impostor.",
          ts: Date.now(),
        });
      }
      return;
    }
  }
}

function cancelGraceTimer(sala, sessionId) {
  const t = sala.disconnectTimers.get(sessionId);
  if (t) clearTimeout(t);
  sala.disconnectTimers.delete(sessionId);
}

/**
 * @param {import("socket.io").Socket} socket
 * @param {SalaState} sala
 * @param {string} codigo
 * @param {string} sessionId
 */
function anexarSocketASessao(socket, sala, codigo, sessionId) {
  const prev = sala.sessionSocket.get(sessionId);
  if (prev && prev !== socket.id) {
    const oldSock = globalThis.__io?.sockets?.sockets?.get(prev);
    if (oldSock) {
      oldSock.emit("sessaoSubstituida");
      oldSock.leave(codigo);
      oldSock.data.impostor = undefined;
    }
  }
  sala.sessionSocket.set(sessionId, socket.id);
  socket.data.impostor = { codigo, sessionId };
  socket.join(codigo);
  cancelGraceTimer(sala, sessionId);
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

/** Todos os jogadores com socket ativo já votaram. */
function todosOnlineJaVotaram(sala, round) {
  for (const sess of sala.players.keys()) {
    if (!sala.sessionSocket.has(sess)) continue;
    if (!round.votos.has(sess)) return false;
  }
  return sala.sessionSocket.size > 0;
}

function estadoPublicoDaSala(codigo) {
  const sala = salas.get(codigo);
  if (!sala) return null;
  const jogadores = [];
  for (const [sessionId, p] of sala.players) {
    jogadores.push({
      id: sessionId,
      nome: p.name,
      dono: sessionId === sala.hostSessionId,
      online: sala.sessionSocket.has(sessionId),
    });
  }

  const extra = {
    lobbyMsgs: sala.round ? [] : sala.lobbyMsgs,
    faseRodada: /** @type {null | "pistas" | "votacao" | "resultado"} */ (null),
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
      const online = [...sala.players.keys()].filter((s) => sala.sessionSocket.has(s)).length;
      extra.votacao = { recebidos: r.votos.size, total: Math.max(online, 1) };
    }
  }

  return {
    codigo,
    jogadores,
    donoId: sala.hostSessionId,
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

/** @param {string} sessionId */
function revelarParaSessao(sessionId, sala) {
  if (!sala.round) return { tipo: "aguardando" };
  if (sessionId === sala.round.impostorId) return { tipo: "impostor" };
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

/**
 * Remove jogador: sessão, timers, ajusta host e rodada.
 * @param {string} codigo
 * @param {string} sessionId
 */
function removerJogadorDaSala(codigo, sessionId) {
  const sala = salas.get(codigo);
  if (!sala || !sala.players.has(sessionId)) return;

  cancelGraceTimer(sala, sessionId);
  sala.players.delete(sessionId);
  sala.sessionSocket.delete(sessionId);

  if (sala.players.size === 0) {
    salas.delete(codigo);
    return;
  }

  if (sala.hostSessionId === sessionId) {
    sala.hostSessionId = sala.players.keys().next().value;
  }

  if (sala.round) {
    const r = sala.round;
    if (r.fase === "pistas") {
      const ids = [...sala.players.keys()];
      if (todasPistasCompletas(r, ids)) {
        r.fase = "votacao";
        r.mensagens.push({
          tipo: "sistema",
          texto: "Todos deram suas pistas. Vote em quem acha que é o impostor.",
          ts: Date.now(),
        });
      } else {
        garantirTurnoComSocket(sala);
      }
    }
    r.votos.delete(sessionId);
    for (const [v, alvo] of [...r.votos]) {
      if (alvo === sessionId) r.votos.delete(v);
    }
  }

  broadcastEstado(codigo);
}

function agendarRemocaoPorDesconexao(codigo, sessionId) {
  const sala = salas.get(codigo);
  if (!sala || !sala.players.has(sessionId)) return;

  cancelGraceTimer(sala, sessionId);
  const tid = setTimeout(() => {
    sala.disconnectTimers.delete(sessionId);
    if (sala.sessionSocket.has(sessionId)) return;
    removerJogadorDaSala(codigo, sessionId);
  }, GRACE_MS);
  sala.disconnectTimers.set(sessionId, tid);
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  pingInterval: 25000,
  pingTimeout: 120000,
  connectTimeout: 60000,
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

  function sairDaSalaExplicito() {
    const meta = socket.data.impostor;
    if (!meta) return;
    const { codigo, sessionId } = meta;
    socket.leave(codigo);
    socket.data.impostor = undefined;
    removerJogadorDaSala(codigo, sessionId);
    salaAtual = null;
  }

  socket.on("disconnect", () => {
    const meta = socket.data.impostor;
    if (!meta) return;
    const { codigo, sessionId } = meta;
    const sala = salas.get(codigo);
    if (!sala) return;
    if (sala.sessionSocket.get(sessionId) !== socket.id) return;
    sala.sessionSocket.delete(sessionId);
    socket.data.impostor = undefined;
    garantirTurnoComSocket(sala);
    agendarRemocaoPorDesconexao(codigo, sessionId);
    broadcastEstado(codigo);
    salaAtual = null;
  });

  /**
   * @param {string} codigo
   * @param {string} sessionId
   * @param {string} name
   * @param {(r: any) => void} [cb]
   */
  function entrarOuRetomar(codigo, sessionId, name, cb) {
    const c = String(codigo || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    if (!c || c.length !== 6) {
      cb?.({ ok: false, erro: "Código inválido. Use 6 caracteres." });
      return;
    }
    const sid = normalizarSessionId(sessionId);
    if (!sid) {
      cb?.({ ok: false, erro: "Identificador de sessão inválido. Atualize a página." });
      return;
    }
    const sala = salas.get(c);
    if (!sala) {
      cb?.({ ok: false, erro: "Sala não encontrada." });
      return;
    }
    const nome = (name || "Jogador").trim().slice(0, 24) || "Jogador";

    if (sala.players.has(sid)) {
      sala.players.get(sid).name = nome;
      anexarSocketASessao(socket, sala, c, sid);
      salaAtual = c;
      garantirTurnoComSocket(sala);
      broadcastEstado(c);
      const estado = estadoPublicoDaSala(c);
      cb?.({
        ok: true,
        codigo: c,
        estado,
        voceEhDono: sid === sala.hostSessionId,
      });
      return;
    }

    if (sala.players.size >= MAX_JOGADORES) {
      cb?.({ ok: false, erro: "Sala cheia (máximo 10 jogadores)." });
      return;
    }

    sala.players.set(sid, { name: nome });
    anexarSocketASessao(socket, sala, c, sid);
    salaAtual = c;
    broadcastEstado(c);
    const estado = estadoPublicoDaSala(c);
    cb?.({
      ok: true,
      codigo: c,
      estado,
      voceEhDono: sid === sala.hostSessionId,
    });
  }

  socket.on("criarSala", ({ nome, sessionId }, cb) => {
    const meta = socket.data.impostor;
    if (meta?.codigo) {
      socket.leave(meta.codigo);
      socket.data.impostor = undefined;
      removerJogadorDaSala(meta.codigo, meta.sessionId);
    }
    const sid = normalizarSessionId(sessionId);
    if (!sid) {
      cb?.({ ok: false, erro: "Identificador de sessão inválido. Atualize a página." });
      return;
    }
    const codigo = codigoSala();
    const name = (nome || "Jogador").trim().slice(0, 24) || "Jogador";
    salas.set(codigo, {
      hostSessionId: sid,
      players: new Map([[sid, { name }]]),
      sessionSocket: new Map(),
      disconnectTimers: new Map(),
      round: null,
      lobbyMsgs: [],
    });
    const sala = salas.get(codigo);
    anexarSocketASessao(socket, sala, codigo, sid);
    salaAtual = codigo;
    broadcastEstado(codigo);
    cb?.({ ok: true, codigo, estado: estadoPublicoDaSala(codigo), voceEhDono: true });
  });

  socket.on("entrarSala", ({ codigo, nome, sessionId }, cb) => {
    const prev = socket.data.impostor;
    if (prev?.codigo) {
      socket.leave(prev.codigo);
      socket.data.impostor = undefined;
      const s = salas.get(prev.codigo);
      if (s?.sessionSocket.get(prev.sessionId) === socket.id) {
        s.sessionSocket.delete(prev.sessionId);
        garantirTurnoComSocket(s);
        agendarRemocaoPorDesconexao(prev.codigo, prev.sessionId);
        broadcastEstado(prev.codigo);
      }
    }
    entrarOuRetomar(codigo, sessionId, nome, cb);
  });

  socket.on("chatLobby", ({ texto }, cb) => {
    const meta = socket.data.impostor;
    if (!meta) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(meta.codigo);
    if (!sala || sala.round) {
      cb?.({ ok: false, erro: "Chat livre só antes da rodada." });
      return;
    }
    const t = String(texto ?? "").trim().slice(0, TEXTO_CHAT_MAX);
    if (!t) {
      cb?.({ ok: false, erro: "Mensagem vazia." });
      return;
    }
    const sid = meta.sessionId;
    const p = sala.players.get(sid);
    sala.lobbyMsgs.push({
      autorId: sid,
      autorNome: p?.name ?? "Jogador",
      texto: t,
      ts: Date.now(),
    });
    if (sala.lobbyMsgs.length > 200) sala.lobbyMsgs.splice(0, sala.lobbyMsgs.length - 200);
    broadcastEstado(meta.codigo);
    cb?.({ ok: true });
  });

  socket.on("gerarPalavra", (cb) => {
    const meta = socket.data.impostor;
    if (!meta) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(meta.codigo);
    const sid = meta.sessionId;
    if (!sala || sala.hostSessionId !== sid) {
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

    const c = meta.codigo;
    broadcastEstado(c);
    const rev = revelarParaSessao(sid, sala);
    io.to(c).emit("rodadaIniciada", { podeVerPalavra: true });
    socket.emit("revelacao", rev);
    cb?.({ ok: true, revelacao: rev });
  });

  socket.on("enviarPista", ({ texto }, cb) => {
    const meta = socket.data.impostor;
    if (!meta) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(meta.codigo);
    const sid = meta.sessionId;
    if (!sala?.round || sala.round.fase !== "pistas") {
      cb?.({ ok: false, erro: "Não é hora de pistas." });
      return;
    }
    const ativo = jogadorDaVezId(sala.round);
    if (sid !== ativo) {
      cb?.({ ok: false, erro: "Aguarde a sua vez." });
      return;
    }
    const palavra = normalizarUmaPalavra(texto);
    if (!palavra) {
      cb?.({ ok: false, erro: "Digite uma palavra." });
      return;
    }
    const p = sala.players.get(sid);
    const nome = p?.name ?? "Jogador";
    sala.round.contagemPalavras[sid] = (sala.round.contagemPalavras[sid] ?? 0) + 1;
    sala.round.mensagens.push({
      tipo: "pista",
      autorId: sid,
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
      garantirTurnoComSocket(sala);
    }

    broadcastEstado(meta.codigo);
    cb?.({ ok: true });
  });

  socket.on("votar", ({ alvoId }, cb) => {
    const meta = socket.data.impostor;
    if (!meta) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(meta.codigo);
    const sid = meta.sessionId;
    if (!sala?.round || sala.round.fase !== "votacao") {
      cb?.({ ok: false, erro: "Votação não está aberta." });
      return;
    }
    const alvo = String(alvoId || "");
    if (!sala.players.has(sid) || !sala.players.has(alvo)) {
      cb?.({ ok: false, erro: "Voto inválido." });
      return;
    }
    sala.round.votos.set(sid, alvo);
    broadcastEstado(meta.codigo);

    if (todosOnlineJaVotaram(sala, sala.round)) {
      iniciarResultado(sala.round, sala);
      broadcastEstado(meta.codigo);
    }

    cb?.({ ok: true });
  });

  socket.on("verPalavra", (cb) => {
    const meta = socket.data.impostor;
    if (!meta) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(meta.codigo);
    const sid = meta.sessionId;
    if (!sala || !sala.round) {
      cb?.({ ok: false, erro: "Ainda não há palavra nesta rodada." });
      return;
    }
    if (sid === sala.hostSessionId) {
      cb?.({ ok: false, erro: "O dono já vê o resultado ao gerar a palavra." });
      return;
    }
    const rev = revelarParaSessao(sid, sala);
    cb?.({ ok: true, revelacao: rev });
  });

  socket.on("finalizarPartida", (cb) => {
    const meta = socket.data.impostor;
    if (!meta) {
      cb?.({ ok: false, erro: "Você não está em uma sala." });
      return;
    }
    const sala = salas.get(meta.codigo);
    const sid = meta.sessionId;
    if (!sala || sala.hostSessionId !== sid) {
      cb?.({ ok: false, erro: "Apenas o dono pode finalizar a partida." });
      return;
    }
    if (!sala.round) {
      cb?.({ ok: false, erro: "Não há partida ativa." });
      return;
    }
    sala.round = null;
    io.to(meta.codigo).emit("rodadaEncerrada");
    broadcastEstado(meta.codigo);
    cb?.({ ok: true });
  });

  socket.on("sairSala", () => {
    sairDaSalaExplicito();
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
