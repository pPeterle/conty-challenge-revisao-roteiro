# Teste de carga

`npm run load` (`scripts/load.sh`) sobe a API na porta 3101 com um banco sqlite temporário, roda `load/revisao.js` no k6 via Docker (`grafana/k6:0.54.0`), confere as invariantes no banco com `scripts/verify-load.ts` e derruba o servidor.

## Cenário

São 100 usuários virtuais por 20 s disputando 10 roteiros, 10 por roteiro. Em cada iteração, o usuário lê o estado do roteiro e age:

- em `aguardando_revisao` com menos de 50 versões, pede alteração na versão atual (prazo daqui a 30 dias). Quem perde a corrida recebe 409;
- em `alteracao_solicitada`, reenvia usando a mesma `Idempotency-Key` que todos os outros que viram a mesma versão. Todos precisam receber 201 e só uma versão pode nascer;
- com 50 versões, aprova. Metade aprova com chave (repetições viram replay 200), metade sem chave (perdedores recebem 409);
- depois de aprovado, tenta aprovar e reenviar de novo, e precisa receber 409 `ROTEIRO_APROVADO`;
- toda ação manda o `X-Ator` certo (`criador` para criar e reenviar, `marca` para pedir alteração e aprovar);
- em 10% das iterações manda um payload inválido sorteado: papel errado (403), `X-Ator` ausente ou desconhecido (400), JSON quebrado, `null`, array, tipo errado, motivo só com zero-width space, prazo em outro formato ou com mês 13, `versao` negativa ou `1e400`, roteiro inexistente, `versoes/0x1` ou número solto. A resposta precisa ser 4xx.

O corpo acima de 1 MB (413) fica só no teste de integração: o servidor responde antes de ler o corpo inteiro e fecha a conexão, e o k6 registra isso como "connection reset by peer" em vez de 413.

Limites: `http_req_failed < 1%` (com 400, 403, 404, 409, 413 e 422 contados como resposta esperada), `p(95) < 500ms` e `checks > 99%`. O teto de latência é folgado para o teste passar em máquinas mais lentas; o que reprova a rodada de verdade são os checks, a taxa de erro e as invariantes no banco.

## Verificação no banco

`scripts/verify-load.ts` falha (exit 1) se algum roteiro tiver versões com buraco ou repetidas, conteúdo de uma versão diferente de `versão <n>` (o que denunciaria gravação de payload inválido ou de reenvio duplicado), versão substituída sem pedido de alteração, mais de uma aprovação, aprovação fora da última versão, evento depois da aprovação ou evento gravado com o ator errado. Também falha se nenhum roteiro chegou a ser aprovado.

## Última execução

Rodada em 2026-10-10 no meu Mac, com outros processos rodando (load average entre 16 e 18). Trecho real da saída:

```
✓ consulta 200
✓ payload inválido responde 4xx (nunca 5xx)
✓ pedido de alteração 201 ou 409
✓ reenvio com chave repetida responde 201
✓ aprovação 200 ou 409
✓ aprovar de novo: 409 ROTEIRO_APROVADO
✓ nova versão após aprovação: 409 ROTEIRO_APROVADO
aprovacoes_aceitas.............: 10
✓ checks.........................: 100.00% 59167 out of 59167
  data_received..................: 520 MB  26 MB/s
✓ http_req_duration..............: avg=33.7ms   min=792.97µs med=27.21ms max=1.14s    p(90)=50.47ms  p(95)=67.7ms
✓ http_req_failed................: 0.00%   0 out of 59177
  http_reqs......................: 59177   2950.829557/s
  invalidos_recusados_4xx........: 2322
  reenvios_201...................: 2267
verificação: 10 roteiros, 500 versões, 10 aprovados
invariantes ok: uma aprovação por roteiro, versões 1..n sem buraco nem duplicata, versões antigas preservadas, ator certo em cada evento
```

Boa parte do tráfego (520 MB recebidos) vem de `GET /roteiros/:id` devolver todas as versões com conteúdo. Está anotado no README entre as decisões que eu mudaria.
