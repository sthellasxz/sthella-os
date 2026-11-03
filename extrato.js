/* Nosso Caixa — importação e análise do extrato bancário.
   Lê OFX, CSV e PDF no próprio celular (o arquivo não é enviado para nenhum servidor);
   só os lançamentos (data, descrição, valor, categoria) são salvos no banco do casal. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NC = window.NC;
  const { sb, st, fmt, esc, toast, sinc, falhou, nomeMes } = NC;

  // ---------------- categorias ----------------
  const CATS = {
    comida:       { nome: "Alimentação e mercado", cor: "#E0703A" },
    lazer:        { nome: "Lazer",            cor: "#E0A21E" },
    contas:       { nome: "Contas da casa",   cor: "#5B7BA6" },
    moradia:      { nome: "Moradia",          cor: "#3E5C76" },
    faculdade:    { nome: "Faculdade e estudos", cor: "#8B5CF6" },
    transporte:   { nome: "Transporte",       cor: "#0EA5A4" },
    saude:        { nome: "Saúde e farmácia", cor: "#E25579" },
    compras:      { nome: "Compras",          cor: "#C0612B" },
    assinaturas:  { nome: "Assinaturas",      cor: "#7C8AA0" },
    cartao:       { nome: "Fatura do cartão", cor: "#475569" },
    transferencia:{ nome: "Pix e transferências", cor: "#94A3B8" },
    outros:       { nome: "Outros",           cor: "#A8A29E" },
    extra:        { nome: "Trabalho extra / freela", cor: "#12A37A" },
    salario:      { nome: "Salário", cor: "#0F7A5C" },
    reembolso:    { nome: "Reembolso", cor: "#3BA7A0" },
    presente:     { nome: "Presente / Pix da família", cor: "#7FB069" },
    entrada:      { nome: "Outras entradas", cor: "#0F8A65" },
  };
  // palavras-chave → categoria (testadas na descrição sem acento, em minúsculas)
  const PALAVRAS = [
    ["faculdade", /faculdade|universidade|unip|estacio|anhanguera|uninove|unopar|kroton|cruzeiro do sul|mackenzie|puc|senac|senai|fies|mensalidade|matricula|escola|colegio|curso|udemy|alura|livraria|xerox|papelaria/],
    ["comida", /mercado|supermerc|atacad|assai|carrefour|extra |pao de acucar|dia %|hortifruti|acougue|padaria|panific|ifood|i food|rappi|ze delivery|restaurante|lanchonete|lanches|pizza|burger|mcdonald|bk |burger king|subway|habib|outback|sushi|churrasc|bar e|cafe|cafeteria|starbucks|sorvete|acai|doceria|food|comida|delivery/],
    ["lazer", /cinema|cinemark|kinoplex|ingresso|sympla|eventim|show|teatro|parque|bar |boteco|pub |balada|clube|viagem|hotel|airbnb|booking|decolar|latam|gol linhas|azul linhas|steam|playstation|xbox|nintendo|game|boliche|karaoke/],
    ["assinaturas", /netflix|spotify|disney|hbo|max\.com|prime video|amazon prime|globoplay|youtube|deezer|apple\.com|icloud|google one|paramount|crunchyroll|chatgpt|openai|claude|anthropic/],
    ["contas", /energia|enel|light|cemig|copel|celesc|coelba|cpfl|eletropaulo|sabesp|agua|saneamento|cedae|copasa|gas natural|comgas|internet|vivo|claro|tim |oi |net virtua|telefon|celular recarga|recarga/],
    ["moradia", /aluguel|condominio|imobiliaria|iptu|quintoandar|seguro residencial/],
    ["transporte", /uber|99 ?app|99pop|cabify|posto|combustivel|gasolina|shell|ipiranga|petrobras|br mania|estacionamento|zona azul|sem parar|conectcar|veloe|metro|bilhete unico|sptrans|onibus|pedagio|ipva|detran|oficina|auto pecas/],
    ["saude", /farmacia|drogaria|droga raia|drogasil|pague menos|panvel|hospital|clinica|laborat|medic|dentist|odonto|unimed|amil|hapvida|bradesco saude|sulamerica|academia|smartfit|smart fit|bluefit|gympass|wellhub|psicolog/],
    ["compras", /shopee|shein|mercado ?livre|mercadopago|amazon|magalu|magazine|americanas|casas bahia|aliexpress|renner|riachuelo|c&a|cea |zara|centauro|netshoes|nike|adidas|loja|shopping|store/],
    ["cartao", /pagamento de fatura|pagto fatura|pag fatura|fatura cartao|pagamento cartao/],
    ["transferencia", /pix enviado|transferencia enviada|ted |doc |pix - envio|transf|pix para/],
  ];

  const semAcento = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  // "chave" = o nome do estabelecimento simplificado, para lembrar a categoria escolhida
  function chaveDe(desc) {
    let s = semAcento(desc)
      .replace(/compra (no )?(cartao|debito|credito)( -)?|compra com cartao|pagamento (efetuado|de boleto)?|pix (enviado|recebido)|transferencia (enviada|recebida)|debito automatico|deb aut|pgto|pag\*|ifd\*|mp \*|pp \*|\*|-/g, " ")
      .replace(/\d{2}\/\d{2}(\/\d{2,4})?/g, " ")
      .replace(/[^a-z ]/g, " ")
      .replace(/\s+/g, " ").trim();
    return s.split(" ").filter((w) => w.length > 1).slice(0, 3).join(" ").slice(0, 120) || semAcento(desc).slice(0, 40);
  }
  function categorizar(desc, valor) {
    const ch = chaveDe(desc);
    if (st.regras[ch]) return st.regras[ch];
    if (valor > 0) return /salario|folha de pag|proventos|vencimentos/.test(semAcento(desc)) ? "salario" : /estorno|reembolso|devolucao/.test(semAcento(desc)) ? "reembolso" : "entrada";
    const d = " " + semAcento(desc) + " ";
    for (const [cat, re] of PALAVRAS) if (re.test(d)) return cat;
    return "outros";
  }

  // ---------------- leitura de arquivos ----------------
  const numBR = (s) => {
    s = String(s).trim().replace(/r\$|\s/gi, "");
    let neg = /^-|-$|^\(.*\)$/.test(s) || /d$/i.test(s);
    s = s.replace(/[()\-+dc]/gi, "");
    if (s.includes(",") && s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    const n = parseFloat(s);
    return isFinite(n) ? (neg ? -n : n) : NaN;
  };
  function dataISO(s, anoPadrao) {
    s = String(s).trim();
    let m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?/);
    if (m) {
      let y = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : String(anoPadrao || new Date().getFullYear());
      return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    }
    return null;
  }

  function lerOFX(txt) {
    const out = [];
    const blocos = txt.split(/<STMTTRN>/i).slice(1);
    for (const b of blocos) {
      const tag = (t) => { const m = b.match(new RegExp("<" + t + ">([^<\\r\\n]*)", "i")); return m ? m[1].trim() : ""; };
      const data = dataISO(tag("DTPOSTED").slice(0, 8));
      const valor = parseFloat(tag("TRNAMT").replace(",", "."));
      const desc = [tag("NAME"), tag("MEMO")].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || "Sem descrição";
      if (data && isFinite(valor)) out.push({ data, descricao: desc, valor });
    }
    const lb = txt.match(/<LEDGERBAL>[\s\S]*?<BALAMT>\s*([-\d.,]+)/i);
    const saldoFinal = lb ? parseFloat(lb[1].replace(",", ".")) : null;
    return { itens: out, cartao: /<CREDITCARDMSGSRSV1>/i.test(txt), saldoFinal: isFinite(saldoFinal) ? saldoFinal : null };
  }

  function lerCSV(txt) {
    const linhas = txt.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
    if (!linhas.length) return { itens: [] };
    const delim = [";", ",", "\t"].map((d) => [d, (linhas[0].match(new RegExp(d === "\t" ? "\t" : "\\" + d, "g")) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
    const quebra = (l) => {
      const r = []; let cur = "", q = false;
      for (const ch of l) { if (ch === '"') q = !q; else if (ch === delim && !q) { r.push(cur); cur = ""; } else cur += ch; }
      r.push(cur); return r.map((x) => x.trim());
    };
    const rows = linhas.map(quebra);
    const cab = rows[0].map(semAcento);
    const temCab = cab.some((c) => /data|date|valor|amount|descri|title|historico|lancamento/.test(c));
    const corpo = temCab ? rows.slice(1) : rows;
    let iData = cab.findIndex((c) => /^data|date/.test(c));
    let iValor = cab.findIndex((c) => /valor|amount|quantia/.test(c));
    let iDesc = cab.findIndex((c) => /descri|title|historico|lancamento|estabelecimento|memo/.test(c));
    // sem cabeçalho reconhecido: descobre pelas próprias linhas
    const amostra = corpo.slice(0, 10);
    if (iData < 0) iData = rows[0].findIndex((_, i) => amostra.every((r) => dataISO(r[i] || "")));
    if (iValor < 0) iValor = rows[0].findIndex((_, i) => i !== iData && amostra.every((r) => isFinite(numBR(r[i] || "x"))));
    if (iDesc < 0) {
      let melhor = -1, tam = 0;
      rows[0].forEach((_, i) => { if (i === iData || i === iValor) return; const t = amostra.reduce((s, r) => s + (r[i] || "").length, 0); if (t > tam) { tam = t; melhor = i; } });
      iDesc = melhor;
    }
    if (iData < 0 || iValor < 0) return { itens: [], erro: "Não reconheci as colunas de data e valor deste CSV." };
    const itens = [];
    for (const r of corpo) {
      const data = dataISO(r[iData] || ""), valor = numBR(r[iValor] || "");
      if (!data || !isFinite(valor) || valor === 0) continue;
      itens.push({ data, descricao: (r[iDesc] || "Sem descrição").slice(0, 200), valor });
    }
    // fatura Nubank: colunas date,title,amount com compras positivas
    const cartao = cab.includes("title") && cab.includes("amount");
    return { itens, cartao };
  }

  let pdfjsPronto = null;
  function carregarPdfJs() {
    if (pdfjsPronto) return pdfjsPronto;
    pdfjsPronto = new Promise((ok, erro) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; ok(window.pdfjsLib); };
      s.onerror = () => { pdfjsPronto = null; erro(new Error("Não consegui carregar o leitor de PDF. Verifique a internet.")); };
      document.head.appendChild(s);
    });
    return pdfjsPronto;
  }
  const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
  // lê o texto do PDF e monta as linhas como aparecem na página
  async function textoPDF(buf, senha) {
    const pdfjs = await carregarPdfJs();
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), password: senha || undefined }).promise;
    } catch (err) {
      if (err && err.name === "PasswordException") throw { precisaSenha: true, senhaErrada: !!senha };
      throw new Error("Não consegui abrir este PDF. Ele pode estar corrompido.");
    }
    const linhas = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      const itens = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({ x: it.transform[4], y: it.transform[5], t: it.str }));
      itens.sort((a, b) => b.y - a.y || a.x - b.x);
      const grupos = [];
      for (const it of itens) {
        const g = grupos.find((g) => Math.abs(g.y - it.y) < 3);
        if (g) g.itens.push(it); else grupos.push({ y: it.y, itens: [it] });
      }
      grupos.sort((a, b) => b.y - a.y).forEach((g) => linhas.push(g.itens.sort((a, b) => a.x - b.x).map((i) => i.t).join(" ").replace(/\s+/g, " ").trim()));
    }
    return linhas;
  }

  function lerLinhasPDF(linhas) {
    const texto = linhas.join("\n");
    if (texto.replace(/\s/g, "").length < 30) throw new Error("Este PDF parece ser uma imagem (foto ou escaneado), então não dá para ler o texto. Baixe o extrato em PDF pelo app do banco, ou em OFX ou CSV.");
    const anoM = texto.match(/\b(20\d{2})\b/);
    const anoPadrao = anoM ? +anoM[1] : new Date().getFullYear();
    const reData = /^(?:(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?|(\d{1,2})\s+(?:de\s+)?(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-zç]*\.?(?:\s+(?:de\s+)?(\d{4}))?)\b\s*/i;
    const reValor = /(?:R\$\s*)?([-−–+]\s?)?(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})(\s?[-DC]\b|\s?-)?/i;
    const temNegativo = /(^|\s)[-−–]\s?(R\$\s*)?\d{1,3}(\.\d{3})*,\d{2}|\d,\d{2}\s?(-|D\b)/m.test(texto);
    const itens = [];
    let dataAtual = null, modo = 0, pendente = "";
    for (let l of linhas) {
      const sem = semAcento(l);
      // seções de saídas e entradas (formato Nubank e parecidos)
      if (/^total de saidas|^saidas\b|^debitos\b|^valores debitados/.test(sem)) { modo = -1; continue; }
      if (/^total de entradas|^entradas\b|^creditos\b|^valores creditados/.test(sem)) { modo = 1; continue; }
      const md = l.match(reData);
      if (md) {
        const dia = md[1] || md[4], mes = md[2] || MESES[semAcento(md[5]).slice(0, 3)], ano = md[3] || md[6];
        const y = ano ? (String(ano).length === 2 ? 2000 + +ano : +ano) : anoPadrao;
        if (+mes >= 1 && +mes <= 12 && +dia >= 1 && +dia <= 31) {
          dataAtual = `${y}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
          l = l.slice(md[0].length).trim();
          if (!/\d,\d{2}/.test(l)) modo = 0; // novo dia: zera a seção
        }
      }
      if (!dataAtual || !l) continue;
      if (/saldo|^total|limite dispon|resumo|pagina \d|periodo|extrato|agencia|conta corrente|^data\b|lancamento.*valor/.test(semAcento(l))) { pendente = ""; continue; }
      const mv = l.match(reValor);
      if (!mv) { if (l.length > 2 && /[a-z]/i.test(l)) pendente = (pendente ? pendente + " " : "") + l; continue; }
      let desc = l.slice(0, mv.index).replace(/[-−–+]\s*$/, "").trim();
      if (desc.length < 2) desc = pendente;
      pendente = "";
      if (!desc || desc.length < 2) continue;
      let valor = parseFloat(mv[2].replace(/\./g, "").replace(",", "."));
      if (!valor) continue;
      const sinal = (mv[1] || "").trim(), suf = (mv[3] || "").trim().toUpperCase();
      let neg;
      if (/[-−–]/.test(sinal) || suf === "-" || suf === "D") neg = true;
      else if (sinal === "+" || suf === "C") neg = false;
      else if (modo) neg = modo < 0;
      else if (temNegativo) neg = false; // o banco marca as saídas com "-": sem sinal é entrada
      else neg = !/recebid|recebimento|salario|deposito|estorno|credito em conta|rendimento/.test(semAcento(desc));
      itens.push({ data: dataAtual, descricao: desc.slice(0, 200), valor: neg ? -valor : valor });
    }
    return itens;
  }

  // procura "saldo inicial/anterior" e "saldo final" no texto do PDF
  function saldosPDF(linhas) {
    const val = (l) => {
      const m = l.match(/([-−–]?)\s?(?:R\$\s*)?([-−–]?)\s?(\d{1,3}(?:\.\d{3})*,\d{2})(\s?[-D])?/i);
      if (!m) return null;
      const v = parseFloat(m[3].replace(/\./g, "").replace(",", "."));
      return (m[1] || m[2] || (m[4] || "").trim()) ? -v : v;
    };
    let ini = null, fim = null;
    for (const l of linhas) {
      const s = semAcento(l);
      if (ini == null && /saldo (inicial|anterior)/.test(s)) ini = val(l.slice(s.search(/saldo (inicial|anterior)/)));
      if (/saldo (final|atual|disponivel|em conta|do dia)/.test(s)) { const v = val(l.slice(s.search(/saldo (final|atual|disponivel|em conta|do dia)/))); if (v != null) fim = v; }
    }
    return { saldoInicial: ini, saldoFinal: fim };
  }

  async function lerPDF(buf, senha) {
    const linhas = await textoPDF(buf, senha);
    return { itens: lerLinhasPDF(linhas), pdf: true, linhas, ...saldosPDF(linhas) };
  }

  // ---------------- pré-visualização ----------------
  let previa = [], nomeArquivo = "";
  function optsCategorias(sel) {
    return Object.entries(CATS).map(([k, c]) => `<option value="${k}"${k === sel ? " selected" : ""}>${c.nome}</option>`).join("");
  }
  function hashDe(l, n) { return [l.data, l.valor.toFixed(2), semAcento(l.descricao).replace(/\s+/g, " "), n].join("|"); }

  function montarPrevia(itens, cartao) {
    const inverter = $("previa-inverter").checked;
    const vistos = {};
    previa = itens.map((it) => {
      const valor = inverter ? -it.valor : it.valor;
      const base = { ...it, valor };
      const h0 = hashDe(base, 0); vistos[h0] = (vistos[h0] || 0) + 1;
      return { ...base, chave: chaveDe(it.descricao), categoria: categorizar(it.descricao, valor), hash: hashDe(base, vistos[h0] - 1), incluir: true };
    });
    const jaTem = new Set(st.lancamentos.map((l) => l.hash));
    let repetidos = 0;
    previa.forEach((p) => { if (jaTem.has(p.hash)) { p.incluir = false; p.repetido = true; repetidos++; } });
    const datas = previa.map((p) => p.data).sort();
    $("previa-info").textContent = previa.length
      ? `${previa.length} lançamentos de ${datas[0].split("-").reverse().join("/")} a ${datas[datas.length - 1].split("-").reverse().join("/")}${repetidos ? ` · ${repetidos} já importados` : ""}`
      : "";
    $("previa-lista").innerHTML = previa.map((p, i) => linhaLanc(p, i, true)).join("");
    resumoPrevia();
    $("previa").hidden = false;
    $("previa").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  let ultimosItens = [];
  let ultimoSaldo = { inicial: null, final: null }, inicialDigitado = false, dono = "A", resumoMeses = [];
  const nomesP = () => ({ A: st.config.nome_a || "Pessoa 1", B: st.config.nome_b || "Pessoa 2" });

  // calcula, mês a mês, quanto tinha no começo, quanto entrou, quanto saiu e quanto ficou
  function resumoPrevia() {
    const cartao = $("previa-inverter").checked;
    $("previa-resumo").hidden = cartao || previa.length === 0;
    if (cartao || !previa.length) { resumoMeses = []; return; }
    const n = nomesP();
    $("previa-dono").querySelectorAll("button").forEach((b) => { b.textContent = n[b.dataset.dono]; b.setAttribute("aria-pressed", b.dataset.dono === dono); });
    // usa todas as linhas do arquivo (também as já importadas) para o saldo bater com o banco
    const meses = {};
    for (const p of previa) {
      const m = p.data.slice(0, 7);
      meses[m] = meses[m] || { entrou: 0, saiu: 0 };
      if (p.valor > 0) meses[m].entrou += p.valor; else meses[m].saiu -= p.valor;
    }
    const ordem = Object.keys(meses).sort();
    const totalLiq = ordem.reduce((s, m) => s + meses[m].entrou - meses[m].saiu, 0);
    let inicial;
    if (inicialDigitado) inicial = NC.parse($("previa-inicial").value);
    else if (ultimoSaldo.inicial != null) inicial = ultimoSaldo.inicial;
    else if (ultimoSaldo.final != null) inicial = ultimoSaldo.final - totalLiq;
    else {
      // sem saldo no arquivo: usa o "dinheiro que já estava na conta" do primeiro mês, se houver
      const ex = (st.ext[ordem[0]] || {})[dono];
      inicial = ex && ex.inicial != null ? ex.inicial : 0;
    }
    inicial = Math.round(inicial * 100) / 100;
    if (!inicialDigitado) $("previa-inicial").value = NC.paraCampo(Math.abs(inicial)) ? (inicial < 0 ? "-" : "") + NC.paraCampo(Math.abs(inicial)) : "0,00";
    $("previa-inicial-ajuda").textContent = inicialDigitado ? "Valor digitado por você."
      : ultimoSaldo.inicial != null ? "Lido do extrato (saldo inicial)."
      : ultimoSaldo.final != null ? `Calculado pelo saldo final do extrato (${fmt(ultimoSaldo.final)}).`
      : "O arquivo não traz o saldo. Confira no app do banco e corrija aqui se precisar.";
    let corrente = inicial;
    resumoMeses = ordem.map((m) => {
      const r = { mes: m, inicial: corrente, entrou: Math.round(meses[m].entrou * 100) / 100, saiu: Math.round(meses[m].saiu * 100) / 100 };
      r.final = Math.round((r.inicial + r.entrou - r.saiu) * 100) / 100;
      corrente = r.final;
      return r;
    });
    $("previa-tabela").innerHTML = resumoMeses.map((r) => `<tr><td>${nomeMes(r.mes)}</td><td>${fmt(r.inicial)}</td><td class="ok">+ ${fmt(r.entrou)}</td><td class="alerta">− ${fmt(r.saiu)}</td><td><b>${fmt(r.final)}</b></td></tr>`).join("");
    const ult = resumoMeses[resumoMeses.length - 1];
    $("previa-usar-saldo-txt").textContent = `Usar o que ficou no fim de cada mês como "dinheiro que já estava na conta" no mês seguinte (ex.: ${fmt(ult.final)} no começo de ${nomeMes(NC.somaMes(ult.mes, 1), true)})`;
    const hoje = NC.chaveMes(new Date());
    $("previa-atual-wrap").hidden = ult.mes !== hoje;
    $("previa-atual-txt").textContent = `Atualizar "tem na conta agora" de ${n[dono]} para ${fmt(ult.final)}`;
  }
  $("previa-dono").addEventListener("click", (e) => { const b = e.target.closest("[data-dono]"); if (b) { dono = b.dataset.dono; resumoPrevia(); } });
  $("previa-inicial").addEventListener("input", () => { inicialDigitado = true; resumoPrevia(); });
  $("previa-inverter").addEventListener("change", () => montarPrevia(ultimosItens));
  $("previa-lista").addEventListener("change", (e) => { if (e.target.closest("[data-inc]")) resumoPrevia(); });

  function linhaLanc(l, i, ehPrevia) {
    const c = CATS[l.categoria] || CATS.outros;
    const dt = l.data.split("-").reverse().slice(0, 2).join("/");
    return `<li class="lanc${ehPrevia && !l.incluir ? " fora" : ""}" style="--cat:${c.cor}">
      ${ehPrevia ? `<input type="checkbox" class="lanc-chk" data-inc="${i}" ${l.incluir ? "checked" : ""} aria-label="Incluir ${esc(l.descricao)}">` : ""}
      <div class="lanc-corpo">
        <div class="lanc-l1"><span class="lanc-desc">${esc(l.descricao)}</span><b class="${l.valor > 0 ? "ok" : ""}">${l.valor > 0 ? "+" : "−"} ${fmt(Math.abs(l.valor))}</b></div>
        <div class="lanc-l2"><span class="muted pequeno">${dt}${l.repetido ? " · já importado" : ""}${!ehPrevia && l.origem === "manual" ? " · " + esc(quemNome(l.quem)) : ""}</span>
          <select class="cat-sel" ${ehPrevia ? `data-pcat="${i}"` : `data-lcat="${l.id}"`} aria-label="Categoria">${optsCategorias(l.categoria)}</select>
        </div>
        ${ehPrevia ? "" : `<button class="del-lanc" data-del="${l.id}" type="button">excluir</button>`}
      </div>
    </li>`;
  }

  $("previa-lista").addEventListener("change", (e) => {
    const inc = e.target.closest("[data-inc]");
    if (inc) { const p = previa[+inc.dataset.inc]; p.incluir = inc.checked; inc.closest(".lanc").classList.toggle("fora", !p.incluir); return; }
    const sel = e.target.closest("[data-pcat]");
    if (sel) {
      const p = previa[+sel.dataset.pcat]; const nova = sel.value;
      // aplica a mesma escolha a todos do mesmo estabelecimento nesta importação
      previa.forEach((q, j) => { if (q.chave === p.chave) { q.categoria = nova; q.escolhida = true; const s = $("previa-lista").querySelector(`[data-pcat="${j}"]`); if (s) { s.value = nova; s.closest(".lanc").style.setProperty("--cat", CATS[nova].cor); } } });
    }
  });
  $("previa-cancelar").onclick = () => { previa = []; $("previa").hidden = true; };
  $("previa-salvar").onclick = async () => {
    const salvar = previa.filter((p) => p.incluir);
    if (!salvar.length) return toast("Nenhum lançamento marcado para salvar.");
    $("previa-salvar").disabled = true; sinc("Salvando…");
    const linhas = salvar.map((p) => ({ casal_id: st.casal, data: p.data, descricao: p.descricao, valor: Math.round(p.valor * 100) / 100, categoria: p.categoria, chave: p.chave, origem: nomeArquivo.slice(0, 80), hash: p.hash }));
    let erro = null;
    for (let i = 0; i < linhas.length && !erro; i += 500) {
      const { error } = await sb.from("caixa_lancamentos").upsert(linhas.slice(i, i + 500), { onConflict: "casal_id,hash", ignoreDuplicates: true });
      erro = error;
    }
    // lembra as escolhas feitas à mão
    const regras = {};
    salvar.filter((p) => p.escolhida).forEach((p) => (regras[p.chave] = p.categoria));
    if (!erro && Object.keys(regras).length) {
      const { error } = await sb.from("caixa_regras").upsert(Object.entries(regras).map(([chave, categoria]) => ({ casal_id: st.casal, chave, categoria })));
      if (!error) Object.assign(st.regras, regras);
    }
    $("previa-salvar").disabled = false;
    if (erro) return falhou(erro);
    sinc("Salvo", "ok");
    const { data } = await sb.from("caixa_lancamentos").select("*").eq("casal_id", st.casal).order("data", { ascending: false }).limit(5000);
    if (data) st.lancamentos = data.map((l) => ({ ...l, valor: Number(l.valor) }));
    // vai para o mês com mais lançamentos importados
    const cont = {}; salvar.forEach((p) => { const m = p.data.slice(0, 7); cont[m] = (cont[m] || 0) + 1; });
    st.mes = Object.entries(cont).sort((a, b) => b[1] - a[1])[0][0];
    // guarda o resumo do extrato (tinha, entrou, saiu, ficou) de cada mês
    if (resumoMeses.length) {
      const campo = dono === "A" ? "ext_a" : "ext_b", outro = dono === "A" ? "B" : "A";
      const linhasMes = {};
      for (const r of resumoMeses) {
        linhasMes[r.mes] = { casal_id: st.casal, mes: r.mes, [campo]: { inicial: r.inicial, entrou: r.entrou, saiu: r.saiu, final: r.final, arquivo: nomeArquivo.slice(0, 80) } };
        st.ext[r.mes] = { ...(st.ext[r.mes] || {}), [dono]: linhasMes[r.mes][campo] };
      }
      if ($("previa-usar-saldo").checked) {
        for (const r of resumoMeses) {
          const prox = NC.somaMes(r.mes, 1);
          const doOutro = (st.ext[r.mes] || {})[outro];
          const total = Math.max(0, r.final + (doOutro ? doOutro.final : 0));
          linhasMes[prox] = { ...(linhasMes[prox] || { casal_id: st.casal, mes: prox }), saldo: Math.round(total * 100) / 100 };
        }
      }
      const ult = resumoMeses[resumoMeses.length - 1];
      if (!$("previa-atual-wrap").hidden && $("previa-atual").checked) {
        const bk = st.banco[ult.mes] || {};
        linhasMes[ult.mes] = { ...linhasMes[ult.mes], conta_a: dono === "A" ? ult.final : bk.A ?? null, conta_b: dono === "B" ? ult.final : bk.B ?? null, conta_em: new Date().toISOString() };
      }
      // agrupa por conjunto de colunas para o upsert não apagar nada
      const grupos = {};
      Object.values(linhasMes).forEach((l) => { const k = Object.keys(l).sort().join(","); (grupos[k] = grupos[k] || []).push(l); });
      for (const g of Object.values(grupos)) {
        const { error } = await sb.from("caixa_meses").upsert(g);
        if (error) { falhou(error); break; }
      }
      await NC.recarregar();
    }
    previa = []; $("previa").hidden = true;
    NC.render();
    toast(`${salvar.length} lançamentos salvos`);
  };

  $("arquivo").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (!f) return;
    nomeArquivo = f.name;
    if (f.size > 15 * 1024 * 1024) return toast("Arquivo muito grande (máximo 15 MB).");
    $("soltar").classList.add("lendo");
    try {
      const nome = f.name.toLowerCase();
      let res;
      if (nome.endsWith(".pdf") || f.type === "application/pdf") {
        pdfBuf = await f.arrayBuffer();
        $("pdf-senha-box").hidden = true;
        res = await lerPDF(pdfBuf);
      }
      else {
        const buf = await f.arrayBuffer();
        let txt = new TextDecoder("utf-8").decode(buf);
        if (txt.includes("�")) txt = new TextDecoder("windows-1252").decode(buf);
        res = /<OFX>|OFXHEADER|<STMTTRN>/i.test(txt) ? lerOFX(txt) : lerCSV(txt);
      }
      usarResultado(res);
    } catch (err) {
      tratarErro(err);
    } finally { $("soltar").classList.remove("lendo"); }
  });

  let pdfBuf = null;
  $("pdf-diag-fechar").onclick = () => ($("pdf-diag").hidden = true);
  function usarResultado(res) {
    if (res.erro) return toast(res.erro);
    $("pdf-diag").hidden = true;
    if (!res.itens.length) {
      if (res.pdf && res.linhas) {
        $("pdf-diag-texto").textContent = res.linhas.slice(0, 60).join("\n");
        $("pdf-diag").hidden = false;
        $("pdf-diag").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      return toast("Não encontrei lançamentos neste arquivo.");
    }
    $("pdf-senha-box").hidden = true;
    ultimosItens = res.itens;
    ultimoSaldo = { inicial: res.saldoInicial ?? null, final: res.saldoFinal ?? null };
    inicialDigitado = false;
    $("previa-inverter").checked = !!res.cartao;
    montarPrevia(res.itens);
  }
  function tratarErro(err) {
    if (err && err.precisaSenha) {
      $("pdf-senha-box").hidden = false;
      $("pdf-senha-msg").hidden = !err.senhaErrada;
      $("pdf-senha").value = "";
      setTimeout(() => $("pdf-senha").focus(), 50);
      return toast(err.senhaErrada ? "Senha errada. Tente de novo." : "Este PDF tem senha.");
    }
    console.error(err);
    toast((err && err.message) || "Não consegui ler este arquivo.");
  }
  $("pdf-senha-box").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!pdfBuf) return;
    $("pdf-senha-ok").disabled = true;
    try { usarResultado(await lerPDF(pdfBuf, $("pdf-senha").value.trim())); }
    catch (err) { tratarErro(err); }
    finally { $("pdf-senha-ok").disabled = false; }
  });

  // ---------------- análise do mês ----------------
  let filtro = "todas";
  $("g-filtro").addEventListener("change", (e) => { filtro = e.target.value; render(); });

  $("g-lista").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-lcat]"); if (!sel) return;
    const l = st.lancamentos.find((x) => x.id === sel.dataset.lcat); if (!l) return;
    const nova = sel.value, chave = l.chave || chaveDe(l.descricao);
    if (l.origem === "manual") {
      l.categoria = nova; render(); sinc("Salvando…");
      const { error } = await sb.from("caixa_lancamentos").update({ categoria: nova }).eq("id", l.id);
      if (error) return falhou(error);
      sinc("Salvo", "ok"); return toast(`Categoria trocada para ${CATS[nova].nome}`);
    }
    const mesmos = st.lancamentos.filter((x) => (x.chave || chaveDe(x.descricao)) === chave && (x.valor > 0) === (l.valor > 0));
    mesmos.forEach((x) => (x.categoria = nova));
    st.regras[chave] = nova;
    render();
    sinc("Salvando…");
    const r1 = await sb.from("caixa_lancamentos").update({ categoria: nova }).in("id", mesmos.map((x) => x.id));
    const r2 = await sb.from("caixa_regras").upsert({ casal_id: st.casal, chave, categoria: nova });
    if (r1.error || r2.error) return falhou(r1.error || r2.error);
    sinc("Salvo", "ok");
    toast(mesmos.length > 1 ? `${mesmos.length} lançamentos de "${chave}" agora são ${CATS[nova].nome}` : `Categoria trocada para ${CATS[nova].nome}`);
  });

  let render = function (r) {
    r = r || NC.calcular();
    const m = st.mes;
    const doMes = st.lancamentos.filter((l) => l.data.slice(0, 7) === m);
    const exm = st.ext[m] || {}, nn = nomesP();
    const cards = ["A", "B"].filter((k) => exm[k]).map((k) => {
      const e = exm[k];
      return `<div class="ext-card ${k}"><h3>${esc(nn[k])}</h3><dl>
        <div><dt>Tinha no começo</dt><dd>${fmt(e.inicial)}</dd></div>
        <div><dt>Entrou</dt><dd class="ok">+ ${fmt(e.entrou)}</dd></div>
        <div><dt>Saiu</dt><dd class="alerta">− ${fmt(e.saiu)}</dd></div>
        <div class="fim"><dt>Ficou no fim</dt><dd>${fmt(e.final)}</dd></div></dl></div>`;
    });
    $("g-ext-box").hidden = cards.length === 0;
    $("g-ext").innerHTML = cards.join("");
    const saidas = doMes.filter((l) => l.valor < 0), entradas = doMes.filter((l) => l.valor > 0);
    const saiu = -saidas.reduce((s, l) => s + l.valor, 0), entrou = entradas.reduce((s, l) => s + l.valor, 0);
    $("g-saiu").textContent = fmt(saiu);
    $("g-entrou").textContent = fmt(entrou);
    $("g-qtd").textContent = doMes.length;
    $("g-vazio").hidden = doMes.length > 0;
    $("g-lista-box").hidden = doMes.length === 0;

    const porCat = {};
    saidas.forEach((l) => { porCat[l.categoria] = (porCat[l.categoria] || 0) - l.valor; });
    const cats = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
    const maior = cats.length ? cats[0][1] : 1;
    $("g-cats").innerHTML = cats.map(([k, v]) => {
      const c = CATS[k] || CATS.outros;
      const qtd = saidas.filter((l) => l.categoria === k).length;
      return `<li style="--cat:${c.cor}">
        <div class="cat-l1"><span class="cat-nome"><i></i>${c.nome}</span><b>${fmt(v)}</b></div>
        <div class="cat-barra"><i style="width:${(v / maior * 100).toFixed(1)}%"></i></div>
        <span class="muted pequeno">${Math.round(v / (saiu || 1) * 100)}% do que saiu · ${qtd} ${qtd === 1 ? "lançamento" : "lançamentos"}</span>
      </li>`;
    }).join("");

    const porEnt = {};
    entradas.forEach((l) => { porEnt[l.categoria] = (porEnt[l.categoria] || 0) + l.valor; });
    const ents = Object.entries(porEnt).sort((a, b) => b[1] - a[1]);
    $("g-entradas-box").hidden = ents.length === 0;
    $("g-entradas").innerHTML = ents.map(([k, v]) => {
      const c = CATS[k] || CATS.entrada;
      return `<li style="--cat:${c.cor}"><div class="cat-l1"><span class="cat-nome"><i></i>${c.nome}</span><b class="ok">+ ${fmt(v)}</b></div>
        <div class="cat-barra"><i style="width:${(v / ents[0][1] * 100).toFixed(1)}%"></i></div>
        <span class="muted pequeno">${["extra", "reembolso", "presente"].includes(k) ? "Soma na sobra do mês" : k === "salario" ? "Já contado na aba Renda" : "Não soma na sobra (pode ser transferência entre vocês)"}</span></li>`;
    }).join("");

    // compara com o planejado
    const lazerGasto = porCat.lazer || 0;
    const comp = [];
    if (saidas.length && r.lazer > 0) {
      const pct = lazerGasto / r.lazer * 100;
      comp.push(`<div class="comp ${pct > 100 ? "ruim" : "bom"}"><b>Lazer:</b> gastaram ${fmt(lazerGasto)} de ${fmt(r.lazer)} planejados${pct > 100 ? ` (passou ${fmt(lazerGasto - r.lazer)})` : ` (ainda tem ${fmt(r.lazer - lazerGasto)})`}.</div>`);
    }
    if (saidas.length && r.renda > 0) {
      const sobrou = r.renda + r.saldo - saiu;
      comp.push(`<div class="comp ${sobrou < r.guardar ? "ruim" : "bom"}"><b>Guardar:</b> pela renda e pelo que saiu, sobraram ${fmt(sobrou)}. A meta era guardar ${fmt(r.guardar)}.</div>`);
    }
    $("g-comparar").innerHTML = comp.join("");
    $("g-comparar").hidden = comp.length === 0;

    // filtro e lista
    const usadas = [...new Set(doMes.map((l) => l.categoria))];
    if (filtro !== "todas" && !usadas.includes(filtro)) filtro = "todas";
    $("g-filtro").innerHTML = `<option value="todas">Todas as categorias</option>` + usadas.map((k) => `<option value="${k}"${k === filtro ? " selected" : ""}>${(CATS[k] || CATS.outros).nome}</option>`).join("");
    const lista = (filtro === "todas" ? doMes : doMes.filter((l) => l.categoria === filtro)).sort((a, b) => b.data.localeCompare(a.data));
    $("g-lista").innerHTML = lista.map((l) => linhaLanc(l, 0, false)).join("");
  }

  // ---------------- lançar gasto à mão ----------------
  const RAPIDAS = ["comida", "lazer", "transporte", "faculdade", "contas", "compras", "saude", "moradia", "assinaturas", "outros"];
  const RAPIDAS_ENTRADA = ["extra", "presente", "reembolso", "salario", "entrada"];
  let gmCat = "comida", gmQuem = "ambos", gmTipo = "saida";
  function setTipoGasto(t) {
    gmTipo = t;
    const ent = t === "entrada";
    $("gm-tipo").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.gtipo === t));
    gmCat = ent ? "extra" : "comida";
    $("gm-titulo").textContent = ent ? "Entrou dinheiro" : "Lançar um gasto";
    $("gm-ex").textContent = ent ? "ex.: Pix de R$ 150 de um trabalho extra" : "ex.: R$ 20 no almoço";
    $("gm-cat-lbl").textContent = ent ? "De onde veio?" : "Com o quê?";
    $("gm-quem-lbl").textContent = ent ? "Quem recebeu" : "Quem gastou";
    $("gm-desc").placeholder = ent ? "Ex.: freela de design, bico no fim de semana" : "Ex.: almoço, Uber, xerox";
    $("gm-salvar").textContent = ent ? "Salvar entrada" : "Salvar gasto";
    $("gm-ajuda").hidden = !ent;
    $("form-gasto").classList.toggle("modo-entrada", ent);
    desenharChips();
  }
  const nomes = () => ({ A: st.config.nome_a || "Pessoa 1", B: st.config.nome_b || "Pessoa 2", ambos: "Os dois" });
  function quemNome(q) { return nomes()[q] || "Os dois"; }
  const hojeISO = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  function desenharChips() {
    $("gm-cats").innerHTML = (gmTipo === "entrada" ? RAPIDAS_ENTRADA : RAPIDAS).map((k) => `<button type="button" role="radio" aria-checked="${k === gmCat}" data-gcat="${k}" style="--cat:${CATS[k].cor}"><i></i>${CATS[k].nome}</button>`).join("");
  }
  desenharChips();
  $("gm-data").value = hojeISO();
  $("gm-tipo").addEventListener("click", (e) => { const b = e.target.closest("[data-gtipo]"); if (b) setTipoGasto(b.dataset.gtipo); });
  document.addEventListener("click", (e) => { const b = e.target.closest("[data-tipo]"); if (b) setTipoGasto(b.dataset.tipo); });
  $("gm-cats").addEventListener("click", (e) => { const b = e.target.closest("[data-gcat]"); if (!b) return; gmCat = b.dataset.gcat; desenharChips(); });
  $("gm-quem").addEventListener("click", (e) => {
    const b = e.target.closest("[data-quem]"); if (!b) return; gmQuem = b.dataset.quem;
    $("gm-quem").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  });
  $("form-gasto").addEventListener("submit", async (e) => {
    e.preventDefault();
    const valor = NC.parse($("gm-valor").value);
    const data = $("gm-data").value || hojeISO();
    const ent = gmTipo === "entrada";
    if (!(valor > 0)) return (($("gm-msg").textContent = ent ? "Digite quanto entrou, por exemplo 150,00." : "Digite quanto foi gasto, por exemplo 20,00."), ($("gm-msg").hidden = false));
    $("gm-msg").hidden = true;
    const descricao = $("gm-desc").value.trim() || CATS[gmCat].nome;
    const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
    const linha = { casal_id: st.casal, data, descricao: descricao.slice(0, 200), valor: (ent ? 1 : -1) * Math.round(valor * 100) / 100, categoria: gmCat, chave: chaveDe(descricao), origem: "manual", quem: gmQuem, hash: "manual|" + id };
    // tira o gasto (ou soma a entrada) do saldo de quem gastou, se o saldo do mês foi informado
    const mesL = data.slice(0, 7), bk = { ...(st.banco[mesL] || {}) };
    const propA = NC.calcular().propA, v = Math.abs(linha.valor);
    const parte = gmQuem === "A" ? { A: v, B: 0 } : gmQuem === "B" ? { A: 0, B: v } : { A: v * propA, B: v * (1 - propA) };
    const desc = {}; let mexeu = false;
    for (const k of ["A", "B"]) if (bk[k] != null && parte[k]) { desc[k] = Math.round(parte[k] * (ent ? 1 : -1) * 100) / 100; bk[k] = Math.round((bk[k] + desc[k]) * 100) / 100; mexeu = true; }
    if (mexeu) linha.descontado = { mes: mesL, ...desc };
    $("gm-salvar").disabled = true; sinc("Salvando…");
    const { data: salvo, error } = await sb.from("caixa_lancamentos").insert(linha).select().single();
    $("gm-salvar").disabled = false;
    if (error) return falhou(error);
    if (mexeu) { bk.em = new Date().toISOString(); st.banco[mesL] = bk; NC.salvarBanco(mesL); }
    st.lancamentos.unshift({ ...salvo, valor: Number(salvo.valor) });
    sinc("Salvo", "ok");
    st.mes = data.slice(0, 7);
    $("gm-valor").value = ""; $("gm-desc").value = "";
    NC.render();
    const nm = nomes();
    const deQuem = gmQuem === "ambos" ? "dos dois" : "de " + nm[gmQuem];
    toast(ent ? `Entrada de ${fmt(valor)} salva${mexeu ? `, somada ao saldo ${deQuem}` : ""}` : `${fmt(valor)} em ${CATS[gmCat].nome} salvo${mexeu ? `, descontado do saldo ${deQuem}` : ""}`);
  });
  $("g-lista").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    if (!b.dataset.confirmar) { b.dataset.confirmar = "1"; b.textContent = "confirmar exclusão"; b.classList.add("confirmar"); setTimeout(() => { if (b.isConnected) { b.dataset.confirmar = ""; b.textContent = "excluir"; b.classList.remove("confirmar"); } }, 4000); return; }
    const id = b.dataset.del;
    const l = st.lancamentos.find((x) => x.id === id);
    const { error } = await sb.from("caixa_lancamentos").delete().eq("id", id);
    if (error) return falhou(error);
    st.lancamentos = st.lancamentos.filter((x) => x.id !== id);
    // devolve ao saldo o que tinha sido descontado
    let voltou = false;
    if (l && l.descontado && l.descontado.mes) {
      const mesL = l.descontado.mes, bk = { ...(st.banco[mesL] || {}) };
      for (const k of ["A", "B"]) if (bk[k] != null && l.descontado[k]) { bk[k] = Math.round((bk[k] - l.descontado[k]) * 100) / 100; voltou = true; }
      if (voltou) { bk.em = new Date().toISOString(); st.banco[mesL] = bk; NC.salvarBanco(mesL); }
    }
    NC.render(); toast(voltou ? "Lançamento excluído e saldo corrigido" : "Lançamento excluído");
  });

  const renderOriginal = render;
  render = function (r) {
    const n = nomes();
    $("gm-quem").querySelector('[data-quem="A"]').textContent = n.A;
    $("gm-quem").querySelector('[data-quem="B"]').textContent = n.B;
    renderOriginal(r);
  };

  window.NC_gastos = { render: (r) => render(r) };
  render();
})();
