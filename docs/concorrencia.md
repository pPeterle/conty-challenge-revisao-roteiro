# Idempotência e concorrência

## Transação por ação

Cada caso de uso roda inteiro dentro de `BEGIN IMMEDIATE` (`transacao` em `src/db.ts`, `executarAcao` em `src/revisao.ts`). Dentro da transação a ordem é: o roteiro existe, a `Idempotency-Key` já foi usada, o estado permite a ação, a regra do relógio vale (prazo vencido ou distante demais). Só então a ação grava.

O `DatabaseSync` é síncrono e a API roda num processo só, então duas requisições nunca intercalam entre a leitura do estado e a escrita. O banco também se protege sozinho, caso algum dia isso deixe de ser verdade:

- a chave primária `(roteiro_id, numero)` impede versão duplicada;
- o índice único parcial `um_pedido_vigente_por_versao` impede dois pedidos vigentes para a mesma versão (um pedido vencido substituído fica com `expirado_em` preenchido e sai do índice);
- o índice único parcial `uma_aprovacao_por_roteiro` em `eventos` impede uma segunda aprovação;
- triggers recusam `UPDATE` do conteúdo e `DELETE` de versão.

## Idempotency-Key

O header é opcional nos três `POST` sobre um roteiro e vale por roteiro. A primeira resposta de sucesso fica em `chaves_idempotencia` junto com uma impressão da operação e dos campos já validados pelo zod. Como a saída do schema tem campos em ordem fixa e textos aparados, `{"motivo":"x","prazo":"2026-03-12"}` e `{"prazo":"2026-03-12","motivo":"  x  "}` contam como o mesmo pedido.

- Repetição com a mesma impressão devolve a resposta gravada, com os headers `Idempotent-Replayed: true` e `Estado-Atual: <estado de agora>`. O corpo é a foto do momento da primeira resposta; o header mostra se o roteiro já andou desde então.
- A mesma chave com outra operação ou outro corpo recebe 422 `CHAVE_IDEMPOTENCIA_REUTILIZADA`.
- Erros não ficam gravados. Uma chave usada cedo demais (por exemplo, reenvio antes do pedido de alteração) volta a funcionar quando o estado permitir.

## Testes

`test/integration/concorrencia.test.ts` dispara requisições com `Promise.all`:

- 20 reenvios com a mesma chave geram uma versão e 19 repetições com a mesma resposta;
- 20 reenvios sem chave geram um 201 e 19 respostas 409;
- 30 aprovações geram uma 200 e 29 respostas 409, com um único evento `aprovado`;
- aprovação e pedido de alteração disputando a mesma versão: só um vence.

`test/integration/pedido-vencido.test.ts` dispara 10 pedidos novos sobre o mesmo pedido vencido: um substitui, nove recebem 409.

`test/integration/auditoria.test.ts` cobre a impressão independente da ordem dos campos e o header `Estado-Atual`.

## Com várias instâncias

Eu passaria para Postgres mantendo as mesmas restrições únicas, faria `SELECT ... FOR UPDATE` na linha do roteiro dentro da transação e deixaria a tabela de idempotência no mesmo banco, gravada na mesma transação da ação. Lock distribuído só entraria se aparecesse um efeito externo que não cabe na transação (uma notificação, por exemplo), e mesmo nesse caso eu tentaria antes um outbox.
