import { div, image } from "gpui-kit";

export function providerIcon(provider, size = 18) {
  const name = { claude: "claude", codex: "codex", agy: "antigravity" }[provider];
  return name ? image(`mods/sessions-plus/icons/${name}.svg`).w(size).h(size).flex_none() : div().w(size).h(size).text_center().child("●");
}
