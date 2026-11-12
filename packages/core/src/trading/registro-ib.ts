import { IBApiNext, LogLevel } from "@stoqey/ib"

/** TWS's notice that the client id is already taken by another API program: TWS accepts the
 * socket, sends this and drops the connection half a second later. */
export const CLIENTE_OCUPADO = 326

type Opciones = NonNullable<ConstructorParameters<typeof IBApiNext>[0]>

const OCUPADO = new RegExp(`Code: ${CLIENTE_OCUPADO}\\b`)

/** An IBApiNext that reports a taken client id. The library passes TWS's notices that name no
 * request (id -1) only to its logger, never to `errorSubject`, and only at log level INFO; the
 * 326 is one of them. Without this, a taken client id reads as a socket that connects and drops
 * for no reason. The logger stays as quiet as the library's default one (which prints nothing
 * at its default level) and only passes that notice on. */
export const conexionIb = (opciones: Omit<Opciones, "logger">, alOcupado: () => void) => {
  const ib = new IBApiNext({
    ...opciones,
    logger: {
      debug: () => {},
      info: (_tag, ...args) => {
        if (args.some((arg) => OCUPADO.test(String(arg)))) alOcupado()
      },
      warn: () => {},
      error: () => {},
    },
  })
  ib.logLevel = LogLevel.INFO
  return ib
}
