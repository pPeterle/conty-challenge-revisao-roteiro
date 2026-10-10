// Carga concentrada em poucos roteiros: vários usuários virtuais disputam o mesmo
// roteiro, pedindo alteração, reenviando (com Idempotency-Key repetida) e aprovando.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3101";
const ROTEIROS = Number(__ENV.ROTEIROS || 10);
const MAX_VERSAO = Number(__ENV.MAX_VERSAO || 50);

const aprovacoesAceitas = new Counter("aprovacoes_aceitas");
const versoesCriadasOuRepetidas = new Counter("reenvios_201");

http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    disputa: { executor: "constant-vus", vus: 100, duration: "20s" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<300"],
    checks: ["rate>0.99"],
  },
};

const json = { headers: { "content-type": "application/json" } };

export function setup() {
  const ids = [];
  for (let i = 0; i < ROTEIROS; i++) {
    const r = http.post(
      `${BASE_URL}/roteiros`,
      JSON.stringify({ titulo: `Roteiro de carga ${i + 1}`, conteudo: "versão 1" }),
      json,
    );
    if (r.status !== 201) throw new Error(`setup falhou: ${r.status} ${r.body}`);
    ids.push(r.json("id"));
  }
  return { ids };
}

export default function ({ ids }) {
  const id = ids[(__VU - 1) % ids.length];
  const atual = http.get(`${BASE_URL}/roteiros/${id}`, { tags: { op: "consultar" } });
  if (!check(atual, { "consulta 200": (r) => r.status === 200 })) return;
  const estado = atual.json("estado");
  const versao = atual.json("versao_atual");

  if (estado === "alteracao_solicitada") {
    // Todos que viram a mesma versão usam a mesma chave: é o "reenvio duplicado".
    const r = http.post(
      `${BASE_URL}/roteiros/${id}/versoes`,
      JSON.stringify({ conteudo: `versão ${versao + 1}` }),
      { headers: { ...json.headers, "Idempotency-Key": `reenvio-da-v${versao}` }, tags: { op: "reenviar" } },
    );
    check(r, { "reenvio com chave repetida responde 201": (x) => x.status === 201 });
    if (r.status === 201) versoesCriadasOuRepetidas.add(1);
    return;
  }

  if (estado === "aguardando_revisao" && versao < MAX_VERSAO) {
    const r = http.post(
      `${BASE_URL}/roteiros/${id}/pedidos-alteracao`,
      JSON.stringify({ motivo: `ajuste na versão ${versao}`, prazo: "2099-12-31", versao }),
      { ...json, tags: { op: "pedir_alteracao" } },
    );
    check(r, { "pedido de alteração 201 ou 409": (x) => x.status === 201 || x.status === 409 });
    return;
  }

  if (estado === "aguardando_revisao") {
    // Metade aprova com chave (repetições viram replay 200), metade sem chave (perdedores levam 409).
    const headers = __VU % 2 === 0 ? { ...json.headers, "Idempotency-Key": `aprovar-v${versao}` } : json.headers;
    const r = http.post(`${BASE_URL}/roteiros/${id}/aprovacao`, JSON.stringify({ versao }), {
      headers,
      tags: { op: "aprovar" },
    });
    check(r, { "aprovação 200 ou 409": (x) => x.status === 200 || x.status === 409 });
    if (r.status === 200 && r.headers["Idempotent-Replayed"] !== "true") aprovacoesAceitas.add(1);
    return;
  }

  // Aprovado: tudo precisa voltar 409 ROTEIRO_APROVADO.
  const aprovar = http.post(`${BASE_URL}/roteiros/${id}/aprovacao`, "{}", { ...json, tags: { op: "aprovar_de_novo" } });
  const reenviar = http.post(`${BASE_URL}/roteiros/${id}/versoes`, JSON.stringify({ conteudo: "tarde demais" }), {
    ...json,
    tags: { op: "reenviar_aprovado" },
  });
  check(aprovar, { "aprovar de novo: 409 ROTEIRO_APROVADO": (x) => x.status === 409 && x.json("error.code") === "ROTEIRO_APROVADO" });
  check(reenviar, { "nova versão após aprovação: 409 ROTEIRO_APROVADO": (x) => x.status === 409 && x.json("error.code") === "ROTEIRO_APROVADO" });
}
