import { describe, expect, it } from "vitest";
import { montar } from "./helpers.ts";

async function emAlteracao() {
  const ctx = montar();
  const id = await ctx.criarRoteiro();
  await ctx.chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
  return { ...ctx, id };
}

describe("idempotência e concorrência", () => {
  it("reenvio repetido com a mesma Idempotency-Key cria uma única versão e devolve a mesma resposta", async () => {
    const { chamar, id } = await emAlteracao();
    const headers = { "Idempotency-Key": "reenvio-abc" };
    const respostas = await Promise.all(
      Array.from({ length: 20 }, () => chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" }, headers)),
    );
    expect(respostas.every((r) => r.status === 201)).toBe(true);
    expect(respostas.filter((r) => r.headers.get("Idempotent-Replayed") === "true")).toHaveLength(19);
    expect(new Set(respostas.map((r) => JSON.stringify(r.json))).size).toBe(1);
    const roteiro = await chamar("GET", `/roteiros/${id}`);
    expect(roteiro.json.versoes.map((v: { numero: number }) => v.numero)).toEqual([1, 2]);
  });

  it("reenvios concorrentes sem chave: um cria a versão 2, os outros recebem 409", async () => {
    const { chamar, id } = await emAlteracao();
    const respostas = await Promise.all(
      Array.from({ length: 20 }, (_, i) => chamar("POST", `/roteiros/${id}/versoes`, { conteudo: `v2 ${i}` })),
    );
    expect(respostas.filter((r) => r.status === 201)).toHaveLength(1);
    expect(respostas.filter((r) => r.status === 409).every((r) => r.json.error.code === "AGUARDANDO_REVISAO")).toBe(true);
    const roteiro = await chamar("GET", `/roteiros/${id}`);
    expect(roteiro.json.versoes.map((v: { numero: number }) => v.numero)).toEqual([1, 2]);
  });

  it("aprovações concorrentes geram uma única aprovação", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const respostas = await Promise.all(Array.from({ length: 30 }, () => chamar("POST", `/roteiros/${id}/aprovacao`)));
    expect(respostas.filter((r) => r.status === 200)).toHaveLength(1);
    expect(respostas.filter((r) => r.status === 409)).toHaveLength(29);
    const h = await chamar("GET", `/roteiros/${id}/historico`);
    expect(h.json.eventos.filter((e: { tipo: string }) => e.tipo === "aprovado")).toHaveLength(1);
  });

  it("aprovação repetida com a mesma Idempotency-Key devolve 200 nas repetições, sem segunda aprovação", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const headers = { "Idempotency-Key": "aprovar-1" };
    const respostas = await Promise.all(
      Array.from({ length: 10 }, () => chamar("POST", `/roteiros/${id}/aprovacao`, { versao: 1 }, headers)),
    );
    expect(respostas.every((r) => r.status === 200)).toBe(true);
    const h = await chamar("GET", `/roteiros/${id}/historico`);
    expect(h.json.eventos.filter((e: { tipo: string }) => e.tipo === "aprovado")).toHaveLength(1);
  });

  it("aprovação e pedido de alteração disputando a mesma versão: só um vence", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const respostas = await Promise.all([
      chamar("POST", `/roteiros/${id}/aprovacao`, { versao: 1 }),
      chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12", versao: 1 }),
      chamar("POST", `/roteiros/${id}/aprovacao`, { versao: 1 }),
    ]);
    expect(respostas.filter((r) => r.status < 300)).toHaveLength(1);
    const roteiro = await chamar("GET", `/roteiros/${id}`);
    expect(["aprovado", "alteracao_solicitada"]).toContain(roteiro.json.estado);
  });

  it("mesma Idempotency-Key com outro corpo é recusada (422)", async () => {
    const { chamar, id } = await emAlteracao();
    const headers = { "Idempotency-Key": "k1" };
    await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" }, headers);
    const r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "outro texto" }, headers);
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("CHAVE_IDEMPOTENCIA_REUTILIZADA");
  });

  it("erro não fica gravado na chave: a mesma chave funciona quando o estado permite", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const headers = { "Idempotency-Key": "cedo-demais" };
    const antes = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" }, headers);
    expect(antes.status).toBe(409);
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    const depois = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" }, headers);
    expect(depois.status).toBe(201);
    expect(depois.json.versao_atual).toBe(2);
  });
});
