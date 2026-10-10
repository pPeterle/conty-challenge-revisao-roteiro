// Carga concentrada em poucos roteiros: vários usuários virtuais disputam o mesmo
// roteiro, pedindo alteração, reenviando (com Idempotency-Key repetida) e aprovando.
// Cerca de 10% das iterações mandam payload inválido e precisam receber 4xx.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3101";
const ROTEIROS = Number(__ENV.ROTEIROS || 10);
const MAX_VERSAO = Number(__ENV.MAX_VERSAO || 50);

const aprovacoesAceitas = new Counter("aprovacoes_aceitas");
const versoesCriadasOuRepetidas = new Counter("reenvios_201");

const invalidosRecusados = new Counter("invalidos_recusados_4xx");

// 4xx são respostas esperadas aqui; só 5xx ou erro de rede contam como falha.
http.setResponseCallback(http.expectedStatuses(200, 201, 400, 404, 409, 413, 422));

// Prazo válido para o relógio real do servidor: daqui a 30 dias.
const PRAZO = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

// Corpo acima de 1 MB (413) fica só no teste de integração: o servidor responde antes de
// ler o corpo inteiro e fecha a conexão, e o k6 registra isso como "connection reset".
function payloadInvalido(id) {
  const casos = [
    ["POST", `/roteiros/${id}/versoes`, "{conteudo:"],
    ["POST", `/roteiros/${id}/versoes`, JSON.stringify({ conteudo: 123 })],
    ["POST", `/roteiros/${id}/versoes`, "null"],
    ["POST", `/roteiros/${id}/pedidos-alteracao`, JSON.stringify({ motivo: "\u200B", prazo: PRAZO })],
    ["POST", `/roteiros/${id}/pedidos-alteracao`, JSON.stringify({ motivo: "x", prazo: "31/12/2026" })],
    ["POST", `/roteiros/${id}/pedidos-alteracao`, JSON.stringify({ motivo: "x", prazo: "9999-12-31" })],
    ["POST", `/roteiros/${id}/pedidos-alteracao`, "[]"],
    ["POST", `/roteiros/${id}/aprovacao`, JSON.stringify({ versao: -1 })],
    ["POST", `/roteiros/${id}/aprovacao`, '{"versao":1e400}'],
    ["POST", "/roteiros", JSON.stringify({ titulo: 42, conteudo: ["x"] })],
    ["POST", "/roteiros/nao-existe/aprovacao", "{}"],
    ["GET", `/roteiros/${id}/versoes/0x1`, null],
    ["POST", `/roteiros/${id}/versoes`, String(Math.random())],
  ];
  const [metodo, caminho, corpo] = casos[Math.floor(Math.random() * casos.length)];
  return http.request(metodo, `${BASE_URL}${caminho}`, corpo, { ...json, tags: { op: "invalido" } });
}

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

  if (Math.random() < 0.1) {
    const r = payloadInvalido(id);
    if (check(r, { "payload inválido responde 4xx (nunca 5xx)": (x) => x.status >= 400 && x.status < 500 })) {
      invalidosRecusados.add(1);
    }
    return;
  }
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
      JSON.stringify({ motivo: `ajuste na versão ${versao}`, prazo: PRAZO, versao }),
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
