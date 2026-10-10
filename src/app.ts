import { Hono, type Context } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { ErroApi } from "./erros.ts";
import * as revisao from "./revisao.ts";

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
}

async function lerCorpo(c: Context): Promise<Record<string, unknown>> {
  const texto = await c.req.text();
  if (texto.trim() === "") return {};
  let corpo: unknown;
  try {
    corpo = JSON.parse(texto);
  } catch {
    throw new ErroApi(400, "JSON_INVALIDO", "O corpo da requisição não é um JSON válido.");
  }
  if (typeof corpo !== "object" || corpo === null || Array.isArray(corpo)) {
    throw new ErroApi(400, "JSON_INVALIDO", "O corpo da requisição precisa ser um objeto JSON.");
  }
  return corpo as Record<string, unknown>;
}

function chaveIdempotencia(c: Context): string | undefined {
  const chave = c.req.header("Idempotency-Key")?.trim();
  if (chave === undefined || chave === "") return undefined;
  if (chave.length > 200) {
    throw new ErroApi(400, "CHAVE_IDEMPOTENCIA_INVALIDA", "A Idempotency-Key pode ter no máximo 200 caracteres.");
  }
  return chave;
}

function responder(c: Context, r: revisao.Resultado) {
  if (r.repetida) c.header("Idempotent-Replayed", "true");
  return c.json(r.corpo, r.status);
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ErroApi) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    console.error(err);
    return c.json({ error: { code: "ERRO_INTERNO", message: "Erro inesperado no servidor." } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: "ROTA_NAO_ENCONTRADA", message: "Rota não encontrada." } }, 404));

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/roteiros", async (c) => responder(c, revisao.criarRoteiro(deps, await lerCorpo(c))));

  app.get("/roteiros/:id", (c) => c.json(revisao.obterRoteiro(deps, c.req.param("id"))));

  app.get("/roteiros/:id/historico", (c) => c.json(revisao.obterHistorico(deps, c.req.param("id"))));

  app.get("/roteiros/:id/versoes/:numero", (c) =>
    c.json(revisao.obterVersao(deps, c.req.param("id"), c.req.param("numero"))),
  );

  app.post("/roteiros/:id/pedidos-alteracao", async (c) => {
    const corpo = await lerCorpo(c);
    return responder(c, revisao.solicitarAlteracao(deps, c.req.param("id"), corpo, chaveIdempotencia(c)));
  });

  app.post("/roteiros/:id/versoes", async (c) => {
    const corpo = await lerCorpo(c);
    return responder(c, revisao.enviarNovaVersao(deps, c.req.param("id"), corpo, chaveIdempotencia(c)));
  });

  app.post("/roteiros/:id/aprovacao", async (c) => {
    const corpo = await lerCorpo(c);
    return responder(c, revisao.aprovar(deps, c.req.param("id"), corpo, chaveIdempotencia(c)));
  });

  return app;
}
