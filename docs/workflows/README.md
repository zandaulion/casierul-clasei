# Planșele vizuale ale fluxurilor

Acest director păstrează reprezentările SVG statice ale tuturor celor 16 fluxuri documentate și disponibile în Ajutorul aplicației:

1. [Pornire și organizare](01-pornire-si-organizare.svg) — activare, configurarea clasei, copii și cheltuieli.
2. [Bani și corecții](02-bani-si-corectii.svg) — încasare, plată directă către beneficiar, **Nu mai colectez**, avansul copilului, registru și corecții.
3. [Documente și comunicare](03-documente-si-comunicare.svg) — documente justificative, WhatsApp și rapoarte.
4. [Acces, siguranță și date](04-acces-siguranta-si-date.svg) — clase și roluri, conexiune/PWA, export și backup.

Fișierele sunt vectoriale, au titlu și descriere accesibilă și pot fi deschise direct într-un browser, incluse în documente sau imprimate. Sursele Mermaid cu descrierea detaliată rămân în [ghidul vizual](../visual-flow-guide.md).

Regenerare din rădăcina repository-ului:

```sh
node scripts/render-workflow-svg.mjs
```

Generatorul folosește numai Node.js și scrie determinist cele patru fișiere SVG din acest director.
