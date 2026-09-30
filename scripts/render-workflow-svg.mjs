import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const outputDir = fileURLToPath(new URL('../docs/workflows/', import.meta.url));

const palettes = {
  green: { header: '#dfeee2', accent: '#1f6652', step: '#edf5ef', branch: '#fff4d4' },
  coral: { header: '#f9dfd5', accent: '#9c4b3d', step: '#fff0ea', branch: '#e8f2f8' },
  blue: { header: '#deedf5', accent: '#2f657c', step: '#ebf4f8', branch: '#f3eafa' },
  violet: { header: '#ebe3f4', accent: '#66517b', step: '#f4eff8', branch: '#e8f2e9' },
};

const diagrams = [
  {
    file: '01-pornire-si-organizare.svg',
    eyebrow: 'CASIERUL CLASEI · FLUXURI 1/4',
    title: 'Pornire și organizare',
    subtitle: 'De la invitație la prima cheltuială a clasei',
    palette: 'green',
    workflows: [
      { title: '1. Activarea și accesul', stages: [
        ['Primești invitația'], ['Introduci codul'], ['Activezi dispozitivul'],
        ['Deschizi registrul', 'Folosești a doua activare'], ['Alegi clasa'],
      ] },
      { title: '2. Configurarea clasei', stages: [
        ['Deschizi Setări'], ['Școală · clasă · an'], ['Sold inițial'],
        ['Revolut · beneficiar · IBAN'], ['Sigle și salvare'],
      ] },
      { title: '3. Copiii și contactele', stages: [
        ['Deschizi Copii'], ['Adaugi un copil sau lista'], ['Verifici fișa'],
        ['Salvezi maximum două contacte'], ['Editezi sau arhivezi'],
      ] },
      { title: '4. Cheltuielile', stages: [
        ['Cheltuială nouă'], ['Fix', 'Total împărțit', 'Cantitate × preț'],
        ['Selectezi participanții'], ['Verifici calculul'], ['Salvezi'],
      ] },
    ],
  },
  {
    file: '02-bani-si-corectii.svg',
    eyebrow: 'CASIERUL CLASEI · FLUXURI 2/4',
    title: 'Bani și corecții',
    subtitle: 'Încasări exacte, surse distincte și istoric verificabil',
    palette: 'coral',
    workflows: [
      { title: '5. Încasarea', stages: [
        ['Atingi copilul'], ['Alegi totalul sau contribuția'], ['Introduci suma ori rotunjirea'],
        ['Mai puțin', 'Exact', 'Mai mult'], ['Verifici și înregistrezi'],
      ] },
      { title: '6. Nu mai colectez', stages: [
        ['Deschizi contribuția'], ['Apeși „Nu mai colectez”'],
        ['Excluzi și recalculezi', 'Ajustezi diferența mică', 'Acoperi din avans personal'], ['Verifici efectul'], ['Confirmi'],
      ] },
      { title: '7. Avansul copilului', stages: [
        ['Primești surplus'], ['Păstrezi în avans'],
        ['Stingi contribuții', 'Restitui copilului'], ['Numerarul se mișcă o singură dată'], ['Istoric separat'],
      ] },
      { title: '8. Registrul și avansurile personale', stages: [
        ['Deschizi Registru'], ['Bani dați mai departe', 'Sumă avansată fondului'],
        ['Actualizezi numerarul și datoria'], ['Restitui sau acoperi contribuții'], ['Verifici soldul'],
      ] },
      { title: '9. Corectarea', stages: [
        ['Deschizi operațiunea'], ['Alegi Corectează'], ['Scrii motivul'],
        ['Confirmi inversarea'], ['Înregistrezi varianta corectă'],
      ] },
    ],
  },
  {
    file: '03-documente-si-comunicare.svg',
    eyebrow: 'CASIERUL CLASEI · FLUXURI 3/4',
    title: 'Documente și comunicare',
    subtitle: 'Dovezi, mesaje și rapoarte pregătite pentru părinți',
    palette: 'blue',
    workflows: [
      { title: '10. Documentele justificative', stages: [
        ['Deschizi cheltuiala sau plata'], ['Atașezi PDF ori fotografie'],
        ['Intern', 'Vizibil clasei'], ['Tip și amprentă verificate'], ['Document imuabil'],
      ] },
      { title: '11. WhatsApp și detaliile de plată', stages: [
        ['Configurezi contactele și plata'], ['Copil', 'Grup', 'Date de plată'],
        ['Doar mesajul', 'Copie mesaj + PDF', 'Date separate'], ['Alegi conversația'], ['Verifici și trimiți'],
      ] },
      { title: '12. Rapoartele', stages: [
        ['Deschizi Rapoarte'], ['Clasă', 'Tabel', 'Cheltuială', 'Copil'],
        ['Generezi PDF-ul imuabil'], ['Previzualizezi'], ['Partajezi ori descarci'],
      ] },
    ],
  },
  {
    file: '04-acces-siguranta-si-date.svg',
    eyebrow: 'CASIERUL CLASEI · FLUXURI 4/4',
    title: 'Acces, siguranță și date',
    subtitle: 'Roluri izolate, salvare sigură și recuperarea evidenței',
    palette: 'violet',
    workflows: [
      { title: '13. Mai multe clase și roluri', stages: [
        ['Primești sau creezi permisiunea'], ['Adaugi accesul'], ['Alegi clasa'],
        ['Casier', 'Părinte', 'Auditor'], ['Dispozitiv revocabil separat'],
      ] },
      { title: '14. Conexiunea și actualizarea PWA', stages: [
        ['Interfața se adaptează ecranului'], ['Salvezi online', 'Fără coadă offline'],
        ['Răspuns confirmat', 'Verifică / reîncearcă'], ['Păstrezi formularul activ'], ['Actualizezi aplicația'],
      ] },
      { title: '15. Exportul și backup-ul', stages: [
        ['Export JSON pentru inspecție', 'Backup SQLite zilnic'], ['Date de business', 'Registru · contacte · documente'],
        ['Verifici integritatea'], ['Restaurezi setul complet'], ['Exportul nu înlocuiește backup-ul'],
      ] },
    ],
  },
];

const esc = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

function wrap(text, limit = 23) {
  const words = String(text).split(/\s+/u);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > limit && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function textBlock(text, x, y, { anchor = 'middle', size = 21, weight = 600, fill = '#29443c', limit = 23, lineHeight = 25 } = {}) {
  const lines = wrap(text, limit);
  const firstY = y - ((lines.length - 1) * lineHeight / 2);
  return `<text x="${x}" y="${firstY}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${esc(line)}</tspan>`).join('')}</text>`;
}

function render(diagram) {
  const width = 1600;
  const headerHeight = 210;
  const rowHeight = 238;
  const rowGap = 28;
  const bottom = 54;
  const height = headerHeight + diagram.workflows.length * (rowHeight + rowGap) + bottom - rowGap;
  const palette = palettes[diagram.palette];
  const rowX = 44;
  const rowWidth = width - 88;
  const labelWidth = 300;
  const flowX = rowX + labelWidth + 38;
  const flowWidth = rowWidth - labelWidth - 68;
  const stageGap = 32;

  const rows = diagram.workflows.map((workflow, rowIndex) => {
    const y = headerHeight + rowIndex * (rowHeight + rowGap);
    const stageWidth = (flowWidth - stageGap * (workflow.stages.length - 1)) / workflow.stages.length;
    const middleY = y + rowHeight / 2 + 18;
    const connectors = workflow.stages.slice(0, -1).map((_, index) => {
      const x1 = flowX + stageWidth * (index + 1) + stageGap * index;
      const x2 = x1 + stageGap - 9;
      return `<path d="M ${x1 + 4} ${middleY} L ${x2} ${middleY}" stroke="${palette.accent}" stroke-width="3" fill="none" marker-end="url(#arrow)" opacity=".7"/>`;
    }).join('');
    const stages = workflow.stages.map((stage, stageIndex) => {
      const x = flowX + stageIndex * (stageWidth + stageGap);
      const itemGap = 8;
      const itemHeight = Math.min(70, (rowHeight - 58 - itemGap * (stage.length - 1)) / stage.length);
      const groupHeight = stage.length * itemHeight + (stage.length - 1) * itemGap;
      const startY = middleY - groupHeight / 2;
      return stage.map((item, itemIndex) => {
        const itemY = startY + itemIndex * (itemHeight + itemGap);
        const fill = stage.length > 1 ? palette.branch : palette.step;
        const label = textBlock(item, x + stageWidth / 2, itemY + itemHeight / 2 + 7, {
          size: stage.length > 2 ? 17 : 19,
          limit: stage.length > 2 ? 20 : 24,
          lineHeight: 21,
        });
        return `<rect x="${x}" y="${itemY}" width="${stageWidth}" height="${itemHeight}" rx="18" fill="${fill}" stroke="${palette.accent}" stroke-opacity=".16"/>${label}`;
      }).join('');
    }).join('');
    return `<g>
      <rect x="${rowX}" y="${y}" width="${rowWidth}" height="${rowHeight}" rx="28" fill="#fffdfa" stroke="#d9d5cc" stroke-width="2"/>
      <rect x="${rowX}" y="${y}" width="${labelWidth}" height="${rowHeight}" rx="28" fill="${palette.header}"/>
      <rect x="${rowX + labelWidth - 28}" y="${y}" width="28" height="${rowHeight}" fill="${palette.header}"/>
      <circle cx="${rowX + 54}" cy="${y + 54}" r="24" fill="#fffdfa"/>
      <text x="${rowX + 54}" y="${y + 62}" text-anchor="middle" font-size="24" font-weight="700" fill="${palette.accent}">${esc(workflow.title.match(/^\d+/u)?.[0] || rowIndex + 1)}</text>
      ${textBlock(workflow.title, rowX + 42, y + 123, { anchor: 'start', size: 27, weight: 700, fill: palette.accent, limit: 20, lineHeight: 31 })}
      ${connectors}${stages}
    </g>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(diagram.title)}</title>
  <desc id="desc">${esc(diagram.subtitle)}. Diagramă cu ${diagram.workflows.length} fluxuri ale aplicației Casierul clasei.</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.accent}"/></marker>
  </defs>
  <rect width="${width}" height="${height}" fill="#fbf7ef"/>
  <circle cx="1460" cy="70" r="82" fill="${palette.header}" opacity=".75"/>
  <path d="M1420 88 L1498 48 L1474 124 L1450 96 Z" fill="#fffdfa" stroke="${palette.accent}" stroke-width="4" stroke-linejoin="round"/>
  <text x="52" y="48" font-family="system-ui, -apple-system, sans-serif" font-size="19" font-weight="700" letter-spacing="2" fill="${palette.accent}">${esc(diagram.eyebrow)}</text>
  <text x="52" y="108" font-family="system-ui, -apple-system, sans-serif" font-size="46" font-weight="760" fill="#263f37">${esc(diagram.title)}</text>
  <text x="52" y="150" font-family="system-ui, -apple-system, sans-serif" font-size="24" fill="#60736c">${esc(diagram.subtitle)}</text>
  <g font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">${rows}</g>
  <text x="${width - 52}" y="${height - 22}" text-anchor="end" font-family="system-ui, -apple-system, sans-serif" font-size="17" fill="#73837d">casierul-clasei · ghid vizual</text>
</svg>`;
}

await mkdir(outputDir, { recursive: true });
for (const diagram of diagrams) {
  await writeFile(path.join(outputDir, diagram.file), render(diagram), 'utf8');
}
console.log(`Generated ${diagrams.length} workflow diagrams in ${outputDir}`);
