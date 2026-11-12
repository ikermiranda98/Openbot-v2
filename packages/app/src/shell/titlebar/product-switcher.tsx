// The product switcher: the segmented control at the titlebar's start that swaps the whole
// shell between OpenCode (the session surface) and Trading (the desk) — two labels on a
// track with a thumb that slides under the active one (the way Claude and Claude Code read
// as one active product). It only marks the active product and asks to move; navigation
// stays in the tabs store (toggleHome / toggleTrading), called from the titlebar.
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"

export function ProductSwitcher(props: { trading: boolean; aOpenCode: () => void; aTrading: () => void }) {
  const language = useLanguage()

  // Both half-track widths are equal (each option centers its label), so the thumb pins the
  // active side: zero at OpenCode, full at Trading. `dir` pins the two options left-to-right
  // so the thumb's own transform translates the same way in every text direction.
  const lado = () => (props.trading ? "translateX(100%)" : "translateX(0)")

  return (
    <div
      data-action="product-switcher"
      role="group"
      aria-label={language.t("product.switch")}
      dir="ltr"
      class="relative flex h-7 shrink-0 items-center rounded-[8px] bg-v2-overlay-simple-overlay-hover p-0.5 [app-region:no-drag]"
    >
      <span
        // The thumb sits behind the labels (they paint above it with z-10) and carries the
        // raised elevation, the same chip the status pill drew.
        aria-hidden="true"
        data-thumb
        class="absolute inset-y-0.5 start-0.5 w-[calc(50%-2px)] rounded-[6px] bg-v2-background-bg-layer-01 shadow-[var(--v2-elevation-raised)] transition-transform duration-150 ease-out"
        style={{ transform: lado() }}
      />
      <button
        type="button"
        data-action="product-switcher-openCode"
        aria-pressed={!props.trading}
        aria-label={language.t("product.openCode")}
        title={language.t("product.openCode")}
        class="relative z-10 flex h-6 min-w-0 items-center justify-center rounded-[6px] px-2.5 focus-visible:outline-none aria-pressed:text-v2-text-text-base"
        onClick={props.aOpenCode}
      >
        <Icon name="grid-plus" size="small" class="shrink-0 text-v2-text-text-muted transition-colors duration-150 hover:text-v2-text-text-base" />
      </button>
      <button
        type="button"
        data-action="product-switcher-trading"
        aria-pressed={props.trading}
        aria-label={language.t("trading.title")}
        title={language.t("trading.title")}
        class="relative z-10 flex h-6 min-w-0 items-center justify-center rounded-[6px] px-2.5 focus-visible:outline-none aria-pressed:text-v2-text-text-base"
        onClick={props.aTrading}
      >
        <Icon name="trading-chart" size="small" class="shrink-0 text-v2-text-text-muted transition-colors duration-150 hover:text-v2-text-text-base" />
      </button>
    </div>
  )
}
