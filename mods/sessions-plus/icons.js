import { div, image, svg } from "gpui-kit";
import { theme } from "herdr";

// Brand marks: LobeHub lobe-icons static-svg/icons/{claude-color,openai}.svg (MIT).
// Keep the bundled LICENSE; OpenAI is tinted by the active theme, agy stays multicolor.
export function providerIcon(provider, size = 18) {
  const name = { claude: "claude", codex: "codex", agy: "antigravity" }[provider];
  if (!name) return div().w(size).h(size).text_center().child("●");
  const path = `mods/sessions-plus/icons/${name}.svg`;
  const icon = provider === "codex" ? svg(path).text_color(theme().foreground) : image(path);
  return icon.w(size).h(size).flex_none();
}
