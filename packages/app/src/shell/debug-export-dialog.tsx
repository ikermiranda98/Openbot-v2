import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Checkbox } from "@opencode/ui/checkbox"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"

export type DebugExportDialogProps = {
  /** The checkbox's answer once the user confirms; the export itself runs outside the dialog. */
  onConfirm: (includeCrashDumps: boolean) => void
}

/**
 * The Export logs confirmation, shared by the command palette and the crash page: it says where the archive
 * lands and what the crash dump flag adds. Mounted through a dialog stack; nothing is exported until the
 * confirm button closes this dialog with the checkbox's answer, so Cancel leaves the answer unread.
 */
export function DebugExportDialog(props: DebugExportDialogProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const [answer, setAnswer] = createStore({ includeCrashDumps: false })

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title={language.t("debug.export.title")} description={language.t("debug.export.confirm")} />
      </DialogHeader>
      <DialogBody class="px-4">
        <Checkbox
          checked={answer.includeCrashDumps}
          onChange={(checked: boolean) => setAnswer("includeCrashDumps", checked)}
        >
          {language.t("debug.export.includeCrashDumps")}
        </Checkbox>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" autofocus onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button
          onClick={() => {
            const includeCrashDumps = answer.includeCrashDumps
            dialog.close()
            props.onConfirm(includeCrashDumps)
          }}
        >
          {language.t("debug.export.button")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
