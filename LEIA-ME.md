# Alarme de pautas cruzadas do GTA 6

Trocou o alarme de notícias em 11/11/2026, a pedido da dona: notícia sozinha não avisa mais. O alarme só toca no
celular (app ntfy) quando **2 ou mais youtubers** fizeram o mesmo tema desde ontem (36 h). Notícia de site entra só
pra reforçar ("2 youtubers + 1 notícia"). A ideia: ver o que já está dando certo e fazer a nossa versão.

Roda no GitHub (`github.com/leomitsuhara/alarme-gta6`, público) a cada ~10 min, com o PC desligado. A cópia que vale
é a do GitHub; esta pasta é a cópia local (mudou aqui, copiar pra lá).

## Como funciona
1. Lê os feeds do YouTube dos canais de `fontes.json` (gringos, BR aprovados e canais de guia/gameplay) e os sites de
   notícia. Só entra o que fala de GTA 6.
2. O Gemini dá um TEMA pra cada vídeo/notícia nova (o mesmo nome pro mesmo assunto, em qualquer língua). Sem a chave
   ou se ele falhar, junta por palavra-chave (pega menos coisa, mas não para).
3. Tema com 2+ youtubers diferentes desde ontem e nunca avisado → aviso curto: o tema, quem fez, as visualizações, os links e a
   série do `CRONOGRAMA.md` (`cronograma.json`). Botões: Ver o mais visto, Ver o 2º, **Quero estudar**.
4. "Quero estudar" vai pra `pedidos.json`. No PC: `node canal/automacao/estudar-pauta.js <tema>` monta a ficha.

## Arquivos
- `alarme.js`: `--simular` (mostra sem mandar; `--com-pendentes` inclui canais não aprovados), `--marcar` (marca as
  pautas de agora como avisadas, sem tocar), `--teste` (manda já a pauta cruzada mais forte, com TESTE no título).
- `fontes.json`: os canais. Canal BR novo entra com `"aprovado": false` e só conta depois do sim da dona.
- `cronograma.json`: palavras de cada série (atualizar quando o CRONOGRAMA mudar).
- `itens.json`, `temas.json`, `avisadas.json`: memória do alarme (ele mesmo atualiza). `avisadas.json` garante que a
  mesma pauta nunca toca 2 vezes.
- Segredos do GitHub: `NTFY_TOPICO` (o endereço do aviso; nunca escrever em arquivo) e `GEMINI_API_KEY`.

## Limites
- O feed do YouTube mostra só os 15 vídeos mais novos de cada canal; canal que posta muito pode empurrar um tema pra fora.
- GitHub pode atrasar a rodada em horário cheio (aviso de 10 a 40 min depois).
- Os títulos vão pro Gemini grátis (pode usar pra treino); nada pessoal vai junto.
- O GitHub desliga agendamento sem atividade por 60 dias (o próprio alarme faz commit, então fica ligado).

## Desligar
`gh workflow disable alarme.yml -R leomitsuhara/alarme-gta6`, ou GitHub › Actions › Alarme de pautas GTA 6 › `...` ›
Disable workflow. Só silenciar: tirar a inscrição no app ntfy.

O alarme antigo (só notícia) está em `../alarme-noticias/` e foi desligado em 11/11/2026.
