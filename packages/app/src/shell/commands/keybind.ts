// Pure keybind matching, extracted from the command registry screen so light surfaces (a desk
// panel hosting dictation) can compare shortcuts without pulling the command graph.
export const IS_MAC = typeof navigator !== "undefined" && /(Mac|iPod|iPhone|iPad)/.test(navigator.platform)

function normalizeKey(key: string) {
  if (key === ",") return "comma"

  if (key === "+") return "plus"

  if (key === " ") return "space"

  return key.toLowerCase()
}

export function keyFromKeyboardEvent(event: KeyboardEvent) {
  const key = normalizeKey(physicalKey(event))

  if (!event.altKey || /^[a-z0-9]$/.test(key)) return key

  if (!event.code.startsWith("Key") || event.code.length !== 4) return key

  return event.code.slice(3).toLowerCase()
}

// ⇧[ types { and ⌥. types ≥ on US layouts. Keep ASCII layout mappings; non-ASCII falls back to the physical key.
function physicalKey(event: Pick<KeyboardEvent, "key" | "code">) {
  if (event.key === "{" || event.key === "}") return event.key === "{" ? "[" : "]"

  if (!/^[^\x00-\x7f]$/u.test(event.key)) return event.key

  if (event.code === "BracketLeft") return "["

  if (event.code === "BracketRight") return "]"

  if (event.code === "Period") return "."

  return event.key
}

export interface Keybind {
  key: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  alt: boolean
}

export function parseKeybind(config: string): Keybind[] {
  if (!config || config === "none") return []

  return config.split(",").map((combo) => {
    const parts = combo.trim().toLowerCase().split("+")

    const keybind: Keybind = {
      key: "",
      ctrl: false,
      meta: false,
      shift: false,
      alt: false,
    }

    for (const part of parts) {
      switch (part) {
        case "ctrl":
        case "control":
          keybind.ctrl = true
          break
        case "meta":
        case "cmd":
        case "command":
          keybind.meta = true
          break
        case "mod":
          if (IS_MAC) keybind.meta = true
          else keybind.ctrl = true
          break
        case "alt":
        case "option":
          keybind.alt = true
          break
        case "shift":
          keybind.shift = true
          break
        default:
          keybind.key = part
          break
      }
    }

    return keybind
  })
}

export function matchKeybind(keybinds: Keybind[], event: KeyboardEvent): boolean {
  const eventKey = keyFromKeyboardEvent(event)

  for (const kb of keybinds) {
    const keyMatch = kb.key === eventKey
    const ctrlMatch = kb.ctrl === (event.ctrlKey || false)
    const metaMatch = kb.meta === (event.metaKey || false)
    const shiftMatch = kb.shift === (event.shiftKey || false)
    const altMatch = kb.alt === (event.altKey || false)

    if (keyMatch && ctrlMatch && metaMatch && shiftMatch && altMatch) {
      return true
    }
  }

  return false
}
