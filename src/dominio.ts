// Máquina de estados do roteiro e regras que dependem do relógio. Funções puras.
// A forma da entrada (tipos, tamanhos, formato da data) é validada em schemas.ts.
import { ErroApi } from "./erros.ts";
import {
  FUSO_MARCA,
  dataCivilNoFuso,
  fimDoDia,
  formatarDataCivil,
  prazoVencido,
  type DataCivil,
} from "./prazo.ts";

export type EstadoRoteiro = "aguardando_revisao" | "alteracao_solicitada" | "aprovado";
export type EstadoVersao = "aguardando_revisao" | "alteracao_solicitada" | "aprovada";
export type Acao = "solicitar_alteracao" | "enviar_nova_versao" | "aprovar";

const ACOES_POR_ESTADO: Record<EstadoRoteiro, Acao[]> = {
  aguardando_revisao: ["solicitar_alteracao", "aprovar"],
  alteracao_solicitada: ["enviar_nova_versao"],
  aprovado: [],
};

/**
 * Pedido de alteração vencido não vale mais: a marca volta a poder aprovar a versão
 * atual ou fazer um pedido novo, que substitui o vencido. O criador continua podendo reenviar.
 */
const ACOES_COM_PEDIDO_VENCIDO: Acao[] = ["enviar_nova_versao", "solicitar_alteracao", "aprovar"];

export function acoesPermitidas(estado: EstadoRoteiro, pedidoAbertoVencido = false): Acao[] {
  if (estado === "alteracao_solicitada" && pedidoAbertoVencido) return ACOES_COM_PEDIDO_VENCIDO;
  return ACOES_POR_ESTADO[estado];
}

/** Lança 409 com um código específico quando a ação não cabe no estado atual. */
export function exigirAcao(estado: EstadoRoteiro, acao: Acao, pedidoAbertoVencido = false): void {
  if (acoesPermitidas(estado, pedidoAbertoVencido).includes(acao)) return;
  if (estado === "aprovado") {
    throw new ErroApi(409, "ROTEIRO_APROVADO", "O roteiro já foi aprovado; a revisão está encerrada.");
  }
  if (estado === "alteracao_solicitada") {
    throw new ErroApi(
      409,
      "AGUARDANDO_NOVA_VERSAO",
      "Há um pedido de alteração aberto e dentro do prazo; o criador precisa enviar uma nova versão antes.",
    );
  }
  throw new ErroApi(
    409,
    "AGUARDANDO_REVISAO",
    "A versão atual ainda está em revisão; só é possível enviar outra depois de um pedido de alteração.",
  );
}

/** Se o cliente informou a versão que está revisando, ela precisa ser a atual. */
export function exigirVersaoAtual(versaoInformada: number | undefined, versaoAtual: number): void {
  if (versaoInformada !== undefined && versaoInformada !== versaoAtual) {
    throw new ErroApi(
      409,
      "VERSAO_DESATUALIZADA",
      `A versão informada (${versaoInformada}) não é a atual (${versaoAtual}).`,
    );
  }
}

export const LIMITES = {
  titulo: 200,
  conteudo: 50_000,
  motivo: 2_000,
  /** O prazo pode ficar no máximo um ano à frente da data de hoje no fuso da marca. */
  anosDePrazo: 1,
} as const;

export interface PrazoValidado {
  data: DataCivil;
  texto: string;
  fim: Date;
}

/** O prazo é um dia no fuso da marca e vale até o último milissegundo desse dia. */
export function verificarPrazo(data: DataCivil, agora: Date): PrazoValidado {
  const texto = formatarDataCivil(data);
  const fim = fimDoDia(data, FUSO_MARCA);
  if (prazoVencido(fim, agora)) {
    throw new ErroApi(422, "PRAZO_VENCIDO", `O prazo ${texto} já passou no fuso da marca (${FUSO_MARCA}).`);
  }
  const hoje = dataCivilNoFuso(agora, FUSO_MARCA);
  const limite = formatarDataCivil({ ...hoje, ano: hoje.ano + LIMITES.anosDePrazo });
  // Datas AAAA-MM-DD comparam bem como texto.
  if (texto > limite) {
    throw new ErroApi(
      400,
      "PRAZO_MUITO_DISTANTE",
      `O prazo pode ser no máximo ${LIMITES.anosDePrazo} ano à frente (até ${limite}).`,
    );
  }
  return { data, texto, fim };
}
