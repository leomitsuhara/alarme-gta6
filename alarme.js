#!/usr/bin/env node
// Alarme de PAUTAS CRUZADAS do GTA 6 (troca o alarme de notícias, a pedido da dona em 11/11/2026).
// Lê os vídeos novos dos youtubers e as notícias dos sites, junta tudo por assunto e só avisa no celular (ntfy)
// quando 2 ou mais youtubers fizeram o mesmo tema. Notícia sozinha nunca avisa: ela só reforça a pauta.
//
//   node alarme.js              roda de verdade (precisa de NTFY_TOPICO; usa GEMINI_API_KEY se tiver)
//   node alarme.js --simular    mostra os grupos e o que avisaria, sem mandar e sem guardar
//                  (+ --com-pendentes: inclui os canais ainda não aprovados, só para ver)
//   node alarme.js --marcar     guarda tudo e marca as pautas de hoje como já avisadas, sem avisar
//   node alarme.js --teste      manda já a pauta cruzada mais forte de agora (com "TESTE" no título)
//   node alarme.js --pedidos    só traz os toques no botão "Quero estudar" para pedidos.json
//
// O tópico do ntfy fica só no segredo do GitHub (NTFY_TOPICO), nunca neste arquivo: o projeto é público.

const fs = require('fs');
const path = require('path');

const PASTA = __dirname;
const ARQ = (n) => path.join(PASTA, n);
const lerJson = (n, padrao) => { try { return JSON.parse(fs.readFileSync(ARQ(n), 'utf8')); } catch { return padrao; } };
const gravar = (n, v) => fs.writeFileSync(ARQ(n), JSON.stringify(v, null, 1) + '\n');

const FONTES = lerJson('fontes.json');
const CRONO = lerJson('cronograma.json', { regras: [] });
const FILTRO = new RegExp(FONTES.filtro, 'i');
const JANELA_YT_H = 36;      // "desde ontem" (a dona pediu, 11/11/2026): 4 dias era muito tempo pro GTA 6
const JANELA_NOT_H = 36;
const GUARDA_DIAS = 10;      // itens e temas mais velhos saem dos arquivos
const MIN_YOUTUBERS = 2;
const MAX_AVISOS = 3;        // por rodada; o resto vai na seguinte
const CABECALHO = { 'user-agent': 'Mozilla/5.0 (compatible; alarme-pautas/1.0)' };
const MODELOS = ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-flash-lite-latest'];

const args = new Set(process.argv.slice(2));
const TOPICO = (process.env.NTFY_TOPICO || '').trim();
const CHAVE = (process.env.GEMINI_API_KEY || chaveLocal() || '').trim();

function chaveLocal() {
  // No PC: a chave do Gemini vem do .env da Máquina (nunca mostrar).
  try {
    const env = fs.readFileSync(path.resolve(PASTA, '..', '..', '..', '.env'), 'utf8');
    return (env.match(/^GEMINI_API_KEY_GTA=(.+)$/m) || env.match(/^GEMINI_API_KEY=(.+)$/m) || [])[1];
  } catch { return ''; }
}

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function limpar(texto) {
  return String(texto || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

function campo(bloco, ...tags) {
  for (const tag of tags) {
    const m = bloco.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m && limpar(m[1])) return limpar(m[1]);
  }
  return '';
}

function lerItens(xml) {
  const blocos = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocos.map((b) => {
    const href = b.match(/<link\b[^>]*\bhref="([^"]+)"/i);
    const link = campo(b, 'link') || (href ? limpar(href[1]) : '');
    const data = Date.parse(campo(b, 'pubDate', 'published', 'updated', 'dc:date'));
    const views = b.match(/<media:statistics\s+views="(\d+)"/i);
    return {
      id: campo(b, 'yt:videoId', 'guid', 'id') || link,
      titulo: campo(b, 'title'),
      link,
      data: Number.isNaN(data) ? null : data,
      views: views ? Number(views[1]) : null,
    };
  }).filter((i) => i.id && i.titulo && i.link);
}

async function baixar(fonte) {
  const url = fonte.url || `https://www.youtube.com/feeds/videos.xml?channel_id=${fonte.canal}`;
  const resposta = await fetch(url, { headers: CABECALHO, signal: AbortSignal.timeout(20000) });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return lerItens(await resposta.text());
}

// ---------- Gemini: dá a cada vídeo/notícia novo um TEMA (o mesmo nome para o mesmo assunto) ----------
async function gemini(texto) {
  for (const m of MODELOS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': CHAVE },
        body: JSON.stringify({
          contents: [{ parts: [{ text: texto }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 8192 },
        }),
        signal: AbortSignal.timeout(45000),
      });
      const j = await r.json().catch(() => ({}));
      const t = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (t) return JSON.parse(t);
      console.log(`Gemini ${m}: ${r.status} ${(j.error?.message || '').slice(0, 80)}`);
    } catch (erro) { console.log(`Gemini ${m}: ${erro.message.slice(0, 80)}`); }
  }
  return null;
}

async function darTemas(novos, temas) {
  if (!CHAVE || !novos.length) return false;
  const lista = temas.map((t) => `${t.id}: ${t.nome}`).join('\n') || '(nenhum ainda)';
  const pedidos = novos.map((n, i) => `${i + 1}. [${n.grupo === 'noticia' ? 'notícia' : 'vídeo'}] ${n.titulo}`).join('\n');
  const pedido = `Você organiza pautas de um canal de YouTube sobre GTA 6. Para cada título abaixo, diga qual é o TEMA do vídeo ou da notícia,
para juntar quem fez o mesmo assunto (em qualquer língua). O tema é o ÂNGULO específico, não só "GTA 6":
bons temas: "detalhes escondidos nas novas imagens", "tamanho e horário do pré-download", "coisas pra saber antes de jogar",
"comparação GTA 5 x GTA 6", "carros confirmados", "como ganhar dinheiro rápido". Ruim: "notícias de GTA 6", "GTA 6".
Se um tema que já existe serve, use o id dele. Se não, crie um nome novo curto em português (3 a 7 palavras).
Se o título não é pauta de GTA 6 (live, outro jogo, assunto vago), use "fora".

Temas que já existem:
${lista}

Títulos:
${pedidos}

Responda só JSON: [{"n":1,"tema":"t3"}, {"n":2,"novo":"nome do tema"}, {"n":3,"tema":"fora"}]`;
  const resposta = await gemini(pedido);
  if (!Array.isArray(resposta)) return false;
  let proximo = temas.reduce((m, t) => Math.max(m, Number(String(t.id).slice(1)) || 0), 0) + 1;
  const porNome = new Map(temas.map((t) => [semAcento(t.nome), t]));
  for (const r of resposta) {
    const item = novos[Number(r.n) - 1];
    if (!item) continue;
    if (r.tema === 'fora') { item.tema = 'fora'; continue; }
    if (r.tema && temas.some((t) => t.id === r.tema)) { item.tema = r.tema; continue; }
    if (r.novo) {
      const chave = semAcento(r.novo);
      let t = porNome.get(chave);
      if (!t) { t = { id: `t${proximo++}`, nome: String(r.novo).slice(0, 80), criado: Date.now() }; temas.push(t); porNome.set(chave, t); }
      item.tema = t.id;
    }
  }
  return true;
}

// Sem Gemini (ou se ele falhar): junta por palavra-chave. Pega menos coisa, mas não deixa o alarme parado.
const PALAVRAS = [
  ['kw:detalhes', 'detalhes escondidos / easter eggs', /easter egg|detalhe|detail|escondid|hidden|segredo|secret|nao viu|missed/],
  ['kw:preload', 'pré-download, tamanho e horário', /pre-?load|pre-?download|tamanho|file size|\bgb\b|unlock time|horario|que horas|release time/],
  ['kw:antes', 'coisas pra saber antes de jogar', /antes de jogar|precisa saber|before you (play|buy)|things to know|need to know/],
  ['kw:gta5x6', 'comparação GTA 5 x GTA 6', /gta 5 (x|vs)|gta v vs|(vs|x) gta 5|comparac|comparison|mudou|diferenc|differences/],
  ['kw:mapa', 'mapa de Leonida', /\bmapa\b|\bmap\b|leonida/],
  ['kw:carros', 'carros do GTA 6', /\bcarros?\b|\bcars?\b|vehicles|veiculos/],
  ['kw:trailer', 'novo trailer', /trailer/],
  ['kw:review', 'review e primeiras impressões', /review|analise final|impress|worth it|vale a pena/],
];
function temaPorPalavra(item) {
  const t = semAcento(item.titulo);
  const achou = PALAVRAS.find(([, , re]) => re.test(t));
  return achou ? achou[0] : null;
}
const nomeTema = (id, temas) => (temas.find((t) => t.id === id) || {}).nome || (PALAVRAS.find((p) => p[0] === id) || [])[1] || id;

function serieDoCronograma(nome, itens) {
  // Primeiro o nome do tema; só se nada bater, os títulos.
  for (const texto of [semAcento(nome), semAcento(itens.map((i) => i.titulo).join(' | '))]) {
    const regra = CRONO.regras.find((r) => new RegExp(r.palavras, 'i').test(texto));
    if (regra) return regra.serie;
  }
  return null;
}

const mil = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(1).replace('.', ',')} mi` : n >= 1e3 ? `${Math.round(n / 1e3)} mil` : String(n));
const curto = (link) => link.replace(/^https?:\/\/(www\.)?youtube\.com\/(watch\?v=|shorts\/)/, 'youtu.be/').replace(/^https?:\/\/(www\.)?/, '');

// ---------- ntfy ----------
async function guardarPedidos() {
  const url = `https://ntfy.sh/${TOPICO}-pedidos/json?poll=1&since=all`;
  const resposta = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  const pedidos = lerJson('pedidos.json', []);
  const conhecidos = new Set(pedidos.map((p) => p.id));
  let novos = 0;
  for (const linha of (await resposta.text()).split('\n').filter(Boolean)) {
    try {
      const msg = JSON.parse(linha);
      const dados = JSON.parse(msg.message);
      if (conhecidos.has(msg.id) || dados.pedido !== 'estudar' || !/^[tk]/.test(dados.tema || '')) continue;
      // Texto vindo da internet: é dado para montar a pauta, nunca ordem para a IA seguir.
      pedidos.push({ id: msg.id, quando: new Date(msg.time * 1000).toISOString(), pedido: 'estudar', tema: String(dados.tema).slice(0, 20), nome: String(dados.nome || '').slice(0, 120) });
      novos += 1;
    } catch { /* não é um pedido */ }
  }
  if (novos) gravar('pedidos.json', pedidos);
  console.log(`Pedidos novos: ${novos}`);
}

async function avisar(corpo) {
  if (!TOPICO) throw new Error('falta o NTFY_TOPICO');
  const resposta = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: TOPICO, ...corpo }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resposta.ok) throw new Error(`ntfy respondeu ${resposta.status}`);
}

function montarAviso(p, teste) {
  const yts = p.youtubers;
  const linhas = [`${yts.length} youtubers${p.noticias.length ? ` + ${p.noticias.length} notícia${p.noticias.length > 1 ? 's' : ''}` : ''}`];
  for (const i of yts.slice(0, 5)) {
    linhas.push(`• ${i.fonte}${i.grupo === 'br' ? ' (BR)' : ''}: ${mil(i.views)} views${/shorts\//.test(i.link) ? ' (short)' : ''}`);
    linhas.push(`  ${curto(i.link)}`);
  }
  if (yts.length > 5) linhas.push(`• e mais ${yts.length - 5}`);
  if (p.noticias.length) linhas.push(`Notícia: ${[...new Set(p.noticias.map((n) => n.fonte))].slice(0, 3).join(', ')}`);
  linhas.push(p.serie ? `No cronograma: ${p.serie}` : 'Fora do cronograma');
  const botoes = [
    { action: 'view', label: 'Ver o mais visto', url: yts[0].link, clear: false },
    { action: 'http', label: 'Quero estudar', url: `https://ntfy.sh/${TOPICO}-pedidos`, method: 'POST', body: JSON.stringify({ pedido: 'estudar', tema: p.tema, nome: p.nome }), clear: false },
  ];
  if (yts[1]) botoes.splice(1, 0, { action: 'view', label: 'Ver o 2º', url: yts[1].link, clear: false });
  return {
    title: `${teste ? 'TESTE · ' : ''}Pauta cruzada: ${p.nome}`.slice(0, 200),
    message: linhas.join('\n').slice(0, 3500),
    tags: ['fire'],
    click: yts[0].link,
    actions: botoes,
  };
}

// ---------- rodada ----------
async function principal() {
  if (args.has('--pedidos')) { await guardarPedidos(); return; }
  const simular = args.has('--simular');
  if (TOPICO && !simular && !args.has('--marcar')) {
    try { await guardarPedidos(); } catch (erro) { console.log(`Pedidos não lidos: ${erro.message}`); }
  }

  const fontes = [
    ...FONTES.youtubers.filter((f) => f.aprovado !== false || (simular && args.has('--com-pendentes'))),
    ...FONTES.noticias.map((f) => ({ ...f, grupo: 'noticia' })),
  ];
  const lidos = await Promise.all(fontes.map(async (fonte) => {
    try { return { fonte, itens: await baixar(fonte) }; }
    catch (erro) { console.log(`FALHOU ${fonte.nome}: ${erro.message}`); return { fonte, itens: [] }; }
  }));
  const certos = lidos.filter((r) => r.itens.length).length;
  console.log(`Fontes lidas: ${certos} de ${fontes.length}`);
  if (!certos) throw new Error('nenhuma fonte respondeu');

  const agora = Date.now();
  const itens = lerJson('itens.json', []).filter((i) => agora - (i.data || i.visto) < GUARDA_DIAS * 864e5);
  const temas = lerJson('temas.json', []).filter((t) => agora - t.criado < GUARDA_DIAS * 864e5 || itens.some((i) => i.tema === t.id));
  const avisadas = lerJson('avisadas.json', []);
  const porChave = new Map(itens.map((i) => [i.chave, i]));

  for (const { fonte, itens: lista } of lidos) {
    for (const it of lista) {
      if (!fonte.todos && !FILTRO.test(it.titulo)) continue;
      const janela = fonte.grupo === 'noticia' ? JANELA_NOT_H : JANELA_YT_H;
      if (it.data && agora - it.data > janela * 3600e3) continue;
      const chave = `${fonte.nome}|${it.id}`;
      const ja = porChave.get(chave);
      if (ja) {
        if (it.views != null) {
          ja.views = it.views;
          // Curva de crescimento (painel, 12/11/2026): 1 ponto por hora nas primeiras 72 h do vídeo.
          const h = ja.hist || (ja.hist = []);
          const ult = h[h.length - 1];
          if (agora - (ja.data || ja.visto) < 72 * 3600e3 && (!ult || agora - ult[0] >= 55 * 60e3)) h.push([agora, it.views]);
        }
        continue;
      }
      const novo = { chave, fonte: fonte.nome, grupo: fonte.grupo, titulo: it.titulo.slice(0, 200), link: it.link, data: it.data, views: it.views, visto: agora, tema: null, hist: it.views != null ? [[agora, it.views]] : [] };
      itens.push(novo); porChave.set(chave, novo);
    }
  }

  const semTema = itens.filter((i) => !i.tema || String(i.tema).startsWith('kw:'));
  console.log(`Itens na janela: ${itens.length}. Sem tema do Gemini: ${semTema.length}.`);
  let usouGemini = false;
  for (let k = 0; k < semTema.length; k += 40) {
    if (await darTemas(semTema.slice(k, k + 40), temas)) usouGemini = true;
  }
  for (const i of itens) if (!i.tema) i.tema = temaPorPalavra(i);
  if (!usouGemini && semTema.length) console.log(CHAVE ? 'Gemini falhou: juntei por palavra-chave.' : 'Sem GEMINI_API_KEY: juntei por palavra-chave.');

  // Junta por tema e vê quem cruzou.
  const grupos = new Map();
  for (const i of itens) {
    if (!i.tema || i.tema === 'fora') continue;
    const janela = (i.grupo === 'noticia' ? JANELA_NOT_H : JANELA_YT_H) * 3600e3;
    if (i.data && agora - i.data > janela) continue;
    if (!grupos.has(i.tema)) grupos.set(i.tema, []);
    grupos.get(i.tema).push(i);
  }
  const jaAvisado = new Set(avisadas.map((a) => a.tema));
  const nomesAvisados = new Set(avisadas.map((a) => semAcento(a.nome)));
  const pautas = [];
  for (const [tema, lista] of grupos) {
    const melhorPorCanal = new Map();
    for (const i of lista.filter((x) => x.grupo !== 'noticia')) {
      const atual = melhorPorCanal.get(i.fonte);
      if (!atual || (i.views || 0) > (atual.views || 0)) melhorPorCanal.set(i.fonte, i);
    }
    const youtubers = [...melhorPorCanal.values()].sort((a, b) => (b.views || 0) - (a.views || 0));
    const noticias = lista.filter((x) => x.grupo === 'noticia');
    const nome = nomeTema(tema, temas);
    pautas.push({ tema, nome, youtubers, noticias, serie: serieDoCronograma(nome, lista), forca: youtubers.length * 10 + noticias.length + Math.log10(1 + youtubers.reduce((s, i) => s + (i.views || 0), 0)) });
  }
  pautas.sort((a, b) => b.forca - a.forca);
  // 13/11/2026 (Conselho nota 8, dona): depois que o GTA 6 sai (18/11 8h de Brasília), 1 canal de GUIA sozinho já avisa
  // (guia antecipa o que o público vai procurar). Antes disso continua a regra de 2+ youtubers.
  const GUIA_SOZINHO = agora >= Date.parse('2026-11-18T08:00:00-03:00');
  const cruzadas = pautas.filter((p) => (p.youtubers.length >= MIN_YOUTUBERS || (GUIA_SOZINHO && p.youtubers.some((i) => i.grupo === 'guia'))) && !jaAvisado.has(p.tema) && !nomesAvisados.has(semAcento(p.nome)));

  if (simular) {
    console.log('\nGrupos (os 15 mais fortes):');
    for (const p of pautas.slice(0, 15)) console.log(`- [${p.tema}] ${p.nome}: ${p.youtubers.length} yt (${p.youtubers.map((i) => i.fonte).join(', ')}) + ${p.noticias.length} not. | ${p.serie || 'fora do cronograma'}${jaAvisado.has(p.tema) ? ' | JÁ AVISADA' : ''}`);
    console.log(`\nAvisaria ${cruzadas.length}:`);
    for (const p of cruzadas) console.log(`--- ${montarAviso(p).title}\n${montarAviso(p).message}`);
    return;
  }

  const marcar = (p) => avisadas.push({ tema: p.tema, nome: p.nome, quando: new Date().toISOString(), itens: p.youtubers.map((i) => i.chave) });
  let falhou = false;

  // Trava contra repetir: o que já chegou no celular nas últimas 24 h (pela reserva do PC, por exemplo) não toca de novo.
  if (TOPICO && cruzadas.length) {
    try {
      const r = await fetch(`https://ntfy.sh/${TOPICO}/json?poll=1&since=24h`, { signal: AbortSignal.timeout(20000) });
      const enviados = new Set((await r.text()).split('\n').filter(Boolean).map((l) => { try { return semAcento(JSON.parse(l).title || '').replace(/^teste · /, ''); } catch { return ''; } }));
      for (let k = cruzadas.length - 1; k >= 0; k--) {
        if (enviados.has(semAcento(montarAviso(cruzadas[k]).title))) { marcar(cruzadas[k]); cruzadas.splice(k, 1); }
      }
    } catch (erro) { console.log(`Histórico do ntfy não lido: ${erro.message}`); }
  }
  if (args.has('--marcar')) {
    cruzadas.forEach(marcar);
    console.log(`Marquei ${cruzadas.length} pautas como já avisadas, sem avisar.`);
  } else if (args.has('--teste')) {
    if (!cruzadas.length) console.log('Nenhuma pauta cruzada nova agora para o teste.');
    else { await avisar(montarAviso(cruzadas[0], true)); marcar(cruzadas[0]); console.log(`Teste enviado: ${cruzadas[0].nome}`); }
  } else {
    for (const p of cruzadas.slice(0, MAX_AVISOS)) {
      try { await avisar(montarAviso(p)); marcar(p); console.log(`Avisei: ${p.nome} (${p.youtubers.length} youtubers)`); }
      catch (erro) { console.log(`NÃO ENVIOU: ${erro.message}`); falhou = true; break; }
    }
    console.log(`Pautas cruzadas novas: ${cruzadas.length}.`);
  }

  gravar('itens.json', itens);
  gravar('temas.json', temas);
  gravar('avisadas.json', avisadas.slice(-500));
  if (falhou) process.exitCode = 1;
}

principal().catch((erro) => { console.error(`ERRO: ${erro.message}`); process.exit(1); });
