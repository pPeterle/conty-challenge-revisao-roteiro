export type StatusErro = 400 | 404 | 409 | 413 | 422;

export interface DetalheErro {
  campo: string;
  motivo: string;
}

export class ErroApi extends Error {
  constructor(
    readonly status: StatusErro,
    readonly code: string,
    message: string,
    readonly details?: DetalheErro[],
  ) {
    super(message);
  }
}
