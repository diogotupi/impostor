import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : "");

function socketUrl() {
  return SOCKET_URL || window.location.origin;
}

const PALAVRAS_POR_JOGADOR = 3;

export default function App() {
  const [nome, setNome] = useState(() => localStorage.getItem("impostor-nome") || "");
  const [codigoEntrada, setCodigoEntrada] = useState("");
  const [erro, setErro] = useState("");
  const [socket, setSocket] = useState(null);
  const [meuId, setMeuId] = useState(null);
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
    const s = io(socketUrl(), { transports: ["websocket", "polling"] });
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
      }
      setSala(estado);
    };

    s.on("connect", () => {
      setConectado(true);
      setMeuId(s.id);
    });
    s.on("disconnect", () => {
      setConectado(false);
      setMeuId(null);
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
      setSala(null);
      setVoceEhDono(false);
      limparRodadaUi();
    });
    return () => {
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
    socket.emit("criarSala", { nome }, (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Não foi possível criar a sala.");
        return;
      }
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
    socket.emit("entrarSala", { codigo: c, nome }, (res) => {
      if (!res?.ok) {
        setErro(res?.erro || "Não foi possível entrar.");
        return;
      }
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
  const minhaVezPista = Boolean(
    rodadaAtiva && fase === "pistas" && sala?.jogadorDaVezId && meuId === sala.jogadorDaVezId,
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
        <h1 className="logo">Impostor</h1>
        <p className="tagline">Uma palavra em comum — menos para um de vocês.</p>
        {!conectado && <span className="badge warn">Conectando…</span>}
      </header>

      <main className="main wide">
        {entrarLobby ? (
          <section className="card">
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
          <section className="card sala">
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
        <p>Jogue presencialmente: conversem, votem, divirtam-se.</p>
      </footer>

      <style>{`
        .app {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 1.5rem 1rem 2rem;
        }
        .header {
          text-align: center;
          margin-bottom: 1.5rem;
          max-width: 420px;
        }
        .logo {
          margin: 0;
          font-size: 1.75rem;
          font-weight: 700;
          letter-spacing: -0.02em;
        }
        .tagline {
          margin: 0.35rem 0 0;
          color: var(--muted);
          font-size: 0.95rem;
        }
        .badge {
          display: inline-block;
          margin-top: 0.5rem;
          font-size: 0.75rem;
          padding: 0.2rem 0.5rem;
          border-radius: 999px;
          background: var(--border);
        }
        .badge.warn {
          background: #fef3c7;
          color: #92400e;
        }
        .main {
          width: 100%;
          max-width: 420px;
        }
        .main.wide {
          max-width: 520px;
        }
        .card {
          background: var(--card);
          border-radius: var(--radius);
          box-shadow: var(--shadow);
          border: 1px solid var(--border);
          padding: 1.25rem 1.35rem;
        }
        .card.sala .sala-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 1rem;
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
          font-size: 0.85rem;
        }
        .codigo-grande {
          margin: 0;
          font-size: 1.75rem;
          font-weight: 700;
          letter-spacing: 0.18em;
          font-variant-numeric: tabular-nums;
        }
        .label {
          display: block;
          font-size: 0.8rem;
          font-weight: 600;
          color: var(--muted);
          margin-bottom: 0.35rem;
        }
        .input {
          width: 100%;
          padding: 0.65rem 0.75rem;
          border: 1px solid var(--border);
          border-radius: 8px;
          font-size: 1rem;
        }
        .input:focus {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
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
          border-radius: 8px;
          padding: 0.65rem 1rem;
          font-size: 0.95rem;
          font-weight: 600;
        }
        .btn.block {
          width: 100%;
        }
        .btn.primary {
          background: var(--accent);
          color: white;
        }
        .btn.primary:hover:not(:disabled) {
          background: var(--accent-hover);
        }
        .btn.secondary {
          background: #e0f2f1;
          color: #115e59;
        }
        .btn.secondary:hover:not(:disabled) {
          background: #ccfbf1;
        }
        .btn.danger {
          background: #fef2f2;
          color: var(--danger);
          border: 1px solid #fecaca;
        }
        .btn.danger:hover:not(:disabled) {
          background: #fee2e2;
        }
        .btn.ghost {
          background: transparent;
          color: var(--muted);
          border: 1px solid var(--border);
        }
        .btn.ghost:hover:not(:disabled) {
          background: var(--bg);
        }
        .divider {
          height: 1px;
          background: var(--border);
          margin: 1.1rem 0;
        }
        .hint {
          font-size: 0.85rem;
          color: var(--muted);
          margin: 0.5rem 0 0;
        }
        .hint.center {
          text-align: center;
        }
        .erro {
          color: var(--danger);
          font-size: 0.9rem;
          margin: 0.75rem 0 0;
        }
        .lista-jogadores ul {
          list-style: none;
          padding: 0;
          margin: 0.25rem 0 0;
        }
        .lista-jogadores li {
          padding: 0.35rem 0;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
        }
        .pill {
          font-size: 0.7rem;
          font-weight: 600;
          background: #e0f2f1;
          color: #0f766e;
          padding: 0.15rem 0.45rem;
          border-radius: 999px;
        }
        .pill.faint {
          background: #f5f5f4;
          color: var(--muted);
        }
        .chat {
          margin-top: 1rem;
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 0.75rem;
          background: #fafaf9;
        }
        .chat-log {
          max-height: 220px;
          overflow-y: auto;
          font-size: 0.9rem;
          margin-bottom: 0.65rem;
        }
        .msg {
          padding: 0.35rem 0;
          border-bottom: 1px solid var(--border);
        }
        .msg:last-child {
          border-bottom: none;
        }
        .msg.sistema {
          color: var(--muted);
          font-style: italic;
          font-size: 0.85rem;
        }
        .msg-autor {
          font-weight: 600;
          color: #44403c;
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
          margin-top: 1rem;
          padding-top: 0.75rem;
          border-top: 1px solid var(--border);
        }
        .voto-lista {
          list-style: none;
          padding: 0;
          margin: 0.35rem 0 0;
        }
        .voto-lista li {
          margin-bottom: 0.4rem;
        }
        .voto-btn {
          text-align: left;
        }
        .overlay {
          position: fixed;
          inset: 0;
          background: rgba(28, 25, 23, 0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 50;
          padding: 1rem;
        }
        .overlay-card {
          background: var(--card);
          border-radius: var(--radius);
          padding: 1.5rem;
          max-width: 380px;
          width: 100%;
          border: 1px solid var(--border);
          box-shadow: var(--shadow);
        }
        .overlay-head {
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          margin-bottom: 0.75rem;
        }
        .overlay-titulo {
          margin: 0;
          font-size: 1.25rem;
          text-align: center;
        }
        .btn-overlay-fechar {
          position: absolute;
          right: 0;
          top: 50%;
          transform: translateY(-50%);
          width: 2.25rem;
          height: 2.25rem;
          padding: 0;
          border: none;
          border-radius: 8px;
          background: var(--bg);
          color: var(--muted);
          font-size: 1.5rem;
          line-height: 1;
          cursor: pointer;
        }
        .btn-overlay-fechar:hover {
          background: var(--border);
          color: var(--text);
        }
        .overlay-fechar-baixo {
          margin-top: 1rem;
        }
        .resultado-mini {
          margin-top: 0.75rem;
        }
        .overlay-texto {
          margin: 0.5rem 0;
          font-size: 0.95rem;
        }
        .voto-resumo {
          margin: 0.25rem 0 0;
          padding-left: 1.1rem;
          font-size: 0.9rem;
        }
        .acoes {
          margin-top: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 0.65rem;
        }
        .painel-revelacao {
          margin-top: 1.25rem;
          min-height: 3rem;
        }
        .destaque {
          margin: 0;
          text-align: center;
          font-size: 1.15rem;
          font-weight: 600;
        }
        .destaque.palavra {
          color: #0f766e;
        }
        .destaque.impostor {
          color: var(--danger);
        }
        .footer {
          margin-top: auto;
          padding-top: 2rem;
          text-align: center;
          color: var(--muted);
          font-size: 0.8rem;
        }
        .footer p {
          margin: 0;
        }
      `}</style>
    </div>
  );
}
