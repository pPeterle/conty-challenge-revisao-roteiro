# Revisão de roteiro

API para o fluxo de revisão de roteiro entre criador e marca. O criador envia o roteiro, a marca pede alteração com motivo e prazo, o criador manda outra versão e a marca aprova. Cada versão fica guardada com o próprio estado, e o histórico de eventos pode ser consultado a qualquer momento.

Stack: Node 22.13+, TypeScript, Hono, zod, `node:sqlite`, Vitest e k6 (via Docker).

## Por onde começar a leitura

1. `src/prazo.ts`: o prazo como dia no fuso da marca (funções puras).
2. `src/dominio.ts`: estados, quem pode fazer o quê e as regras que dependem do relógio (funções puras).
3. `src/revisao.ts`: os casos de uso, cada um numa transação.

O resto é borda: `src/schemas.ts` valida a entrada, `src/app.ts` liga as rotas e `src/db.ts` concentra o SQL. Idempotência, triggers de imutabilidade e o teste de carga são extras de robustez; o fluxo pedido pelo enunciado está nos três arquivos acima.

## Enunciado, código e testes

| Item do enunciado | Onde no código | Teste que cobre |
|---|---|---|
| Repositório com API, README de como rodar e testes dos estados principais | `src/`, este README | `test/integration/fluxo.test.ts`: "envio, pedido de alteração, reenvio e aprovação, com o estado e as ações explícitos em cada passo" |
| Exemplos de request e response | seção "Exemplo real" abaixo | gerados com curl contra a API rodando |
| Prazo no último instante do dia e no primeiro instante do dia seguinte, com relógio controlado | `fimDoDia` em `src/prazo.ts`, `verificarPrazo` em `src/dominio.ts`, `ControlledClock` em `src/clock.ts` | `test/integration/pedido-alteracao.test.ts`: "prazo 2026-03-12 ainda vale no último instante..." e "...não vale no primeiro instante do dia seguinte..." |
| Nota das decisões que eu deixaria diferentes | seção no fim deste README | |
| O que foi feito com IA e o que eu revisei | seção "Uso de IA" | |
| Dá para seguir o fluxo inteiro sem adivinhar o estado | `montarRoteiro` em `src/revisao.ts` (`estado`, `pedido_vencido`, `acoes_permitidas`, `acoes_por_ator`) | `fluxo.test.ts` (fluxo completo), `test/integration/papeis.test.ts`: "acoes_por_ator separa o que cada lado pode fazer em cada estado" |
| Pedido de alteração sem motivo ou sem prazo não passa | `pedidoAlteracaoSchema` em `src/schemas.ts` | `pedido-alteracao.test.ts`: bloco "pedido de alteração exige motivo e prazo" |
| O prazo no fuso da marca não vira o dia errado quando o UTC já virou | `fimDoDia` em `src/prazo.ts` | `pedido-alteracao.test.ts`: "quando o UTC já virou para o dia 13 mas em SP ainda é dia 12, prazo 2026-03-12 vale"; `test/unit/prazo.test.ts` (horário de verão de 2018 e 2019) |
| Roteiro aprovado não aceita nova versão nem novo pedido | `exigirAcao` em `src/dominio.ts`; índice `uma_aprovacao_por_roteiro` em `src/db.ts` | `fluxo.test.ts`: bloco "roteiro aprovado" |
| Versão antiga não se perde quando chega uma nova | `inserirVersao` e triggers `versao_imutavel` em `src/db.ts` | `fluxo.test.ts`: "versão antiga não se perde quando chega uma nova..." e "o banco recusa alterar ou apagar o conteúdo de uma versão" |
| Pedido de alteração com prazo que já passou não vale | `verificarPrazo` e `acoesPermitidas` em `src/dominio.ts` | `pedido-alteracao.test.ts` (422 ao criar); `test/integration/pedido-vencido.test.ts` (pedido aberto que vence) |
| README curto e honesto sobre o que ficou de fora | seção "O que ficou de fora" | |
| Nada de arquivo dirigido a ferramenta | não há AGENTS.md, regras de editor nem similares | |

## Como rodar

```bash
npm install
npm run dev          # API em http://localhost:3000, banco em data/roteiros.db
npm test             # unitários + integração (sqlite em memória, relógio controlado)
npm run typecheck
npm run load         # precisa de Docker; sobe a API na porta 3101 com banco temporário
```

`PORT` e `DB_PATH` mudam a porta e o arquivo do banco. Os logs saem em JSON pelo pino, com transporte em worker thread (`pino/file` no stdout), e `LOG_LEVEL` muda o nível (padrão `info`; nos testes o logger é silencioso).

## Estados

`GET /roteiros/:id` traz `estado`, `pedido_vencido`, `versao_atual`, `acoes_permitidas`, `acoes_por_ator` e `pedido_alteracao_aberto`. `pedido_vencido` é derivado do relógio e fica `true` quando o roteiro espera nova versão e o prazo do pedido já passou. Com esses campos o cliente sabe qual é o próximo passo.

```mermaid
stateDiagram-v2
  [*] --> aguardando_revisao: POST /roteiros (versão 1)
  aguardando_revisao --> alteracao_solicitada: POST /pedidos-alteracao (motivo + prazo)
  alteracao_solicitada --> aguardando_revisao: POST /versoes (versão n+1)
  alteracao_solicitada --> alteracao_solicitada: novo pedido (só com o anterior vencido)
  aguardando_revisao --> aprovado: POST /aprovacao
  alteracao_solicitada --> aprovado: POST /aprovacao (só com o pedido vencido)
  aprovado --> [*]
```

| Estado do roteiro | Marca pode | Criador pode | Outras ações |
|---|---|---|---|
| `aguardando_revisao` | `solicitar_alteracao`, `aprovar` | | nova versão: 409 `AGUARDANDO_REVISAO` |
| `alteracao_solicitada`, `pedido_vencido: false` | | `enviar_nova_versao` | aprovar ou pedir de novo: 409 `AGUARDANDO_NOVA_VERSAO` |
| `alteracao_solicitada`, `pedido_vencido: true` | `solicitar_alteracao`, `aprovar` | `enviar_nova_versao` | |
| `aprovado` | | | tudo: 409 `ROTEIRO_APROVADO` |

Cada versão também tem estado (`aguardando_revisao`, `alteracao_solicitada` ou `aprovada`). Texto e número de uma versão nunca mudam: um trigger no sqlite recusa `UPDATE` do conteúdo e `DELETE` de versão, e a versão antiga continua em `GET /roteiros/:id/versoes/1`.

## Endpoints

| Método | Caminho | `X-Ator` | Corpo |
|---|---|---|---|
| POST | `/roteiros` | `criador` | `{ "titulo", "conteudo" }` |
| GET | `/roteiros/:id` | | |
| GET | `/roteiros/:id/versoes/:numero` | | |
| GET | `/roteiros/:id/historico` | | |
| POST | `/roteiros/:id/pedidos-alteracao` | `marca` | `{ "motivo", "prazo": "AAAA-MM-DD", "versao"? }` |
| POST | `/roteiros/:id/versoes` | `criador` | `{ "conteudo" }` |
| POST | `/roteiros/:id/aprovacao` | `marca` | `{ "versao"? }` (corpo pode ser omitido) |

Toda ação exige o header `X-Ator` (`marca` ou `criador`), e cada evento do histórico grava quem agiu. Leituras não exigem o header. Os três `POST` sobre um roteiro aceitam `Idempotency-Key`. O campo opcional `versao` diz qual versão a marca está revisando; se não for a atual, a resposta é 409 `VERSAO_DESATUALIZADA`.

Erros vêm como `{ "error": { "code", "message", "details"? } }`. A ordem das checagens é: forma da entrada (400), papel (403), roteiro existe (404), estado permite a ação (409), regra que depende do relógio (422). Assim, um pedido com prazo vencido num roteiro aprovado recebe 409 `ROTEIRO_APROVADO`.

| Status | Código | Quando |
|---|---|---|
| 400 | `MOTIVO_OBRIGATORIO`, `PRAZO_OBRIGATORIO`, `PRAZO_INVALIDO`, `CAMPO_OBRIGATORIO`, `CAMPO_MUITO_LONGO`, `CARACTERE_INVALIDO`, `VERSAO_INVALIDA` | corpo com campo ausente, vazio, de tipo errado ou fora do formato |
| 400 | `JSON_INVALIDO`, `CONTENT_TYPE_INVALIDO` | corpo que não é um objeto JSON, ou enviado sem `Content-Type` JSON |
| 400 | `ATOR_INVALIDO`, `CHAVE_IDEMPOTENCIA_INVALIDA`, `PARAMETRO_INVALIDO` | header `X-Ator` ausente ou inválido, `Idempotency-Key` longa demais, número de versão mal formado na URL |
| 403 | `ATOR_NAO_PERMITIDO` | marca tentando enviar versão, ou criador tentando pedir alteração ou aprovar |
| 404 | `ROTEIRO_NAO_ENCONTRADO`, `VERSAO_NAO_ENCONTRADA`, `ROTA_NAO_ENCONTRADA` | id, versão ou rota que não existe |
| 409 | `ROTEIRO_APROVADO` | qualquer ação depois da aprovação |
| 409 | `AGUARDANDO_REVISAO`, `AGUARDANDO_NOVA_VERSAO` | ação que o estado atual não permite (ver tabela de estados) |
| 409 | `VERSAO_DESATUALIZADA` | `versao` informada não é a atual |
| 413 | `CORPO_MUITO_GRANDE` | corpo acima de 1 MB |
| 422 | `PRAZO_VENCIDO` | pedido com prazo que já terminou no fuso da marca |
| 422 | `CHAVE_IDEMPOTENCIA_REUTILIZADA` | mesma `Idempotency-Key` com outra operação ou outro corpo |

Validação e limites: todo corpo, parâmetro de rota, `X-Ator` e `Idempotency-Key` passa por um schema zod (`src/schemas.ts`). Campos desconhecidos são ignorados e textos são aparados. Recebem 400 os casos de JSON malformado, corpo que não é objeto, `Content-Type` diferente de JSON com corpo, texto vazio ou só com caracteres invisíveis, texto com caracteres de controle como NUL (`CARACTERE_INVALIDO`; tab e quebras de linha passam), `titulo` com mais de 200 caracteres, `conteudo` com mais de 50 mil, `motivo` com mais de 2 mil, `versao` que não é inteiro positivo, número de versão na URL fora de `^[1-9]\d*$` e prazo com ano abaixo de 100 ou acima de 9999 (só o formato limita a data; não há teto de negócio). Corpo acima de 1 MB recebe 413, e rota, método ou id inexistente recebe 404 em JSON. Erro inesperado vira 500 genérico, sem stack trace, e o erro completo vai para o log. Os casos estão em `test/integration/payloads-invalidos.test.ts`.

## Regra do prazo

O prazo é uma data civil `AAAA-MM-DD` no fuso da marca (`America/Sao_Paulo`) e vale até 23:59:59.999 desse dia em São Paulo. `fimDoDia` (`src/prazo.ts`) calcula esse instante com `Intl`, sem `-03:00` fixo; os testes unitários incluem dias de 2018 e 2019 com horário de verão.

Com prazo `2026-03-12` e relógio controlado, o pedido passa em `2026-03-13T02:59:59.999Z` e recebe 422 `PRAZO_VENCIDO` em `2026-03-13T03:00:00.000Z`. Em `2026-03-13T01:30:00Z` o UTC já está no dia 13, mas em São Paulo ainda é dia 12: o prazo do dia 12 vale e o do dia 11 não (`test/integration/pedido-alteracao.test.ts`).

Pedido com prazo que já passou não vale, e isso vale também para o pedido que venceu depois de aberto. Até o último instante do prazo, só o criador age (a marca recebe 409). A partir do primeiro instante do dia seguinte, a marca volta a ter saída: pode fazer um pedido novo na mesma versão, que substitui o vencido, ou aprovar a versão atual. Nos dois casos o pedido vencido fica guardado com `situacao: "expirado"` em `pedidos_expirados` da versão, e o histórico ganha um evento `pedido_expirado`. Os testes com relógio controlado estão em `test/integration/pedido-vencido.test.ts`.

O criador continua podendo reenviar depois do prazo. A versão nova sai com `enviada_apos_prazo: true` e o evento `reenviado` registra `apos_prazo: true`; a marca vê o atraso e decide.

## Exemplo real

Chamadas feitas com curl contra a API rodando localmente, em 2026-10-10. Rodei na porta 3101 e troquei para 3000 aqui. Mostro só os campos que interessam a cada passo (filtrei com `jq`); a resposta completa traz também `versoes`, `criado_em` e `atualizado_em`.

```bash
curl -s -X POST localhost:3000/roteiros -H 'content-type: application/json' -H 'X-Ator: criador' \
  -d '{"titulo":"Campanha protetor solar","conteudo":"Abro mostrando o produto na praia e falo do FPS 50."}'
# 201 {"id":"8a73b226-2723-41ba-9235-993657824c81","estado":"aguardando_revisao","pedido_vencido":false,"versao_atual":1,"acoes_por_ator":{"marca":["solicitar_alteracao","aprovar"],"criador":[]}}

curl -s -X POST localhost:3000/roteiros/$ID/aprovacao -H 'content-type: application/json' -H 'X-Ator: criador' -d '{}'
# 403 {"error":{"code":"ATOR_NAO_PERMITIDO","message":"Só a marca pode aprovar."}}

curl -s -X POST localhost:3000/roteiros/$ID/aprovacao -H 'content-type: application/json' -d '{}'
# 400 {"error":{"code":"ATOR_INVALIDO","message":"Informe o header X-Ator com \"marca\" ou \"criador\".","details":[{"campo":"x-ator","motivo":"Informe o header X-Ator com \"marca\" ou \"criador\"."}]}}

curl -s -X POST localhost:3000/roteiros/$ID/pedidos-alteracao -H 'content-type: application/json' -H 'X-Ator: marca' \
  -d '{"motivo":" ","prazo":"17/10/2026"}'
# 400 {"error":{"code":"MOTIVO_OBRIGATORIO","message":"Informe o campo \"motivo\".","details":[{"campo":"motivo","motivo":"Informe o campo \"motivo\"."},{"campo":"prazo","motivo":"O prazo precisa ser uma data válida no formato AAAA-MM-DD."}]}}

curl -s -X POST localhost:3000/roteiros/$ID/pedidos-alteracao -H 'content-type: application/json' -H 'X-Ator: marca' \
  -d '{"motivo":"Trocar o gancho","prazo":"2026-10-01"}'
# 422 {"error":{"code":"PRAZO_VENCIDO","message":"O prazo 2026-10-01 já passou no fuso da marca (America/Sao_Paulo)."}}

curl -s -X POST localhost:3000/roteiros/$ID/pedidos-alteracao -H 'content-type: application/json' -H 'X-Ator: marca' \
  -d '{"motivo":"Trocar o gancho dos 3 primeiros segundos.","prazo":"2026-10-17","versao":1}'
# 201 {"estado":"alteracao_solicitada","pedido_vencido":false,"acoes_por_ator":{"marca":[],"criador":["enviar_nova_versao"]},"pedido_alteracao_aberto":{"id":"de8987c1-0f82-46e6-8047-22f7c59adbc2","versao":1,"situacao":"aberto","motivo":"Trocar o gancho dos 3 primeiros segundos.","prazo":"2026-10-17","fuso":"America/Sao_Paulo","prazo_fim":"2026-10-17T23:59:59.999-03:00","prazo_fim_utc":"2026-10-18T02:59:59.999Z","vencido":false,"criado_em":"2026-10-10T13:02:59.954Z","expirado_em":null}}

curl -s -X POST localhost:3000/roteiros/$ID/versoes -H 'content-type: application/json' -H 'X-Ator: criador' \
  -H 'Idempotency-Key: reenvio-v1' -d '{"conteudo":"Abro com a pergunta: você reaplica o protetor?"}'
# 201 (versão 2 criada). A mesma chamada de novo devolve 201 com os headers
# idempotent-replayed: true e estado-atual: aguardando_revisao, sem criar versão 3.

curl -s -X POST localhost:3000/roteiros/$ID/aprovacao -H 'content-type: application/json' -H 'X-Ator: marca' -d '{"versao":2}'
# 200 {"estado":"aprovado","versao_atual":2,"acoes_por_ator":{"marca":[],"criador":[]},"aprovacao":{"versao":2,"aprovado_em":"2026-10-10T13:02:59.991Z"}}

curl -s -X POST localhost:3000/roteiros/$ID/versoes -H 'content-type: application/json' -H 'X-Ator: criador' -d '{"conteudo":"mais uma"}'
# 409 {"error":{"code":"ROTEIRO_APROVADO","message":"O roteiro já foi aprovado; a revisão está encerrada."}}

curl -s localhost:3000/roteiros/$ID/versoes/1
# 200 {"numero":1,"estado":"alteracao_solicitada","conteudo":"Abro mostrando o produto na praia e falo do FPS 50.","pedido_alteracao":{"situacao":"atendido", ...}, ...}

curl -s localhost:3000/roteiros/$ID/historico
# 200 eventos (tipo, versão, ator): enviado 1 criador, alteracao_solicitada 1 marca, reenviado 2 criador, aprovado 2 marca
# (com um pedido vencido substituído ou aprovado por cima, aparece também pedido_expirado, ator marca)
```

## Por que essa solução

Revisão de roteiro tem poucas ações por roteiro, espalhadas ao longo de dias. Um processo Node com sqlite serializando as escritas dá conta disso com folga, e as garantias ficam em restrições do banco que eu consigo testar: chave primária no número da versão, um pedido vigente por versão e um índice único parcial que permite uma aprovação por roteiro. Cada ação roda inteira numa transação `BEGIN IMMEDIATE`. Não usei Redis nem lock distribuído porque nenhuma ação tem efeito fora do banco. Detalhes de idempotência, concorrência e do caminho para várias instâncias estão em [docs/concorrencia.md](docs/concorrencia.md).

Teste de carga: 100 usuários virtuais por 20 s disputando 10 roteiros, com 10% de payloads inválidos (incluindo papel errado e `X-Ator` ausente). Na última execução, nesta máquina: p95 de 34,9 ms, 4231 req/s, 0% de falha, 100% dos checks e invariantes conferidas no banco, inclusive o ator de cada evento. A máquina tinha outros processos rodando (load average perto de 5). O limite do k6 para o p95 é 500 ms, folgado de propósito para máquinas mais lentas; checks, taxa de erro e invariantes continuam rígidos. Cenário e saída em [docs/carga.md](docs/carga.md).

## O que ficou de fora

- Autenticação. O papel vem do header `X-Ator`, declarado pelo cliente: a API confere se aquele papel pode fazer a ação, mas não verifica identidade nem a qual marca ou criador o roteiro pertence.
- Notificações para criador e marca.
- Listagem e busca de roteiros. Só existe consulta por id.
- `Idempotency-Key` em `POST /roteiros`, porque a chave é guardada por roteiro e na criação ainda não há roteiro.
- Fuso por marca: hoje é fixo em `America/Sao_Paulo`.
- Upload, vídeo e interface, como o enunciado permite.

## Decisões que eu deixaria diferentes com mais tempo

- O fuso viria do cadastro da marca, guardado junto do pedido, em vez de uma constante.
- O reenvio após o prazo é aceito e marcado. Talvez a marca devesse escolher por campanha entre aceitar, recusar ou prorrogar, e prorrogação viraria um evento próprio.
- `GET /roteiros/:id` traz todas as versões com conteúdo. Com 50 versões por roteiro, a carga recebeu centenas de MB em 20 s. Eu paginaria as versões e deixaria o conteúdo só no endpoint da versão.
- O histórico guarda `dados` como JSON livre. Eu tiparia por tipo de evento.
- O `X-Ator` seria substituído por identidade autenticada (token da marca ou do criador), com o roteiro ligado a uma campanha, uma marca e um criador.
- As chaves de idempotência nunca expiram. Colocaria validade e limpeza periódica.
- A repetição por idempotência devolve a foto da primeira resposta, com o estado atual só no header `Estado-Atual`. Com mais tempo eu discutiria com quem consome a API se o corpo deveria trazer o estado atual.

## Uso de IA

O código, os testes e este README foram produzidos com Claude Code (Claude Opus) a partir do enunciado do desafio. A IA também rodou os testes, o teste de carga e as chamadas com curl usadas nos exemplos.

O que eu revisei: as regras de negócio e os testes. Rodei a suíte e o teste de carga localmente e conferi os exemplos do README contra a API rodando.
