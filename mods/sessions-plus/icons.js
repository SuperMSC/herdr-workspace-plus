import { div, image } from "gpui-kit";

// Use Herdr's own assets so its agent icons stay consistent after app updates.
export function providerIcon(provider, size = 18) {
  const name = { claude: "claude", codex: "codex", agy: "antigravity" }[provider];
  if (!name) return div().w(size).h(size).text_center().child("●");
  return image(`icons/${name}.svg`).w(size).h(size).flex_none();
}
