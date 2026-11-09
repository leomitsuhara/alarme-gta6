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

async function avisar({ titulo, mensagem, link, urgente }) {
  if (!TOPICO) throw new Error('falta o NTFY_TOPICO');
  const corpo = { topic: TOPICO, title: titulo.slice(0, 200), message: mensagem.slice(0, 1000), tags: ['rotating_light'] };
  if (link) corpo.click = link;
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
      titulo: 'Alarme de GTA 6 ligado',
      mensagem: 'Teste: quando sair notícia de GTA 6, ela chega aqui. Toque para abrir o link.',
      link: 'https://www.rockstargames.com/VI',
    });
    console.log('Aviso de teste enviado.');
    return;
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
