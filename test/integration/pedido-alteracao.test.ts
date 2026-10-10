import { describe, expect, it } from "vitest";
import { montar } from "./helpers.ts";

describe("pedido de alteração exige motivo e prazo", () => {
  const casos: [string, Record<string, unknown>, string][] = [
    ["sem motivo", { prazo: "2026-03-12" }, "MOTIVO_OBRIGATORIO"],
    ["motivo vazio", { motivo: "", prazo: "2026-03-12" }, "MOTIVO_OBRIGATORIO"],
    ["motivo só com espaços", { motivo: "   ", prazo: "2026-03-12" }, "MOTIVO_OBRIGATORIO"],
    ["sem prazo", { motivo: "ajuste" }, "PRAZO_OBRIGATORIO"],
    ["prazo vazio", { motivo: "ajuste", prazo: "" }, "PRAZO_OBRIGATORIO"],
    ["prazo com horário", { motivo: "ajuste", prazo: "2026-03-12T18:00:00Z" }, "PRAZO_INVALIDO"],
    ["prazo em outro formato", { motivo: "ajuste", prazo: "12/03/2026" }, "PRAZO_INVALIDO"],
    ["prazo que não existe", { motivo: "ajuste", prazo: "2026-02-30" }, "PRAZO_INVALIDO"],
  ];

  for (const [nome, corpo, codigo] of casos) {
    it(`pedido ${nome} não passa (400 ${codigo}) e o roteiro continua em revisão`, async () => {
      const { chamar, criarRoteiro } = montar();
      const id = await criarRoteiro();
      const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, corpo);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe(codigo);
      const depois = await chamar("GET", `/roteiros/${id}`);
      expect(depois.json.estado).toBe("aguardando_revisao");
    });
  }
});

describe("prazo no fuso da marca (America/Sao_Paulo) com relógio controlado", () => {
  it("prazo 2026-03-12 ainda vale no último instante do dia em SP (2026-03-13T02:59:59.999Z)", async () => {
    const { chamar, criarRoteiro, clock } = montar();
    const id = await criarRoteiro();
    clock.set("2026-03-13T02:59:59.999Z");
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    expect(r.status).toBe(201);
    expect(r.json.pedido_alteracao_aberto.vencido).toBe(false);
  });

  it("prazo 2026-03-12 não vale no primeiro instante do dia seguinte em SP (2026-03-13T03:00:00.000Z)", async () => {
    const { chamar, criarRoteiro, clock } = montar();
    const id = await criarRoteiro();
    clock.set("2026-03-13T03:00:00.000Z");
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("PRAZO_VENCIDO");
    const depois = await chamar("GET", `/roteiros/${id}`);
    expect(depois.json.estado).toBe("aguardando_revisao");
  });

  it("quando o UTC já virou para o dia 13 mas em SP ainda é dia 12, prazo 2026-03-12 vale", async () => {
    const { chamar, criarRoteiro, clock } = montar();
    const id = await criarRoteiro();
    // 22:30 do dia 12 em São Paulo.
    clock.set("2026-03-13T01:30:00.000Z");
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    expect(r.status).toBe(201);
    expect(r.json.pedido_alteracao_aberto.prazo_fim).toBe("2026-03-12T23:59:59.999-03:00");
  });

  it("quando o UTC já virou, o dia anterior em SP já terminou: prazo 2026-03-11 não vale", async () => {
    const { chamar, criarRoteiro, clock } = montar();
    const id = await criarRoteiro();
    clock.set("2026-03-13T01:30:00.000Z");
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-11" });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("PRAZO_VENCIDO");
  });

  it("o campo vencido do pedido aberto acompanha o relógio", async () => {
    const { chamar, criarRoteiro, clock } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    clock.set("2026-03-13T02:59:59.999Z");
    expect((await chamar("GET", `/roteiros/${id}`)).json.pedido_alteracao_aberto.vencido).toBe(false);
    clock.set("2026-03-13T03:00:00.000Z");
    expect((await chamar("GET", `/roteiros/${id}`)).json.pedido_alteracao_aberto.vencido).toBe(true);
  });
});

describe("reenvio depois do prazo", () => {
  it("reenvio no último instante do prazo entra no prazo", async () => {
    const { chamar, criarRoteiro, clock } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    clock.set("2026-03-13T02:59:59.999Z");
    const r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" });
    expect(r.status).toBe(201);
    expect(r.json.versoes[1].enviada_apos_prazo).toBe(false);
  });

  it("reenvio depois do prazo é aceito, marcado como enviado após o prazo, e a marca segue podendo decidir", async () => {
    const { chamar, criarRoteiro, clock } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    clock.set("2026-03-13T03:00:00.000Z");
    const r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2 atrasada" });
    expect(r.status).toBe(201);
    expect(r.json.estado).toBe("aguardando_revisao");
    expect(r.json.versoes[1]).toMatchObject({ numero: 2, enviada_apos_prazo: true });
    const h = await chamar("GET", `/roteiros/${id}/historico`);
    expect(h.json.eventos.at(-1)).toMatchObject({ tipo: "reenviado", versao: 2, dados: { apos_prazo: true, prazo: "2026-03-12" } });
    expect(r.json.acoes_permitidas).toEqual(["solicitar_alteracao", "aprovar"]);
  });
});
