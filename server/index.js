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
app.set("trust proxy", 1);
app.use(cors({ origin: true, credentials: true }));

/**
 * @typedef {{
 *   word: string,
 *   impostorId: string,
 *   fase: 'revelacao' | 'pistas' | 'votacao' | 'resultado',
 *   viramPalavra: Set<string>,
 *   ordemTurno: string[],
 *   turnoAtualId: string | null,
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
 *   modoSala: 'online' | 'presencial',
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

/** Chave estável por rede (IP do cliente) para lembrar nome no browser. */
function getClienteChave(socket) {
  const hdr = socket.handshake.headers["x-forwarded-for"];
  const first =
    typeof hdr === "string"
      ? hdr
          .split(",")[0]
          ?.trim()
          ?.replace(/^::ffff:/i, "") ?? ""
      : "";
  if (first) return first.slice(0, 128);
  const addr = socket.handshake.address || socket.conn?.remoteAddress || "unknown";
  return String(addr).replace(/^::ffff:/i, "").slice(0, 128);
}

function normalizarNomeComparacao(nome) {
  return String(nome ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** @returns {{ ok: true, nome: string } | { ok: false, erro: string }} */
function validarNomeEntrada(raw) {
  const nome = String(raw ?? "").trim().slice(0, 24);
  if (!nome) return { ok: false, erro: "Digite seu nome." };
  return { ok: true, nome };
}

/** @param {SalaState} sala */
function nomeJaUsadoPorOutro(sala, nomeNorm, excetoSessionId) {
  for (const [sid, p] of sala.players) {
    if (sid === excetoSessionId) continue;
    if (normalizarNomeComparacao(p.name) === nomeNorm) return true;
  }
  return false;
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
  const id = round.turnoAtualId;
  return id ?? null;
}

/** Ordem de turno só com jogadores ainda na sala (mantém ordem relativa). */
function ordemTurnoAtiva(round, sala) {
  return round.ordemTurno.filter((id) => sala.players.has(id));
}

/** @param {RoundState} round @param {SalaState} sala */
function todasPistasCompletas(round, sala) {
  const ordem = ordemTurnoAtiva(round, sala);
  return ordem.length > 0 && ordem.every((id) => (round.contagemPalavras[id] ?? 0) >= PALAVRAS_POR_JOGADOR);
}

/** Próximo na roda (depois de depoisDeSid) que ainda precisa enviar pistas. */
function proximoComPistasPendentes(r, sala, depoisDeSid) {
  const ordem = ordemTurnoAtiva(r, sala);
  const n = ordem.length;
  if (!n) return null;
  const start =
    depoisDeSid != null && ordem.includes(depoisDeSid)
      ? (ordem.indexOf(depoisDeSid) + 1) % n
      : 0;
  for (let k = 0; k < n; k++) {
    const sid = ordem[(start + k) % n];
    if ((r.contagemPalavras[sid] ?? 0) < PALAVRAS_POR_JOGADOR) return sid;
  }
  return null;
}

/**
 * Avança a vez a partir de quem acabou de enviar.
 * @param {SalaState} sala
 * @param {string} sessionIdQueEnviou
 */
function avancarTurnoAposPista(sala, sessionIdQueEnviou) {
  const r = sala.round;
  if (!r || r.fase !== "pistas") return;
  r.ordemTurno = r.ordemTurno.filter((id) => sala.players.has(id));
  const next = proximoComPistasPendentes(r, sala, sessionIdQueEnviou);
  if (next) {
    r.turnoAtualId = next;
    return;
  }
  r.fase = "votacao";
  r.turnoAtualId = null;
  r.mensagens.push({
    tipo: "sistema",
    texto: "Todos deram suas pistas. Vote em quem acha que é o impostor.",
    ts: Date.now(),
  });
}

function todosViramPalavra(sala, round) {
  for (const sid of sala.players.keys()) {
    if (!round.viramPalavra.has(sid)) return false;
  }
  return sala.players.size > 0;
}

function tentarIniciarPistasAposRevelacao(sala, codigo) {
  const r = sala.round;
  if (!r || r.fase !== "revelacao") return;
  if (!todosViramPalavra(sala, r)) return;
  const io = globalThis.__io;

  if ((sala.modoSala ?? "online") === "presencial") {
    r.fase = "votacao";
    r.turnoAtualId = null;
    r.mensagens.push({
      tipo: "sistema",
      texto:
        "Modo presencial: joguem à mesa com a palavra (ou o impostor sem ela). Quando quiserem, votem abaixo.",
      ts: Date.now(),
    });
    if (io) io.to(codigo).emit("rodadaIniciada", { faseVotacao: true });
    return;
  }

  r.fase = "pistas";
  const idsAtuais = [...sala.players.keys()];
  r.ordemTurno = embaralhar(idsAtuais);
  for (const id of idsAtuais) {
    if (r.contagemPalavras[id] === undefined) r.contagemPalavras[id] = 0;
  }
  r.indiceTurno = 0;
  r.turnoAtualId = proximoComPistasPendentes(r, sala, null);
  r.mensagens.push({
    tipo: "sistema",
    texto: "Todos viram a palavra (ou o papel de impostor). Comecem as pistas!",
    ts: Date.now(),
  });
  r.mensagens.push({
    tipo: "sistema",
    texto: `Cada um envia ${PALAVRAS_POR_JOGADOR} palavras, uma de cada vez. A ordem foi sorteada.`,
    ts: Date.now(),
  });
  garantirTurnoComSocket(sala);
  if (io) io.to(codigo).emit("rodadaIniciada", { fasePistas: true });
}

/**
 * Se quem deveria jogar está sem socket ou já completou pistas, ajusta o índice (sem somar palavra).
 * @param {SalaState} sala
 */
/** Primeiro jogador online na roda a partir de startAfter (exclusivo) com pistas pendentes. */
function primeiroOnlineComPistasPendentes(r, sala, startAfterSid) {
  const ordem = ordemTurnoAtiva(r, sala);
  const n = ordem.length;
  if (!n) return null;
  const start =
    startAfterSid != null && ordem.includes(startAfterSid)
      ? (ordem.indexOf(startAfterSid) + 1) % n
      : 0;
  for (let k = 0; k < n; k++) {
    const sid = ordem[(start + k) % n];
    if (!sala.sessionSocket.has(sid)) continue;
    if ((r.contagemPalavras[sid] ?? 0) < PALAVRAS_POR_JOGADOR) return sid;
  }
  return null;
}

function garantirTurnoComSocket(sala) {
  const r = sala.round;
  if (!r || r.fase !== "pistas") return;
  if (sala.sessionSocket.size === 0) return;
  r.ordemTurno = r.ordemTurno.filter((id) => sala.players.has(id));
  const cur = r.turnoAtualId;
  if (
    cur &&
    sala.players.has(cur) &&
    sala.sessionSocket.has(cur) &&
    (r.contagemPalavras[cur] ?? 0) < PALAVRAS_POR_JOGADOR
  ) {
    return;
  }

  const next = primeiroOnlineComPistasPendentes(r, sala, cur);
  if (next) {
    r.turnoAtualId = next;
    return;
  }
  if (todasPistasCompletas(r, sala)) {
    r.fase = "votacao";
    r.turnoAtualId = null;
    r.mensagens.push({
      tipo: "sistema",
      texto: "Todos deram suas pistas. Vote em quem acha que é o impostor.",
      ts: Date.now(),
    });
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

  const modo = sala.modoSala ?? "online";
  const extra = {
    modoSala: modo,
    lobbyMsgs: sala.round || modo !== "online" ? [] : sala.lobbyMsgs,
    faseRodada: /** @type {null | "revelacao" | "pistas" | "votacao" | "resultado"} */ (null),
    jogadorDaVezId: /** @type {string | null} */ (null),
    contagemPalavras: /** @type {Record<string, number>} */ ({}),
    mensagensRodada: /** @type {Array<{ tipo: string, texto: string, autorId?: string, autorNome?: string, ts: number }>} */ (
      []
    ),
    viramPalavraIds: /** @type {string[]} */ ([]),
    votacao: /** @type {null | { recebidos: number, total: number }} */ (null),
    resultado: /** @type {null | Record<string, unknown>} */ (null),
  };

  if (sala.round) {
    const r = sala.round;
    extra.faseRodada = r.fase;
    extra.viramPalavraIds = [...r.viramPalavra];
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
    r.viramPalavra.delete(sessionId);
    if (r.fase === "revelacao") {
      tentarIniciarPistasAposRevelacao(sala, codigo);
    } else if (r.fase === "pistas") {
      if (todasPistasCompletas(r, sala)) {
        r.fase = "votacao";
        r.turnoAtualId = null;
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

  socket.emit("clienteChave", { chave: getClienteChave(socket) });

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
    const v = validarNomeEntrada(name);
    if (!v.ok) {
      cb?.(v);
      return;
    }
    const nomeNorm = normalizarNomeComparacao(v.nome);

    if (sala.players.has(sid)) {
      if (nomeJaUsadoPorOutro(sala, nomeNorm, sid)) {
        cb?.({ ok: false, erro: "Já existe outro jogador com esse nome na sala." });
        return;
      }
      sala.players.get(sid).name = v.nome;
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

    if (nomeJaUsadoPorOutro(sala, nomeNorm, sid)) {
      cb?.({ ok: false, erro: "Já existe um jogador com esse nome na sala." });
      return;
    }

    sala.players.set(sid, { name: v.nome });
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

  socket.on("criarSala", ({ nome, sessionId, modoSala }, cb) => {
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
    const v = validarNomeEntrada(nome);
    if (!v.ok) {
      cb?.(v);
      return;
    }
    const name = v.nome;
    const modo =
      modoSala === "presencial" || modoSala === "online" ? modoSala : "online";
    salas.set(codigo, {
      hostSessionId: sid,
      players: new Map([[sid, { name }]]),
      sessionSocket: new Map(),
      disconnectTimers: new Map(),
      round: null,
      lobbyMsgs: [],
      modoSala: modo,
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
    if ((sala.modoSala ?? "online") !== "online") {
      cb?.({ ok: false, erro: "Esta sala é presencial — sem chat no lobby." });
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

    const msgInicial =
      (sala.modoSala ?? "online") === "presencial"
        ? "O dono definiu a palavra secreta. Cada jogador deve clicar em Ver palavra (ou ver se é o impostor). Modo presencial: depois joguem à mesa; quando quiserem, votem no app."
        : "O dono definiu a palavra secreta. Cada jogador deve clicar em Ver palavra (ou ver se é o impostor). Quando todos tiverem visto, começam as pistas no chat.";

    sala.round = {
      word,
      impostorId,
      fase: "revelacao",
      viramPalavra: new Set([sid]),
      ordemTurno,
      indiceTurno: 0,
      turnoAtualId: null,
      contagemPalavras,
      mensagens: [
        {
          tipo: "sistema",
          texto: msgInicial,
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
    if ((sala.modoSala ?? "online") === "presencial") {
      cb?.({ ok: false, erro: "Modo presencial — as pistas são à mesa, não pelo app." });
      return;
    }
    if ((sala.round.contagemPalavras[sid] ?? 0) >= PALAVRAS_POR_JOGADOR) {
      cb?.({ ok: false, erro: "Você já enviou todas as suas palavras nesta rodada." });
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

    if (todasPistasCompletas(sala.round, sala)) {
      sala.round.fase = "votacao";
      sala.round.turnoAtualId = null;
      sala.round.mensagens.push({
        tipo: "sistema",
        texto: "Todos deram suas pistas. Vote em quem acha que é o impostor.",
        ts: Date.now(),
      });
    } else {
      avancarTurnoAposPista(sala, sid);
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
    const r = sala?.round;
    if (!sala || !r) {
      cb?.({ ok: false, erro: "Ainda não há palavra nesta rodada." });
      return;
    }
    if (sid === sala.hostSessionId) {
      cb?.({ ok: false, erro: "O dono já vê o resultado ao gerar a palavra." });
      return;
    }
    if (r.fase === "votacao" || r.fase === "resultado") {
      cb?.({ ok: false, erro: "Não é possível ver agora." });
      return;
    }
    if (r.fase === "revelacao") {
      r.viramPalavra.add(sid);
      tentarIniciarPistasAposRevelacao(sala, meta.codigo);
      const rev = revelarParaSessao(sid, sala);
      broadcastEstado(meta.codigo);
      cb?.({ ok: true, revelacao: rev });
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
