import { createApp } from "../../src/app.ts";
import { ControlledClock } from "../../src/clock.ts";
import { openDatabase } from "../../src/db.ts";

/** Ator certo para cada ação, para os testes que não estão testando papéis. */
export function atorPadrao(metodo: string, caminho: string): Record<string, string> {
  if (metodo !== "POST") return {};
  if (caminho === "/roteiros" || caminho.endsWith("/versoes")) return { "X-Ator": "criador" };
  return { "X-Ator": "marca" };
}

export function montar(inicio = "2026-03-10T15:00:00.000Z") {
  const db = openDatabase(":memory:");
  const clock = new ControlledClock(inicio);
  const app = createApp({ db, clock });

  async function chamar(metodo: string, caminho: string, corpo?: unknown, headers: Record<string, string> = {}) {
    const comAtor = { ...atorPadrao(metodo, caminho), ...headers };
    const res = await app.request(caminho, {
      method: metodo,
      headers: corpo === undefined ? comAtor : { "content-type": "application/json", ...comAtor },
      body: corpo === undefined ? undefined : typeof corpo === "string" ? corpo : JSON.stringify(corpo),
    });
    const json = (await res.json()) as any;
    return { status: res.status, json, headers: res.headers };
  }

  async function criarRoteiro(conteudo = "Versão 1: abre com o produto na mão.") {
    const r = await chamar("POST", "/roteiros", { titulo: "Campanha verão", conteudo });
    if (r.status !== 201) throw new Error(`falha ao criar roteiro: ${JSON.stringify(r.json)}`);
    return r.json.id as string;
  }

  return { db, clock, app, chamar, criarRoteiro };
}
