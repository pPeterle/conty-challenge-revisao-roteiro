import { describe, expect, it } from "vitest";
import {
  acoesPermitidas,
  exigirAcao,
  exigirVersaoAtual,
  validarMotivo,
  validarPrazo,
  type Acao,
  type EstadoRoteiro,
} from "../../src/dominio.ts";
import { ErroApi } from "../../src/erros.ts";

function codigoDe(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ErroApi) return e.code;
    throw e;
  }
  return undefined;
}

describe("máquina de estados", () => {
  it("cada estado diz exatamente quais ações cabem", () => {
    expect(acoesPermitidas("aguardando_revisao")).toEqual(["solicitar_alteracao", "aprovar"]);
    expect(acoesPermitidas("alteracao_solicitada")).toEqual(["enviar_nova_versao"]);
    expect(acoesPermitidas("aprovado")).toEqual([]);
  });

  it("aprovado é terminal: nenhuma ação passa", () => {
    for (const acao of ["solicitar_alteracao", "enviar_nova_versao", "aprovar"] as Acao[]) {
      expect(codigoDe(() => exigirAcao("aprovado", acao))).toBe("ROTEIRO_APROVADO");
    }
  });

  it("ações fora de hora recebem código que explica o que falta", () => {
    const casos: [EstadoRoteiro, Acao, string][] = [
      ["aguardando_revisao", "enviar_nova_versao", "AGUARDANDO_REVISAO"],
      ["alteracao_solicitada", "aprovar", "AGUARDANDO_NOVA_VERSAO"],
      ["alteracao_solicitada", "solicitar_alteracao", "AGUARDANDO_NOVA_VERSAO"],
    ];
    for (const [estado, acao, codigo] of casos) {
      expect(codigoDe(() => exigirAcao(estado, acao)), `${estado}/${acao}`).toBe(codigo);
    }
  });

  it("versão informada diferente da atual é recusada", () => {
    expect(codigoDe(() => exigirVersaoAtual(1, 2))).toBe("VERSAO_DESATUALIZADA");
    expect(codigoDe(() => exigirVersaoAtual(undefined, 2))).toBeUndefined();
    expect(codigoDe(() => exigirVersaoAtual(2, 2))).toBeUndefined();
  });
});

describe("validação do pedido de alteração", () => {
  const agora = new Date("2026-03-10T15:00:00.000Z");

  it("motivo ausente, vazio ou só com espaços não passa", () => {
    expect(codigoDe(() => validarMotivo(undefined))).toBe("MOTIVO_OBRIGATORIO");
    expect(codigoDe(() => validarMotivo(""))).toBe("MOTIVO_OBRIGATORIO");
    expect(codigoDe(() => validarMotivo("   "))).toBe("MOTIVO_OBRIGATORIO");
    expect(codigoDe(() => validarMotivo(42))).toBe("MOTIVO_INVALIDO");
    expect(validarMotivo("  trocar o gancho  ")).toBe("trocar o gancho");
  });

  it("prazo ausente, mal formatado ou inexistente não passa", () => {
    expect(codigoDe(() => validarPrazo(undefined, agora))).toBe("PRAZO_OBRIGATORIO");
    expect(codigoDe(() => validarPrazo("", agora))).toBe("PRAZO_OBRIGATORIO");
    expect(codigoDe(() => validarPrazo("2026-03-12T23:59:59-03:00", agora))).toBe("PRAZO_INVALIDO");
    expect(codigoDe(() => validarPrazo("2026-02-30", agora))).toBe("PRAZO_INVALIDO");
    expect(codigoDe(() => validarPrazo(20260312, agora))).toBe("PRAZO_INVALIDO");
  });

  it("prazo de um dia que já terminou em São Paulo não vale", () => {
    expect(codigoDe(() => validarPrazo("2026-03-09", agora))).toBe("PRAZO_VENCIDO");
  });

  it("prazo para hoje vale e guarda o fim do dia", () => {
    const prazo = validarPrazo("2026-03-10", agora);
    expect(prazo.texto).toBe("2026-03-10");
    expect(prazo.fim.toISOString()).toBe("2026-03-11T02:59:59.999Z");
  });
});
