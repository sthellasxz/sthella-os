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
    comida:       { nome: "Comida e mercado", cor: "#E0703A" },
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
    entrada:      { nome: "Entrada (salário, Pix recebido)", cor: "#0F8A65" },
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
    if (valor > 0) return "entrada";
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
    return { itens: out, cartao: /<CREDITCARDMSGSRSV1>/i.test(txt) };
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
  async function lerPDF(buf) {
    const pdfjs = await carregarPdfJs();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const linhas = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const pg = await doc.getPage(p);
      const tc = await pg.getTextContent();
      const porY = new Map();
      for (const it of tc.items) {
        if (!it.str.trim()) continue;
        const y = Math.round(it.transform[5] / 3);
        if (!porY.has(y)) porY.set(y, []);
        porY.get(y).push([it.transform[4], it.str]);
      }
      [...porY.entries()].sort((a, b) => b[0] - a[0]).forEach(([, its]) => linhas.push(its.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(" ").replace(/\s+/g, " ").trim()));
    }
    const texto = linhas.join("\n");
    const anoM = texto.match(/\b(20\d{2})\b/);
    const ano = anoM ? anoM[1] : new Date().getFullYear();
    const itens = [];
    let dataAtual = null;
    const reValor = /(-?\s?R?\$?\s?-?\d{1,3}(?:\.\d{3})*,\d{2}\s?[-DC]?)\s*$/i;
    for (let l of linhas) {
      const md = l.match(/^(\d{2}\/\d{2}(?:\/\d{2,4})?)\s+/);
      if (md) { dataAtual = dataISO(md[1], ano); l = l.slice(md[0].length); }
      if (!dataAtual) continue;
      if (/saldo|total|limite/i.test(l)) continue;
      // pega o primeiro valor monetário da linha (o último costuma ser o saldo)
      const valores = l.match(/-?\s?R?\$?\s?-?\d{1,3}(?:\.\d{3})*,\d{2}\s?[-DC]?/gi);
      if (!valores) continue;
      const vTxt = valores[0];
      const desc = l.slice(0, l.indexOf(vTxt)).trim();
      if (!desc || desc.length < 2) continue;
      let valor = numBR(vTxt);
      if (!isFinite(valor) || valor === 0) continue;
      if (/C$/i.test(vTxt.trim())) valor = Math.abs(valor);
      itens.push({ data: dataAtual, descricao: desc.slice(0, 200), valor });
    }
    return { itens, pdf: true };
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
    $("previa").hidden = false;
    $("previa").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  let ultimosItens = [];
  $("previa-inverter").addEventListener("change", () => montarPrevia(ultimosItens));

  function linhaLanc(l, i, ehPrevia) {
    const c = CATS[l.categoria] || CATS.outros;
    const dt = l.data.split("-").reverse().slice(0, 2).join("/");
    return `<li class="lanc${ehPrevia && !l.incluir ? " fora" : ""}" style="--cat:${c.cor}">
      ${ehPrevia ? `<input type="checkbox" class="lanc-chk" data-inc="${i}" ${l.incluir ? "checked" : ""} aria-label="Incluir ${esc(l.descricao)}">` : ""}
      <div class="lanc-corpo">
        <div class="lanc-l1"><span class="lanc-desc">${esc(l.descricao)}</span><b class="${l.valor > 0 ? "ok" : ""}">${l.valor > 0 ? "+" : "−"} ${fmt(Math.abs(l.valor))}</b></div>
        <div class="lanc-l2"><span class="muted pequeno">${dt}${l.repetido ? " · já importado" : ""}</span>
          <select class="cat-sel" ${ehPrevia ? `data-pcat="${i}"` : `data-lcat="${l.id}"`} aria-label="Categoria">${optsCategorias(l.categoria)}</select>
        </div>
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
      if (nome.endsWith(".pdf") || f.type === "application/pdf") res = await lerPDF(await f.arrayBuffer());
      else {
        const buf = await f.arrayBuffer();
        let txt = new TextDecoder("utf-8").decode(buf);
        if (txt.includes("�")) txt = new TextDecoder("windows-1252").decode(buf);
        res = /<OFX>|OFXHEADER|<STMTTRN>/i.test(txt) ? lerOFX(txt) : lerCSV(txt);
      }
      if (res.erro) return toast(res.erro);
      if (!res.itens.length) return toast(res.pdf ? "Não encontrei lançamentos neste PDF. Tente baixar o extrato em OFX ou CSV." : "Não encontrei lançamentos neste arquivo.");
      ultimosItens = res.itens;
      $("previa-inverter").checked = !!res.cartao;
      montarPrevia(res.itens);
    } catch (err) {
      console.error(err);
      toast(err.message || "Não consegui ler este arquivo.");
    } finally { $("soltar").classList.remove("lendo"); }
  });

  // ---------------- análise do mês ----------------
  let filtro = "todas";
  $("g-filtro").addEventListener("change", (e) => { filtro = e.target.value; render(); });

  $("g-lista").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-lcat]"); if (!sel) return;
    const l = st.lancamentos.find((x) => x.id === sel.dataset.lcat); if (!l) return;
    const nova = sel.value, chave = l.chave || chaveDe(l.descricao);
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

  function render(r) {
    r = r || NC.calcular();
    const m = st.mes;
    const doMes = st.lancamentos.filter((l) => l.data.slice(0, 7) === m);
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

  window.NC_gastos = { render };
  render();
})();
