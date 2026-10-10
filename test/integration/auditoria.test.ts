import { describe, expect, it } from "vitest";
import { montar } from "./helpers.ts";

describe("ordem das checagens", () => {
  it("roteiro aprovado recusa pedido com prazo vencido como 409 ROTEIRO_APROVADO, não 422", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/aprovacao`);
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2020-01-01" });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("ROTEIRO_APROVADO");
  });

  it("ordem documentada: forma do corpo (400) vem antes do estado (409), regra do relógio (422) vem depois", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    await chamar("POST", `/roteiros/${id}/aprovacao`);
    const formaInvalida = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { prazo: "2026-03-12" });
    expect(formaInvalida.status).toBe(400);
    expect(formaInvalida.json.error.code).toBe("MOTIVO_OBRIGATORIO");
    const vencido = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2020-01-01" });
    expect(vencido.json.error.code).toBe("ROTEIRO_APROVADO");
  });
});

describe("Idempotency-Key", () => {
  it("a impressão não depende da ordem dos campos do JSON", async () => {
    const { app, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const enviar = (corpo: string) =>
      app.request(`/roteiros/${id}/pedidos-alteracao`, {
        method: "POST",
        body: corpo,
        headers: { "content-type": "application/json", "Idempotency-Key": "ordem" },
      });
    const primeira = await enviar('{"motivo":"ajuste","prazo":"2026-03-12","versao":1}');
    const segunda = await enviar('{"versao":1,"prazo":"2026-03-12","motivo":"  ajuste  "}');
    expect(primeira.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(segunda.headers.get("Idempotent-Replayed")).toBe("true");
  });

  it("na repetição, o header Estado-Atual mostra o estado de agora (o corpo é a foto da primeira resposta)", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const headers = { "Idempotency-Key": "pedido-1" };
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" }, headers);
    await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" });
    const repetida = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" }, headers);
    expect(repetida.status).toBe(201);
    expect(repetida.json.estado).toBe("alteracao_solicitada");
    expect(repetida.headers.get("Estado-Atual")).toBe("aguardando_revisao");
  });

  it("mesma chave com corpo equivalente depois do trim conta como repetição", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const headers = { "Idempotency-Key": "k" };
    await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "2026-03-12" });
    const a = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "v2" }, headers);
    const b = await chamar("POST", `/roteiros/${id}/versoes`, { conteudo: "  v2  ", extra: true }, headers);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
  });

  it("Idempotency-Key com mais de 200 caracteres responde 400 CHAVE_IDEMPOTENCIA_INVALIDA", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/aprovacao`, {}, { "Idempotency-Key": "k".repeat(201) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("CHAVE_IDEMPOTENCIA_INVALIDA");
  });
});

describe("limite do prazo", () => {
  it("não há teto de negócio: prazo distante é aceito enquanto o formato for válido (até 9999-12-31)", async () => {
    const { chamar, criarRoteiro } = montar("2026-03-10T15:00:00.000Z");
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "9999-12-31" });
    expect(r.status).toBe(201);
    expect(r.json.pedido_alteracao_aberto.prazo_fim).toBe("9999-12-31T23:59:59.999-03:00");
  });

  it("ano com mais de 4 dígitos não passa no formato (400 PRAZO_INVALIDO)", async () => {
    const { chamar, criarRoteiro } = montar();
    const id = await criarRoteiro();
    const r = await chamar("POST", `/roteiros/${id}/pedidos-alteracao`, { motivo: "x", prazo: "10000-01-01" });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("PRAZO_INVALIDO");
  });
});
