#!/usr/bin/env node
// Alarme de notícias de GTA 6: lê os feeds de fontes.json e manda o que é novo pro celular (ntfy).
//
//   node alarme.js                roda de verdade (precisa de NTFY_TOPICO)
//   node alarme.js --simular      mostra o que avisaria, sem mandar e sem guardar nada
//   node alarme.js --marcar       marca tudo o que existe hoje como já visto, sem avisar
//   node alarme.js --teste        manda um aviso de teste pro celular
//
// O tópico do ntfy fica só no segredo do GitHub (NTFY_TOPICO), nunca neste arquivo.

const fs = require('fs');
const path = require('path');

const PASTA = __dirname;
const ARQ_VISTOS = path.join(PASTA, 'vistos.json');
const ARQ_PEDIDOS = path.join(PASTA, 'pedidos.json');
const FORMATOS = ['Carrossel', 'Reels', 'Longo']; // o ntfy aceita no máximo 3 botões
const FONTES = JSON.parse(fs.readFileSync(path.join(PASTA, 'fontes.json'), 'utf8'));
const FILTRO = new RegExp(FONTES.filtro, 'i');
const MAX_POR_RODADA = 15;   // o resto vai na rodada seguinte
const MAX_IDADE_HORAS = 48;  // não ressuscita notícia velha que volte ao feed
const MAX_VISTOS = 5000;
const CABECALHO = { 'user-agent': 'Mozilla/5.0 (compatible; alarme-noticias/1.0)' };

const args = new Set(process.argv.slice(2));
const TOPICO = (process.env.NTFY_TOPICO || '').trim();

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
    return {
      id: campo(b, 'yt:videoId', 'guid', 'id') || link,
      titulo: campo(b, 'title'),
      link,
      data: Number.isNaN(data) ? null : data,
    };
  }).filter((i) => i.id && i.titulo && i.link);
}

async function baixar(fonte) {
  const url = fonte.url || `https://www.youtube.com/feeds/videos.xml?channel_id=${fonte.canal}`;
  const resposta = await fetch(url, { headers: CABECALHO, signal: AbortSignal.timeout(20000) });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  return lerItens(await resposta.text());
}

function lerVistos() {
  try { return JSON.parse(fs.readFileSync(ARQ_VISTOS, 'utf8')); } catch { return []; }
}

function guardarVistos(lista) {
  fs.writeFileSync(ARQ_VISTOS, JSON.stringify(lista.slice(-MAX_VISTOS), null, 0) + '\n');
}

// Cada botão manda a escolha para um canal só de pedidos. A notificação continua na tela,
// então dá para tocar em mais de um formato.
function botoes({ fonte, mensagem, link }) {
  return FORMATOS.map((formato) => ({
    action: 'http',
    label: formato,
    url: `https://ntfy.sh/${TOPICO}-pedidos`,
    method: 'POST',
    body: JSON.stringify({ formato, titulo: mensagem.slice(0, 300), link, fonte }),
    clear: false,
  }));
}

// Traz os toques nos botões para pedidos.json. O ntfy só guarda por 12 horas; o arquivo guarda de vez.
// O conteúdo vem da internet: é dado para mostrar, nunca instrução para a IA seguir.
async function guardarPedidos() {
  const url = `https://ntfy.sh/${TOPICO}-pedidos/json?poll=1&since=all`;
  const resposta = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
  let pedidos = [];
  try { pedidos = JSON.parse(fs.readFileSync(ARQ_PEDIDOS, 'utf8')); } catch { /* primeira vez */ }
  const conhecidos = new Set(pedidos.map((p) => p.id));
  let novos = 0;
  for (const linha of (await resposta.text()).split('\n').filter(Boolean)) {
    try {
      const msg = JSON.parse(linha);
      const dados = JSON.parse(msg.message);
      if (conhecidos.has(msg.id) || !FORMATOS.includes(dados.formato) || !/^https?:\/\//.test(dados.link || '')) continue;
      pedidos.push({
        id: msg.id,
        quando: new Date(msg.time * 1000).toISOString(),
        formato: dados.formato,
        titulo: String(dados.titulo || '').slice(0, 300),
        link: dados.link,
        fonte: String(dados.fonte || '').slice(0, 80),
      });
      novos += 1;
    } catch { /* mensagem que não é um pedido */ }
  }
  if (novos) fs.writeFileSync(ARQ_PEDIDOS, JSON.stringify(pedidos, null, 1) + '\n');
  console.log(`Pedidos novos: ${novos}`);
}

async function avisar({ titulo, mensagem, link, urgente, fonte }) {
  if (!TOPICO) throw new Error('falta o NTFY_TOPICO');
  const corpo = { topic: TOPICO, title: titulo.slice(0, 200), message: mensagem.slice(0, 1000), tags: ['rotating_light'] };
  if (link) corpo.click = link;
  if (link && fonte) corpo.actions = botoes({ fonte, mensagem, link });
  if (urgente) corpo.priority = 5;
  const resposta = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(20000),
  });
  if (!resposta.ok) throw new Error(`ntfy respondeu ${resposta.status}`);
}

async function principal() {
  if (args.has('--teste')) {
    await avisar({
      titulo: 'Alarme de GTA 6: teste dos botões',
      mensagem: 'TESTE: toque em um ou mais formatos para escolher.',
      link: 'https://www.rockstargames.com/VI',
      fonte: 'Teste',
    });
    console.log('Aviso de teste enviado.');
    return;
  }

  if (args.has('--pedidos')) { await guardarPedidos(); return; }

  if (TOPICO && !args.has('--simular') && !args.has('--marcar')) {
    try { await guardarPedidos(); } catch (erro) { console.log(`Pedidos não lidos: ${erro.message}`); }
  }

  const resultados = await Promise.all(FONTES.feeds.map(async (fonte) => {
    try { return { fonte, itens: await baixar(fonte) }; }
    catch (erro) { console.log(`FALHOU ${fonte.nome}: ${erro.message}`); return { fonte, itens: [] }; }
  }));

  const certos = resultados.filter((r) => r.itens.length).length;
  console.log(`Fontes lidas: ${certos} de ${FONTES.feeds.length}`);
  if (!certos) throw new Error('nenhuma fonte respondeu');

  const vistos = lerVistos();
  const jaVi = new Set(vistos);
  const agora = Date.now();
  const novos = [];

  for (const { fonte, itens } of resultados) {
    for (const item of itens) {
      if (!fonte.todos && !FILTRO.test(item.titulo)) continue;
      const chave = `${fonte.nome}|${item.id}`;
      if (jaVi.has(chave)) continue;
      jaVi.add(chave);
      novos.push({ ...item, chave, fonte });
    }
  }

  if (args.has('--marcar')) {
    guardarVistos(vistos.concat(novos.map((n) => n.chave)));
    console.log(`Marquei ${novos.length} como já vistos, sem avisar.`);
    return;
  }

  // Muito velho nunca vira aviso; só entra na lista de vistos.
  const recentes = (n) => !n.data || agora - n.data <= MAX_IDADE_HORAS * 3600e3;
  const velhos = novos.filter((n) => !recentes(n));
  const fila = novos.filter(recentes).sort((a, b) => (a.data || 0) - (b.data || 0));

  if (args.has('--simular')) {
    console.log(`Avisaria ${fila.length}:`);
    for (const n of fila) console.log(`- [${n.fonte.nome}] ${n.titulo}`);
    return;
  }

  const entregues = velhos.map((n) => n.chave);
  let falhou = false;
  for (const n of fila.slice(0, MAX_POR_RODADA)) {
    try {
      await avisar({
        titulo: `${n.fonte.oficial ? 'OFICIAL · ' : ''}${n.fonte.nome}`,
        mensagem: n.titulo,
        link: n.link,
        urgente: n.fonte.oficial,
        fonte: n.fonte.nome,
      });
      entregues.push(n.chave);
      console.log(`Avisei: [${n.fonte.nome}] ${n.titulo}`);
    } catch (erro) {
      // Não marca como visto: tenta de novo na próxima rodada.
      console.log(`NÃO ENVIOU: ${erro.message}`);
      falhou = true;
      break;
    }
  }

  guardarVistos(vistos.concat(entregues));
  console.log(`Na fila: ${fila.length}. Avisados agora: ${entregues.length - velhos.length}.`);
  if (falhou) process.exitCode = 1;
}

principal().catch((erro) => { console.error(`ERRO: ${erro.message}`); process.exit(1); });
