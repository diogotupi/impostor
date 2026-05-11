import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : "");

function socketUrl() {
  return SOCKET_URL || window.location.origin;
}

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
  const donoRef = useRef(false);
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
  }, []);

  useEffect(() => {
    const s = io(socketUrl(), { transports: ["websocket", "polling"] });
    setSocket(s);
    s.on("connect", () => setConectado(true));
    s.on("disconnect", () => setConectado(false));
    s.on("estadoSala", (estado) => {
      setSala(estado);
      if (!estado.rodadaAtiva) limparRodadaUi();
    });
    s.on("rodadaIniciada", () => {
      setRodadaAtiva(true);
      setPodeVerPalavra(true);
      if (!donoRef.current) {
        setRevelacao(null);
        setClicouVerPalavra(false);
      }
    });
    s.on("rodadaEncerrada", () => {
      limparRodadaUi();
    });
    s.on("revelacao", (rev) => {
      setRevelacao(rev);
    });
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

  return (
    <div className="app">
      <header className="header">
        <h1 className="logo">Impostor</h1>
        <p className="tagline">Uma palavra em comum — menos para um de vocês.</p>
        {!conectado && <span className="badge warn">Conectando…</span>}
      </header>

      <main className="main">
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
              <div>
                <p className="label">Código da sala</p>
                <p className="codigo-grande">{sala?.codigo}</p>
              </div>
              <button type="button" className="btn ghost" onClick={sairSala}>
                Sair
              </button>
            </div>

            <p className="hint">
              Mínimo de 3 jogadores para gerar palavra. Máximo 10 na sala.
            </p>

            <div className="lista-jogadores">
              <p className="label">Jogadores ({sala?.jogadores?.length ?? 0})</p>
              <ul>
                {sala?.jogadores?.map((j) => (
                  <li key={j.id}>
                    {j.nome}
                    {j.dono ? <span className="pill">Dono</span> : null}
                  </li>
                ))}
              </ul>
            </div>

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
              {voceEhDono && rodadaAtiva && !revelacao && (
                <p className="hint center">Gerando…</p>
              )}
            </div>

            {erro && <p className="erro">{erro}</p>}
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
        }
        .pill {
          font-size: 0.7rem;
          font-weight: 600;
          background: #e0f2f1;
          color: #0f766e;
          padding: 0.15rem 0.45rem;
          border-radius: 999px;
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
