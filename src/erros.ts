export type StatusErro = 400 | 404 | 409 | 422;

export class ErroApi extends Error {
  constructor(
    readonly status: StatusErro,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
