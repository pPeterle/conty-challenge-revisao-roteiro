export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Relógio dos testes: só anda quando alguém manda. */
export class ControlledClock implements Clock {
  private atual: number;

  constructor(inicio: Date | string) {
    this.atual = new Date(inicio).getTime();
  }

  now(): Date {
    return new Date(this.atual);
  }

  set(instante: Date | string): void {
    this.atual = new Date(instante).getTime();
  }

  advance(ms: number): void {
    this.atual += ms;
  }
}
