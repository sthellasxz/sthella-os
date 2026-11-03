/* Nosso Caixa — lógica do app.
   Dados no Supabase (tabelas caixa_*). Cada usuário pertence a um casal (caixa_membros);
   as regras RLS garantem que cada casal só lê e escreve o que é seu. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const sb = window.supabase.createClient(NC_CONFIG.supabaseUrl, NC_CONFIG.supabaseKey);

  // ---------------- utilidades ----------------
  const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const fmt = (v) => BRL.format(Math.round((Number(v) || 0) * 100) / 100);
  const parse = (s) => {
    if (s == null) return 0;
    s = String(s).trim().replace(/[^\d,.-]/g, "");
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  };
  const paraCampo = (v) => (v ? (Math.round(v * 100) / 100).toFixed(2).replace(".", ",") : "");
  const chaveMes = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  const difMes = (a, b) => { const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number); return (by - ay) * 12 + (bm - am); };
  const somaMes = (k, n) => { const [y, m] = k.split("-").map(Number); return chaveMes(new Date(y, m - 1 + n, 1)); };
  const nomeMes = (k, longo) => {
    const [y, m] = k.split("-").map(Number);
    const d = new Date(y, m - 1, 1);
    if (longo) return d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }).replace(" de ", " ");
    return d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "") + "/" + String(y).slice(2);
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const CATEGORIAS = {
    compras: "Compras", casa: "Casa e aluguel", servicos: "Luz, água, internet", mercado: "Mercado",
    transporte: "Transporte", saude: "Saúde", educacao: "Estudos", lazer: "Lazer", outros: "Outros",
  };
  $("c-cat").innerHTML = Object.entries(CATEGORIAS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");

  const HOJE = chaveMes(new Date());
  const st = {
    user: null, casal: null, codigo: "", membros: 0,
    mes: HOJE, aba: "inicio", visao: (() => { try { return localStorage.getItem("nc-visao") || "agora"; } catch { return "agora"; } })(), filtro: "todas",
    config: { nome_a: "Eu", nome_b: "João", renda_a: 0, renda_b: 0, pct_guardar: 40, pct_lazer: 30 },
    meses: {}, recebido: {}, saldoInfo: {}, banco: {}, ext: {}, contas: [], lancamentos: [], regras: {},
  };

  // ---------------- telas ----------------
  function mostrar(tela) {
    for (const id of ["tela-carregando", "tela-login", "tela-casal", "app"]) $(id).hidden = id !== tela;
  }
  let toastT;
  function toast(txt) {
    const t = $("toast"); t.textContent = txt; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
  }
  function sinc(txt, cls) { $("sinc").className = "sinc " + (cls || ""); $("sinc").querySelector("span").textContent = txt; }
  function msg(el, txt, ok) { el.textContent = txt; el.hidden = !txt; el.classList.toggle("ok", !!ok); }

  // ---------------- login ----------------
  let modoCriar = false;
  function setModo(criar) {
    modoCriar = criar;
    $("aba-entrar").setAttribute("aria-pressed", !criar);
    $("aba-criar").setAttribute("aria-pressed", criar);
    $("login-btn").textContent = criar ? "Criar minha conta" : "Entrar";
    $("login-senha").autocomplete = criar ? "new-password" : "current-password";
    msg($("login-msg"), "");
  }
  $("aba-entrar").onclick = () => setModo(false);
  $("aba-criar").onclick = () => setModo(true);

  $("form-login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("login-email").value.trim(), senha = $("login-senha").value;
    if (!email || !email.includes("@")) return msg($("login-msg"), "Digite um e-mail válido.");
    if (senha.length < 6) return msg($("login-msg"), "A senha precisa ter pelo menos 6 caracteres.");
    $("login-btn").disabled = true;
    try {
      if (modoCriar) {
        const { data, error } = await sb.auth.signUp({ email, password: senha, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (!data.session) {
          setModo(false);
          msg($("login-msg"), "Conta criada! Confirme pelo link que chegou no seu e-mail (olhe o spam também) e depois entre aqui com a mesma senha.", true);
          return;
        }
        iniciar();
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password: senha });
        if (error) throw error;
        iniciar();
      }
    } catch (err) {
      const m = String(err.message || err);
      msg($("login-msg"),
        /invalid login/i.test(m) ? "E-mail ou senha incorretos." :
        /not confirmed/i.test(m) ? "Falta confirmar o e-mail. Procure a mensagem na sua caixa de entrada (ou spam)." :
        /already registered/i.test(m) ? "Esse e-mail já tem conta. Toque em \"Já tenho conta\"." :
        /rate limit/i.test(m) ? "Muitas tentativas. Espere um minuto e tente de novo." :
        "Não deu certo: " + m);
    } finally { $("login-btn").disabled = false; }
  });

  async function sair() { await sb.auth.signOut(); location.reload(); }
  $("btn-sair").onclick = sair;
  $("btn-sair-1").onclick = sair;

  // ---------------- casal ----------------
  async function carregarCasal() {
    const { data, error } = await sb.from("caixa_membros").select("casal_id").eq("user_id", st.user.id).maybeSingle();
    if (error) throw error;
    return data ? data.casal_id : null;
  }
  $("btn-criar-casal").onclick = async () => {
    $("btn-criar-casal").disabled = true;
    const { error } = await sb.rpc("caixa_criar_casal");
    $("btn-criar-casal").disabled = false;
    if (error) return msg($("casal-msg"), "Não foi possível criar: " + error.message);
    iniciar();
  };
  $("form-codigo").addEventListener("submit", async (e) => {
    e.preventDefault();
    const cod = $("codigo").value.trim().toUpperCase();
    if (cod.length !== 6) return msg($("casal-msg"), "O código tem 6 letras ou números.");
    const { data, error } = await sb.rpc("caixa_entrar_casal", { p_codigo: cod });
    if (error) return msg($("casal-msg"), /completo/.test(error.message) ? "Esse caixa já tem duas pessoas." : "Erro: " + error.message);
    if (!data) return msg($("casal-msg"), "Código não encontrado. Confira com o seu par.");
    iniciar();
  });

  // ---------------- dados ----------------
  async function buscarTudo() {
    sinc("Sincronizando…");
    const c = st.casal;
    const [cfg, meses, contas, casal, membros, lanc, regras] = await Promise.all([
      sb.from("caixa_config").select("*").eq("casal_id", c).maybeSingle(),
      sb.from("caixa_meses").select("*").eq("casal_id", c),
      sb.from("caixa_contas").select("*").eq("casal_id", c).order("criado_em"),
      sb.from("caixa_casais").select("codigo").eq("id", c).maybeSingle(),
      sb.from("caixa_membros").select("user_id").eq("casal_id", c),
      sb.from("caixa_lancamentos").select("*").eq("casal_id", c).order("data", { ascending: false }).limit(5000),
      sb.from("caixa_regras").select("chave,categoria").eq("casal_id", c),
    ]);
    const erro = cfg.error || meses.error || contas.error;
    if (erro) { sinc("Sem conexão — mostrando o que já tinha", "erro"); return; }
    if (cfg.data) st.config = cfg.data;
    st.meses = Object.fromEntries((meses.data || []).map((m) => [m.mes, Number(m.saldo)]));
    const num = (v) => (v == null ? null : Number(v));
    st.banco = Object.fromEntries((meses.data || []).map((m) => [m.mes, { A: num(m.conta_a), B: num(m.conta_b), em: m.conta_em }]));
    st.ext = Object.fromEntries((meses.data || []).map((m) => [m.mes, { A: m.ext_a || null, B: m.ext_b || null }]));
    st.saldoInfo = Object.fromEntries((meses.data || []).map((m) => [m.mes, { restante: m.saldo_restante == null ? null : Number(m.saldo_restante), data: m.saldo_data || "" }]));
    st.recebido = Object.fromEntries((meses.data || []).map((m) => [m.mes, { A: !!m.recebeu_a, B: !!m.recebeu_b }]));
    st.contas = (contas.data || []).map(normConta);
    st.codigo = casal.data ? casal.data.codigo : "";
    st.membros = (membros.data || []).length;
    if (!lanc.error) st.lancamentos = (lanc.data || []).map((l) => ({ ...l, valor: Number(l.valor) }));
    if (!regras.error) st.regras = Object.fromEntries((regras.data || []).map((x) => [x.chave, x.categoria]));
    sinc("Sincronizado", "ok");
    render();
  }
  const normConta = (c) => ({ ...c, valor_parcela: Number(c.valor_parcela), parcelas: Number(c.parcelas), pagos: c.pagos || {} });

  let canal = null;
  function ouvirMudancas() {
    if (canal) sb.removeChannel(canal);
    let t;
    const recarregar = () => { clearTimeout(t); t = setTimeout(buscarTudo, 400); };
    canal = sb.channel("caixa-" + st.casal);
    for (const tabela of ["caixa_config", "caixa_meses", "caixa_contas", "caixa_lancamentos"]) {
      canal.on("postgres_changes", { event: "*", schema: "public", table: tabela, filter: "casal_id=eq." + st.casal }, recarregar);
    }
    canal.subscribe();
  }

  function falhou(error) {
    console.error(error);
    sinc("Erro ao salvar", "erro");
    toast("Não foi possível salvar. Verifique a internet.");
  }

  let tCfg;
  function salvarConfig() {
    clearTimeout(tCfg);
    tCfg = setTimeout(async () => {
      const { nome_a, nome_b, renda_a, renda_b, pct_guardar, pct_lazer } = st.config;
      sinc("Salvando…");
      const { error } = await sb.from("caixa_config")
        .update({ nome_a, nome_b, renda_a, renda_b, pct_guardar, pct_lazer, atualizado_em: new Date().toISOString() })
        .eq("casal_id", st.casal);
      error ? falhou(error) : sinc("Salvo", "ok");
    }, 600);
  }
  let tSaldo;
  function salvarSaldo(mes) {
    clearTimeout(tSaldo);
    tSaldo = setTimeout(async () => {
      sinc("Salvando…");
      const { error } = await sb.from("caixa_meses").upsert({ casal_id: st.casal, mes, saldo: st.meses[mes] || 0 });
      error ? falhou(error) : sinc("Salvo", "ok");
    }, 600);
  }
  async function salvarRecebido(mes) {
    const r = st.recebido[mes] || {};
    sinc("Salvando…");
    const { error } = await sb.from("caixa_meses").upsert({ casal_id: st.casal, mes, recebeu_a: !!r.A, recebeu_b: !!r.B });
    error ? falhou(error) : sinc("Salvo", "ok");
  }
  async function salvarBanco(m) {
    const b = st.banco[m] || {};
    const { error } = await sb.from("caixa_meses").upsert({ casal_id: st.casal, mes: m, conta_a: b.A ?? null, conta_b: b.B ?? null, conta_em: b.em || new Date().toISOString() });
    if (error) falhou(error);
  }
  async function salvarPagos(conta) {
    sinc("Salvando…");
    const { error } = await sb.from("caixa_contas").update({ pagos: conta.pagos }).eq("id", conta.id);
    error ? falhou(error) : sinc("Salvo", "ok");
  }

  // ---------------- cálculos ----------------
  function parcelaNoMes(c, m) {
    const i = difMes(c.inicio, m) + 1;
    if (i < 1) return 0;
    if (c.tipo === "parcelada" && i > c.parcelas) return 0;
    return i;
  }
  function fimConta(c) { return c.tipo === "parcelada" ? somaMes(c.inicio, c.parcelas - 1) : null; }
  function qtdPagas(c) {
    let n = 0;
    for (const k in c.pagos) if (c.pagos[k] && parcelaNoMes(c, k)) n++;
    return n;
  }
  const nomes = () => ({ A: st.config.nome_a || "Pessoa 1", B: st.config.nome_b || "Pessoa 2", ambos: "Os dois" });

  function calcular() {
    const cfg = st.config, m = st.mes;
    const rA = Number(cfg.renda_a) || 0, rB = Number(cfg.renda_b) || 0;
    const renda = rA + rB;
    const propA = renda > 0 ? rA / renda : 0.5;
    const saldo = st.meses[m] || 0;
    const ativas = st.contas.filter((c) => parcelaNoMes(c, m));
    let contas = 0, pago = 0, contaA = 0, contaB = 0, naoPagasA = 0, naoPagasB = 0;
    for (const c of ativas) {
      const v = c.valor_parcela;
      contas += v;
      if (c.pagos[m]) pago += v;
      else if (c.quem === "A") naoPagasA += v;
      else if (c.quem === "B") naoPagasB += v;
      else { naoPagasA += v * propA; naoPagasB += v * (1 - propA); }
      if (c.quem === "A") contaA += v;
      else if (c.quem === "B") contaB += v;
      else { contaA += v * propA; contaB += v * (1 - propA); }
    }
    // dinheiro extra do mês (trabalho extra, reembolso, presente); salário não entra porque já está na renda
    const EXTRA = ["extra", "reembolso", "presente"];
    const extras = (st.lancamentos || []).filter((l) => l.valor > 0 && l.data.slice(0, 7) === m && EXTRA.includes(l.categoria));
    const extra = extras.reduce((s, l) => s + l.valor, 0);
    // quanto ainda sobra de cada dinheiro (null = ainda tem tudo)
    const sobraDe = (total, resto) => (resto == null ? total : Math.min(Number(resto), total));
    const extraAgora = extras.reduce((s, l) => s + sobraDe(l.valor, l.restante), 0);
    const saldoAgora = sobraDe(saldo, (st.saldoInfo[m] || {}).restante);
    // salário só conta quando já foi marcado como recebido (na visão "Dinheiro de agora")
    const rec = st.recebido[m] || {};
    const rendaRecebida = (rec.A ? rA : 0) + (rec.B ? rB : 0);
    const pendente = renda - rendaRecebida;
    const rendaUsada = st.visao === "previsto" ? renda : rendaRecebida;
    // dinheiro que já acabou não volta: vale para as duas visões
    const saldoUsado = saldoAgora;
    const extraUsado = extraAgora;
    let disponivel = rendaUsada + saldoUsado + extraUsado;
    let sobra = disponivel - contas;
    // saldo informado de cada conta: na visão "agora" usa o saldo real e desconta só o que falta pagar
    const bk = st.banco[m] || {};
    const bancoA = bk.A == null ? null : Number(bk.A), bancoB = bk.B == null ? null : Number(bk.B);
    const naoPagas = contas - pago;
    const modoBanco = st.visao !== "previsto" && (bancoA != null || bancoB != null);
    const agoraA = bancoA != null ? bancoA : rec.A ? rA : 0, agoraB = bancoB != null ? bancoB : rec.B ? rB : 0;
    // com saldo informado, a sobra é o que tem na conta; a conta só sai do saldo quando é marcada como paga
    if (modoBanco) { disponivel = agoraA + agoraB; sobra = disponivel; }
    const base = Math.max(0, sobra);
    const contasBarra = modoBanco ? 0 : contas;
    const guardar = base * cfg.pct_guardar / 100;
    const lazer = base * cfg.pct_lazer / 100;
    const folga = Math.max(0, base - guardar - lazer);
    return { naoPagasA, naoPagasB, modoBanco, bancoA, bancoB, agoraA, agoraB, naoPagas, contasBarra, extras, saldoAgora, extraAgora, saldoUsado, extraUsado, rA, rB, renda, rendaRecebida, rendaUsada, pendente, propA, saldo, extra, ativas, contas, pago, contaA, contaB, disponivel, sobra, guardar, lazer, folga };
  }

  // ---------------- render ----------------
  function setVal(id, v) { if (document.activeElement !== $(id)) $(id).value = v; }

  function render() {
    const r = calcular(), cfg = st.config, n = nomes(), m = st.mes;
    document.querySelectorAll(".mes-txt").forEach((el) => (el.textContent = nomeMes(m, true)));
    $("mes-nome").textContent = nomeMes(m, true);

    // início
    $("h-sobra").textContent = fmt(r.sobra);
    $("h-sobra").classList.toggle("neg", r.sobra < 0);
    $("h-sobra2").textContent = fmt(r.sobra);
    const agora = st.visao !== "previsto";
    document.querySelectorAll("[data-visao]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.visao === st.visao));
    $("h-renda").textContent = fmt(r.rendaUsada);
    $("h-renda-lbl").textContent = agora ? "Salários já recebidos" : "Salários do mês (previsto)";
    $("h-eyebrow").firstChild.textContent = agora ? "Sobra de agora · " : "Sobra prevista de ";
    $("h-pendente").hidden = !(r.pendente > 0) || r.modoBanco;
    if (r.pendente > 0) {
      const faltam = ["A", "B"].filter((k) => !(st.recebido[m] || {})[k] && (k === "A" ? r.rA : r.rB) > 0).map((k) => n[k]).join(" e ");
      $("h-pendente").textContent = agora
        ? `Ainda falta cair o salário de ${faltam} (${fmt(r.pendente)}). Quando cair, a sobra vai para ${fmt(r.sobra + r.pendente)}. Marque como recebido no bloco "Salário" abaixo.`
        : `Previsão contando o salário de ${faltam} (${fmt(r.pendente)}), que ainda não caiu.`;
    }
    $("h-saldo").textContent = fmt(r.saldoUsado);
    $("h-saldo-lbl").textContent = r.saldoUsado !== r.saldo ? `+ Ainda tem do que já estava na conta (entrou ${fmt(r.saldo)})` : "+ Já tinha na conta";
    $("h-extra").textContent = fmt(r.extraUsado);
    $("h-extra-lbl").textContent = r.extraUsado !== r.extra ? `+ Ainda tem do dinheiro extra (entrou ${fmt(r.extra)})` : "+ Dinheiro extra (Pix, freela)";
    $("h-extra-linha").hidden = !r.extra;

    // outro dinheiro que entrou e quanto ainda sobra
    const itensResto = [];
    if (r.saldo > 0) itensResto.push({ tipo: "saldo", id: "saldo", nome: "Já estava na conta", data: (st.saldoInfo[m] || {}).data, valor: r.saldo, restante: (st.saldoInfo[m] || {}).restante });
    r.extras.forEach((l) => itensResto.push({ tipo: "lanc", id: l.id, nome: l.descricao, data: l.data, valor: l.valor, restante: l.restante == null ? null : Number(l.restante) }));
    $("outros-din").hidden = itensResto.length === 0;
    $("resto-lista").innerHTML = itensResto.map((it) => {
      const tem = it.restante == null ? it.valor : Math.min(it.restante, it.valor);
      const st0 = tem <= 0 ? ["acabou", "Já acabou"] : tem >= it.valor ? ["tudo", "Ainda tem tudo"] : ["parte", `Ainda tem ${fmt(tem)}`];
      const dt = it.data ? it.data.split("-").reverse().slice(0, 2).join("/") : "";
      return `<li><button type="button" class="resto-item ${st0[0]}" data-resto="${it.tipo === "saldo" ? "saldo" : it.id}">
        <span class="resto-txt"><b>${esc(it.nome)}</b><small>${dt ? "Entrou em " + dt + " · " : ""}${fmt(it.valor)}</small></span>
        <span class="resto-st">${st0[1]}</span>
        <span class="resto-trilho"><i style="width:${(Math.max(0, tem) / it.valor * 100).toFixed(1)}%"></i></span>
      </button></li>`;
    }).join("");
    const infoS = st.saldoInfo[m] || {};
    setVal("saldo-data", infoS.data || "");
    const temS = infoS.restante == null ? r.saldo : Math.min(infoS.restante, r.saldo);
    $("saldo-resto-btn").textContent = r.saldo <= 0 ? "—" : temS <= 0 ? "Já acabou" : temS >= r.saldo ? "Ainda tem tudo" : `Ainda tem ${fmt(temS)}`;
    $("saldo-resto-btn").disabled = r.saldo <= 0;
    $("h-contas").textContent = fmt(r.contas);
    // com saldo informado: cada um separado, sem somar as duas contas
    const separado = r.modoBanco;
    $("h-pessoas").hidden = !separado;
    $("h-sobra").hidden = separado;
    document.querySelector(".hero .conta-linha").hidden = separado;
    if (separado) {
      $("h-eyebrow").firstChild.textContent = "Cada um em ";
      const bkm0 = st.banco[m] || {};
      $("h-pessoas").innerHTML = ["A", "B"].map((k) => {
        const banco = k === "A" ? r.bancoA : r.bancoB;
        const total = k === "A" ? r.contaA : r.contaB, falta = k === "A" ? r.naoPagasA : r.naoPagasB, pagoP = total - falta;
        return `<button type="button" class="h-pessoa ${k}" data-banco="${k}">
          <b class="hp-nome">${esc(n[k])}</b>
          <span class="hp-lbl">Tem na conta</span>
          <span class="hp-valor${banco != null && banco < 0 ? " neg" : ""}">${banco == null ? "—" : fmt(banco)}</span>
          ${banco == null ? `<span class="hp-acao">Informar saldo</span>` : ""}
          <span class="hp-lbl">Vai pagar no mês</span>
          <span class="hp-total">${fmt(total)}</span>
          <span class="hp-det">${falta > 0 ? `Já pagou ${fmt(pagoP)} · falta ${fmt(falta)}` : total > 0 ? "Tudo pago" : "Nenhuma conta"}</span>
        </button>`;
      }).join("");
    }
    document.querySelectorAll(".h-banco").forEach((el) => (el.hidden = !r.modoBanco));
    document.querySelectorAll(".h-normal").forEach((el) => (el.hidden = r.modoBanco));
    if (r.modoBanco) {
      $("h-extra-linha").hidden = true;
      $("h-banco-a-lbl").textContent = r.bancoA != null ? `Na conta de ${n.A} agora` : `${n.A}: salário recebido (sem saldo informado)`;
      $("h-banco-b-lbl").textContent = r.bancoB != null ? `Na conta de ${n.B} agora` : `${n.B}: salário recebido (sem saldo informado)`;
      $("h-banco-a").textContent = fmt(r.agoraA); $("h-banco-b").textContent = fmt(r.agoraB);
      $("h-naopagas").textContent = r.naoPagas > 0 ? fmt(r.naoPagas) : "tudo pago";
    }
    $("h-exp").textContent = r.renda === 0
      ? "Comece pela aba Renda: coloque quanto cada um ganha por mês."
      : r.modoBanco ? "Toque no nome para atualizar o saldo. Cada conta sai do saldo de quem paga quando vocês marcam como paga. Contas dos dois são divididas pela renda." : agora ? "Só conta o salário que já caiu, menos todas as contas do mês." : "Quanto vai sobrar no mês quando todos os salários caírem.";

    const tot = Math.max(r.disponivel, r.contasBarra) || 1;
    const partes = [
      [r.modoBanco ? "Contas a pagar" : "Contas", r.contasBarra, "--c-contas"], ["Guardar", r.guardar, "--c-guardar"],
      ["Lazer", r.lazer, "--c-lazer"], ["Folga", r.folga, "--c-folga"],
    ];
    $("barra").innerHTML = partes.filter((p) => p[1] > 0).map((p) => `<i style="width:${(p[1] / tot * 100).toFixed(2)}%;background:var(${p[2]})" title="${p[0]}"></i>`).join("");
    $("legenda").innerHTML = partes.map((p) => `<li style="--c:var(${p[2]})"><span>${p[0]}${r.disponivel > 0 && r.disponivel >= r.contasBarra ? " · " + Math.round(p[1] / r.disponivel * 100) + "%" : ""}</span><b>${fmt(p[1])}</b></li>`).join("");

    $("p-guardar").textContent = fmt(r.guardar);
    $("p-lazer").textContent = fmt(r.lazer);
    $("p-folga").textContent = fmt(r.folga);
    $("p-guardar-pct").textContent = cfg.pct_guardar + "%";
    $("p-lazer-pct").textContent = cfg.pct_lazer + "%";
    $("p-lazer-semana").textContent = r.lazer > 0 ? `Cerca de ${fmt(r.lazer / 4.3)} por semana` : "";
    $("aviso-negativo").hidden = r.sobra >= 0;
    $("aviso-negativo").textContent = agora && r.pendente > 0
      ? (r.sobra + r.pendente >= 0
          ? `Por enquanto o dinheiro que já entrou não cobre as contas do mês (faltam ${fmt(-r.sobra)}). Quando o salário cair, fica tudo certo. Até lá, melhor segurar os gastos.`
          : `Mesmo quando os salários caírem, as contas de ${nomeMes(m, true)} passam o dinheiro em ${fmt(-(r.sobra + r.pendente))}.`)
      : `Atenção: as contas de ${nomeMes(m, true)} passam o dinheiro disponível em ${fmt(-r.sobra)}. Neste mês não dá para guardar nem gastar com lazer.`;

    const qtdPagasMes = r.ativas.filter((c) => c.pagos[m]).length;
    $("pc-txt").textContent = `${qtdPagasMes} de ${r.ativas.length} contas pagas`;
    const falta = r.contas - r.pago;
    $("pc-falta").textContent = r.ativas.length === 0 ? "Nenhuma conta" : falta > 0 ? `Falta pagar ${fmt(falta)}` : "Tudo pago!";
    $("pc-falta").classList.toggle("ok", falta <= 0);
    $("pc-barra").style.width = (r.contas ? (r.pago / r.contas) * 100 : 0) + "%";
    const prox = [...r.ativas].sort((a, b) => (!!a.pagos[m] - !!b.pagos[m]) || b.valor_parcela - a.valor_parcela).slice(0, 5);
    $("lista-proximas").innerHTML = prox.length
      ? prox.map((c) => `<li class="${c.pagos[m] ? "pago" : ""}"><span>${esc(c.nome)}${c.tipo === "parcelada" ? ` <small class="muted">(${parcelaNoMes(c, m)}/${c.parcelas})</small>` : ""}</span><b>${fmt(c.valor_parcela)}</b></li>`).join("")
      : `<li><span class="muted">Nenhuma conta cadastrada para este mês.</span></li>`;

    $("pessoas-resumo").innerHTML = ["A", "B"].map((k) => {
      const renda = k === "A" ? r.rA : r.rB, conta = k === "A" ? r.contaA : r.contaB;
      const pct = r.renda > 0 ? Math.round((k === "A" ? r.propA : 1 - r.propA) * 100) : 50;
      return `<div class="pessoa ${k}"><h3>${esc(n[k])}</h3><dl>
        <div><dt>Ganha</dt><dd>${fmt(renda)}</dd></div>
        <div><dt>Paga de contas</dt><dd>${fmt(conta)}</dd></div>
        <div><dt>Parte nas contas dos dois</dt><dd>${pct}%</dd></div>
        <div class="sobra-p"><dt>Sobra</dt><dd>${fmt(renda - conta)}</dd></div></dl></div>`;
    }).join("");

    // contas
    $("rc-total").textContent = fmt(r.contas);
    $("rc-pago").textContent = fmt(r.pago);
    $("rc-falta").textContent = fmt(r.contas - r.pago);
    let lista = [...r.ativas];
    if (st.filtro === "abertas") lista = lista.filter((c) => !c.pagos[m]);
    if (st.filtro === "pagas") lista = lista.filter((c) => c.pagos[m]);
    lista.sort((a, b) => (!!a.pagos[m] - !!b.pagos[m]) || a.nome.localeCompare(b.nome));
    $("lista-contas").innerHTML = lista.map((c) => cartaoConta(c, m, n)).join("");
    $("contas-vazio").hidden = r.ativas.length > 0;
    if (r.ativas.length && !lista.length) $("lista-contas").innerHTML = `<li class="vazio"><p class="muted">Nenhuma conta neste filtro.</p></li>`;
    const fora = st.contas.filter((c) => !parcelaNoMes(c, m));
    $("encerradas-box").hidden = fora.length === 0;
    $("lista-fora").innerHTML = fora.map((c) => cartaoConta(c, m, n, true)).join("");

    // renda
    setVal("nome-a", cfg.nome_a); setVal("nome-b", cfg.nome_b);
    setVal("renda-a", paraCampo(Number(cfg.renda_a))); setVal("renda-b", paraCampo(Number(cfg.renda_b)));
    setVal("saldo", paraCampo(r.saldo));
    const bkm = st.banco[m] || {};
    for (const [k, low] of [["A", "a"], ["B", "b"]]) {
      setVal("banco-" + low, bkm[k] == null ? "" : paraCampo(bkm[k]) || "0,00");
      $("banco-" + low + "-info").textContent = bkm[k] == null ? `Saldo de ${nomeMes(m)} não informado` : bkm.em ? `Atualizado em ${new Date(bkm.em).toLocaleDateString("pt-BR")}` : "";
    }
    $("renda-total").textContent = fmt(r.renda);
    $("pct-guardar").value = cfg.pct_guardar; $("pct-lazer").value = cfg.pct_lazer;
    $("pct-guardar-txt").textContent = cfg.pct_guardar + "%";
    $("pct-lazer-txt").textContent = cfg.pct_lazer + "%";
    $("pct-folga-txt").textContent = (100 - cfg.pct_guardar - cfg.pct_lazer) + "%";
    $("c-quem").options[1].textContent = n.A; $("c-quem").options[2].textContent = n.B;

    // casal
    $("codigo-casal").textContent = st.codigo || "——————";
    $("membros-txt").textContent = st.membros >= 2 ? "Vocês dois já estão neste caixa." : "Por enquanto só você está neste caixa.";
    // salário recebido no mês
    const rec = st.recebido[m] || {};
    document.querySelectorAll("[data-recebeu]").forEach((b) => {
      const k = b.dataset.recebeu, ok = !!rec[k], mini = b.classList.contains("sal-mini");
      b.setAttribute("aria-pressed", ok);
      const stt = b.querySelector(".sal-status");
      stt.textContent = mini ? (ok ? `Salário de ${nomeMes(m)}: recebido` : `Salário de ${nomeMes(m)}: ainda não recebeu`) : (ok ? "Recebido" : "Ainda não recebeu");
      const nm = b.querySelector(".sal-nome"); if (nm) nm.textContent = n[k];
      const vl = b.querySelector(".sal-valor"); if (vl) vl.textContent = fmt(k === "A" ? r.rA : r.rB);
    });
    const entrou = (rec.A ? r.rA : 0) + (rec.B ? r.rB : 0);
    $("sal-entrou").textContent = fmt(entrou);
    $("sal-falta").textContent = fmt(r.renda - entrou);
    $("sal-falta").classList.toggle("alerta", r.renda - entrou > 0);

    $("email-logado").textContent = st.user ? "Conectado como " + st.user.email : "";
    if (window.NC_gastos) window.NC_gastos.render(r);
  }

  function cartaoConta(c, m, n, fora) {
    const pago = !!c.pagos[m];
    const idx = parcelaNoMes(c, m);
    const tags = [`<span class="tag ${c.quem}">${esc(n[c.quem] || "Os dois")}</span>`, `<span class="tag">${CATEGORIAS[c.categoria] || "Outros"}</span>`];
    if (!fora) tags.push(pago ? `<span class="tag status-ok">Pago</span>` : `<span class="tag status-ab">A pagar</span>`);
    let linhaTipo, prog = "";
    if (c.tipo === "parcelada") {
      const pagas = qtdPagas(c), total = c.valor_parcela * c.parcelas, falta = (c.parcelas - pagas) * c.valor_parcela;
      linhaTipo = fora
        ? (difMes(c.inicio, m) < 0 ? `Começa em ${nomeMes(c.inicio)}` : `Terminou em ${nomeMes(fimConta(c))}`)
        : `Parcela ${idx} de ${c.parcelas}`;
      prog = `<div class="conta-prog">
        <div class="trilho"><i style="width:${(pagas / c.parcelas * 100).toFixed(1)}%"></i></div>
        <div class="conta-detalhes">
          <div><span>Valor total</span><b>${fmt(total)}</b></div>
          <div><span>Pagas</span><b>${pagas} de ${c.parcelas}</b></div>
          <div><span>Falta pagar</span><b>${fmt(falta)}</b></div>
        </div>
        <p class="pequeno muted">Última parcela em ${nomeMes(fimConta(c), true)}</p>
      </div>`;
    } else {
      linhaTipo = `Conta fixa desde ${nomeMes(c.inicio)}`;
    }
    return `<li class="conta ${pago && !fora ? "paga" : ""}">
      <button class="check" data-pagar="${c.id}" aria-pressed="${pago}" aria-label="${pago ? "Desmarcar" : "Marcar como pago"}: ${esc(c.nome)}"${fora ? " tabindex=\"-1\"" : ""}><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>
      <button class="conta-corpo" data-editar="${c.id}" aria-label="Ver detalhes de ${esc(c.nome)}">
        <div class="conta-l1"><span class="conta-nome">${esc(c.nome)}</span><span class="conta-valor">${fmt(c.valor_parcela)}</span></div>
        <span class="pequeno muted">${linhaTipo}${c.tipo === "parcelada" ? " · por mês" : " · todo mês"}</span>
        <div class="conta-tags">${tags.join("")}</div>
        ${prog}
      </button>
    </li>`;
  }

  // ---------------- eventos gerais ----------------
  function irPara(aba) {
    st.aba = aba;
    document.querySelectorAll(".aba").forEach((s) => (s.hidden = s.dataset.aba !== aba));
    document.querySelectorAll(".nav button").forEach((b) => { if (b.dataset.ir === aba) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    window.scrollTo({ top: 0 });
  }
  document.addEventListener("click", (e) => {
    const ir = e.target.closest("[data-ir]");
    if (ir) { irPara(ir.dataset.ir); if (ir.dataset.foco) setTimeout(() => $(ir.dataset.foco).focus(), 80); return; }
    const pagar = e.target.closest("[data-pagar]");
    if (pagar) {
      const c = st.contas.find((x) => x.id === pagar.dataset.pagar);
      if (!c || !parcelaNoMes(c, st.mes)) return;
      const m = st.mes, novo = !c.pagos[m], antes = c.pagos[m];
      c.pagos = { ...c.pagos };
      // tira (ou devolve) o valor do saldo de quem paga, se o saldo foi informado
      const bk = { ...(st.banco[m] || {}) };
      let mexeu = false, desc = { A: 0, B: 0 };
      if (novo) {
        const r0 = calcular(), v = c.valor_parcela;
        const parte = c.quem === "A" ? { A: v, B: 0 } : c.quem === "B" ? { A: 0, B: v } : { A: v * r0.propA, B: v * (1 - r0.propA) };
        for (const k of ["A", "B"]) if (bk[k] != null && parte[k]) { bk[k] = Math.round((bk[k] - parte[k]) * 100) / 100; desc[k] = Math.round(parte[k] * 100) / 100; mexeu = true; }
        c.pagos[m] = mexeu ? { A: desc.A, B: desc.B } : true;
      } else {
        if (antes && typeof antes === "object") for (const k of ["A", "B"]) if (bk[k] != null && antes[k]) { bk[k] = Math.round((bk[k] + antes[k]) * 100) / 100; mexeu = true; }
        delete c.pagos[m];
      }
      if (mexeu) { bk.em = new Date().toISOString(); st.banco[m] = bk; salvarBanco(m); }
      render(); salvarPagos(c);
      const quemNm = c.quem === "A" ? nomes().A : c.quem === "B" ? nomes().B : "dos dois";
      toast(novo ? `${c.nome} pago${mexeu ? `: ${fmt(c.valor_parcela)} saiu do saldo ${c.quem === "ambos" ? "dos dois" : "de " + quemNm}` : ""}` : `${c.nome}: pagamento desmarcado${mexeu ? ", valor voltou para o saldo" : ""}`);
      return;
    }
    const bc = e.target.closest("[data-banco]");
    if (bc) { irPara("renda"); setTimeout(() => $("banco-" + bc.dataset.banco.toLowerCase()).focus(), 80); return; }
    const vs = e.target.closest("[data-visao]");
    if (vs) { st.visao = vs.dataset.visao; try { localStorage.setItem("nc-visao", st.visao); } catch {} render(); return; }
    const rcb = e.target.closest("[data-recebeu]");
    if (rcb) {
      const k = rcb.dataset.recebeu, m = st.mes;
      st.recebido[m] = { ...(st.recebido[m] || {}), [k]: !(st.recebido[m] || {})[k] };
      render(); salvarRecebido(m);
      toast(st.recebido[m][k] ? `Salário de ${nomes()[k]} marcado como recebido` : `Salário de ${nomes()[k]}: ainda não recebeu`);
      return;
    }
    const ed = e.target.closest("[data-editar]");
    if (ed) return abrirFolha(st.contas.find((x) => x.id === ed.dataset.editar));
  });
  document.querySelectorAll("[data-filtro]").forEach((b) => (b.onclick = () => {
    st.filtro = b.dataset.filtro;
    document.querySelectorAll("[data-filtro]").forEach((x) => x.setAttribute("aria-pressed", x === b));
    render();
  }));
  $("mes-ant").onclick = () => { st.mes = somaMes(st.mes, -1); render(); };
  $("mes-prox").onclick = () => { st.mes = somaMes(st.mes, 1); render(); };

  const ligarCfg = (id, campo, fn) => $(id).addEventListener("input", (e) => { st.config[campo] = fn(e.target.value); render(); salvarConfig(); });
  ligarCfg("nome-a", "nome_a", (v) => v.trim().slice(0, 20));
  ligarCfg("nome-b", "nome_b", (v) => v.trim().slice(0, 20));
  ligarCfg("renda-a", "renda_a", parse);
  ligarCfg("renda-b", "renda_b", parse);
  ["renda-a", "renda-b", "saldo"].forEach((id) => $(id).addEventListener("blur", () => { $(id).value = ""; render(); }));
  let tBanco;
  for (const [k, low] of [["A", "a"], ["B", "b"]]) {
    $("banco-" + low).addEventListener("input", (e) => {
      const m = st.mes, txt = e.target.value.trim();
      st.banco[m] = { ...(st.banco[m] || {}), [k]: txt === "" ? null : parse(txt), em: new Date().toISOString() };
      render();
      clearTimeout(tBanco);
      tBanco = setTimeout(async () => {
        const b = st.banco[m]; sinc("Salvando…");
        const { error } = await sb.from("caixa_meses").upsert({ casal_id: st.casal, mes: m, conta_a: b.A ?? null, conta_b: b.B ?? null, conta_em: b.em });
        error ? falhou(error) : sinc("Salvo", "ok");
      }, 700);
    });
    $("banco-" + low).addEventListener("blur", () => { $("banco-" + low).value = ""; render(); });
  }

  $("saldo-data").addEventListener("change", async (e) => {
    const m = st.mes; st.saldoInfo[m] = { ...(st.saldoInfo[m] || { restante: null }), data: e.target.value };
    sinc("Salvando…");
    const { error } = await sb.from("caixa_meses").upsert({ casal_id: st.casal, mes: m, saldo_data: e.target.value || null });
    error ? falhou(error) : sinc("Salvo", "ok");
    render();
  });

  // ---- folha "quanto ainda sobra" ----
  let restoAlvo = null;
  function abrirResto(alvo) {
    const m = st.mes, r = calcular();
    if (alvo === "saldo") {
      const info = st.saldoInfo[m] || {};
      restoAlvo = { tipo: "saldo", valor: r.saldo, restante: info.restante };
      $("resto-nome").textContent = "Dinheiro que já estava na conta";
      $("resto-sub").textContent = `Entrou ${fmt(r.saldo)}${info.data ? " em " + info.data.split("-").reverse().join("/") : ""}`;
    } else {
      const l = st.lancamentos.find((x) => x.id === alvo); if (!l) return;
      restoAlvo = { tipo: "lanc", id: l.id, valor: l.valor, restante: l.restante == null ? null : Number(l.restante) };
      $("resto-nome").textContent = l.descricao;
      $("resto-sub").textContent = `Entrou ${fmt(l.valor)} em ${l.data.split("-").reverse().join("/")}`;
    }
    const tem = restoAlvo.restante == null ? restoAlvo.valor : Math.min(restoAlvo.restante, restoAlvo.valor);
    $("resto-valor").value = paraCampo(tem) || "0,00";
    $("resto-ajuda").textContent = `Por exemplo: entrou ${fmt(restoAlvo.valor)} e você já gastou tudo, então sobra R$ 0,00.`;
    $("resto-folha").hidden = false; $("resto-fundo").hidden = false; document.body.style.overflow = "hidden";
  }
  function fecharResto() { $("resto-folha").hidden = true; $("resto-fundo").hidden = true; document.body.style.overflow = ""; }
  $("resto-fechar").onclick = fecharResto; $("resto-fundo").onclick = fecharResto;
  async function salvarResto(valor) {
    if (!restoAlvo) return;
    const v = valor == null ? null : Math.max(0, Math.min(Math.round(valor * 100) / 100, restoAlvo.valor));
    const restante = v != null && v >= restoAlvo.valor ? null : v;
    const m = st.mes; sinc("Salvando…");
    let error;
    if (restoAlvo.tipo === "saldo") {
      st.saldoInfo[m] = { ...(st.saldoInfo[m] || { data: "" }), restante };
      ({ error } = await sb.from("caixa_meses").upsert({ casal_id: st.casal, mes: m, saldo_restante: restante }));
    } else {
      const l = st.lancamentos.find((x) => x.id === restoAlvo.id); if (l) l.restante = restante;
      ({ error } = await sb.from("caixa_lancamentos").update({ restante }).eq("id", restoAlvo.id));
    }
    fecharResto(); render();
    if (error) return falhou(error);
    sinc("Salvo", "ok");
    toast(restante === 0 ? "Marcado: esse dinheiro já acabou" : restante == null ? "Marcado: ainda tem tudo" : `Marcado: ainda sobra ${fmt(restante)}`);
  }
  $("resto-acabou").onclick = () => salvarResto(0);
  $("resto-tudo").onclick = () => salvarResto(null);
  $("resto-form").addEventListener("submit", (e) => { e.preventDefault(); salvarResto(parse($("resto-valor").value)); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-resto]"); if (b && !b.disabled) abrirResto(b.dataset.resto); });

  $("saldo").addEventListener("input", (e) => { st.meses[st.mes] = parse(e.target.value); render(); salvarSaldo(st.mes); });
  function setPct(g, l) { st.config.pct_guardar = g; st.config.pct_lazer = l; render(); salvarConfig(); }
  $("pct-guardar").addEventListener("input", (e) => { const g = +e.target.value; setPct(g, Math.min(st.config.pct_lazer, 100 - g)); });
  $("pct-lazer").addEventListener("input", (e) => { const l = +e.target.value; setPct(Math.min(st.config.pct_guardar, 100 - l), l); });
  document.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => { const [g, l] = b.dataset.preset.split(",").map(Number); setPct(g, l); toast(`Divisão: guardar ${g}%, lazer ${l}%`); }));

  $("btn-copiar").onclick = async () => {
    try { await navigator.clipboard.writeText(st.codigo); toast("Código copiado"); }
    catch { const r = document.createRange(); r.selectNodeContents($("codigo-casal")); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Selecione e copie o código"); }
  };

  window.NC = { recarregar: () => buscarTudo(), paraCampo, somaMes, sb, st, fmt, parse, nomeMes, chaveMes, esc, toast, sinc, falhou, render: () => render(), calcular };

  // ---------------- folha de conta ----------------
  let editando = null, tipo = "parcelada", ultimo = "total", pagosForm = {};
  function setTipo(t) {
    tipo = t;
    $("c-tipo-parc").setAttribute("aria-pressed", t === "parcelada");
    $("c-tipo-fixa").setAttribute("aria-pressed", t === "fixa");
    $("c-linha-parc").hidden = t !== "parcelada";
    $("c-parcela-lbl").textContent = t === "parcelada" ? "Valor de cada parcela" : "Valor por mês";
    $("c-inicio-lbl").textContent = t === "parcelada" ? "Mês da 1ª parcela" : "Começou em";
    $("c-tipo-ajuda").textContent = t === "parcelada"
      ? "Compra dividida em parcelas que um dia acabam (tênis, celular, viagem)."
      : "Conta que se repete todo mês sem data para acabar (aluguel, internet, academia).";
    atualizaCalc();
  }
  $("c-tipo-parc").onclick = () => setTipo("parcelada");
  $("c-tipo-fixa").onclick = () => setTipo("fixa");

  function recalc() {
    const n = parseInt($("c-n").value, 10) || 0;
    if (n > 0) {
      if (ultimo === "total") { const t = parse($("c-total").value); $("c-parcela").value = t ? paraCampo(t / n) : ""; }
      else { const p = parse($("c-parcela").value); $("c-total").value = p ? paraCampo(p * n) : ""; }
    }
    atualizaCalc();
  }
  $("c-total").addEventListener("input", () => { ultimo = "total"; recalc(); });
  $("c-parcela").addEventListener("input", () => { ultimo = "parcela"; recalc(); });
  $("c-n").addEventListener("input", recalc);
  $("c-inicio").addEventListener("input", atualizaCalc);

  function atualizaCalc() {
    const n = parseInt($("c-n").value, 10) || 0, p = parse($("c-parcela").value), ini = $("c-inicio").value;
    if (tipo === "parcelada" && n > 0 && p > 0 && ini) {
      $("c-calc").textContent = `${n}x de ${fmt(p)} = ${fmt(n * p)}. Vai de ${nomeMes(ini, true)} até ${nomeMes(somaMes(ini, n - 1), true)}.`;
    } else if (tipo === "fixa" && p > 0) {
      $("c-calc").textContent = `${fmt(p)} todo mês, ${fmt(p * 12)} por ano.`;
    } else $("c-calc").textContent = "";
    desenharMeses();
  }
  function desenharMeses() {
    const ini = $("c-inicio").value;
    const n = parseInt($("c-n").value, 10) || 0;
    if (!ini || (tipo === "parcelada" && !n)) { $("c-meses-box").hidden = true; return; }
    $("c-meses-box").hidden = false;
    let fim = tipo === "parcelada" ? somaMes(ini, Math.min(n, 120) - 1) : somaMes(HOJE > ini ? HOJE : ini, 2);
    const meses = [];
    for (let k = ini, i = 1; k <= fim && meses.length < 120; k = somaMes(k, 1), i++) meses.push([k, i]);
    const inicioVis = tipo === "fixa" ? Math.max(0, meses.length - 15) : 0;
    $("c-meses").innerHTML = meses.slice(inicioVis).map(([k, i]) =>
      `<button type="button" data-mes="${k}" aria-pressed="${!!pagosForm[k]}" class="${k === st.mes ? "atual" : ""}">${nomeMes(k)}${tipo === "parcelada" ? `<small>${i}ª parcela</small>` : ""}</button>`).join("");
  }
  $("c-meses").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mes]"); if (!b) return;
    const k = b.dataset.mes;
    if (pagosForm[k]) delete pagosForm[k]; else pagosForm[k] = true;
    b.setAttribute("aria-pressed", !!pagosForm[k]);
  });

  function abrirFolha(c) {
    editando = c || null;
    msg($("c-msg"), "");
    $("folha-titulo").textContent = c ? "Editar conta" : "Nova conta";
    $("c-excluir").hidden = !c;
    $("c-excluir").textContent = "Excluir";
    $("c-excluir").dataset.confirmar = "";
    $("c-nome").value = c ? c.nome : "";
    $("c-n").value = c && c.tipo === "parcelada" ? c.parcelas : "";
    $("c-parcela").value = c ? paraCampo(c.valor_parcela) : "";
    $("c-total").value = c && c.tipo === "parcelada" ? paraCampo(c.valor_parcela * c.parcelas) : "";
    $("c-inicio").value = c ? c.inicio : st.mes;
    $("c-quem").value = c ? c.quem : "ambos";
    $("c-cat").value = c ? c.categoria : "compras";
    pagosForm = c ? { ...c.pagos } : {};
    ultimo = "parcela";
    setTipo(c ? c.tipo : "parcelada");
    $("folha").hidden = false; $("folha-fundo").hidden = false;
    document.body.style.overflow = "hidden";
    if (!c) setTimeout(() => $("c-nome").focus(), 50);
  }
  function fecharFolha() { $("folha").hidden = true; $("folha-fundo").hidden = true; document.body.style.overflow = ""; }
  $("btn-nova-conta").onclick = () => abrirFolha(null);
  $("folha-fechar").onclick = fecharFolha;
  $("folha-fundo").onclick = fecharFolha;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("folha").hidden) fecharFolha(); });

  $("form-conta").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nome = $("c-nome").value.trim();
    const n = tipo === "parcelada" ? parseInt($("c-n").value, 10) : 0;
    let parcela = parse($("c-parcela").value);
    if (tipo === "parcelada" && !parcela && n) parcela = parse($("c-total").value) / n;
    const inicio = $("c-inicio").value;
    if (!nome) return msg($("c-msg"), "Escreva o nome da conta (por exemplo: Tênis).");
    if (tipo === "parcelada" && (!n || n < 1 || n > 360)) return msg($("c-msg"), "Informe em quantas parcelas foi dividido (de 1 a 360).");
    if (!(parcela > 0)) return msg($("c-msg"), tipo === "parcelada" ? "Informe o valor total ou o valor de cada parcela." : "Informe quanto é por mês.");
    if (!inicio) return msg($("c-msg"), "Escolha o mês em que começa.");
    // só guarda meses que existem nesta conta
    const pagos = {};
    for (const k in pagosForm) if (pagosForm[k] && difMes(inicio, k) >= 0 && (tipo !== "parcelada" || difMes(inicio, k) < n)) pagos[k] = true;
    const dados = {
      nome, tipo, valor_parcela: Math.round(parcela * 100) / 100, parcelas: n, inicio,
      quem: $("c-quem").value, categoria: $("c-cat").value, pagos,
    };
    $("c-salvar").disabled = true;
    sinc("Salvando…");
    const q = editando
      ? sb.from("caixa_contas").update(dados).eq("id", editando.id).select().single()
      : sb.from("caixa_contas").insert({ ...dados, casal_id: st.casal }).select().single();
    const { data, error } = await q;
    $("c-salvar").disabled = false;
    if (error) { falhou(error); return msg($("c-msg"), "Não foi possível salvar: " + error.message); }
    const nova = normConta(data);
    if (editando) st.contas = st.contas.map((x) => (x.id === nova.id ? nova : x));
    else st.contas.push(nova);
    sinc("Salvo", "ok");
    fecharFolha(); render();
    toast(editando ? "Conta atualizada" : "Conta adicionada");
  });

  $("c-excluir").onclick = async () => {
    const b = $("c-excluir");
    if (!b.dataset.confirmar) { b.dataset.confirmar = "1"; b.textContent = "Toque de novo para excluir"; return; }
    const { error } = await sb.from("caixa_contas").delete().eq("id", editando.id);
    if (error) return falhou(error);
    st.contas = st.contas.filter((x) => x.id !== editando.id);
    fecharFolha(); render(); toast("Conta excluída");
  };

  document.addEventListener("visibilitychange", () => { if (!document.hidden && st.casal) buscarTudo(); });

  // ---------------- instalar (PWA) ----------------
  let promptInstalar = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); promptInstalar = e; $("btn-instalar").hidden = false; });
  $("btn-instalar").onclick = async () => { if (!promptInstalar) return; promptInstalar.prompt(); await promptInstalar.userChoice; promptInstalar = null; $("btn-instalar").hidden = true; };
  // atualiza o app sozinho quando sai uma versão nova
  if ("serviceWorker" in navigator) {
    const jaTinha = !!navigator.serviceWorker.controller;
    let recarregou = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => { if (jaTinha && !recarregou) { recarregou = true; location.reload(); } });
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
      reg.update();
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update(); });
    }).catch(() => {}));
  }

  // ---------------- início ----------------
  async function iniciar() {
    const { data: { session } } = await sb.auth.getSession();
    st.user = session ? session.user : null;
    if (!st.user) return mostrar("tela-login");
    try {
      st.casal = await carregarCasal();
    } catch (err) {
      mostrar("tela-login");
      return msg($("login-msg"), "Não foi possível conectar. Verifique a internet e tente de novo.");
    }
    if (!st.casal) return mostrar("tela-casal");
    mostrar("app");
    render();
    await buscarTudo();
    ouvirMudancas();
  }
  sb.auth.onAuthStateChange((evento) => { if (evento === "SIGNED_OUT") mostrar("tela-login"); });
  iniciar();
})();
