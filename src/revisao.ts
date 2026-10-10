// Casos de uso: lê o estado, aplica a regra pura do domínio e grava, tudo na mesma transação.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import * as repo from "./db.ts";
import {
  acoesPermitidas,
  exigirAcao,
  exigirVersaoAtual,
  verificarPrazo,
  type Acao,
  type EstadoRoteiro,
} from "./dominio.ts";
import { ErroApi } from "./erros.ts";
import { FUSO_MARCA, formatarNoFuso, prazoVencido } from "./prazo.ts";
import type { Aprovacao, CriarRoteiro, NovaVersao, PedidoAlteracao } from "./schemas.ts";

export interface Deps {
  db: DatabaseSync;
  clock: Clock;
}

export interface Resultado {
  status: 200 | 201;
  corpo: unknown;
  repetida?: boolean;
  /** Em repetições, o estado de agora (o corpo é a foto da primeira resposta). */
  estadoAtual?: EstadoRoteiro;
}


function exigirRoteiro(db: DatabaseSync, id: string): repo.LinhaRoteiro {
  const roteiro = repo.buscarRoteiro(db, id);
  if (!roteiro) throw new ErroApi(404, "ROTEIRO_NAO_ENCONTRADO", `Roteiro ${id} não encontrado.`);
  return roteiro;
}

function pedidoParaJson(p: repo.LinhaPedido, agora: Date) {
  const fim = new Date(p.prazo_fim);
  return {
    id: p.id,
    versao: p.versao,
    motivo: p.motivo,
    prazo: p.prazo,
    fuso: FUSO_MARCA,
    prazo_fim: formatarNoFuso(fim, FUSO_MARCA),
    prazo_fim_utc: p.prazo_fim,
    vencido: prazoVencido(fim, agora),
    criado_em: p.criado_em,
  };
}

export function montarRoteiro(db: DatabaseSync, r: repo.LinhaRoteiro, agora: Date) {
  const pedidos = new Map(repo.listarPedidos(db, r.id).map((p) => [p.versao, p]));
  const aberto = r.estado === "alteracao_solicitada" ? pedidos.get(r.versao_atual) : undefined;
  return {
    id: r.id,
    titulo: r.titulo,
    estado: r.estado,
    versao_atual: r.versao_atual,
    acoes_permitidas: acoesPermitidas(r.estado),
    pedido_alteracao_aberto: aberto ? pedidoParaJson(aberto, agora) : null,
    aprovacao: r.aprovado_em ? { versao: r.versao_aprovada, aprovado_em: r.aprovado_em } : null,
    versoes: repo.listarVersoes(db, r.id).map((v) => {
      const pedido = pedidos.get(v.numero);
      return {
        numero: v.numero,
        estado: v.estado,
        conteudo: v.conteudo,
        enviada_em: v.enviada_em,
        enviada_apos_prazo: v.enviada_apos_prazo === 1,
        pedido_alteracao: pedido ? pedidoParaJson(pedido, agora) : null,
      };
    }),
    criado_em: r.criado_em,
    atualizado_em: r.atualizado_em,
  };
}

/**
 * Roda uma ação sobre um roteiro numa transação. O corpo chega já validado pelo zod
 * (400). Aqui a ordem é: roteiro existe (404), repetição de Idempotency-Key (devolve a
 * resposta gravada), estado permite a ação (409), regras que dependem do relógio
 * (422/400) e só então grava.
 *
 * A impressão da chave é feita sobre a saída do schema, que tem campos em ordem fixa,
 * então `{"a":1,"b":2}` e `{"b":2,"a":1}` contam como o mesmo pedido. Só sucesso é
 * gravado: depois de um erro, a mesma chave reavalia o estado.
 */
function executarAcao<T>(
  deps: Deps,
  roteiroId: string,
  chave: string | undefined,
  acao: Acao,
  dados: T,
  executar: (roteiro: repo.LinhaRoteiro, dados: T, agora: Date) => Resultado,
): Resultado {
  const impressao = JSON.stringify({ acao, dados });
  return repo.transacao(deps.db, () => {
    const roteiro = exigirRoteiro(deps.db, roteiroId);
    const existente = chave === undefined ? undefined : repo.buscarChave(deps.db, roteiroId, chave);
    if (existente) {
      if (impressao !== existente.impressao) {
        throw new ErroApi(
          422,
          "CHAVE_IDEMPOTENCIA_REUTILIZADA",
          "Essa Idempotency-Key já foi usada com outra operação ou outro corpo.",
        );
      }
      return {
        status: existente.status as 200 | 201,
        corpo: JSON.parse(existente.resposta),
        repetida: true,
        estadoAtual: roteiro.estado,
      };
    }

    exigirAcao(roteiro.estado, acao);
    const agora = deps.clock.now();
    const resultado = executar(roteiro, dados, agora);
    if (chave !== undefined) {
      repo.gravarChave(
        deps.db,
        roteiroId,
        chave,
        { impressao, status: resultado.status, resposta: JSON.stringify(resultado.corpo) },
        agora.toISOString(),
      );
    }
    return resultado;
  });
}

export function criarRoteiro(deps: Deps, { titulo, conteudo }: CriarRoteiro): Resultado {
  return repo.transacao(deps.db, () => {
    const agora = deps.clock.now();
    const quando = agora.toISOString();
    const id = randomUUID();
    repo.inserirRoteiro(deps.db, {
      id,
      titulo,
      estado: "aguardando_revisao",
      versao_atual: 1,
      criado_em: quando,
      atualizado_em: quando,
      aprovado_em: null,
      versao_aprovada: null,
    });
    repo.inserirVersao(deps.db, {
      roteiro_id: id,
      numero: 1,
      conteudo,
      estado: "aguardando_revisao",
      enviada_em: quando,
      enviada_apos_prazo: 0,
    });
    repo.inserirEvento(deps.db, { roteiro_id: id, versao: 1, tipo: "enviado", ocorrido_em: quando });
    return { status: 201, corpo: montarRoteiro(deps.db, exigirRoteiro(deps.db, id), agora) };
  });
}

export function solicitarAlteracao(deps: Deps, roteiroId: string, corpo: PedidoAlteracao, chave?: string): Resultado {
  return executarAcao(deps, roteiroId, chave, "solicitar_alteracao", corpo, (roteiro, dados, agora) => {
    const prazo = verificarPrazo(dados.prazo, agora);
    exigirVersaoAtual(dados.versao ?? undefined, roteiro.versao_atual);

    const quando = agora.toISOString();
    repo.inserirPedido(deps.db, {
      id: randomUUID(),
      roteiro_id: roteiroId,
      versao: roteiro.versao_atual,
      motivo: dados.motivo,
      prazo: prazo.texto,
      prazo_fim: prazo.fim.toISOString(),
      criado_em: quando,
    });
    repo.mudarEstadoVersao(deps.db, roteiroId, roteiro.versao_atual, "alteracao_solicitada");
    repo.atualizarRoteiro(deps.db, roteiroId, {
      estado: "alteracao_solicitada",
      versao_atual: roteiro.versao_atual,
      atualizado_em: quando,
      aprovado_em: null,
      versao_aprovada: null,
    });
    repo.inserirEvento(deps.db, {
      roteiro_id: roteiroId,
      versao: roteiro.versao_atual,
      tipo: "alteracao_solicitada",
      dados: { motivo: dados.motivo, prazo: prazo.texto, prazo_fim: prazo.fim.toISOString() },
      ocorrido_em: quando,
    });
    return { status: 201, corpo: montarRoteiro(deps.db, exigirRoteiro(deps.db, roteiroId), agora) };
  });
}

export function enviarNovaVersao(deps: Deps, roteiroId: string, corpo: NovaVersao, chave?: string): Resultado {
  return executarAcao(deps, roteiroId, chave, "enviar_nova_versao", corpo, (roteiro, dados, agora) => {
    const pedido = repo.buscarPedidoDaVersao(deps.db, roteiroId, roteiro.versao_atual);
    // Reenvio depois do prazo é aceito, mas fica marcado: a marca decide o que fazer com o atraso.
    const aposPrazo = pedido ? prazoVencido(new Date(pedido.prazo_fim), agora) : false;
    const numero = roteiro.versao_atual + 1;
    const quando = agora.toISOString();
    repo.inserirVersao(deps.db, {
      roteiro_id: roteiroId,
      numero,
      conteudo: dados.conteudo,
      estado: "aguardando_revisao",
      enviada_em: quando,
      enviada_apos_prazo: aposPrazo ? 1 : 0,
    });
    repo.atualizarRoteiro(deps.db, roteiroId, {
      estado: "aguardando_revisao",
      versao_atual: numero,
      atualizado_em: quando,
      aprovado_em: null,
      versao_aprovada: null,
    });
    repo.inserirEvento(deps.db, {
      roteiro_id: roteiroId,
      versao: numero,
      tipo: "reenviado",
      dados: { apos_prazo: aposPrazo, prazo: pedido?.prazo ?? null },
      ocorrido_em: quando,
    });
    return { status: 201, corpo: montarRoteiro(deps.db, exigirRoteiro(deps.db, roteiroId), agora) };
  });
}

export function aprovar(deps: Deps, roteiroId: string, corpo: Aprovacao, chave?: string): Resultado {
  return executarAcao(deps, roteiroId, chave, "aprovar", corpo, (roteiro, dados, agora) => {
    exigirVersaoAtual(dados.versao ?? undefined, roteiro.versao_atual);

    const quando = agora.toISOString();
    repo.mudarEstadoVersao(deps.db, roteiroId, roteiro.versao_atual, "aprovada");
    repo.atualizarRoteiro(deps.db, roteiroId, {
      estado: "aprovado",
      versao_atual: roteiro.versao_atual,
      atualizado_em: quando,
      aprovado_em: quando,
      versao_aprovada: roteiro.versao_atual,
    });
    repo.inserirEvento(deps.db, {
      roteiro_id: roteiroId,
      versao: roteiro.versao_atual,
      tipo: "aprovado",
      ocorrido_em: quando,
    });
    return { status: 200, corpo: montarRoteiro(deps.db, exigirRoteiro(deps.db, roteiroId), agora) };
  });
}

export function obterRoteiro(deps: Deps, roteiroId: string) {
  return montarRoteiro(deps.db, exigirRoteiro(deps.db, roteiroId), deps.clock.now());
}

export function obterVersao(deps: Deps, roteiroId: string, numero: number) {
  const roteiro = exigirRoteiro(deps.db, roteiroId);
  const versao = repo.buscarVersao(deps.db, roteiroId, numero);
  if (!versao) {
    throw new ErroApi(404, "VERSAO_NAO_ENCONTRADA", `Versão ${numero} não encontrada no roteiro ${roteiroId}.`);
  }
  const visao = montarRoteiro(deps.db, roteiro, deps.clock.now());
  return visao.versoes.find((v) => v.numero === versao.numero)!;
}

export function obterHistorico(deps: Deps, roteiroId: string) {
  exigirRoteiro(deps.db, roteiroId);
  return {
    roteiro_id: roteiroId,
    eventos: repo.listarEventos(deps.db, roteiroId).map((e) => ({
      tipo: e.tipo,
      versao: e.versao,
      ocorrido_em: e.ocorrido_em,
      ...(e.dados ? { dados: JSON.parse(e.dados) as unknown } : {}),
    })),
  };
}
