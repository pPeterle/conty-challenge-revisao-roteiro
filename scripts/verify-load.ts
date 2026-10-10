// Confere no banco, depois da carga, que a concorrência não quebrou nenhuma invariante.
import { DatabaseSync } from "node:sqlite";
import * as repo from "../src/db.ts";

const caminho = process.argv[2];
if (!caminho) {
  console.error("uso: tsx scripts/verify-load.ts <arquivo.db>");
  process.exit(2);
}

const db = new DatabaseSync(caminho, { readOnly: true });
const falhas: string[] = [];
let aprovados = 0;
let totalVersoes = 0;

for (const id of repo.listarIdsRoteiros(db)) {
  const r = repo.buscarRoteiro(db, id)!;
  const versoes = repo.listarVersoes(db, id);
  // Pedidos expirados (vencidos e substituídos) não contam como pedido da versão.
  const pedidos = repo.listarPedidos(db, id).filter((p) => p.expirado_em === null);
  const eventos = repo.listarEventos(db, id);
  const erro = (m: string) => falhas.push(`${id}: ${m}`);
  totalVersoes += versoes.length;

  const numeros = versoes.map((v) => v.numero);
  const esperado = Array.from({ length: versoes.length }, (_, i) => i + 1);
  if (JSON.stringify(numeros) !== JSON.stringify(esperado)) erro(`versões com buraco ou repetidas: ${numeros}`);
  if (r.versao_atual !== versoes.length) erro(`versao_atual ${r.versao_atual} != ${versoes.length} versões`);
  for (const v of versoes) {
    if (v.conteudo !== `versão ${v.numero}`) erro(`versão ${v.numero} com conteúdo de outra: "${v.conteudo}"`);
  }

  const reenvios = eventos.filter((e) => e.tipo === "reenviado");
  if (reenvios.length !== versoes.length - 1) erro(`${reenvios.length} reenvios para ${versoes.length} versões`);

  // Toda versão substituída teve exatamente um pedido de alteração.
  const comPedido = new Set(pedidos.map((p) => p.versao));
  for (const v of versoes.slice(0, -1)) {
    if (!comPedido.has(v.numero)) erro(`versão ${v.numero} foi substituída sem pedido de alteração`);
    if (v.estado !== "alteracao_solicitada") erro(`versão antiga ${v.numero} em estado ${v.estado}`);
  }

  const aprovacoes = eventos.filter((e) => e.tipo === "aprovado");
  if (aprovacoes.length > 1) erro(`${aprovacoes.length} aprovações`);
  if (r.estado === "aprovado") {
    aprovados++;
    const ultima = versoes.at(-1)!;
    if (aprovacoes.length !== 1) erro(`aprovado com ${aprovacoes.length} eventos de aprovação`);
    if (r.versao_aprovada !== ultima.numero || ultima.estado !== "aprovada") erro("aprovação não está na última versão");
    if (eventos.at(-1)?.tipo !== "aprovado") erro("houve evento depois da aprovação");
    if (comPedido.has(ultima.numero)) erro("versão aprovada também tem pedido de alteração");
  } else if (aprovacoes.length > 0) {
    erro(`estado ${r.estado} mas existe aprovação`);
  }
}

const roteiros = repo.listarIdsRoteiros(db).length;
console.log(`verificação: ${roteiros} roteiros, ${totalVersoes} versões, ${aprovados} aprovados`);
if (roteiros === 0 || aprovados === 0) falhas.push("a carga não chegou a aprovar nenhum roteiro");
if (falhas.length > 0) {
  console.error(`invariantes quebradas (${falhas.length}):\n${falhas.slice(0, 20).join("\n")}`);
  process.exit(1);
}
console.log("invariantes ok: uma aprovação por roteiro, versões 1..n sem buraco nem duplicata, versões antigas preservadas");
