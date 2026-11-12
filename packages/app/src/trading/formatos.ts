// The trading panel's Intl formatter set: one per interface locale, built once and cached.
// Money keeps the USD narrow `$` (the engine's unit — the same rendering the TUI's trading
// panel shows), stamps follow the locale. Components read `useFormatos()` once and replay
// the closures in their rows without touching Intl again. The module holds no engine or SDK
// imports, so the light nav files may read it beside the route.
import { useLanguage } from "@/runtime/i18n/language"

interface ConjuntoFormateo {
  usd: Intl.NumberFormat
  reloj: Intl.DateTimeFormat
  díaHora: Intl.DateTimeFormat
  completo: Intl.DateTimeFormat
}

const CONJUNTOS = new Map<string, ConjuntoFormateo>()

function conjuntoDe(locale: string) {
  let conjunto = CONJUNTOS.get(locale)

  if (conjunto === undefined) {
    conjunto = {
      usd: new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }),
      reloj: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
      díaHora: new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }),
      completo: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }),
    }
    CONJUNTOS.set(locale, conjunto)
  }

  return conjunto
}

export function useFormatos() {
  const language = useLanguage()
  const conjunto = conjuntoDe(language.intl())

  return {
    formatoUSD: (número: number | null) => (número === null || !Number.isFinite(número) ? "—" : conjunto.usd.format(número)),
    /** A position's price: a currency pair (EURUSD, USD.JPY) is a rate, quoted bare with the
     * pips it moves in; everything else is a dollar price. */
    formatoPrecio: (símbolo: string, precio: number | null) => {
      if (precio === null || !Number.isFinite(precio)) return "—"

      const par = /^([A-Z]{3})\.?([A-Z]{3})$/.exec(símbolo)

      if (par === null) return conjunto.usd.format(precio)

      return precio.toLocaleString(conjunto.usd.resolvedOptions().locale, { minimumFractionDigits: decimalesPar(par[1]!, par[2]!), maximumFractionDigits: decimalesPar(par[1]!, par[2]!) })
    },
    formatoHora: (ts: number) => (!Number.isFinite(ts) ? "—" : conjunto.reloj.format(ts)),
    /** Record rows: today's entries read as plain clock time, older ones name their day — the
     * ring keeps several days of history, so a bare clock time would make yesterday read as
     * today. */
    formatoMomento: (ts: number) => {
      if (!Number.isFinite(ts)) return "—"

      const momento = new Date(ts)

      return esHoy(momento) ? conjunto.reloj.format(momento) : conjunto.díaHora.format(momento)
    },
    títuloMomento: (ts: number) => (Number.isFinite(ts) ? conjunto.completo.format(new Date(ts)) : undefined),
  }
}

/** The decimals a pair is quoted in: yen pairs and silver to 3, gold to 2, the rest to 5. */
function decimalesPar(base: string, cotizada: string) {
  if (base === "XAU") return 2
  if (base === "XAG" || cotizada === "JPY") return 3
  return 5
}

function esHoy(momento: Date) {
  const ahora = new Date()

  return ahora.getFullYear() === momento.getFullYear() && ahora.getMonth() === momento.getMonth() && ahora.getDate() === momento.getDate()
}
