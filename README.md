# Chat Pruner

Extensao para reduzir travamentos durante stream de respostas no ChatGPT, com poda de historico e controle de lote/cooldown no pipeline SSE.

## Diagnostico da travadeira (causa raiz)

O problema principal era bloqueio da main thread por commits grandes do React durante o stream.

Em resumo:

- O stream SSE chegava em bursts de `event: delta`.
- O pipeline acumulava eventos demais e empurrava lotes grandes para a UI.
- Parte dos deltas era opaca (ex.: `delta:op:root`), causando dedupe inconsistente.
- Markdown/codigo parcial no meio do stream aumentava custo de parse/highlight.
- Quando ocorria freeze, o proximo flush podia disparar quase em seguida e repetir o ciclo.

## Por que podar mensagens nao basta

Mesmo removendo mensagens antigas do DOM, a travadeira pode continuar em chats grandes.

Motivos:

- Poda visual reduz peso de tela, mas nao elimina custo do estado interno que continua sendo atualizado por `delta`.
- O problema principal vira frequencia de atualizacao na main thread, nao apenas quantidade de mensagens visiveis.
- `Markdown` e blocos de codigo durante stream seguem caros para parse/highlight/layout.
- Se o stream chega mais rapido do que a UI consegue reconciliar, forma backlog e gera bursts com long tasks.

## Evidencias observadas nos logs

- Lotes muito grandes (ex.: `events=172` e `events=741`).
- Render cost extremo em alguns flushes (ex.: ~13s e ~59s).
- Long tasks acumuladas em dezenas de segundos no pior caso.
- FPS baixo e multiplos `UI FREEZE` durante uma mesma resposta.

## Mitigacoes implementadas

- Limite por lote de eventos (`MAX_EVENTS_PER_EMIT`).
- Limite por tamanho aproximado de payload (`MAX_EMIT_BYTES`).
- Cooldown adaptativo baseado em custo de render.
- Penalidade extra de congestionamento quando render vem caro.
- Modo de seguranca no inicio da stream (`startup safe mode`).
- Merge de appends adjacentes de texto para reduzir churn de render.
- Classificacao/filtragem de `delta` mais robusta.
- Dedupe estrutural de `delta` por patch (`op/path/msgId`) em vez de tratar todo `delta` como order-sensitive.
- Telemetria de diagnostico via:
  - `window.__chatPrunerStreamStats`
  - `window.__chatPrunerRootSnapshot`

## Solucao atomica (abordagem definitiva)

Para resolver de forma estrutural, o pipeline precisa tratar stream como estado e nao como render por evento:

- Coalescer deltas e renderizar em cadencia fixa baixa (ex.: 2-4 commits por segundo).
- Aplicar budget rigido por flush (tempo e bytes).
- Priorizar apenas eventos de conteudo do assistant e eventos terminais.
- Ignorar patches de ruido (`root noise`) sem impacto no texto final.
- Garantir flush final obrigatorio ao terminar a stream.

Trade-off:

- Menos efeito de "digitando em tempo real".
- Muito menos freeze/jank na thread principal.

## Presets de uso

O motor suporta tres modos:

- `stable`: maximo foco em estabilidade, menos "tempo real".
- `balanced`: meio termo (padrao).
- `snappy`: mais fluido/rapido, com maior risco de micro-jank.

No painel visual do Chat Pruner, selecione o modo e clique em `Recarregar` para aplicar.

## Arquivos principais

- `debounce.js`: interceptacao SSE, dedupe, batching, cooldown adaptativo e presets.
- `content.js`: injecao de scripts, painel visual e persistencia de configuracao.
- `profiler.js`: monitoramento de long tasks/frame gaps e relatorios de stream.
- `styles.css`: estilo do painel.
