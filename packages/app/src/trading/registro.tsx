// The record panel's own language: the merged record rows (log ring + trade record) with
// their lifecycle beats and filter chips plus the CSV window export. The module stays light
// (no SDK, no engine imports) so the route's ficha and the titlebar's sidebar log panel both
// read it; row data arrives typed by the nav-estado bridge the route writes.
import { createSignal, For, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Badge } from "@opencode/ui/badge"
import { useLanguage } from "@/runtime/i18n/language"
import { useFormatos } from "./formatos"
import type { FilaRegistroNav } from "./nav-estado"
import type { Trading } from "@opencode/schema/trading"

/** Signed day-P/L tone and arrow, the same rule every row that shows one uses. */
function tonoPnl(valor: number | null) {
  if (valor === null) return "text-v2-text-text-muted"

  return valor >= 0 ? "text-v2-state-fg-success" : "text-v2-state-fg-danger"
}

/** The state a record row's tag speaks in: green when the bot went in, blue for the first
 * signal, neutral when it came out (the close's own P/L carries the verdict's colour beside
 * it), amber and red for the loud levels — so a close never reads as a warning. */
type TonoEtiqueta = "success" | "info" | "warning" | "danger" | null

const TONO_EVENTO: Record<Exclude<FilaRegistroNav["evento"], null>, TonoEtiqueta> = {
  apertura: "success",
  cierre: null,
  senal: "info",
}

const TONO_NIVEL: Record<Exclude<FilaRegistroNav["nivel"], "info">, TonoEtiqueta> = {
  aviso: "warning",
  error: "danger",
}

/** A record row's message, rendered from the row's engine i18n key when it carries one
 * (`trading.log.*`, the sample rows' `trading.demo.*`); keys ahead of the app's dictionaries
 * (a newer engine's rows, bot rows without a key) fall back to the raw English message. */
export function textoRegistro(entrada: FilaRegistroNav, language: ReturnType<typeof useLanguage>): string {
  if (entrada.clave_mensaje === null) return entrada.mensaje
  const texto = language.t(entrada.clave_mensaje, entrada.params_mensaje ?? undefined) ?? entrada.mensaje
  return entrada.clave_mensaje === "trading.panic.summary" && entrada.params_mensaje
    ? texto + textoSobrante(entrada.params_mensaje, language)
    : texto
}

/** The panic summary's still-open positions render here, not in the engine's template: the
 * engine's params carry the symbols, and the app words the line in its own language (the
 * engine's raw English message stays the fallback). The line's appearance hangs on the count,
 * but its wording does not: the snapshot's rows carry no account of their own, so the
 * accounts the symbols sit in stay uncounted. */
function textoSobrante(params: Record<string, string | number | boolean>, language: ReturnType<typeof useLanguage>): string {
  const simbolos = typeof params.leftover_symbols === "string" ? params.leftover_symbols : ""
  const cuenta = typeof params.leftover_count === "number" ? params.leftover_count : 0

  if (cuenta <= 0) return ""

  return ` ${language.t("trading.engine.panic.summary.unclosed", { symbols: simbolos }) ?? ""}`
}

/** A close or panic toast's verdict, rendered from the result's engine i18n key when it carries
 * one (`trading.close.*`, `trading.panic.*`); keys ahead of the app's dictionaries (an older
 * engine's verdicts) fall back to the raw English message, the same rule every record row uses. */
export function textoVeredicto(resultado: Trading.PositionCloseResult | Trading.PanicResult, language: ReturnType<typeof useLanguage>): string {
  if (resultado.message_key === undefined) return resultado.message

  // SAFETY: the engine's verdict params only interpolate into `message_key`, so their values are plain strings, numbers or booleans — never nested structures.
  const texto =
    language.t(resultado.message_key, resultado.message_params as Record<string, string | number | boolean>) ??
    resultado.message

  return resultado.message_key === "trading.panic.summary"
    ? texto + textoSobrante(resultado.message_params as Record<string, string | number | boolean>, language)
    : texto
}

/** A record row's class tag, drawn as the app's own Badge (its size, weight and box) in the
 * row's state colours: the lifecycle beat when the row carries one, else its loud level
 * (warning, error); a plain info line carries none. The sidebar's panel and the dossier's
 * list read the same tag. */
export function EtiquetaRegistro(props: { entrada: FilaRegistroNav }) {
  const language = useLanguage()

  const etiqueta = () => {
    const evento = props.entrada.evento

    if (evento !== null) return { tono: TONO_EVENTO[evento], texto: language.t(CLAVE_EVENTO[evento]) }

    const nivel = props.entrada.nivel

    if (nivel === "info") return undefined

    return { tono: TONO_NIVEL[nivel], texto: language.t(CLAVE_NIVEL[nivel]) }
  }

  return (
    <Show when={etiqueta()}>
      {(valor) => (
        <Badge
          // The level words are stored lowercase ("warning"); the tag reads them in sentence case.
          class="shrink-0 capitalize"
          style={
            valor().tono === null
              ? undefined
              : {
                  color: `var(--v2-state-fg-${valor().tono})`,
                  background: `var(--v2-state-bg-${valor().tono})`,
                  "border-color": `var(--v2-state-border-${valor().tono})`,
                }
          }
        >
          {valor().texto}
        </Badge>
      )}
    </Show>
  )
}

const CLAVE_EVENTO: Record<Exclude<FilaRegistroNav["evento"], null>, string> = {
  apertura: "trading.log.event.open",
  cierre: "trading.log.event.close",
  senal: "trading.log.event.signal",
}

// Mapping table for the engine's internal level tokens: copy language always comes from
// the i18n keys, never from the stored Spanish words.
export const CLAVE_NIVEL: Record<FilaRegistroNav["nivel"], string> = {
  info: "trading.log.level.info",
  aviso: "trading.log.level.warning",
  error: "trading.log.level.error",
}

/** Downloads the picked window's entries as a CSV file, with the BOM so Excel opens the
 * accented messages right and CR/LF rows Excel's reader expects. Both the header row and
 * the level tokens arrive translated (the engine's stored tokens are Spanish and never
 * leak to the user). The anchor-click pattern works in both the renderer and the web; the
 * object URL outlives the click so the download never races its own revocation. */
function descargarRegistro(entradas: FilaRegistroNav[], archivo: { etiqueta: string; cabeceras: string; nivel: (valor: FilaRegistroNav["nivel"]) => string }) {
  const celda = (valor: string) => `"${valor.replaceAll('"', '""').replaceAll("\n", " ")}"`

  const filas = [
    archivo.cabeceras,
    ...entradas.map((entrada) =>
      [
        // A non-finite timestamp (the engine's no-value) would throw a RangeError on
        // toISOString; it leaves the cell empty instead of aborting the whole export.
        Number.isFinite(entrada.ts) ? new Date(entrada.ts).toISOString() : "",
        archivo.nivel(entrada.nivel),
        entrada.bot,
        entrada.evento ?? "",
        entrada.mensaje,
        entrada.pnl === null ? "" : entrada.pnl.toFixed(2),
      ]
        .map(celda)
        .join(","),
    ),
  ].join("\r\n")

  const href = URL.createObjectURL(new Blob(["\ufeff", filas], { type: "text/csv;charset=utf-8" }))
  const enlace = document.createElement("a")
  enlace.href = href
  enlace.download = `trading-record-${archivo.etiqueta}.csv`
  enlace.click()
  setTimeout(() => URL.revokeObjectURL(href), 10_000)
}

/** The record panel's download button with its three time windows (today, this week, this
 * month — all local calendar boundaries). A fixed transparent layer closes the tiny menu
 * on any outside click, the same trade-off every popover makes without a ports layer. */
export function MenuDescarga(props: { entradas: () => FilaRegistroNav[] }) {
  const language = useLanguage()
  const [abierto, fijarAbierto] = createSignal(false)
  let menú: HTMLMenuElement | undefined

  const bajar = (desde: number, etiqueta: string) => {
    fijarAbierto(false)
    descargarRegistro(props.entradas().filter((entrada) => entrada.ts >= desde), {
      etiqueta,
      cabeceras: language.t("trading.log.csv.headers"),
      nivel: (valor) => language.t(CLAVE_NIVEL[valor]),
    })
  }

  // Evaluated when the user picks: today's midnight, this Monday and this month's 1st.
  const pedir = () => {
    const hoy = new Date()
    hoy.setHours(0, 0, 0, 0)
    // The filename stamp is the machine's local calendar day (an ISO slice was UTC and
    // named the windows a day off through the western hours of the local day).
    const día = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`
    const semana = new Date(hoy)
    semana.setDate(hoy.getDate() - ((hoy.getDay() + 6) % 7))
    const mes = new Date(hoy)
    mes.setDate(1)

    return [
      { clave: "today" as const, desde: hoy.getTime(), etiqueta: día },
      { clave: "week" as const, desde: semana.getTime(), etiqueta: `${día}-week` },
      { clave: "month" as const, desde: mes.getTime(), etiqueta: `${día}-month` },
    ]
  }

  return (
    <div class="relative">
      <IconButton
        type="button"
        variant="ghost-muted"
        size="small"
        class="shrink-0"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => fijarAbierto(!abierto())}
        aria-label={language.t("trading.log.download.title")}
        aria-expanded={abierto()}
        icon={<Icon name="download" />}
      />
      <Show when={abierto()}>
        <div class="fixed inset-0 z-40" onClick={() => fijarAbierto(false)} aria-hidden="true" />
        <menu
          role="menu"
          ref={(elemento) => {
            menú = elemento
            // A ref runs before the children render and before the menu is in the
            // document, so the first item gets the focus one microtask later, once
            // the For items exist. The overlay keeps real focus away from the page.
            queueMicrotask(() => elemento.querySelector<HTMLButtonElement>("button")?.focus())
          }}
          class="absolute end-0 top-full z-50 mt-1 flex w-max flex-col whitespace-nowrap rounded-[8px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-1"
          onKeyDown={(evento) => {
            if (evento.key === "Escape") {
              evento.preventDefault()
              fijarAbierto(false)
              // The focused item unmounts with the menu, so send the focus back to
              // the trigger button (the first button in this wrapper) instead of
              // letting it fall to the body.
              evento.currentTarget.parentElement?.querySelector<HTMLButtonElement>("button")?.focus()

              return
            }

            // Roving focus stays on the real buttons (they remain tabbable, so
            // nothing here can strand the focus): arrows cycle, Home and End jump
            // to the ends — the native <select> menu contract.
            const botones = [...(menú?.querySelectorAll<HTMLButtonElement>("button") ?? [])]

            if (botones.length === 0) return
            const actual = botones.findIndex((botón) => botón === document.activeElement)

            if (evento.key === "ArrowDown") {
              evento.preventDefault()
              botones[(actual + 1) % botones.length]?.focus()

              return
            }

            if (evento.key === "ArrowUp") {
              evento.preventDefault()
              botones[(actual - 1 + botones.length) % botones.length]?.focus()

              return
            }

            if (evento.key === "Home") {
              evento.preventDefault()
              botones[0]?.focus()

              return
            }

            if (evento.key === "End") {
              evento.preventDefault()
              botones[botones.length - 1]?.focus()
            }
          }}
        >
          <For each={pedir()}>
            {(opción) => (
              <button
                type="button"
                role="menuitem"
                class="rounded-[6px] px-2 py-1 text-start text-[13px] text-v2-text-text-base hover:bg-v2-background-bg-layer-02"
                style={{ "line-height": "var(--line-height-compact)" }}
                onClick={() => bajar(opción.desde, opción.etiqueta)}
              >
                {language.t(`trading.log.download.${opción.clave}`)}
              </button>
            )}
          </For>
        </menu>
      </Show>
    </div>
  )
}

/** One record row class the filter can show alone: the lifecycle beats (open, close,
 * first signal) and the loud levels (warning, error). "todos" shows the whole record. */
type FiltroRegistro = "todos" | "apertura" | "cierre" | "senal" | "aviso" | "error"

const CLASE_FILTRO: Array<Exclude<FiltroRegistro, "todos">> = ["apertura", "cierre", "senal", "aviso", "error"]

// The filter value doubles as the match key: the first three are event beats, the last two
// are log levels, so one comparison pair classifies every row.
function enFiltro(entrada: FilaRegistroNav, filtro: Exclude<FiltroRegistro, "todos">) {
  return entrada.evento === filtro || entrada.nivel === filtro
}

/**
 * The record panel's one list, shared with each system's dossier: a fixed system column makes the
 * beginner of every entry readable at a glance, the lifecycle beats (an event chip, a warning
 * or an error) always show, and every other line hides behind "Show the rest". The filter chips
 * list only the classes with rows; a chosen class shows all of its rows (no hiding), and the
 * order never changes.
 */
export function ListaRegistro(props: { registros: FilaRegistroNav[] }) {
  const { formatoUSD, formatoMomento, títuloMomento } = useFormatos()
  const language = useLanguage()
  const [extendido, fijarExtendido] = createSignal(false)
  const [filtro, fijarFiltro] = createSignal<FiltroRegistro>("todos")

  const conCoincidencia = () => CLASE_FILTRO.filter((clase) => props.registros.some((entrada) => enFiltro(entrada, clase)))

  // The bar shows every class with rows, plus the chosen one even when its rows have gone
  // (a poll can empty it): a stuck chip with no escape would strand the reader — the bar
  // stays until they pick All (hence the All chip) or another class.
  const clases = () => {
    const elegido = filtro()

    if (elegido === "todos") return conCoincidencia()

    return [elegido, ...conCoincidencia().filter((clase) => clase !== elegido)]
  }

  const principales = () => props.registros.filter((entrada) => entrada.evento !== null || entrada.nivel !== "info")
  const resto = () => props.registros.filter((entrada) => entrada.evento === null && entrada.nivel === "info")

  const visibles = () => {
    const elegido = filtro()

    if (elegido === "todos") return extendido() ? props.registros : principales()

    return props.registros.filter((entrada) => enFiltro(entrada, elegido))
  }

  return (
    <>
      <Show when={clases().length > 0}>
        <div class="mb-1.5 flex flex-wrap gap-1">
          <button
            type="button"
            class={`h-6 shrink-0 rounded-full border px-2 text-[11px] leading-[20px] text-v2-text-text-base ${
              filtro() === "todos"
                ? "border-v2-border-border-muted bg-v2-background-bg-layer-02"
                : "border-transparent hover:text-v2-text-text-base text-v2-text-text-muted"
            }`}
            onClick={() => fijarFiltro("todos")}
            aria-pressed={filtro() === "todos"}
          >
            {language.t("trading.log.filter.all")}
          </button>
          <For each={clases()}>
            {(clase) => (
              <button
                type="button"
                class={`h-6 shrink-0 rounded-full border px-2 text-[11px] leading-[20px] text-v2-text-text-base ${
                  filtro() === clase
                    ? "border-v2-border-border-muted bg-v2-background-bg-layer-02"
                    : "border-transparent hover:text-v2-text-text-base text-v2-text-text-muted"
                }`}
                onClick={() => fijarFiltro(clase)}
                aria-pressed={filtro() === clase}
              >
                {language.t(`trading.log.filter.${clase}`)}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="flex flex-col">
        <Show
          when={visibles().length > 0}
          fallback={
            filtro() === "todos" ? null : (
              <p class="px-1 text-[13px] text-v2-text-text-muted" style={{ "line-height": "var(--line-height-compact)" }}>
                {language.t("trading.log.filter.empty")}
              </p>
            )
          }
        >
          <For each={visibles()}>
            {(entrada) => (
              <div class="flex min-h-6 items-center gap-2">
        <time class="w-[70px] shrink-0 text-[11px] text-v2-text-text-muted tabular-nums" style={{ "line-height": "var(--line-height-compact)" }} title={títuloMomento(entrada.ts)}>
                  {formatoMomento(entrada.ts)}
                </time>
                <span class="flex w-[72px] shrink-0 justify-start">
                  <EtiquetaRegistro entrada={entrada} />
                </span>
                <span class="w-48 shrink-0 truncate font-mono text-[12px] text-v2-text-text-base" title={entrada.bot}>
                  {entrada.bot}
                </span>
                <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-muted" style={{ "line-height": "var(--line-height-compact)" }}>
                  {textoRegistro(entrada, language)}
                </span>
                <Show when={entrada.evento === "cierre"}>
                  <span class={`w-[64px] shrink-0 text-end text-[13px] tabular-nums ${tonoPnl(entrada.pnl)}`}>{formatoUSD(entrada.pnl)}</span>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
      <Show when={filtro() === "todos" && resto().length > 0}>
        <button
          type="button"
          class="mt-1 px-1 text-[11px] text-v2-text-text-muted hover:text-v2-text-text-base"
          style={{ "line-height": "var(--line-height-compact)" }}
          onClick={() => fijarExtendido(!extendido())}
        >
          {extendido() ? language.t("trading.log.less") : language.plural("trading.log.more", resto().length)}
        </button>
      </Show>
    </>
  )
}
