import { describe, expect, it } from "vitest";
import { montar } from "./helpers.ts";

// Pedido feito em 2026-03-10 com prazo 2026-03-12: vale até 2026-03-13T02:59:59.999Z.
async function comPedidoAberto() {
  const ctx = montar("2026-03-10T15:00:00.000Z");
  const id = await ctx.criarRoteiro("texto original");
  const r = await ctx.chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "trocar o gancho", prazo: "2026-03-12" });
  expect(r.status).toBe(201);
  return { ...ctx, id, pedidoId: r.json.pedido_alteracao_aberto.id as string };
}

describe("pedido de alteração vencido deixa de valer e a marca recupera a decisão", () => {
  it("no último instante do prazo (2026-03-13T02:59:59.999Z) a marca ainda recebe 409 para aprovar ou pedir de novo", async () => {
    const { chamar, clock, id } = await comPedidoAberto();
    clock.set("2026-03-13T02:59:59.999Z");
    const roteiro = await chamar("GET", `/roteiros/${id}`);
    expect(roteiro.json.acoes_permitidas).toEqual(["enviar_nova_versao"]);
    expect(roteiro.json.pedido_alteracao_aberto.vencido).toBe(false);

    const aprovar = await chamar("POST", `/roteiros/${id}/aprovacao`);
    expect(aprovar.status).toBe(409);
    expect(aprovar.json.error.code).toBe("AGUARDANDO_NOVA_VERSAO");
    const pedir = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "outro", prazo: "2026-03-20" });
    expect(pedir.status).toBe(409);
    expect(pedir.json.error.code).toBe("AGUARDANDO_NOVA_VERSAO");
  });

  it("no primeiro instante do dia seguinte (2026-03-13T03:00:00.000Z) as ações da marca voltam a aparecer", async () => {
    const { chamar, clock, id } = await comPedidoAberto();
    clock.set("2026-03-13T03:00:00.000Z");
    const roteiro = await chamar("GET", `/roteiros/${id}`);
    expect(roteiro.json.estado).toBe("alteracao_solicitada");
    expect(roteiro.json.acoes_permitidas).toEqual(["enviar_nova_versao", "solicitar_alteracao", "aprovar"]);
    expect(roteiro.json.pedido_alteracao_aberto).toMatchObject({ situacao: "aberto", vencido: true });
  });

  it("com o pedido vencido, a marca faz um novo pedido na mesma versão e o vencido fica como expirado", async () => {
    const { chamar, clock, id, pedidoId } = await comPedidoAberto();
    clock.set("2026-03-13T03:00:00.000Z");
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "novo pedido", prazo: "2026-03-20", versao: 1 });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      estado: "alteracao_solicitada",
      versao_atual: 1,
      acoes_permitidas: ["enviar_nova_versao"],
      pedido_alteracao_aberto: { versao: 1, motivo: "novo pedido", prazo: "2026-03-20", situacao: "aberto", vencido: false },
    });
    expect(r.json.pedido_alteracao_aberto.id).not.toBe(pedidoId);
    expect(r.json.versoes[0].pedidos_expirados).toMatchObject([
      { id: pedidoId, motivo: "trocar o gancho", situacao: "expirado", expirado_em: "2026-03-13T03:00:00.000Z" },
    ]);

    const h = await chamar("GET", `/roteiros/${id}/historico`);
    expect(h.json.eventos.map((e: { tipo: string }) => e.tipo)).toEqual([
      "enviado",
      "alteracao_solicitada",
      "pedido_expirado",
      "alteracao_solicitada",
    ]);
    expect(h.json.eventos[2]).toMatchObject({ versao: 1, dados: { pedido_id: pedidoId, prazo: "2026-03-12" } });

    // O reenvio passa a responder ao pedido novo, que está no prazo.
    const v2 = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" });
    expect(v2.json.versoes[1].enviada_apos_prazo).toBe(false);
  });

  it("com o pedido vencido, a marca aprova a versão atual e o pedido vencido fica como expirado", async () => {
    const { chamar, clock, id, pedidoId } = await comPedidoAberto();
    clock.set("2026-03-13T03:00:00.000Z");
    const r = await chamar("POST", `/roteiros/${id}/aprovacao`, { versao: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ estado: "aprovado", acoes_permitidas: [], pedido_alteracao_aberto: null, aprovacao: { versao: 1 } });
    expect(r.json.versoes[0]).toMatchObject({ estado: "aprovada", pedido_alteracao: null });
    expect(r.json.versoes[0].pedidos_expirados[0]).toMatchObject({ id: pedidoId, situacao: "expirado" });
    const h = await chamar("GET", `/roteiros/${id}/historico`);
    expect(h.json.eventos.map((e: { tipo: string }) => e.tipo)).toEqual([
      "enviado",
      "alteracao_solicitada",
      "pedido_expirado",
      "aprovado",
    ]);
  });

  it("o criador continua podendo reenviar depois do prazo, marcado como enviado após o prazo", async () => {
    const { chamar, clock, id } = await comPedidoAberto();
    clock.set("2026-03-13T03:00:00.000Z");
    const r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2 atrasada" });
    expect(r.status).toBe(201);
    expect(r.json.versoes[1].enviada_apos_prazo).toBe(true);
    expect(r.json.versoes[0].pedido_alteracao).toMatchObject({ situacao: "atendido" });
  });

  it("novos pedidos concorrentes sobre o mesmo pedido vencido: só um substitui", async () => {
    const { chamar, clock, id } = await comPedidoAberto();
    clock.set("2026-03-14T12:00:00.000Z");
    const respostas = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: `pedido ${i}`, prazo: "2026-03-20" }),
      ),
    );
    expect(respostas.filter((r) => r.status === 201)).toHaveLength(1);
    expect(respostas.filter((r) => r.status === 409)).toHaveLength(9);
    const roteiro = await chamar("GET", `/roteiros/${id}`);
    expect(roteiro.json.versoes[0].pedidos_expirados).toHaveLength(1);
  });
});

describe("entradas estranhas", () => {
  it.each(["0099-12-31", "0001-01-01", "0000-03-12"])("prazo com ano menor que 100 (%s) responde 400 PRAZO_INVALIDO", async (prazo) => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("PRAZO_INVALIDO");
  });

  it.each([
    ["conteúdo do roteiro", "POST", "/roteiros", { titulo: "t", conteudo: "antes\u0000depois" }],
    ["título", "POST", "/roteiros", { titulo: "t\u0000", conteudo: "x" }],
  ])("caractere NUL no %s é recusado com 400 CARACTERE_INVALIDO", async (_caso, metodo, caminho, corpo) => {
    const { chamar, db } = montar();
    const r = await chamar(metodo, caminho, corpo);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("CARACTERE_INVALIDO");
    expect((db.prepare("SELECT count(*) AS n FROM roteiros").get() as { n: number }).n).toBe(0);
  });

  it("caractere NUL no motivo e no reenvio também é recusado", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const pedido = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "a\u0000b", prazo: "2026-03-12" });
    expect(pedido.json.error.code).toBe("CARACTERE_INVALIDO");
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ok", prazo: "2026-03-12" });
    const versao = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "\u0000" });
    expect(versao.status).toBe(400);
    expect(versao.json.error.code).toBe("CARACTERE_INVALIDO");
  });

  it("tab, quebra de linha e unicode no conteúdo são guardados e devolvidos intactos", async () => {
    const { chamar } = montar();
    const conteudo = "Cena 1:\n\tabre com 🌞 e \"aspas\"\r\nfim";
    const r = await chamar("POST", "/roteiros", { titulo: "t", conteudo });
    expect(r.status).toBe(201);
    const v1 = await chamar("GET", `/roteiros/${r.json.id}/versoes/1`);
    expect(v1.json.conteudo).toBe(conteudo);
  });
});
