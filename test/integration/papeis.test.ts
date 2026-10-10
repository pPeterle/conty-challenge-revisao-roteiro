import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { montar } from "./helpers.ts";

const contarEventos = (db: DatabaseSync) => (db.prepare("SELECT count(*) AS n FROM eventos").get() as { n: number }).n;

type Caso = [nome: string, caminho: (id: string) => string, corpo: Record<string, unknown>, atorCerto: string];

const acoes: Caso[] = [
  ["criar roteiro", () => "/roteiros", { titulo: "t", conteudo: "x" }, "criador"],
  ["pedir alteração", (id) => `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" }, "marca"],
  ["enviar nova versão", (id) => `/roteiros/${id}/versoes`, { conteudo: "v2" }, "criador"],
  ["aprovar", (id) => `/roteiros/${id}/aprovacao`, {}, "marca"],
];

describe("papéis: header X-Ator", () => {
  describe.each(acoes)("%s", (_nome, caminho, corpo, atorCerto) => {
    it("sem X-Ator responde 400 ATOR_INVALIDO", async () => {
      const { app, db, criarRoteiro } = montar();
      const id = await criarRoteiro();
      const antes = contarEventos(db);
      const res = await app.request(caminho(id), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(corpo),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("ATOR_INVALIDO");
      expect(contarEventos(db)).toBe(antes);
    });

    it.each(["agencia", "MARCA", ""])("X-Ator %j responde 400 ATOR_INVALIDO", async (valor) => {
      const { chamar, criarRoteiro } = montar();
      const id = await criarRoteiro();
      const r = await chamar("POST", caminho(id), corpo, { "X-Ator": valor });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("ATOR_INVALIDO");
    });

    it(`só ${atorCerto} pode: o outro ator recebe 403 ATOR_NAO_PERMITIDO e nada é gravado`, async () => {
      const { chamar, db, criarRoteiro } = montar();
      const id = await criarRoteiro();
      // Deixa o roteiro num estado em que a ação seria válida para o ator certo.
      if (caminho(id).endsWith("/versoes")) {
        await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" });
      }
      const antes = contarEventos(db);
      const outro = atorCerto === "marca" ? "criador" : "marca";
      const errado = await chamar("POST", caminho(id), corpo, { "X-Ator": outro });
      expect(errado.status).toBe(403);
      expect(errado.json.error.code).toBe("ATOR_NAO_PERMITIDO");
      expect(contarEventos(db)).toBe(antes);
      const certo = await chamar("POST", caminho(id), corpo, { "X-Ator": atorCerto });
      expect(certo.status).toBeLessThan(300);
    });
  });

  it("403 vem antes de 404: o papel não depende do roteiro existir", async () => {
    const { chamar } = montar();
    const r = await chamar("POST", "/roteiros/nao-existe/aprovacao", {}, { "X-Ator": "criador" });
    expect(r.status).toBe(403);
  });

  it("leituras não exigem X-Ator", async () => {
    const { app, criarRoteiro } = montar();
    const id = await criarRoteiro();
    for (const caminho of [`/roteiros/${id}`, `/roteiros/${id}/historico`, `/roteiros/${id}/versoes/1`]) {
      expect((await app.request(caminho)).status, caminho).toBe(200);
    }
  });
});

describe("ator no histórico e nas ações", () => {
  it("cada evento do histórico grava quem agiu", async () => {
    const { chamar, clock, criarRoteiro } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" });
    clock.set("2026-03-13T03:00:00.000Z");
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "de novo", prazo: "2026-03-20" });
    await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" });
    await chamar("POST", `/roteiros/${id}/aprovacao`);
    const h = await chamar("GET", `/roteiros/${id}/historico`);
    expect(h.json.eventos.map((e: { tipo: string; ator: string }) => [e.tipo, e.ator])).toEqual([
      ["enviado", "criador"],
      ["alteracao_solicitada", "marca"],
      ["pedido_expirado", "marca"],
      ["alteracao_solicitada", "marca"],
      ["reenviado", "criador"],
      ["aprovado", "marca"],
    ]);
  });

  it("acoes_por_ator separa o que cada lado pode fazer em cada estado", async () => {
    const { chamar, clock, criarRoteiro } = montar();
    const id = await criarRoteiro();
    expect((await chamar("GET", `/roteiros/${id}`)).json.acoes_por_ator).toEqual({
      marca: ["solicitar_alteracao", "aprovar"],
      criador: [],
    });
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" });
    expect((await chamar("GET", `/roteiros/${id}`)).json.acoes_por_ator).toEqual({
      marca: [],
      criador: ["enviar_nova_versao"],
    });
    clock.set("2026-03-13T03:00:00.000Z");
    expect((await chamar("GET", `/roteiros/${id}`)).json.acoes_por_ator).toEqual({
      marca: ["solicitar_alteracao", "aprovar"],
      criador: ["enviar_nova_versao"],
    });
    await chamar("POST", `/roteiros/${id}/aprovacao`);
    expect((await chamar("GET", `/roteiros/${id}`)).json.acoes_por_ator).toEqual({ marca: [], criador: [] });
  });
});
