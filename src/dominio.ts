// Máquina de estados do roteiro e validação de entrada. Funções puras.
import { ErroApi } from "./erros.ts";
import {
  FUSO_MARCA,
  fimDoDia,
  formatarDataCivil,
  parseDataCivil,
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

export function acoesPermitidas(estado: EstadoRoteiro): Acao[] {
  return ACOES_POR_ESTADO[estado];
}

/** Lança 409 com um código específico quando a ação não cabe no estado atual. */
export function exigirAcao(estado: EstadoRoteiro, acao: Acao): void {
  if (ACOES_POR_ESTADO[estado].includes(acao)) return;
  if (estado === "aprovado") {
    throw new ErroApi(409, "ROTEIRO_APROVADO", "O roteiro já foi aprovado; a revisão está encerrada.");
  }
  if (estado === "alteracao_solicitada") {
    throw new ErroApi(
      409,
      "AGUARDANDO_NOVA_VERSAO",
      "Há um pedido de alteração aberto; o criador precisa enviar uma nova versão antes.",
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

export interface PrazoValidado {
  data: DataCivil;
  texto: string;
  fim: Date;
}

/** O prazo é um dia no fuso da marca e vale até o último milissegundo desse dia. */
export function validarPrazo(prazo: unknown, agora: Date): PrazoValidado {
  if (prazo === undefined || prazo === null || prazo === "") {
    throw new ErroApi(400, "PRAZO_OBRIGATORIO", "Informe o prazo (data no formato AAAA-MM-DD).");
  }
  if (typeof prazo !== "string") {
    throw new ErroApi(400, "PRAZO_INVALIDO", "O prazo precisa ser uma data no formato AAAA-MM-DD.");
  }
  const data = parseDataCivil(prazo);
  if (!data) {
    throw new ErroApi(400, "PRAZO_INVALIDO", "O prazo precisa ser uma data válida no formato AAAA-MM-DD.");
  }
  const fim = fimDoDia(data, FUSO_MARCA);
  if (prazoVencido(fim, agora)) {
    throw new ErroApi(
      422,
      "PRAZO_VENCIDO",
      `O prazo ${prazo} já passou no fuso da marca (${FUSO_MARCA}).`,
    );
  }
  return { data, texto: formatarDataCivil(data), fim };
}

export function validarMotivo(motivo: unknown): string {
  if (motivo === undefined || motivo === null) {
    throw new ErroApi(400, "MOTIVO_OBRIGATORIO", "Informe o motivo do pedido de alteração.");
  }
  if (typeof motivo !== "string") {
    throw new ErroApi(400, "MOTIVO_INVALIDO", "O motivo precisa ser um texto.");
  }
  const limpo = motivo.trim();
  if (limpo === "") {
    throw new ErroApi(400, "MOTIVO_OBRIGATORIO", "Informe o motivo do pedido de alteração.");
  }
  return limpo;
}

export function validarTextoObrigatorio(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || valor.trim() === "") {
    throw new ErroApi(400, "CAMPO_OBRIGATORIO", `O campo "${campo}" é obrigatório e precisa ser um texto.`);
  }
  return valor;
}

export function validarVersaoOpcional(valor: unknown): number | undefined {
  if (valor === undefined || valor === null) return undefined;
  if (typeof valor !== "number" || !Number.isInteger(valor) || valor < 1) {
    throw new ErroApi(400, "VERSAO_INVALIDA", 'O campo "versao" precisa ser um inteiro maior que zero.');
  }
  return valor;
}
