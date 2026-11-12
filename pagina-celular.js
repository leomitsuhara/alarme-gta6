#!/usr/bin/env node
// Página enxuta pro celular (Bombando agora + Faz agora), gerada a cada rodada do alarme no GitHub.
// Lê itens.json, temas.json e cronograma.json desta pasta e escreve docs/index.html (GitHub Pages publica a pasta docs).
//   node pagina-celular.js            gera docs/index.html
// Só dado público (títulos e links de vídeos do YouTube). Nada de chave, token ou dado pessoal.
const fs = require('fs');
const path = require('path');

const PASTA = __dirname;
const lerJson = (n, p) => { try { return JSON.parse(fs.readFileSync(path.join(PASTA, n), 'utf8')); } catch (e) { return p; } };
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mil = (n) => (n == null ? '?' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' mi' : n >= 1e3 ? Math.round(n / 1e3) + ' mil' : String(n));
const TZ = 'America/Sao_Paulo';
const hora = (ms) => new Date(ms).toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const idYt = (l) => (/(?:v=|shorts\/|youtu\.be\/)([\w-]{11})/.exec(l || '') || [])[1];

const itens = lerJson('itens.json', []);
const temas = lerJson('temas.json', []);
const crono = lerJson('cronograma.json', { regras: [] });
const agora = Date.now();
const grupos = new Map();
for (const i of itens) {
  if (!i.tema || i.tema === 'fora' || i.grupo === 'noticia') continue;
  if (agora - (i.data || i.visto || 0) > 36 * 3600e3) continue;
  if (!grupos.has(i.tema)) grupos.set(i.tema, []);
  grupos.get(i.tema).push(i);
}
const pautas = [];
for (const [tema, its] of grupos) {
  const melhor = new Map();
  for (const i of its) { const a = melhor.get(i.fonte); if (!a || (i.views || 0) > (a.views || 0)) melhor.set(i.fonte, i); }
  const cri = [...melhor.values()].sort((a, b) => (b.views || 0) - (a.views || 0));
  const nome = (temas.find((t) => t.id === tema) || {}).nome || tema;
  const primeiro = Math.min(...its.map((i) => i.data || i.visto));
  const horas = Math.round((agora - primeiro) / 36e5);
  const regra = crono.regras.find((r) => new RegExp(r.palavras, 'i').test(semAcento(nome + ' ' + its.map((i) => i.titulo).join(' '))));
  pautas.push({ nome, cri, horas, serie: regra && regra.serie, views: cri.reduce((s, c) => s + (c.views || 0), 0) });
}
pautas.sort((a, b) => b.cri.length - a.cri.length || b.views - a.views);
const quentes = pautas.filter((p) => p.cri.length >= 2);
const faz = quentes.find((p) => p.horas <= 24 && p.serie) || quentes.find((p) => p.horas <= 24);
const onda = (h) => (h < 6 ? '🟢 pega a onda' : h <= 24 ? '🟡 ainda dá' : '⚪ esfriando');

const cartao = (p) => `<div class="c q"><b>${esc(p.nome)}</b><div class="p">${p.cri.length} youtubers · ${mil(p.views)} views · 1º há ${p.horas} h · ${onda(p.horas)}${p.serie ? ' · ' + esc(p.serie) : ''}</div>${p.cri.slice(0, 4).map((c) => `<a href="${esc(c.link)}">${idYt(c.link) ? `<img loading="lazy" src="https://i.ytimg.com/vi/${idYt(c.link)}/mqdefault.jpg" alt="">` : ''}<span><b>${esc(c.fonte)}</b> · ${mil(c.views)}<br>${esc(c.titulo)}</span></a>`).join('')}</div>`;
const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="600"><title>GTA 6 agora</title>
<style>body{margin:0;background:#14101c;color:#f3eefc;font:15px/1.4 system-ui,sans-serif}h1{font-size:18px;margin:0;padding:12px 16px;background:#2a1240}h2{font-size:16px;margin:16px 16px 6px}.p{color:#a99fbf;font-size:13px;margin:4px 0 8px}.c{background:#1f1830;border:1px solid #33284a;border-radius:12px;margin:0 12px 10px;padding:12px}.q{border-color:#ff6b2c}.f{border:2px solid #3ddc84}a{display:flex;gap:8px;color:#f3eefc;text-decoration:none;margin:6px 0;font-size:13px}img{width:110px;aspect-ratio:16/9;object-fit:cover;border-radius:6px;flex:none}.m{color:#a99fbf;font-size:12px;padding:8px 16px}</style></head><body>
<h1>🐊 GTA 6 agora · Vicent</h1><div class="m">Atualizado ${esc(new Date().toLocaleString('pt-BR', { timeZone: TZ }))} (Brasília) · atualiza sozinho a cada ~10 min</div>
<h2>👉 Faz agora</h2>${faz ? `<div class="c f"><b>${esc(faz.nome)}</b><div class="p">${faz.cri.length} youtubers fizeram (${esc(faz.cri.slice(0, 3).map((c) => c.fonte).join(', '))}), 1º há ${faz.horas} h${faz.serie ? ', série ' + esc(faz.serie) : ''}. Pra começar: mande pra IA "estuda a pauta ${esc(faz.nome)}".</div></div>` : '<div class="c f">Nenhuma pauta quente fresca agora: siga o cronograma de hoje.</div>'}
<h2>🔥 Quentes (2+ youtubers desde ontem)</h2>${quentes.length ? quentes.slice(0, 8).map(cartao).join('') : '<div class="c">Nenhuma agora.</div>'}
<h2>🌡️ Esquentando</h2><div class="c">${pautas.filter((p) => p.cri.length < 2).slice(0, 10).map((p) => `<div class="p">• <b>${esc(p.nome)}</b> · ${esc(p.cri[0].fonte)} · há ${p.horas} h</div>`).join('') || 'Nada.'}</div>
<div class="m">Instagram, métricas e botões ficam no painel do PC.</div></body></html>`;
fs.mkdirSync(path.join(PASTA, 'docs'), { recursive: true });
fs.writeFileSync(path.join(PASTA, 'docs', 'index.html'), html);
console.log(`docs/index.html: ${quentes.length} quentes, faz agora: ${faz ? faz.nome : 'cronograma'}`);
