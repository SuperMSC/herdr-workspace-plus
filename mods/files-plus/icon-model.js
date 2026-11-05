// Original bundled pictograms, shared by Files, Search and Changes.
const groups = {
  python: ["py", "pyi", "pyw", "ipynb"], javascript: ["js", "jsx", "mjs", "cjs"], typescript: ["ts", "tsx", "mts", "cts"],
  json: ["json", "jsonc", "jsonl"], markdown: ["md", "mdx", "rst"], shell: ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"],
  database: ["sql", "db", "sqlite", "sqlite3"], image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif", "heic"],
  table: ["csv", "tsv", "xlsx", "xls", "parquet"], config: ["yaml", "yml", "toml", "ini", "conf", "cfg", "env", "properties"],
  web: ["html", "htm", "css", "scss", "sass", "vue", "svelte"], archive: ["zip", "gz", "tgz", "7z", "tar", "rar", "bz2", "xz"],
  code: ["rs", "go", "java", "c", "h", "cpp", "hpp", "cs", "swift", "kt", "rb", "php"], document: ["pdf", "doc", "docx", "rtf", "txt"],
};
export function iconName(path, directory = false) {
  const name = String(path).split("/").pop().toLowerCase();
  if (directory) {
    if ([".git", ".github", ".gitlab"].includes(name)) return "folder-git";
    if (["test", "tests", "__tests__", "spec", "specs"].includes(name)) return "folder-test";
    if ([".config", "config", "configs", "settings", ".vscode", ".idea"].includes(name)) return "folder-config";
    if (["src", "source", "lib"].includes(name)) return "folder-code";
    if (["doc", "docs", "documentation"].includes(name)) return "folder-docs";
    return "folder";
  }
  if (/^(dockerfile|makefile|justfile|\.env(?:\.|$)|\.gitignore$|\.gitattributes$|\.editorconfig$)/.test(name)) return "config";
  if (/^(license|readme|changelog)(\.|$)/.test(name)) return "markdown";
  const ext = name.split(".").pop();
  return Object.keys(groups).find(group => groups[group].includes(ext)) || "file";
}
