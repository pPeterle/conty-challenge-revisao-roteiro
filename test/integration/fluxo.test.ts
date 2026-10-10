import { describe, expect, it } from "vitest";
import { montar } from "./helpers.ts";

describe("fluxo completo de revisão", () => {
  it("envio, pedido de alteração, reenvio e aprovação, com o estado e as ações explícitos em cada passo", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();

    let r = await chamar("GET", `/roteiros/${id}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      estado: "aguardando_revisao",
      versao_atual: 1,
      acoes_permitidas: ["solicitar_alteracao", "aprovar"],
      pedido_alteracao_aberto: null,
      aprovacao: null,
    });

    r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, {
      motivo: "Trocar o gancho dos 3 primeiros segundos.",
      prazo: "2026-03-12",
    });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      estado: "alteracao_solicitada",
      versao_atual: 1,
      acoes_permitidas: ["enviar_nova_versao"],
      pedido_alteracao_aberto: {
        versao: 1,
        motivo: "Trocar o gancho dos 3 primeiros segundos.",
        prazo: "2026-03-12",
        fuso: "America/Sao_Paulo",
        prazo_fim: "2026-03-12T23:59:59.999-03:00",
        prazo_fim_utc: "2026-03-13T02:59:59.999Z",
        vencido: false,
      },
    });

    r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "Versão 2: abre com a pergunta." });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      estado: "aguardando_revisao",
      versao_atual: 2,
      acoes_permitidas: ["solicitar_alteracao", "aprovar"],
      pedido_alteracao_aberto: null,
    });

    r = await chamar("POST", `/roteiros/${id}/aprovacao`, { versao: 2 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      estado: "aprovado",
      versao_atual: 2,
      acoes_permitidas: [],
      aprovacao: { versao: 2, aprovado_em: "2026-03-10T15:00:00.000Z" },
    });
    expect(r.json.versoes.map((v: { numero: number; estado: string }) => [v.numero, v.estado])).toEqual([
      [1, "alteracao_solicitada"],
      [2, "aprovada"],
    ]);

    const historico = await chamar("GET", `/roteiros/${id}/historico`);
    expect(historico.json.eventos.map((e: { tipo: string; versao: number }) => [e.tipo, e.versao])).toEqual([
      ["enviado", 1],
      ["alteracao_solicitada", 1],
      ["reenviado", 2],
      ["aprovado", 2],
    ]);
    expect(historico.json.eventos[1].dados).toMatchObject({
      motivo: "Trocar o gancho dos 3 primeiros segundos.",
      prazo: "2026-03-12",
    });
  });

  it("aprovar direto a primeira versão também encerra a revisão", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/aprovacao`);
    expect(r.status).toBe(200);
    expect(r.json.estado).toBe("aprovado");
  });

  it("vários ciclos de alteração numeram as versões em sequência", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    for (let n = 2; n <= 4; n++) {
      await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: `ajuste ${n}`, prazo: "2026-03-20" });
      const r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: `versão ${n}` });
      expect(r.json.versao_atual).toBe(n);
    }
    const r = await chamar("GET", `/roteiros/${id}`);
    expect(r.json.versoes.map((v: { numero: number }) => v.numero)).toEqual([1, 2, 3, 4]);
  });
});

describe("versões antigas", () => {
  it("versão antiga não se perde quando chega uma nova: conteúdo, estado e pedido continuam consultáveis", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro("texto original");
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "mudar CTA", prazo: "2026-03-12" });
    await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "texto novo" });

    const v1 = await chamar("GET", `/roteiros/${id}/versoes/1`);
    expect(v1.status).toBe(200);
    expect(v1.json).toMatchObject({
      numero: 1,
      estado: "alteracao_solicitada",
      conteudo: "texto original",
      pedido_alteracao: { motivo: "mudar CTA", prazo: "2026-03-12" },
    });
    const v2 = await chamar("GET", `/roteiros/${id}/versoes/2`);
    expect(v2.json).toMatchObject({ numero: 2, estado: "aguardando_revisao", conteudo: "texto novo" });
  });

  it("o banco recusa alterar ou apagar o conteúdo de uma versão", async () => {
    const { db, criarRoteiro } = montar();
    const id = await criarRoteiro("texto original");
    expect(() => db.prepare("UPDATE versoes SET conteudo = 'x' WHERE roteiro_id = ?").run(id)).toThrow(/imutavel/);
    expect(() => db.prepare("DELETE FROM versoes WHERE roteiro_id = ?").run(id)).toThrow(/imutavel/);
  });

  it("versão inexistente responde 404", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("GET", `/roteiros/${id}/versoes/9`);
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("VERSAO_NAO_ENCONTRADA");
  });
});

describe("roteiro aprovado", () => {
  async function aprovado() {
    const ctx = montar();
    const id = await ctx.criarRoteiro();
    await ctx.chamar("POST", `/roteiros/${id}/aprovacao`);
    return { ...ctx, id };
  }

  it("roteiro aprovado não aceita nova versão (409 ROTEIRO_APROVADO)", async () => {
    const { chamar, id } = await aprovado();
    const r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "mais uma" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("ROTEIRO_APROVADO");
  });

  it("roteiro aprovado não aceita novo pedido de alteração (409 ROTEIRO_APROVADO)", async () => {
    const { chamar, id } = await aprovado();
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "mudei de ideia", prazo: "2026-03-20" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("ROTEIRO_APROVADO");
  });

  it("aprovar duas vezes responde 409 e a aprovação continua uma só", async () => {
    const { chamar, id } = await aprovado();
    const r = await chamar("POST", `/roteiros/${id}/aprovacao`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("ROTEIRO_APROVADO");
    const h = await chamar("GET", `/roteiros/${id}/historico`);
    expect(h.json.eventos.filter((e: { tipo: string }) => e.tipo === "aprovado")).toHaveLength(1);
  });
});

describe("ações fora de hora", () => {
  it("criador não envia nova versão sem pedido de alteração (409 AGUARDANDO_REVISAO)", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "adiantando" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("AGUARDANDO_REVISAO");
  });

  it("marca não aprova nem pede outra alteração enquanto espera a nova versão (409 AGUARDANDO_NOVA_VERSAO)", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    const aprovar = await chamar("POST", `/roteiros/${id}/aprovacao`);
    expect(aprovar.status).toBe(409);
    expect(aprovar.json.error.code).toBe("AGUARDANDO_NOVA_VERSAO");
    const pedir = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "outro", prazo: "2026-03-12" });
    expect(pedir.status).toBe(409);
    expect(pedir.json.error.code).toBe("AGUARDANDO_NOVA_VERSAO");
  });

  it("aprovar informando uma versão que não é a atual responde 409 VERSAO_DESATUALIZADA", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "ajuste", prazo: "2026-03-12" });
    await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" });
    const r = await chamar("POST", `/roteiros/${id}/aprovacao`, { versao: 1 });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("VERSAO_DESATUALIZADA");
  });

  it("roteiro inexistente responde 404", async () => {
    const { chamar } = montar();
    const r = await chamar("POST", "/roteiros/nao-existe/aprovacao");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("ROTEIRO_NAO_ENCONTRADO");
  });
});

describe("validação de entrada", () => {
  it("criar roteiro sem conteúdo responde 400", async () => {
    const { chamar } = montar();
    const r = await chamar("POST", "/roteiros", { titulo: "x" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("CAMPO_OBRIGATORIO");
  });

  it("JSON malformado responde 400 JSON_INVALIDO", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, "{motivo:");
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("JSON_INVALIDO");
  });
});
