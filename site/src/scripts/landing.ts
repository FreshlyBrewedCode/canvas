/*
 * The landing page's three behaviours: parallax for `[data-depth]`, in-view
 * triggers for `[data-beat]` sections (the typed prompt draft among them), and
 * the copy buttons on the command. Nothing here moves under reduced motion,
 * except the copy button's icon, which is an answer to a press.
 */

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- parallax --------------------------------------------------------------

// Each layer drifts against the scroll by its depth: positive is slower than
// the page (further away), negative faster. Offsets are measured from the
// viewport's centre, so a layer sits where it was placed when centred.
function parallax() {
  const layers = [...document.querySelectorAll<HTMLElement>("[data-depth]")].map((el) => ({
    el,
    depth: Number(el.dataset.depth),
    y: 0,
  }));
  if (layers.length === 0) return;

  let ticking = false;
  const update = () => {
    ticking = false;
    const mid = innerHeight / 2;
    for (const layer of layers) {
      const rect = layer.el.getBoundingClientRect();
      const centre = rect.top + rect.height / 2 - layer.y;
      layer.y = Math.round((centre - mid) * layer.depth * -1);
      layer.el.style.setProperty("--py", `${layer.y}px`);
    }
  };
  const schedule = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  update();
}

// ---- beats -----------------------------------------------------------------

async function type(el: HTMLElement, text: string): Promise<void> {
  el.textContent = "";
  el.classList.remove("done");
  for (const char of text) {
    el.textContent += char;
    await new Promise((r) => setTimeout(r, char === " " ? 60 : 28 + Math.random() * 30));
  }
  el.classList.add("done");
}

function beats() {
  const typed = [...document.querySelectorAll<HTMLElement>(".typed")];
  const texts = new Map(typed.map((el) => [el, el.textContent ?? ""]));
  if (!reduced) for (const el of typed) el.textContent = "";

  let typedOnce = false;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        if (!reduced && !typedOnce && entry.target.querySelector(".typed")) {
          typedOnce = true;
          (async () => {
            for (const el of typed) await type(el, texts.get(el)!);
          })();
        }
      }
    },
    { threshold: 0.35 },
  );
  for (const beat of document.querySelectorAll("[data-beat]")) observer.observe(beat);
}

// ---- copy ------------------------------------------------------------------

function copy() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copy!);
      button.dataset.copied = "";
      setTimeout(() => delete button.dataset.copied, 1600);
    });
  }
}

if (!reduced) parallax();
beats();
copy();
