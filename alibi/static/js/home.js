const dossier = document.getElementById("dossier");
const stage = document.getElementById("stage");
if (dossier && matchMedia("(hover: hover) and (pointer: fine)").matches) {
  stage.addEventListener("pointermove", (event) => {
    const rect = stage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    dossier.style.transform = `rotateY(${x * 26}deg) rotateX(${-y * 18}deg)`;
  });
  stage.addEventListener("pointerleave", () => {
    dossier.style.transform = "rotateY(-12deg) rotateX(8deg)";
  });
}

document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((item) => {
      item.classList.toggle("is-on", item === tab);
      item.setAttribute("aria-selected", item === tab ? "true" : "false");
    });
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
      panel.classList.toggle("is-on", panel.dataset.panel === tab.dataset.tab);
    });
  });
});

const pin = document.querySelector(".pin");
const track = document.getElementById("pin-track");
const visuals = document.querySelectorAll("[data-parallax]");
if (pin && track && matchMedia("(min-width: 981px)").matches) {
  const onScroll = () => {
    const rect = pin.getBoundingClientRect();
    const total = pin.offsetHeight - window.innerHeight;
    const progress = Math.min(1, Math.max(0, -rect.top / total));
    const max = track.scrollWidth - window.innerWidth + 80;
    track.style.transform = `translate3d(${-progress * max}px,0,0)`;
    visuals.forEach((node) => {
      const parent = node.closest("article");
      if (!parent || parent.hidden) return;
      const box = parent.getBoundingClientRect();
      const shift = (box.top - window.innerHeight * 0.4) * Number(node.dataset.parallax);
      node.style.setProperty("--shift", shift * -0.15 + "px");
    });
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
}
