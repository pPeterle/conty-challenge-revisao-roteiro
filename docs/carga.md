# Teste de carga

`npm run load` (`scripts/load.sh`) sobe a API na porta 3101 com um banco sqlite temporário, roda `load/revisao.js` no k6 via Docker (`grafana/k6:0.54.0`), confere as invariantes no banco com `scripts/verify-load.ts` e derruba o servidor.

## Cenário

São 100 usuários virtuais por 20 s disputando 10 roteiros, 10 por roteiro. Em cada iteração, o usuário lê o estado do roteiro e age:

- em `aguardando_revisao` com menos de 50 versões, pede alteração na versão atual (prazo daqui a 30 dias). Quem perde a corrida recebe 409;
- em `alteracao_solicitada`, reenvia usando a mesma `Idempotency-Key` que todos os outros que viram a mesma versão. Todos precisam receber 201 e só uma versão pode nascer;
- com 50 versões, aprova. Metade aprova com chave (repetições viram replay 200), metade sem chave (perdedores recebem 409);
- depois de aprovado, tenta aprovar e reenviar de novo, e precisa receber 409 `ROTEIRO_APROVADO`;
- em 10% das iterações manda um payload inválido sorteado (JSON quebrado, `null`, array, tipo errado, motivo só com zero-width space, prazo em outro formato ou com mês 13, `versao` negativa ou `1e400`, roteiro inexistente, `versoes/0x1`, número solto). A resposta precisa ser 4xx.

O corpo acima de 1 MB (413) fica só no teste de integração: o servidor responde antes de ler o corpo inteiro e fecha a conexão, e o k6 registra isso como "connection reset by peer" em vez de 413.

Limites: `http_req_failed < 1%` (com 400, 404, 409, 413 e 422 contados como resposta esperada), `p(95) < 500ms` e `checks > 99%`. O teto de latência é folgado para o teste passar em máquinas mais lentas; o que reprova a rodada de verdade são os checks, a taxa de erro e as invariantes no banco.

## Verificação no banco

`scripts/verify-load.ts` falha (exit 1) se algum roteiro tiver versões com buraco ou repetidas, conteúdo de uma versão diferente de `versão <n>` (o que denunciaria gravação de payload inválido ou de reenvio duplicado), versão substituída sem pedido de alteração, mais de uma aprovação, aprovação fora da última versão ou evento depois da aprovação. Também falha se nenhum roteiro chegou a ser aprovado.

## Última execução

Rodada em 2026-10-10 nesta máquina (um Mac, load average perto de 4 no começo da rodada). Trecho real da saída:

```
✓ consulta 200
✓ pedido de alteração 201 ou 409
✓ payload inválido responde 4xx (nunca 5xx)
✓ reenvio com chave repetida responde 201
✓ aprovação 200 ou 409
✓ aprovar de novo: 409 ROTEIRO_APROVADO
✓ nova versão após aprovação: 409 ROTEIRO_APROVADO
aprovacoes_aceitas.............: 10
✓ checks.........................: 100.00% 84813 out of 84813
  data_received..................: 725 MB  36 MB/s
✓ http_req_duration..............: avg=23.51ms min=274.21µs med=22.24ms max=721.48ms p(90)=29.4ms  p(95)=34.82ms
✓ http_req_failed................: 0.00%   0 out of 84823
  http_reqs......................: 84823   4231.262317/s
  invalidos_recusados_4xx........: 3266
  reenvios_201...................: 2654
verificação: 10 roteiros, 500 versões, 10 aprovados
invariantes ok: uma aprovação por roteiro, versões 1..n sem buraco nem duplicata, versões antigas preservadas
```

Boa parte do tráfego (725 MB recebidos) vem de `GET /roteiros/:id` devolver todas as versões com conteúdo. Está anotado no README entre as decisões que eu mudaria.
