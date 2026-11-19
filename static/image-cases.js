import { node } from "./render.js";

export function createImageGallery(onSelect) {
  const section = document.getElementById("image-cases");
  const metadata = document.getElementById("image-cases-meta");
  const toggle = document.getElementById("toggle-image-cases");
  const options = document.getElementById("image-case-options");
  const groups = document.getElementById("image-case-groups");
  const grid = document.getElementById("image-case-grid");
  let catalog;
  let loading = false;
  let currentGroup = 0;

  function setExpanded(expanded) {
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "收合案例" : "展開案例";
    options.hidden = !expanded;
  }

  function showGroup(index) {
    currentGroup = index;
    [...groups.children].forEach((button, group) => button.setAttribute("aria-pressed", String(group === currentGroup)));
    grid.replaceChildren(...catalog.groups[index].cases.map((example) => {
      const button = node("button", "image-case");
      const image = node("img");
      image.src = "/static/image-cases/" + example.id + ".webp";
      image.alt = "";
      image.loading = "lazy";
      image.width = 54;
      image.height = 54;
      button.type = "button";
      button.append(image, node("span", "", example.title));
      button.addEventListener("click", () => onSelect(example, catalog));
      return button;
    }));
  }

  async function load() {
    loading = true;
    metadata.textContent = "載入案例中…";
    try {
      const response = await fetch("/static/image-cases.json");
      if (!response.ok) throw new Error("Unable to load image cases");
      const data = await response.json();
      if (!data.groups?.length) throw new Error("Empty image case catalog");
      catalog = data;
      const count = catalog.groups.reduce((total, group) => total + group.cases.length, 0);
      metadata.textContent = catalog.model + " 實測 · " + count + " 組 · " + catalog.size.replace("x", " × ");
      groups.replaceChildren(...catalog.groups.map((group, index) => {
        const button = node("button", "image-case-group", group.title);
        button.type = "button";
        button.addEventListener("click", () => showGroup(index));
        return button;
      }));
      showGroup(currentGroup);
    } catch {
      metadata.textContent = "案例載入失敗，重新開啟可再試一次。";
    } finally {
      loading = false;
    }
  }

  toggle.addEventListener("click", () => {
    setExpanded(options.hidden);
    if (!options.hidden && !catalog && !loading) void load();
  });

  return (visible, busy) => {
    const opened = visible && section.hidden;
    section.hidden = !visible;
    options.inert = busy;
    toggle.disabled = busy;
    if (busy && visible) setExpanded(false);
    if (opened) {
      setExpanded(true);
      if (!catalog && !loading) void load();
    }
  };
}
