// Regras de prazo: funções puras, sem I/O e sem relógio global.

export const FUSO_MARCA = "America/Sao_Paulo";

export interface DataCivil {
  ano: number;
  mes: number;
  dia: number;
}

const FORMATO_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Aceita só `YYYY-MM-DD` de uma data que existe no calendário (rejeita 2026-02-30).
 * O formato já limita o ano a 9999; anos abaixo de 100 são recusados porque o
 * `Date.UTC` os trata como 19xx.
 */
export function parseDataCivil(texto: string): DataCivil | null {
  const m = FORMATO_DATA.exec(texto);
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (ano < 100) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    return null;
  }
  return { ano, mes, dia };
}

export function formatarDataCivil({ ano, mes, dia }: DataCivil): string {
  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

const formatadores = new Map<string, Intl.DateTimeFormat>();

function formatador(fuso: string): Intl.DateTimeFormat {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuso,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatadores.set(fuso, f);
  }
  return f;
}

interface PartesLocais extends DataCivil {
  hora: number;
  minuto: number;
  segundo: number;
}

function partesLocais(instante: number, fuso: string): PartesLocais {
  const partes: Record<string, number> = {};
  for (const p of formatador(fuso).formatToParts(new Date(instante))) {
    if (p.type !== "literal") partes[p.type] = Number(p.value);
  }
  return {
    ano: partes.year!,
    mes: partes.month!,
    dia: partes.day!,
    hora: partes.hour!,
    minuto: partes.minute!,
    segundo: partes.second!,
  };
}

/** Diferença (ms) entre o horário de parede no fuso e o UTC naquele instante. */
function deslocamento(instante: number, fuso: string): number {
  const p = partesLocais(instante, fuso);
  const comoUtc = Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo);
  return comoUtc - (instante - (((instante % 1000) + 1000) % 1000));
}

/** Data civil de um instante visto do fuso informado. */
export function dataCivilNoFuso(instante: Date, fuso: string): DataCivil {
  const { ano, mes, dia } = partesLocais(instante.getTime(), fuso);
  return { ano, mes, dia };
}

function mesmaData(a: DataCivil, b: DataCivil): boolean {
  return a.ano === b.ano && a.mes === b.mes && a.dia === b.dia;
}

/** Primeiro instante em que o relógio de parede do fuso mostra a data informada. */
export function inicioDoDia(data: DataCivil, fuso: string): Date {
  const meiaNoiteUtc = Date.UTC(data.ano, data.mes - 1, data.dia);
  // Dois palpites cobrem dias com mudança de horário de verão (o Brasil teve até 2019):
  // um usa o deslocamento antes da virada, o outro o deslocamento depois.
  const t1 = meiaNoiteUtc - deslocamento(meiaNoiteUtc, fuso);
  const t2 = meiaNoiteUtc - deslocamento(t1, fuso);
  const candidatos = [...new Set([t1, t2])].sort((a, b) => a - b);
  for (const t of candidatos) {
    if (mesmaData(dataCivilNoFuso(new Date(t), fuso), data)) return new Date(t);
  }
  return new Date(candidatos[candidatos.length - 1]!);
}

function diaSeguinte(data: DataCivil): DataCivil {
  const d = new Date(Date.UTC(data.ano, data.mes - 1, data.dia + 1));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/** Último milissegundo do dia no fuso: o prazo ainda vale nesse instante. */
export function fimDoDia(data: DataCivil, fuso: string): Date {
  return new Date(inicioDoDia(diaSeguinte(data), fuso).getTime() - 1);
}

export function prazoVencido(fimDoPrazo: Date, agora: Date): boolean {
  return agora.getTime() > fimDoPrazo.getTime();
}

/** ISO 8601 com o deslocamento do fuso, ex.: 2026-03-12T23:59:59.999-03:00. */
export function formatarNoFuso(instante: Date, fuso: string): string {
  const t = instante.getTime();
  const p = partesLocais(t, fuso);
  const desloc = deslocamento(t, fuso) / 60000;
  const sinal = desloc < 0 ? "-" : "+";
  const abs = Math.abs(desloc);
  const dd = (n: number, w = 2) => String(n).padStart(w, "0");
  const ms = ((t % 1000) + 1000) % 1000;
  return (
    `${dd(p.ano, 4)}-${dd(p.mes)}-${dd(p.dia)}T${dd(p.hora)}:${dd(p.minuto)}:${dd(p.segundo)}.${dd(ms, 3)}` +
    `${sinal}${dd(Math.floor(abs / 60))}:${dd(abs % 60)}`
  );
}
