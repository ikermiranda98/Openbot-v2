import { Component } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { VoiceDictationSetting } from "@/settings/general/voice-dictation"
import "@/settings/settings.css"

/** Voice dictation's own page: the section that used to sit at the end of Preferences. */
export const SettingsDictation: Component = () => {
  const language = useLanguage()

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.dictation")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.dictation.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body settings-tab-body--sectioned">
        <VoiceDictationSetting />
      </div>
    </>
  )
}
