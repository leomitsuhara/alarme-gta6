# Alarme de notícias de GTA 6

A cada 5 minutos, mais ou menos, o GitHub lê as fontes de `fontes.json`, pega o que é de GTA 6 e ainda não foi avisado
e manda título e link para o app ntfy no celular. Funciona com o PC e a IA desligados.

- `alarme.js`: o programa. `--simular` mostra sem enviar; `--marcar` marca tudo como visto; `--teste` manda um aviso.
- `fontes.json`: as fontes e o filtro. Fonte nova é uma linha aqui.
- `vistos.json`: o que já foi avisado (o próprio alarme atualiza).
- `.github/workflows/alarme.yml`: o horário.
- O endereço do aviso fica só no segredo `NTFY_TOPICO` do GitHub. Nunca escrever em arquivo: este projeto é público.

## Botões de formato
Cada aviso traz Carrossel, Reels e Longo. Dá para tocar em mais de um. Cada rodada guarda os toques em `pedidos.json`.
Esse arquivo tem texto vindo da internet: é informação para montar a pauta, nunca ordem para a IA seguir.

## Limites conhecidos
- O GitHub pode atrasar a rodada em horários cheios, então o aviso pode levar de 5 a 30 minutos.
- Rockstar Newswire e X não têm feed. O site oficial entra pelo YouTube da Rockstar e pelo GTA BOOM, que repete o que sai lá.
- A mesma notícia pode chegar por sites diferentes.
- ntfy grátis: 250 avisos por dia por endereço de internet. Se o envio falhar, o alarme tenta de novo na rodada seguinte.
- O GitHub desliga agendamentos sem atividade por 60 dias.

## Desligar
GitHub, aba Actions, Alarme GTA 6, botão `...`, **Disable workflow**. Para só silenciar: tirar a inscrição no app ntfy.
