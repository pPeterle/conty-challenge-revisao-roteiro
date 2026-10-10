import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EstadoRoteiro, EstadoVersao } from "./dominio.ts";

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS roteiros (
  id TEXT PRIMARY KEY,
  titulo TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('aguardando_revisao', 'alteracao_solicitada', 'aprovado')),
  versao_atual INTEGER NOT NULL,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  aprovado_em TEXT,
  versao_aprovada INTEGER
);

CREATE TABLE IF NOT EXISTS versoes (
  roteiro_id TEXT NOT NULL REFERENCES roteiros(id),
  numero INTEGER NOT NULL CHECK (numero >= 1),
  conteudo TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('aguardando_revisao', 'alteracao_solicitada', 'aprovada')),
  enviada_em TEXT NOT NULL,
  enviada_apos_prazo INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (roteiro_id, numero)
);

-- Versão é imutável: o texto e o número nunca mudam e a linha nunca some.
CREATE TRIGGER IF NOT EXISTS versao_imutavel
BEFORE UPDATE OF roteiro_id, numero, conteudo, enviada_em ON versoes
BEGIN
  SELECT RAISE(ABORT, 'versao imutavel');
END;

CREATE TRIGGER IF NOT EXISTS versao_nao_apaga
BEFORE DELETE ON versoes
BEGIN
  SELECT RAISE(ABORT, 'versao imutavel');
END;

CREATE TABLE IF NOT EXISTS pedidos_alteracao (
  id TEXT PRIMARY KEY,
  roteiro_id TEXT NOT NULL REFERENCES roteiros(id),
  versao INTEGER NOT NULL,
  motivo TEXT NOT NULL CHECK (length(trim(motivo)) > 0),
  prazo TEXT NOT NULL,
  prazo_fim TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  UNIQUE (roteiro_id, versao)
);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roteiro_id TEXT NOT NULL REFERENCES roteiros(id),
  versao INTEGER NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('enviado', 'alteracao_solicitada', 'reenviado', 'aprovado')),
  dados TEXT,
  ocorrido_em TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uma_aprovacao_por_roteiro ON eventos (roteiro_id) WHERE tipo = 'aprovado';

CREATE TABLE IF NOT EXISTS chaves_idempotencia (
  roteiro_id TEXT NOT NULL,
  chave TEXT NOT NULL,
  impressao TEXT NOT NULL,
  status INTEGER NOT NULL,
  resposta TEXT NOT NULL,
  criada_em TEXT NOT NULL,
  PRIMARY KEY (roteiro_id, chave)
);
`;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }
  db.exec(SCHEMA);
  return db;
}

/**
 * Executa `fn` numa transação de escrita. O DatabaseSync é síncrono, então nada
 * intercala entre a leitura do estado e a escrita; o BEGIN IMMEDIATE protege
 * também contra outro processo abrindo o mesmo arquivo.
 */
export function transacao<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const resultado = fn();
    db.exec("COMMIT");
    return resultado;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface LinhaRoteiro {
  id: string;
  titulo: string;
  estado: EstadoRoteiro;
  versao_atual: number;
  criado_em: string;
  atualizado_em: string;
  aprovado_em: string | null;
  versao_aprovada: number | null;
}

export interface LinhaVersao {
  roteiro_id: string;
  numero: number;
  conteudo: string;
  estado: EstadoVersao;
  enviada_em: string;
  enviada_apos_prazo: number;
}

export interface LinhaPedido {
  id: string;
  roteiro_id: string;
  versao: number;
  motivo: string;
  prazo: string;
  prazo_fim: string;
  criado_em: string;
}

export interface LinhaEvento {
  id: number;
  roteiro_id: string;
  versao: number;
  tipo: "enviado" | "alteracao_solicitada" | "reenviado" | "aprovado";
  dados: string | null;
  ocorrido_em: string;
}

export interface LinhaChave {
  impressao: string;
  status: number;
  resposta: string;
}

export function inserirRoteiro(db: DatabaseSync, r: LinhaRoteiro): void {
  db.prepare(
    `INSERT INTO roteiros (id, titulo, estado, versao_atual, criado_em, atualizado_em, aprovado_em, versao_aprovada)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.id, r.titulo, r.estado, r.versao_atual, r.criado_em, r.atualizado_em, r.aprovado_em, r.versao_aprovada);
}

export function buscarRoteiro(db: DatabaseSync, id: string): LinhaRoteiro | undefined {
  return db.prepare("SELECT * FROM roteiros WHERE id = ?").get(id) as LinhaRoteiro | undefined;
}

export function atualizarRoteiro(
  db: DatabaseSync,
  id: string,
  campos: Pick<LinhaRoteiro, "estado" | "versao_atual" | "atualizado_em" | "aprovado_em" | "versao_aprovada">,
): void {
  db.prepare(
    `UPDATE roteiros SET estado = ?, versao_atual = ?, atualizado_em = ?, aprovado_em = ?, versao_aprovada = ?
     WHERE id = ?`,
  ).run(campos.estado, campos.versao_atual, campos.atualizado_em, campos.aprovado_em, campos.versao_aprovada, id);
}

export function inserirVersao(db: DatabaseSync, v: LinhaVersao): void {
  db.prepare(
    `INSERT INTO versoes (roteiro_id, numero, conteudo, estado, enviada_em, enviada_apos_prazo)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(v.roteiro_id, v.numero, v.conteudo, v.estado, v.enviada_em, v.enviada_apos_prazo);
}

export function mudarEstadoVersao(db: DatabaseSync, roteiroId: string, numero: number, estado: EstadoVersao): void {
  db.prepare("UPDATE versoes SET estado = ? WHERE roteiro_id = ? AND numero = ?").run(estado, roteiroId, numero);
}

export function listarVersoes(db: DatabaseSync, roteiroId: string): LinhaVersao[] {
  return db
    .prepare("SELECT * FROM versoes WHERE roteiro_id = ? ORDER BY numero")
    .all(roteiroId) as unknown as LinhaVersao[];
}

export function buscarVersao(db: DatabaseSync, roteiroId: string, numero: number): LinhaVersao | undefined {
  return db
    .prepare("SELECT * FROM versoes WHERE roteiro_id = ? AND numero = ?")
    .get(roteiroId, numero) as LinhaVersao | undefined;
}

export function inserirPedido(db: DatabaseSync, p: LinhaPedido): void {
  db.prepare(
    `INSERT INTO pedidos_alteracao (id, roteiro_id, versao, motivo, prazo, prazo_fim, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.id, p.roteiro_id, p.versao, p.motivo, p.prazo, p.prazo_fim, p.criado_em);
}

export function buscarPedidoDaVersao(db: DatabaseSync, roteiroId: string, versao: number): LinhaPedido | undefined {
  return db
    .prepare("SELECT * FROM pedidos_alteracao WHERE roteiro_id = ? AND versao = ?")
    .get(roteiroId, versao) as LinhaPedido | undefined;
}

export function listarPedidos(db: DatabaseSync, roteiroId: string): LinhaPedido[] {
  return db
    .prepare("SELECT * FROM pedidos_alteracao WHERE roteiro_id = ? ORDER BY versao")
    .all(roteiroId) as unknown as LinhaPedido[];
}

export function inserirEvento(
  db: DatabaseSync,
  e: Omit<LinhaEvento, "id" | "dados"> & { dados?: Record<string, unknown> },
): void {
  db.prepare(
    "INSERT INTO eventos (roteiro_id, versao, tipo, dados, ocorrido_em) VALUES (?, ?, ?, ?, ?)",
  ).run(e.roteiro_id, e.versao, e.tipo, e.dados ? JSON.stringify(e.dados) : null, e.ocorrido_em);
}

export function listarEventos(db: DatabaseSync, roteiroId: string): LinhaEvento[] {
  return db
    .prepare("SELECT * FROM eventos WHERE roteiro_id = ? ORDER BY id")
    .all(roteiroId) as unknown as LinhaEvento[];
}

export function buscarChave(db: DatabaseSync, roteiroId: string, chave: string): LinhaChave | undefined {
  return db
    .prepare("SELECT impressao, status, resposta FROM chaves_idempotencia WHERE roteiro_id = ? AND chave = ?")
    .get(roteiroId, chave) as LinhaChave | undefined;
}

export function gravarChave(
  db: DatabaseSync,
  roteiroId: string,
  chave: string,
  registro: LinhaChave,
  criadaEm: string,
): void {
  db.prepare(
    `INSERT INTO chaves_idempotencia (roteiro_id, chave, impressao, status, resposta, criada_em)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(roteiroId, chave, registro.impressao, registro.status, registro.resposta, criadaEm);
}

export function listarIdsRoteiros(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM roteiros ORDER BY criado_em, id").all() as { id: string }[]).map((r) => r.id);
}
