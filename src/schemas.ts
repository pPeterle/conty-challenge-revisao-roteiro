// Todos os schemas de entrada num lugar só. Campos desconhecidos são ignorados (strip)
// e cada problema vira o mesmo formato de erro da API, com o código específico do campo.
import type { Context, Env, ValidationTargets } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z, type ZodIssue, type ZodTypeAny } from "zod";
import { LIMITES } from "./dominio.ts";
import { ErroApi } from "./erros.ts";
import { parseDataCivil } from "./prazo.ts";

// Espaços, quebras e caracteres de formatação invisíveis (zero-width space, BOM etc.).
const INVISIVEIS = /[\s\p{Cf}]/gu;
const temConteudoVisivel = (texto: string) => texto.replace(INVISIVEIS, "") !== "";

function textoObrigatorio(campo: string, max: number) {
  return z
    .string({ required_error: `Informe o campo "${campo}".`, invalid_type_error: `O campo "${campo}" precisa ser um texto.` })
    .trim()
    .min(1, `Informe o campo "${campo}".`)
    .max(max, `O campo "${campo}" pode ter no máximo ${max} caracteres.`)
    .refine(temConteudoVisivel, { message: `Informe o campo "${campo}".`, params: { vazio: true } });
}

const versaoOpcional = z
  .number({ invalid_type_error: 'O campo "versao" precisa ser um inteiro maior que zero.' })
  .int('O campo "versao" precisa ser um inteiro maior que zero.')
  .safe('O campo "versao" precisa ser um inteiro maior que zero.')
  .positive('O campo "versao" precisa ser um inteiro maior que zero.')
  .nullish()
  .transform((v) => v ?? null);

/** Data civil `AAAA-MM-DD` que existe no calendário. Se ainda vale é regra do domínio (depende do relógio). */
const prazo = z
  .string({ required_error: "Informe o prazo (data no formato AAAA-MM-DD).", invalid_type_error: "O prazo precisa ser uma data no formato AAAA-MM-DD." })
  .min(1, "Informe o prazo (data no formato AAAA-MM-DD).")
  .refine((s) => parseDataCivil(s) !== null, "O prazo precisa ser uma data válida no formato AAAA-MM-DD.")
  .transform((s) => parseDataCivil(s)!);

export const criarRoteiroSchema = z
  .object({
    titulo: textoObrigatorio("titulo", LIMITES.titulo),
    conteudo: textoObrigatorio("conteudo", LIMITES.conteudo),
  })
  .strip();

export const pedidoAlteracaoSchema = z
  .object({
    motivo: textoObrigatorio("motivo", LIMITES.motivo),
    prazo,
    versao: versaoOpcional,
  })
  .strip();

export const novaVersaoSchema = z.object({ conteudo: textoObrigatorio("conteudo", LIMITES.conteudo) }).strip();

export const aprovacaoSchema = z.object({ versao: versaoOpcional }).strip();

export const roteiroParamSchema = z.object({
  id: z.string().min(1).max(200, "Identificador de roteiro longo demais."),
});

export const versaoParamSchema = roteiroParamSchema.extend({
  numero: z
    .string()
    .regex(/^[1-9]\d{0,8}$/, "O número da versão precisa ser um inteiro positivo, sem zeros à esquerda.")
    .transform(Number),
});

export const idempotenciaHeaderSchema = z
  .object({
    "idempotency-key": z
      .string()
      .trim()
      .max(200, "A Idempotency-Key pode ter no máximo 200 caracteres.")
      .optional()
      .transform((v) => (v === "" ? undefined : v)),
  })
  .strip();

export type CriarRoteiro = z.infer<typeof criarRoteiroSchema>;
export type PedidoAlteracao = z.infer<typeof pedidoAlteracaoSchema>;
export type NovaVersao = z.infer<typeof novaVersaoSchema>;
export type Aprovacao = z.infer<typeof aprovacaoSchema>;

/** Código de erro do contrato da API para cada problema apontado pelo zod. */
export function codigoDoProblema(problema: ZodIssue, alvo: keyof ValidationTargets): string {
  if (alvo === "param") return "PARAMETRO_INVALIDO";
  if (alvo === "header") return "CHAVE_IDEMPOTENCIA_INVALIDA";
  const campo = problema.path[0];
  if (campo === undefined) return "JSON_INVALIDO";
  const ausente =
    problema.code === "invalid_type" && (problema.received === "undefined" || problema.received === "null");
  const vazio = problema.code === "too_small" || (problema.code === "custom" && problema.params?.vazio === true);
  const longo = problema.code === "too_big";
  switch (campo) {
    case "motivo":
      if (ausente || vazio) return "MOTIVO_OBRIGATORIO";
      return longo ? "CAMPO_MUITO_LONGO" : "MOTIVO_INVALIDO";
    case "prazo":
      return ausente || vazio ? "PRAZO_OBRIGATORIO" : "PRAZO_INVALIDO";
    case "versao":
      return "VERSAO_INVALIDA";
    default:
      return longo ? "CAMPO_MUITO_LONGO" : "CAMPO_OBRIGATORIO";
  }
}

/**
 * O zod roda os refinamentos depois das checagens básicas, então a ordem dos problemas
 * não segue a dos campos. Reordeno pela ordem do schema e fico com um problema por campo,
 * para o código do erro ser previsível (ex.: motivo antes de prazo).
 */
export function erroDeValidacao(erro: z.ZodError, alvo: keyof ValidationTargets, schema?: ZodTypeAny): ErroApi {
  const ordem = schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
  const posicao = (p: ZodIssue) => {
    const i = ordem.indexOf(String(p.path[0]));
    return p.path.length === 0 ? -1 : i === -1 ? ordem.length : i;
  };
  const vistos = new Set<string>();
  const problemas = [...erro.issues]
    .sort((a, b) => posicao(a) - posicao(b))
    .filter((p) => {
      const campo = p.path.join(".");
      if (vistos.has(campo)) return false;
      vistos.add(campo);
      return true;
    });
  const primeiro = problemas[0]!;
  const mensagemDe = (p: ZodIssue) => (p.path.length === 0 ? "O corpo da requisição precisa ser um objeto JSON." : p.message);
  return new ErroApi(
    400,
    codigoDoProblema(primeiro, alvo),
    mensagemDe(primeiro),
    problemas.map((p) => ({ campo: p.path.join(".") || "(corpo)", motivo: mensagemDe(p) })),
  );
}

/** zValidator com o único hook de erro da API. */
export function validar<T extends ZodTypeAny, Alvo extends keyof ValidationTargets>(alvo: Alvo, schema: T) {
  return zValidator(alvo, schema, (resultado, _c: Context<Env>) => {
    if (!resultado.success) throw erroDeValidacao(resultado.error as z.ZodError, alvo, schema);
  });
}
