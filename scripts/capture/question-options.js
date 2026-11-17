// Freeze relative labels and show the second card in the desktop panel on both sides of the comparison.
Date.now = () => Date.parse("2026-11-17T14:00:00Z");
const showCard = setInterval(() => {
  if (innerWidth < 1024) { clearInterval(showCard); return; }
  const panel = [...document.querySelectorAll("aside")].at(-1);
  const text = [...(panel?.querySelectorAll("p") ?? [])].find(p => p.textContent === "Do you accept the screen design?");
  if (!text) return;
  text.scrollIntoView({ block: "start" });
  clearInterval(showCard);
}, 100);
