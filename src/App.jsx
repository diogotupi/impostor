import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : "");

function socketUrl() {
  return SOCKET_URL || window.location.origin;
}

const ROOM_STORAGE_KEY = "impostor-sala-atual";
const SESSION_STORAGE_KEY = "impostor-session-id";

function ensureSessionId() {
  try {
    let id = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!id || id.length < 8) {
      id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `s-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      localStorage.setItem(SESSION_STORAGE_KEY, id);
    }
    return id;
  } catch {
    return `s-${Date.now()}`;
  }
}

const PALAVRAS_POR_JOGADOR = 3;

export default function App() {
  const [nome, setNome] = useState(() => localStorage.getItem("impostor-nome") || "");
  const [codigoEntrada, setCodigoEntrada] = useState("");
  const [erro, setErro] = useState("");
  const [socket, setSocket] = useState(null);
  const [conectado, setConectado] = useState(false);
  const [sala, setSala] = useState(null);
  const [voceEhDono, setVoceEhDono] = useState(false);
  const [rodadaAtiva, setRodadaAtiva] = useState(false);
  const [podeVerPalavra, setPodeVerPalavra] = useState(false);
  const [revelacao, setRevelacao] = useState(null);
  const [clicouVerPalavra, setClicouVerPalavra] = useState(false);
  const [lobbyInput, setLobbyInput] = useState("");
  const [pistaInput, setPistaInput] = useState("");
  const [jaVotei, setJaVotei] = useState(false);
  const [copiouCodigo, setCopiouCodigo] = useState(false);
  const [resultadoOverlayFechado, setResultadoOverlayFechado] = useState(false);
  const chatRef = useRef(null);
  const donoRef = useRef(false);
  const faseAnteriorRef = useRef(null);

  useEffect(() => {
    donoRef.current = voceEhDono;
  }, [voceEhDono]);

  useEffect(() => {
    localStorage.setItem("impostor-nome", nome);
  }, [nome]);

  const limparRodadaUi = useCallback(() => {
    setRodadaAtiva(false);
    setPodeVerPalavra(false);
    setRevelacao(null);
    setClicouVerPalavra(false);
    setPistaInput("");
    setJaVotei(false);
  }, []);

  useEffect(() => {
    const s = io(socketUrl(), {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 800,
      reconnectionDelayMax: 15000,
      timeout: 60000,
    });
    setSocket(s);

    const applyEstado = (estado) => {
      if (!estado) return;
      const faseNova = estado.rodadaAtiva ? estado.faseRodada : null;
      const fasePrev = faseAnteriorRef.current;
      if (faseNova === "votacao" && fasePrev === "pistas") setJaVotei(false);
      if (!estado.rodadaAtiva) {
        limparRodadaUi();
        faseAnteriorRef.current = null;
      } else {
        faseAnteriorRef.current = faseNova ?? null;
        setRodadaAtiva(true);
        setPodeVerPalavra(true);
      }
      const sid = ensureSessionId();
      if (estado.donoId) setVoceEhDono(estado.donoId === sid);
      setSala(estado);
    };

    const retomarSalaSeHouver = () => {
      const raw = localStorage.getItem(ROOM_STORAGE_KEY);
      const codigo = String(raw ?? "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
      if (codigo.length !== 6) return;
      const sessionId = ensureSessionId();
      const nomeRetomada = localStorage.getItem("impostor-nome") || "";
      s.emit(
        "entrarSala",
        { codigo, nome: nomeRetomada, sessionId },
        (res) => {
          if (!res?.ok) {
            localStorage.removeItem(ROOM_STORAGE_KEY);
            return;
          }
          applyEstado(res.estado);
        },
      );
    };

    s.on("connect", () => {
      setConectado(true);
      retomarSalaSeHouver();
    });
    s.on("disconnect", () => {
      setConectado(false);
    });
    s.on("sessaoSubstituida", () => {
      localStorage.removeItem(ROOM_STORAGE_KEY);
      setSala(null);
      setVoceEhDono(false);
      limparRodadaUi();
      setErro("Esta sessão foi aberta em outro dispositivo ou aba.");
    });
    s.on("estadoSala", applyEstado);
    s.on("rodadaIniciada", () => {
      setRodadaAtiva(true);
      setResultadoOverlayFechado(false);
      setPodeVerPalavra(true);
      setJaVotei(false);
      if (!donoRef.current) {
        setRevelacao(null);
        setClicouVerPalavra(false);
      }
    });
    s.on("rodadaEncerrada", () => {
      limparRodadaUi();
    });
    s.on("revelacao", (rev) => setRevelacao(rev));
    s.on("saiuDaSala", () => {
      localStorage.removeItem(ROOM_STORAGE_KEY);
      setSala(null);
      setVoceEhDono(false);
      limparRodadaUi();
    });

    const onVis = () => {
      if (document.visibilityState === "visible" && !s.connected) s.connect();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      s.removeAllListeners();
      s.close();
    };
  }, [limparRodadaUi]);

  useEffect(() => {
    if (sala?.faseRodada !== "resultado") setResultadoOverlayFechado(false);
  }, [sala?.faseRodada]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: "smooth" });
  }, [
    sala?.lobbyMsgs,
    sala?.mensagensRodada,
    sala?.faseRodada,
    rodadaAtiva,
  ]);

  const entrarLobby = useMemo(() => !sala, [sala]);

  const criarSala = () => {
    setErro("");
    if (!socket?.connected) {
      setErro("Aguardando conexão…");
      return;
    }
    const sessionId = ensureSessionId();
    socket.emit("criarSala", { nome, sessionId }, (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Não foi possível criar a sala.");
        return;
      }
      localStorage.setItem(ROOM_STORAGE_KEY, res.codigo);
      setSala(res.estado);
      setVoceEhDono(true);
      limparRodadaUi();
    });
  };

  const entrarSala = () => {
    setErro("");
    if (!socket?.connected) {
      setErro("Aguardando conexão…");
      return;
    }
    const c = codigoEntrada.trim().toUpperCase();
    if (c.length !== 6) {
      setErro("Digite o código de 6 caracteres.");
      return;
    }
    const sessionId = ensureSessionId();
    socket.emit("entrarSala", { codigo: c, nome, sessionId }, (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Não foi possível entrar.");
        return;
      }
      localStorage.setItem(ROOM_STORAGE_KEY, c);
      setSala(res.estado);
      setVoceEhDono(!!res.voceEhDono);
      if (!res.estado?.rodadaAtiva) limparRodadaUi();
      else {
        setRodadaAtiva(true);
        setPodeVerPalavra(true);
        if (!res.voceEhDono) {
          setRevelacao(null);
          setClicouVerPalavra(false);
        }
      }
    });
  };

  const gerarPalavra = () => {
    setErro("");
    socket.emit("gerarPalavra", (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Erro ao gerar palavra.");
        return;
      }
      if (res.revelacao) setRevelacao(res.revelacao);
      setRodadaAtiva(true);
      setPodeVerPalavra(true);
    });
  };

  const verPalavra = () => {
    setErro("");
    socket.emit("verPalavra", (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Não foi possível revelar.");
        return;
      }
      setRevelacao(res.revelacao);
      setClicouVerPalavra(true);
    });
  };

  const finalizarPartida = () => {
    setErro("");
    socket.emit("finalizarPartida", (res) => {
      if (!res?.ok) setErro(res?.erro || "Erro ao finalizar.");
    });
  };

  const sairSala = () => {
    setErro("");
    localStorage.removeItem(ROOM_STORAGE_KEY);
    socket.emit("sairSala");
    setSala(null);
    setVoceEhDono(false);
    limparRodadaUi();
  };

  const enviarLobby = (e) => {
    e.preventDefault();
    setErro("");
    const t = lobbyInput.trim();
    if (!t) return;
    socket.emit("chatLobby", { texto: t }, (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Não enviado.");
        return;
      }
      setLobbyInput("");
    });
  };

  const enviarPista = (e) => {
    e.preventDefault();
    setErro("");
    const t = pistaInput.trim();
    if (!t) return;
    socket.emit("enviarPista", { texto: t }, (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Não enviado.");
        return;
      }
      setPistaInput("");
    });
  };

  const votarEm = (alvoId) => {
    setErro("");
    socket.emit("votar", { alvoId }, (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Voto inválido.");
        return;
      }
      setJaVotei(true);
    });
  };

  const fase = sala?.faseRodada ?? null;
  const meuSessionId = ensureSessionId();
  const minhaVezPista = Boolean(
    rodadaAtiva &&
      fase === "pistas" &&
      sala?.jogadorDaVezId &&
      meuSessionId === sala.jogadorDaVezId,
  );
  const resultado = sala?.resultado ?? null;
  const nomeJogador = (id) =>
    sala?.jogadores?.find((j) => j.id === id)?.nome ?? "?";

  const votacaoInfo = sala?.votacao ?? null;

  const copiarCodigo = async () => {
    const c = sala?.codigo;
    if (!c) return;
    setErro("");
    try {
      await navigator.clipboard.writeText(c);
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = c;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        setErro("Não foi possível copiar o código.");
        return;
      }
    }
    setCopiouCodigo(true);
    window.setTimeout(() => setCopiouCodigo(false), 2000);
  };

  const mostrarOverlayResultado =
    fase === "resultado" &&
    resultado &&
    rodadaAtiva &&
    !resultadoOverlayFechado;

  return (
    <div className="app">
      <header className="header">
        <p className="eyebrow">
          <span className="slash">/</span> salas em tempo real <span className="slash">/</span>
        </p>
        <h1 className="logo">
          <span className="logo-core">Impostor</span>
        </h1>
        <p className="tagline">
          Uma palavra em comum <span className="tagline-slash">/</span>{" "}
          <span className="tagline-accent">menos para um</span> de vocês
        </p>
        {!conectado && (
          <span className="badge warn">
            <span className="badge-dot" aria-hidden />
            Conectando…
          </span>
        )}
      </header>

      <main className="main wide">
        {entrarLobby ? (
          <section className="card glass">
            <label className="label" htmlFor="nome">
              Seu nome (opcional)
            </label>
            <input
              id="nome"
              className="input"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ex.: Ana"
              maxLength={24}
            />

            <div className="divider" />

            <button type="button" className="btn primary block" onClick={criarSala}>
              Gerar sala
            </button>
            <p className="hint">Cria um código para amigos entrarem. Você será o dono da sala.</p>

            <div className="divider" />

            <label className="label" htmlFor="codigo">
              Entrar em sala
            </label>
            <div className="row">
              <input
                id="codigo"
                className="input grow"
                value={codigoEntrada}
                onChange={(e) => setCodigoEntrada(e.target.value.toUpperCase())}
                placeholder="Código"
                maxLength={8}
                autoCapitalize="characters"
              />
              <button type="button" className="btn primary" onClick={entrarSala}>
                Entrar
              </button>
            </div>

            {erro && <p className="erro">{erro}</p>}
          </section>
        ) : (
          <section className="card glass sala">
            <div className="sala-top">
              <div className="sala-top-codigo">
                <p className="label">Código da sala</p>
                <div className="codigo-row">
                  <p className="codigo-grande">{sala?.codigo}</p>
                  <button
                    type="button"
                    className="btn secondary btn-copiar"
                    onClick={copiarCodigo}
                    aria-label="Copiar código da sala"
                  >
                    {copiouCodigo ? "Copiado!" : "Copiar"}
                  </button>
                </div>
              </div>
              <button type="button" className="btn ghost" onClick={sairSala}>
                Sair
              </button>
            </div>

            <p className="hint">
              Mínimo de 3 jogadores para gerar palavra. Máximo 10 na sala. Após liberar a
              palavra, cada um diz {PALAVRAS_POR_JOGADOR} pistas ({PALAVRAS_POR_JOGADOR}{" "}
              palavras), um de cada vez, em ordem sorteada.
            </p>

            <div className="lista-jogadores">
              <p className="label">Jogadores ({sala?.jogadores?.length ?? 0})</p>
              <ul>
                {sala?.jogadores?.map((j) => (
                  <li key={j.id}>
                    {j.nome}
                    {j.online === false ? <span className="pill warn">Ausente</span> : null}
                    {j.dono ? <span className="pill">Dono</span> : null}
                    {fase === "pistas" && rodadaAtiva && (
                      <span className="pill faint">
                        {sala?.contagemPalavras?.[j.id] ?? 0}/{PALAVRAS_POR_JOGADOR} pistas
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="chat">
              <p className="label">Chat da sala</p>
              <div className="chat-log" ref={chatRef}>
                {!rodadaAtiva &&
                  (sala?.lobbyMsgs ?? []).map((m) => (
                    <div key={`${m.ts}-${m.autorId}`} className="msg lobby">
                      <span className="msg-autor">{m.autorNome}:</span> {m.texto}
                    </div>
                  ))}
                {rodadaAtiva &&
                  (sala?.mensagensRodada ?? []).map((m, i) => (
                    <div
                      key={`${m.ts}-${i}`}
                      className={`msg ${m.tipo === "sistema" ? "sistema" : "pista"}`}
                    >
                      {m.tipo === "sistema" ? (
                        m.texto
                      ) : (
                        <>
                          <span className="msg-autor">{m.autorNome}:</span>{" "}
                          <strong>{m.texto}</strong>
                        </>
                      )}
                    </div>
                  ))}
              </div>
              {!rodadaAtiva && (
                <form className="chat-form" onSubmit={enviarLobby}>
                  <input
                    className="input"
                    placeholder="Digite algo para a sala..."
                    value={lobbyInput}
                    onChange={(e) => setLobbyInput(e.target.value)}
                    maxLength={120}
                  />
                  <button type="submit" className="btn primary">
                    Enviar
                  </button>
                </form>
              )}
              {rodadaAtiva && fase === "pistas" && (
                <>
                  <p className="hint chat-hint">
                    {minhaVezPista
                      ? "Sua vez — uma palavra e Enter."
                      : `Aguardando: ${nomeJogador(sala?.jogadorDaVezId)}`}
                  </p>
                  <form className="chat-form" onSubmit={enviarPista}>
                    <input
                      className="input"
                      placeholder={minhaVezPista ? "Sua pista..." : "Não é a sua vez"}
                      value={pistaInput}
                      onChange={(e) => setPistaInput(e.target.value)}
                      disabled={!minhaVezPista}
                      maxLength={80}
                    />
                    <button type="submit" className="btn primary" disabled={!minhaVezPista}>
                      Enviar
                    </button>
                  </form>
                </>
              )}
            </div>

            {fase === "votacao" && rodadaAtiva && (
              <div className="votacao">
                <p className="label">Quem é o impostor?</p>
                {votacaoInfo ? (
                  <p className="hint">
                    Votos: {votacaoInfo.recebidos}/{votacaoInfo.total}
                    {jaVotei ? " — você já votou." : ""}
                  </p>
                ) : null}
                <ul className="voto-lista">
                  {sala?.jogadores?.map((j) => (
                    <li key={j.id}>
                      <button
                        type="button"
                        className="btn secondary block voto-btn"
                        onClick={() => votarEm(j.id)}
                        disabled={jaVotei}
                      >
                        {j.nome}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="acoes">
              {voceEhDono ? (
                <>
                  <button
                    type="button"
                    className="btn primary block"
                    onClick={gerarPalavra}
                    disabled={!sala?.podeGerarPalavra || rodadaAtiva}
                  >
                    Gerar palavra
                  </button>
                  {!sala?.podeGerarPalavra && !rodadaAtiva && (
                    <p className="hint center">
                      Reúna pelo menos 3 pessoas na sala para começar.
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn danger block"
                    onClick={finalizarPartida}
                    disabled={!rodadaAtiva}
                  >
                    Finalizar partida
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn secondary block"
                  onClick={verPalavra}
                  disabled={!podeVerPalavra || clicouVerPalavra}
                >
                  Ver palavra
                </button>
              )}
            </div>

            <div className="painel-revelacao">
              {revelacao?.tipo === "palavra" && (
                <p className="destaque palavra">A palavra é: {revelacao.palavra}</p>
              )}
              {revelacao?.tipo === "impostor" && (
                <p className="destaque impostor">Você é o impostor.</p>
              )}
              {voceEhDono && rodadaAtiva && !revelacao && fase !== "resultado" && (
                <p className="hint center">Gerando…</p>
              )}
            </div>

            {erro && <p className="erro">{erro}</p>}

            {fase === "resultado" && resultado && rodadaAtiva && resultadoOverlayFechado && (
              <div className="resultado-mini">
                <button
                  type="button"
                  className="btn secondary block"
                  onClick={() => setResultadoOverlayFechado(false)}
                >
                  Ver resultado de novo
                </button>
              </div>
            )}

            {mostrarOverlayResultado && (
              <div className="overlay" role="dialog" aria-modal="true">
                <div className="overlay-card">
                  <div className="overlay-head">
                    <h2 className="overlay-titulo">Resultado</h2>
                    <button
                      type="button"
                      className="btn-overlay-fechar"
                      onClick={() => setResultadoOverlayFechado(true)}
                      aria-label="Fechar resultado"
                    >
                      ×
                    </button>
                  </div>
                  <p className="overlay-texto destaque">
                    {resultado.impostorPerdeu
                      ? "O impostor perdeu (recebeu a maioria dos votos)."
                      : "O impostor ganhou (não recebeu a maioria dos votos)."}
                  </p>
                  <p className="overlay-texto">
                    O impostor era: <strong>{nomeJogador(resultado.impostorId)}</strong>
                  </p>
                  <p className="overlay-texto">
                    A palavra era: <strong>{resultado.palavra}</strong>
                  </p>
                  <p className="label">Votos por jogador</p>
                  <ul className="voto-resumo">
                    {sala?.jogadores?.map((j) => (
                      <li key={j.id}>
                        {j.nome}: {resultado.votosPorJogador?.[j.id] ?? 0}
                      </li>
                    ))}
                  </ul>
                  <p className="hint center">
                    Use &quot;Finalizar partida&quot; (dono) para voltar ao lobby e preparar nova
                    rodada.
                  </p>
                  <button
                    type="button"
                    className="btn primary block overlay-fechar-baixo"
                    onClick={() => setResultadoOverlayFechado(true)}
                  >
                    Fechar
                  </button>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="footer">
        <p>
          <span className="footer-slash">/</span> jogue presencialmente — conversem, votem, divirtam-se{" "}
          <span className="footer-slash">/</span>
        </p>
      </footer>

      <style>{`
        .app {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 1.75rem 1rem 2.5rem;
          position: relative;
        }
        .header {
          text-align: center;
          margin-bottom: 1.75rem;
          max-width: 520px;
        }
        .eyebrow {
          margin: 0 0 0.5rem;
          font-family: var(--font-mono);
          font-size: 0.7rem;
          font-weight: 500;
          letter-spacing: 0.28em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .slash {
          color: var(--accent);
          font-weight: 600;
          opacity: 0.9;
        }
        .logo {
          margin: 0;
          font-size: clamp(2.1rem, 6vw, 2.75rem);
          font-weight: 800;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          line-height: 1.05;
        }
        .logo-core {
          display: inline-block;
          background: linear-gradient(105deg, #ffffff 0%, var(--accent) 42%, var(--magenta) 88%);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          text-shadow: 0 0 40px rgba(0, 232, 255, 0.25);
        }
        .tagline {
          margin: 0.6rem 0 0;
          color: var(--muted);
          font-size: 0.92rem;
          font-weight: 500;
          max-width: 28ch;
          margin-left: auto;
          margin-right: auto;
        }
        .tagline-slash {
          color: var(--magenta);
          font-weight: 700;
          margin: 0 0.15rem;
        }
        .tagline-accent {
          color: var(--accent);
          font-weight: 700;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          margin-top: 0.65rem;
          font-family: var(--font-mono);
          font-size: 0.72rem;
          font-weight: 500;
          padding: 0.35rem 0.75rem;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--card-solid);
          color: var(--accent);
          letter-spacing: 0.06em;
        }
        .badge-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 10px var(--accent);
          animation: pulse-dot 1.2s ease-in-out infinite;
        }
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
        .main {
          width: 100%;
          max-width: 420px;
        }
        .main.wide {
          max-width: 520px;
        }
        .card.glass {
          background: var(--card);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          border-radius: var(--radius-lg);
          box-shadow: var(--shadow-card);
          border: 1px solid var(--border);
          padding: 1.35rem 1.4rem;
          position: relative;
          overflow: hidden;
        }
        .card.glass::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(
            135deg,
            rgba(0, 232, 255, 0.35) 0%,
            transparent 40%,
            transparent 60%,
            rgba(255, 45, 139, 0.25) 100%
          );
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
        }
        .card.sala .sala-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 1rem;
          position: relative;
          z-index: 1;
        }
        .sala-top-codigo {
          min-width: 0;
        }
        .codigo-row {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          flex-wrap: wrap;
        }
        .btn-copiar {
          flex-shrink: 0;
          padding-left: 0.85rem;
          padding-right: 0.85rem;
          font-size: 0.75rem;
          font-family: var(--font-mono);
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }
        .codigo-grande {
          margin: 0;
          font-family: var(--font-mono);
          font-size: 1.6rem;
          font-weight: 700;
          letter-spacing: 0.22em;
          font-variant-numeric: tabular-nums;
          color: var(--text);
          text-shadow: 0 0 24px rgba(0, 232, 255, 0.35);
        }
        .label {
          display: block;
          font-family: var(--font-mono);
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 0.4rem;
        }
        .label::before {
          content: "/ ";
          color: var(--accent);
          opacity: 0.7;
        }
        .input {
          width: 100%;
          padding: 0.7rem 0.85rem;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          font-size: 0.9rem;
          background: rgba(6, 6, 10, 0.65);
          color: var(--text);
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input::placeholder {
          color: rgba(139, 139, 158, 0.55);
        }
        .input:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-dim), 0 0 20px rgba(0, 232, 255, 0.12);
        }
        .input:disabled {
          opacity: 0.5;
        }
        .row {
          display: flex;
          gap: 0.5rem;
          align-items: stretch;
        }
        .grow {
          flex: 1;
        }
        .btn {
          border: none;
          border-radius: var(--radius);
          padding: 0.7rem 1rem;
          font-size: 0.88rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          transition: transform 0.12s, box-shadow 0.12s, background 0.12s;
        }
        .btn.block {
          width: 100%;
        }
        .btn.primary {
          background: linear-gradient(145deg, var(--accent) 0%, #00b8d4 50%, #0090a8 100%);
          color: #050508;
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2) inset, 0 4px 20px rgba(0, 232, 255, 0.25);
        }
        .btn.primary:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.28) inset, 0 6px 28px rgba(0, 232, 255, 0.35);
        }
        .btn.secondary {
          background: var(--magenta-dim);
          color: #ffc8e4;
          border: 1px solid var(--border-hot);
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
        }
        .btn.secondary:hover:not(:disabled) {
          background: rgba(255, 45, 139, 0.28);
          color: #fff;
        }
        .btn.danger {
          background: var(--danger-dim);
          color: #ff8ba0;
          border: 1px solid rgba(255, 61, 104, 0.45);
        }
        .btn.danger:hover:not(:disabled) {
          background: rgba(255, 61, 104, 0.22);
          color: #ffb3c0;
        }
        .btn.ghost {
          background: transparent;
          color: var(--muted);
          border: 1px solid var(--chrome-line);
          text-transform: none;
          font-weight: 600;
        }
        .btn.ghost:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent);
          background: var(--accent-dim);
        }
        .divider {
          height: 1px;
          margin: 1.25rem 0;
          background: linear-gradient(90deg, transparent, var(--border), var(--border-hot), transparent);
          opacity: 0.9;
        }
        .hint {
          font-size: 0.82rem;
          color: var(--muted);
          margin: 0.55rem 0 0;
          line-height: 1.45;
        }
        .hint.center {
          text-align: center;
        }
        .erro {
          color: #ff7a94;
          font-family: var(--font-mono);
          font-size: 0.82rem;
          margin: 0.85rem 0 0;
        }
        .lista-jogadores {
          position: relative;
          z-index: 1;
        }
        .lista-jogadores ul {
          list-style: none;
          padding: 0;
          margin: 0.25rem 0 0;
        }
        .lista-jogadores li {
          padding: 0.45rem 0;
          border-bottom: 1px solid rgba(0, 232, 255, 0.08);
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          font-weight: 600;
        }
        .pill {
          font-family: var(--font-mono);
          font-size: 0.65rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          background: var(--accent-dim);
          color: var(--accent);
          padding: 0.2rem 0.5rem;
          border-radius: 4px;
          border: 1px solid var(--border);
        }
        .pill.faint {
          background: rgba(255, 255, 255, 0.04);
          color: var(--muted);
          border-color: var(--chrome-line);
        }
        .pill.warn {
          background: rgba(255, 180, 70, 0.12);
          color: #ffc46b;
          border-color: rgba(255, 180, 70, 0.35);
        }
        .chat {
          margin-top: 1.1rem;
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: 0.85rem;
          background: rgba(6, 6, 10, 0.55);
          position: relative;
          z-index: 1;
        }
        .chat-log {
          max-height: 220px;
          overflow-y: auto;
          font-size: 0.88rem;
          margin-bottom: 0.65rem;
          font-family: var(--font-mono);
          scrollbar-color: var(--accent-dim) transparent;
        }
        .msg {
          padding: 0.4rem 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }
        .msg:last-child {
          border-bottom: none;
        }
        .msg.sistema {
          color: var(--muted);
          font-style: italic;
          font-size: 0.8rem;
        }
        .msg-autor {
          font-weight: 600;
          color: var(--accent);
        }
        .chat-form {
          display: flex;
          gap: 0.5rem;
          align-items: stretch;
        }
        .chat-hint {
          margin-bottom: 0.5rem;
        }
        .votacao {
          margin-top: 1.1rem;
          padding-top: 0.9rem;
          border-top: 1px solid rgba(255, 45, 139, 0.2);
          position: relative;
          z-index: 1;
        }
        .voto-lista {
          list-style: none;
          padding: 0;
          margin: 0.35rem 0 0;
        }
        .voto-lista li {
          margin-bottom: 0.45rem;
        }
        .voto-btn {
          text-align: left;
          font-family: var(--font-mono);
          font-size: 0.82rem;
        }
        .overlay {
          position: fixed;
          inset: 0;
          background: rgba(4, 4, 8, 0.82);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 50;
          padding: 1rem;
        }
        .overlay-card {
          background: var(--card-solid);
          border-radius: var(--radius-lg);
          padding: 1.6rem;
          max-width: 380px;
          width: 100%;
          border: 1px solid var(--border);
          box-shadow: var(--shadow-card), 0 0 80px rgba(255, 45, 139, 0.08);
        }
        .overlay-head {
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          margin-bottom: 0.85rem;
        }
        .overlay-titulo {
          margin: 0;
          font-size: 1.35rem;
          font-weight: 800;
          text-align: center;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          background: linear-gradient(90deg, var(--text), var(--accent));
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .btn-overlay-fechar {
          position: absolute;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 2.35rem;
          height: 2.35rem;
          padding: 0;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: rgba(6, 6, 10, 0.8);
          color: var(--muted);
          font-size: 1.4rem;
          line-height: 1;
          cursor: pointer;
          transition: color 0.12s, border-color 0.12s;
        }
        .btn-overlay-fechar:hover {
          border-color: var(--magenta);
          color: var(--magenta);
        }
        .overlay-fechar-baixo {
          margin-top: 1rem;
        }
        .resultado-mini {
          margin-top: 0.75rem;
          position: relative;
          z-index: 1;
        }
        .overlay-texto {
          margin: 0.55rem 0;
          font-size: 0.92rem;
          color: #d4d4de;
        }
        .overlay-texto strong {
          color: var(--accent);
        }
        .voto-resumo {
          margin: 0.35rem 0 0;
          padding-left: 1.1rem;
          font-size: 0.88rem;
          font-family: var(--font-mono);
          color: var(--muted);
        }
        .acoes {
          margin-top: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
          position: relative;
          z-index: 1;
        }
        .painel-revelacao {
          margin-top: 1.25rem;
          min-height: 3rem;
          padding: 0.75rem;
          border-radius: var(--radius);
          border: 1px dashed rgba(0, 232, 255, 0.25);
          background: rgba(0, 232, 255, 0.04);
          position: relative;
          z-index: 1;
        }
        .destaque {
          margin: 0;
          text-align: center;
          font-size: 1.05rem;
          font-weight: 700;
          font-family: var(--font-mono);
        }
        .destaque.palavra {
          color: var(--accent);
          text-shadow: 0 0 20px rgba(0, 232, 255, 0.35);
        }
        .destaque.impostor {
          color: var(--magenta);
          text-shadow: 0 0 24px rgba(255, 45, 139, 0.35);
        }
        .footer {
          margin-top: auto;
          padding-top: 2.25rem;
          text-align: center;
          font-family: var(--font-mono);
          font-size: 0.72rem;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--muted);
          max-width: 36rem;
        }
        .footer p {
          margin: 0;
          line-height: 1.6;
        }
        .footer-slash {
          color: var(--accent);
          opacity: 0.65;
        }
      `}</style>
    </div>
  );
}
