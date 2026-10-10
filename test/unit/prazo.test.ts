import { describe, expect, it } from "vitest";
import {
  FUSO_MARCA,
  dataCivilNoFuso,
  fimDoDia,
  formatarNoFuso,
  parseDataCivil,
  prazoVencido,
} from "../../src/prazo.ts";

const dia = (s: string) => parseDataCivil(s)!;

describe("parseDataCivil", () => {
  it("aceita AAAA-MM-DD de uma data existente", () => {
    expect(parseDataCivil("2026-03-12")).toEqual({ ano: 2026, mes: 3, dia: 12 });
    expect(parseDataCivil("2028-02-29")).toEqual({ ano: 2028, mes: 2, dia: 29 });
  });

  it("rejeita formato errado e datas que não existem", () => {
    for (const s of ["2026-3-12", "12/03/2026", "2026-02-30", "2026-13-01", "2026-03-12T10:00:00Z", "", "amanhã"]) {
      expect(parseDataCivil(s), s).toBeNull();
    }
  });
});

describe("fimDoDia no fuso da marca", () => {
  it("o dia 2026-03-12 em São Paulo termina em 2026-03-13T02:59:59.999Z", () => {
    expect(fimDoDia(dia("2026-03-12"), FUSO_MARCA).toISOString()).toBe("2026-03-13T02:59:59.999Z");
  });

  it("vira o mês e o ano corretamente", () => {
    expect(fimDoDia(dia("2026-12-31"), FUSO_MARCA).toISOString()).toBe("2027-01-01T02:59:59.999Z");
  });

  it("usa o fuso de verdade, não um -03:00 fixo (horário de verão de 2019)", () => {
    // Em janeiro de 2019 São Paulo estava em -02:00.
    expect(fimDoDia(dia("2019-01-15"), FUSO_MARCA).toISOString()).toBe("2019-01-16T01:59:59.999Z");
  });

  it("dia que começa sem meia-noite (início do horário de verão em 2018-11-04)", () => {
    // 2018-11-03 terminou às 23:59:59.999 -03:00; o relógio pulou de 00:00 para 01:00 -02:00.
    expect(fimDoDia(dia("2018-11-03"), FUSO_MARCA).toISOString()).toBe("2018-11-04T02:59:59.999Z");
  });

  it("dia com 25 horas (fim do horário de verão em 2019-02-16)", () => {
    // Às 23:59:59 -02:00 o relógio voltou para 23:00 -03:00, então o dia termina mais tarde.
    expect(fimDoDia(dia("2019-02-16"), FUSO_MARCA).toISOString()).toBe("2019-02-17T02:59:59.999Z");
  });
});

describe("prazoVencido", () => {
  const fim = fimDoDia(dia("2026-03-12"), FUSO_MARCA);

  it("no último milissegundo do dia o prazo ainda vale", () => {
    expect(prazoVencido(fim, new Date("2026-03-13T02:59:59.999Z"))).toBe(false);
  });

  it("no primeiro milissegundo do dia seguinte o prazo já venceu", () => {
    expect(prazoVencido(fim, new Date("2026-03-13T03:00:00.000Z"))).toBe(true);
  });

  it("quando o UTC já virou para o dia 13 mas em São Paulo ainda é dia 12, o prazo vale", () => {
    const agora = new Date("2026-03-13T01:30:00.000Z");
    expect(dataCivilNoFuso(agora, FUSO_MARCA)).toEqual({ ano: 2026, mes: 3, dia: 12 });
    expect(prazoVencido(fim, agora)).toBe(false);
  });
});

describe("formatarNoFuso", () => {
  it("mostra o horário de parede com o deslocamento", () => {
    expect(formatarNoFuso(new Date("2026-03-13T02:59:59.999Z"), FUSO_MARCA)).toBe("2026-03-12T23:59:59.999-03:00");
    expect(formatarNoFuso(new Date("2019-01-16T01:59:59.999Z"), FUSO_MARCA)).toBe("2019-01-15T23:59:59.999-02:00");
  });
});
