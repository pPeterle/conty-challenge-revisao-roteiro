import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.ts";
import { ErroApi } from "./erros.ts";
import * as revisao from "./revisao.ts";
import {
  aprovacaoSchema,
  criarRoteiroSchema,
  idempotenciaHeaderSchema,
  novaVersaoSchema,
  pedidoAlteracaoSchema,
  roteiroParamSchema,
  validar,
  versaoParamSchema,
} from "./schemas.ts";

const LIMITE_CORPO_BYTES = 1024 * 1024;
const TIPO_JSON = /^application\/([a-z.-]+\+)?json\b/i;

export interface AppDeps {
  db: DatabaseSync;
  clock: Clock;
}

function erro(code: string, message: string) {
  return { error: { code, message } };
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ErroApi) {
      const corpo = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
      return c.json(corpo, err.status);
    }
    // O validador do Hono lança 400 quando o JSON não faz parse.
    if (err instanceof HTTPException && err.status === 400) {
      return c.json(erro("JSON_INVALIDO", "O corpo da requisição não é um JSON válido."), 400);
    }
    console.error(err);
    return c.json(erro("ERRO_INTERNO", "Erro inesperado no servidor."), 500);
  });

  app.notFound((c) => c.json(erro("ROTA_NAO_ENCONTRADA", "Rota não encontrada."), 404));

  app.use(
    "*",
    bodyLimit({
      maxSize: LIMITE_CORPO_BYTES,
      onError: (c) => c.json(erro("CORPO_MUITO_GRANDE", "O corpo da requisição pode ter no máximo 1 MB."), 413),
    }),
  );

  // Corpo só é aceito como JSON. Sem corpo (ex.: POST /aprovacao sem nada) segue normalmente.
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" && !TIPO_JSON.test(c.req.header("content-type") ?? "")) {
      if ((await c.req.text()) !== "") {
        throw new ErroApi(400, "CONTENT_TYPE_INVALIDO", "Envie o corpo como JSON, com Content-Type: application/json.");
      }
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  const responder = (c: Context, r: revisao.Resultado) => {
    if (r.repetida) {
      c.header("Idempotent-Replayed", "true");
      if (r.estadoAtual) c.header("Estado-Atual", r.estadoAtual);
    }
    return c.json(r.corpo, r.status);
  };

  app.post("/roteiros", validar("json", criarRoteiroSchema), (c) =>
    responder(c, revisao.criarRoteiro(deps, c.req.valid("json"))),
  );

  app.get("/roteiros/:id", validar("param", roteiroParamSchema), (c) =>
    c.json(revisao.obterRoteiro(deps, c.req.valid("param").id)),
  );

  app.get("/roteiros/:id/historico", validar("param", roteiroParamSchema), (c) =>
    c.json(revisao.obterHistorico(deps, c.req.valid("param").id)),
  );

  app.get("/roteiros/:id/versoes/:numero", validar("param", versaoParamSchema), (c) => {
    const { id, numero } = c.req.valid("param");
    return c.json(revisao.obterVersao(deps, id, numero));
  });

  app.post(
    "/roteiros/:id/pedidos-alteracao",
    validar("param", roteiroParamSchema),
    validar("header", idempotenciaHeaderSchema),
    validar("json", pedidoAlteracaoSchema),
    (c) =>
      responder(
        c,
        revisao.solicitarAlteracao(
          deps,
          c.req.valid("param").id,
          c.req.valid("json"),
          c.req.valid("header")["idempotency-key"],
        ),
      ),
  );

  app.post(
    "/roteiros/:id/versoes",
    validar("param", roteiroParamSchema),
    validar("header", idempotenciaHeaderSchema),
    validar("json", novaVersaoSchema),
    (c) =>
      responder(
        c,
        revisao.enviarNovaVersao(deps, c.req.valid("param").id, c.req.valid("json"), c.req.valid("header")["idempotency-key"]),
      ),
  );

  app.post(
    "/roteiros/:id/aprovacao",
    validar("param", roteiroParamSchema),
    validar("header", idempotenciaHeaderSchema),
    validar("json", aprovacaoSchema),
    (c) =>
      responder(
        c,
        revisao.aprovar(deps, c.req.valid("param").id, c.req.valid("json"), c.req.valid("header")["idempotency-key"]),
      ),
  );

  return app;
}
