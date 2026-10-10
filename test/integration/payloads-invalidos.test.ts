import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { montar } from "./helpers.ts";

const TABELAS = ["roteiros", "versoes", "pedidos_alteracao", "eventos", "chaves_idempotencia"];

function contarLinhas(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    TABELAS.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  );
}

async function enviarCru(app: ReturnType<typeof montar>["app"], caminho: string, corpo: string, headers: Record<string, string> = {}) {
  const res = await app.request(caminho, { method: "POST", body: corpo, headers });
  return { status: res.status, json: (await res.json()) as { error?: { code: string; message: string } } };
}

// Corpos que não são um objeto JSON: valem para todo endpoint de escrita.
const corposMalformados: [string, string][] = [
  ["JSON quebrado", "{motivo:"],
  ["null", "null"],
  ["array", "[]"],
  ["string solta", '"oi"'],
  ["número solto", "42"],
  ["texto qualquer", "motivo=ajuste&prazo=2026-03-12"],
];

const motivoLongo = "a".repeat(2_001);
const conteudoLongo = "a".repeat(50_001);

const pedidosInvalidos: [string, unknown, string][] = [
  ["corpo vazio", {}, "MOTIVO_OBRIGATORIO"],
  ["motivo número", { motivo: 1, prazo: "2026-03-12" }, "MOTIVO_INVALIDO"],
  ["motivo objeto", { motivo: { texto: "x" }, prazo: "2026-03-12" }, "MOTIVO_INVALIDO"],
  ["motivo array", { motivo: ["x"], prazo: "2026-03-12" }, "MOTIVO_INVALIDO"],
  ["motivo só com zero-width space", { motivo: "​​", prazo: "2026-03-12" }, "MOTIVO_OBRIGATORIO"],
  ["motivo só com quebras e BOM", { motivo: "\n\t﻿", prazo: "2026-03-12" }, "MOTIVO_OBRIGATORIO"],
  ["motivo longo demais", { motivo: motivoLongo, prazo: "2026-03-12" }, "CAMPO_MUITO_LONGO"],
  ["prazo número", { motivo: "x", prazo: 20260312 }, "PRAZO_INVALIDO"],
  ["prazo com fuso", { motivo: "x", prazo: "2026-03-12T00:00:00-03:00" }, "PRAZO_INVALIDO"],
  ["prazo 2026-02-29 (ano não bissexto)", { motivo: "x", prazo: "2026-02-29" }, "PRAZO_INVALIDO"],
  ["prazo ano zero", { motivo: "x", prazo: "0000-01-01" }, "PRAZO_INVALIDO"],
  ["prazo com espaço", { motivo: "x", prazo: " 2026-03-12" }, "PRAZO_INVALIDO"],
  ["prazo mais de um ano à frente", { motivo: "x", prazo: "2027-03-11" }, "PRAZO_MUITO_DISTANTE"],
  ["prazo absurdo", { motivo: "x", prazo: "9999-12-31" }, "PRAZO_MUITO_DISTANTE"],
  ["versao negativa", { motivo: "x", prazo: "2026-03-12", versao: -1 }, "VERSAO_INVALIDA"],
  ["versao zero", { motivo: "x", prazo: "2026-03-12", versao: 0 }, "VERSAO_INVALIDA"],
  ["versao fracionária", { motivo: "x", prazo: "2026-03-12", versao: 1.5 }, "VERSAO_INVALIDA"],
  ["versao texto", { motivo: "x", prazo: "2026-03-12", versao: "1" }, "VERSAO_INVALIDA"],
  ["versao enorme", { motivo: "x", prazo: "2026-03-12", versao: 1e308 }, "VERSAO_INVALIDA"],
];

describe("payloads inválidos não passam e não gravam nada", () => {
  describe.each([
    ["POST /roteiros", (_id: string) => "/roteiros"],
    ["POST /pedidos-alteracao", (id: string) => `/roteiros/${id}/pedidos-alteracao`],
    ["POST /versoes", (id: string) => `/roteiros/${id}/versoes`],
    ["POST /aprovacao", (id: string) => `/roteiros/${id}/aprovacao`],
  ])("%s", (_nome, caminho) => {
    it.each(corposMalformados)("corpo %s responde 400 JSON_INVALIDO", async (_caso, corpo) => {
      const { app, db, criarRoteiro, chamar } = montar();
      const id = await criarRoteiro();
      // Deixa o roteiro num estado em que /versoes também chegaria a validar o corpo.
      if (caminho(id).endsWith("/versoes")) {
        await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" });
      }
      const antes = contarLinhas(db);
      const r = await enviarCru(app, caminho(id), corpo, { "content-type": "application/json" });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ code: "JSON_INVALIDO", message: expect.any(String) });
      expect(contarLinhas(db)).toEqual(antes);
    });

    it("corpo acima de 1 MB responde 413 CORPO_MUITO_GRANDE", async () => {
      const { app, db, criarRoteiro } = montar();
      const id = await criarRoteiro();
      const antes = contarLinhas(db);
      const r = await enviarCru(app, caminho(id), JSON.stringify({ conteudo: "a".repeat(1024 * 1024 + 10) }), {
        "content-type": "application/json",
      });
      expect(r.status).toBe(413);
      expect(r.json.error?.code).toBe("CORPO_MUITO_GRANDE");
      expect(contarLinhas(db)).toEqual(antes);
    });
  });

  it.each(pedidosInvalidos)("pedido de alteração com %s responde 400 %s sem gravar", async (_caso, corpo, codigo) => {
    const { chamar, db, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const antes = contarLinhas(db);
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, corpo);
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: codigo, message: expect.any(String) });
    expect(contarLinhas(db)).toEqual(antes);
  });

  it.each([
    ["sem título", { conteudo: "x" }],
    ["título número", { titulo: 1, conteudo: "x" }],
    ["título só espaços", { titulo: "   ", conteudo: "x" }],
    ["título longo demais", { titulo: "a".repeat(201), conteudo: "x" }],
    ["conteúdo objeto", { titulo: "t", conteudo: { a: 1 } }],
    ["conteúdo só zero-width", { titulo: "t", conteudo: "​" }],
    ["conteúdo longo demais", { titulo: "t", conteudo: conteudoLongo }],
  ])("criar roteiro com %s responde 400 sem gravar", async (_caso, corpo) => {
    const { chamar, db } = montar();
    const r = await chamar("POST", "/roteiros", corpo);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toMatch(/^CAMPO_/);
    expect(contarLinhas(db)).toEqual(Object.fromEntries(TABELAS.map((t) => [t, 0])));
  });

  it.each([
    ["sem conteúdo", {}],
    ["conteúdo número", { conteudo: 7 }],
    ["conteúdo vazio", { conteudo: "" }],
    ["conteúdo longo demais", { conteudo: conteudoLongo }],
  ])("reenvio com %s responde 400 sem gravar", async (_caso, corpo) => {
    const { chamar, db, criarRoteiro } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" });
    const antes = contarLinhas(db);
    const r = await chamar("POST", `/roteiros/${id}/versoes`, corpo);
    expect(r.status).toBe(400);
    expect(contarLinhas(db)).toEqual(antes);
  });

  it.each([
    ["versao negativa", { versao: -3 }],
    ["versao texto", { versao: "2" }],
    ["versao infinita (1e400 vira Infinity)", '{"versao":1e400}'],
  ])("aprovação com %s responde 400 VERSAO_INVALIDA sem gravar", async (_caso, corpo) => {
    const { chamar, db, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const antes = contarLinhas(db);
    const r = await chamar("POST", `/roteiros/${id}/aprovacao`, corpo);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("VERSAO_INVALIDA");
    expect(contarLinhas(db)).toEqual(antes);
  });

  it("campos desconhecidos são ignorados", async () => {
    const { chamar } = montar();
    const r = await chamar("POST", "/roteiros", '{"titulo":"t","conteudo":"x","estado":"aprovado","__proto__":{"a":1},"extra":[1]}');
    expect(r.status).toBe(201);
    expect(r.json.estado).toBe("aguardando_revisao");
  });

  it.each([
    ["ausente", undefined],
    ["text/plain", "text/plain"],
    ["form", "application/x-www-form-urlencoded"],
  ])("Content-Type %s com corpo responde 400 CONTENT_TYPE_INVALIDO sem gravar", async (_caso, tipo) => {
    const { app, db } = montar();
    const r = await enviarCru(app, "/roteiros", JSON.stringify({ titulo: "t", conteudo: "x" }), tipo ? { "content-type": tipo } : {});
    expect(r.status).toBe(400);
    expect(r.json.error?.code).toBe("CONTENT_TYPE_INVALIDO");
    expect(contarLinhas(db).roteiros).toBe(0);
  });

  it("Content-Type JSON com charset é aceito", async () => {
    const { app } = montar();
    const r = await enviarCru(app, "/roteiros", JSON.stringify({ titulo: "t", conteudo: "x" }), {
      "content-type": "application/json; charset=utf-8",
    });
    expect(r.status).toBe(201);
  });

  it("erro de validação traz details com cada campo", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "", prazo: "ontem", versao: 0 });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("MOTIVO_OBRIGATORIO");
    expect(r.json.error.details.map((d: { campo: string }) => d.campo)).toEqual(["motivo", "prazo", "versao"]);
  });

  it("aprovação aceita corpo vazio, porque todos os campos dela são opcionais", async () => {
    const { app, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await app.request(`/roteiros/${id}/aprovacao`, { method: "POST" });
    expect(r.status).toBe(200);
  });
});

describe("rotas, ids e métodos", () => {
  it.each([
    ["id inexistente", "GET", "/roteiros/nao-existe"],
    ["id com unicode e espaço", "GET", "/roteiros/ro%20teiro-%C3%A7%F0%9F%98%80"],
    ["id com percent-encoding quebrado", "GET", "/roteiros/%E0%A4%A"],
    ["versão que não existe", "GET", "/roteiros/x/versoes/7"],
    ["histórico de id inexistente", "GET", "/roteiros/x/historico"],
    ["rota inexistente", "GET", "/nada"],
    ["método errado", "DELETE", "/roteiros/x"],
    ["PUT em versões", "PUT", "/roteiros/x/versoes"],
  ])("%s responde 404 JSON", async (_caso, metodo, caminho) => {
    const { app } = montar();
    const r = await app.request(caminho, { method: metodo });
    expect(r.status).toBe(404);
    const json = (await r.json()) as { error: { code: string } };
    expect(json.error.code).toMatch(/NAO_ENCONTRAD/);
  });

  it.each(["0", "01", "0x1", "1e0", "%201", "1.0", "-1", "+1", "99999999999999999999"])(
    "GET /versoes/%s responde 400 PARAMETRO_INVALIDO",
    async (numero) => {
      const { chamar, criarRoteiro } = montar();
      const id = await criarRoteiro();
      const r = await chamar("GET", `/roteiros/${id}/versoes/${numero}`);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("PARAMETRO_INVALIDO");
    },
  );

  it("erro inesperado vira 500 JSON genérico, sem stack trace", async () => {
    const { app, db, criarRoteiro } = montar();
    const id = await criarRoteiro();
    db.exec("DROP TABLE eventos");
    const original = console.error;
    console.error = () => {};
    try {
      const r = await app.request(`/roteiros/${id}/historico`);
      expect(r.status).toBe(500);
      const texto = await r.text();
      expect(JSON.parse(texto)).toEqual({ error: { code: "ERRO_INTERNO", message: "Erro inesperado no servidor." } });
      expect(texto).not.toMatch(/at |sqlite|eventos/);
    } finally {
      console.error = original;
    }
  });
});
