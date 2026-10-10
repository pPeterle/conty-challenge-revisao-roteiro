import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";
import {
  aprovacaoSchema,
  criarRoteiroSchema,
  erroDeValidacao,
  pedidoAlteracaoSchema,
  versaoParamSchema,
} from "../../src/schemas.ts";

function codigo(schema: ZodTypeAny, valor: unknown, alvo: "json" | "param" = "json"): string | undefined {
  const r = schema.safeParse(valor);
  return r.success ? undefined : erroDeValidacao(r.error, alvo, schema).code;
}

describe("pedidoAlteracaoSchema", () => {
  it("motivo ausente, vazio, só com espaços ou só invisíveis conta como obrigatório", () => {
    for (const motivo of [undefined, null, "", "   ", "​", "﻿ ‍"]) {
      expect(codigo(pedidoAlteracaoSchema, { motivo, prazo: "2026-03-12" }), JSON.stringify(motivo)).toBe("MOTIVO_OBRIGATORIO");
    }
  });

  it("motivo com tipo errado ou longo demais tem código próprio", () => {
    expect(codigo(pedidoAlteracaoSchema, { motivo: 42, prazo: "2026-03-12" })).toBe("MOTIVO_INVALIDO");
    expect(codigo(pedidoAlteracaoSchema, { motivo: "a".repeat(2001), prazo: "2026-03-12" })).toBe("CAMPO_MUITO_LONGO");
  });

  it("motivo é aparado e campos extras somem", () => {
    const r = pedidoAlteracaoSchema.parse({ motivo: "  trocar o gancho  ", prazo: "2026-03-12", extra: 1 });
    expect(r).toEqual({ motivo: "trocar o gancho", prazo: { ano: 2026, mes: 3, dia: 12 }, versao: null });
  });

  it("prazo ausente, vazio, mal formatado ou inexistente não passa", () => {
    expect(codigo(pedidoAlteracaoSchema, { motivo: "x" })).toBe("PRAZO_OBRIGATORIO");
    expect(codigo(pedidoAlteracaoSchema, { motivo: "x", prazo: "" })).toBe("PRAZO_OBRIGATORIO");
    for (const prazo of ["2026-03-12T23:59:59-03:00", "2026-02-30", "12/03/2026", 20260312, " 2026-03-12"]) {
      expect(codigo(pedidoAlteracaoSchema, { motivo: "x", prazo }), String(prazo)).toBe("PRAZO_INVALIDO");
    }
  });

  it("erro traz details com campo e motivo de cada problema", () => {
    const r = pedidoAlteracaoSchema.safeParse({ motivo: "", prazo: "ontem", versao: -1 });
    expect(r.success).toBe(false);
    const erro = erroDeValidacao(r.error!, "json", pedidoAlteracaoSchema);
    expect(erro.code).toBe("MOTIVO_OBRIGATORIO");
    expect(erro.details?.map((d) => d.campo)).toEqual(["motivo", "prazo", "versao"]);
  });

  it("motivo invisível vence versao inválida: o código segue a ordem dos campos", () => {
    expect(codigo(pedidoAlteracaoSchema, { motivo: "\u200B", prazo: "2026-03-12", versao: -1 })).toBe("MOTIVO_OBRIGATORIO");
  });
});

describe("outros schemas", () => {
  it("versao precisa ser inteiro seguro positivo", () => {
    for (const versao of [0, -1, 1.5, "1", 1e308, Infinity]) {
      expect(codigo(aprovacaoSchema, { versao }), String(versao)).toBe("VERSAO_INVALIDA");
    }
    expect(aprovacaoSchema.parse({})).toEqual({ versao: null });
  });

  it("corpo que não é objeto vira JSON_INVALIDO", () => {
    for (const corpo of [null, [], "oi", 42]) {
      expect(codigo(criarRoteiroSchema, corpo), JSON.stringify(corpo)).toBe("JSON_INVALIDO");
    }
  });

  it("número de versão na URL aceita só dígitos sem zero à esquerda", () => {
    expect(versaoParamSchema.parse({ id: "x", numero: "12" }).numero).toBe(12);
    for (const numero of ["0", "01", "0x1", "1e0", " 1", "1.0", "-1", "+1", "", "1234567890"]) {
      expect(codigo(versaoParamSchema, { id: "x", numero }, "param"), numero).toBe("PARAMETRO_INVALIDO");
    }
  });
});
