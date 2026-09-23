/**
 * Playback coverage, separate from MusicXML validity and optical recognition.
 * This module never edits XML and never rejects an otherwise readable score.
 * Unknown expressive notation stays in the source; locations explain which
 * gestures the guide synthesizer does not perform. A clean report is not an
 * assurance that an OMR transcript matches its original image.
 *
 * References: W3C MusicXML 4.0 element reference; SMuFL 1.4 glyph categories.
 */
export const NOTATION_CAPABILITIES_VERSION = 1;

const children = (node) => Array.from(node?.children || []);
const tag = (node) => node?.localName?.toLowerCase() || node?.tagName?.toLowerCase() || "";
const text = (node, selector) => node?.querySelector(selector)?.textContent?.trim() || "";
const ancestor = (node, name) => {
  let current = node;
  while (current && tag(current) !== name) current = current.parentElement;
  return current;
};

const RULES = [
  {
    category: "ornament", label: "Ornamentos", selector: "notations > ornaments",
    message: "Trilos, mordentes, grupetos e tremolos ficam no MusicXML; o áudio toca as notas escritas, sem realizar o ornamento.",
  },
  {
    category: "slur", label: "Ligaduras de expressão", selector: "notations > slur",
    message: "A ligadura de expressão fica no MusicXML; o guia não interpreta automaticamente o fraseado legato.",
  },
  {
    category: "fermata", label: "Fermatas", selector: "notations > fermata, barline > fermata",
    message: "A fermata fica no MusicXML; o guia mantém a duração escrita, sem acrescentar um tempo de sustentação arbitrário.",
  },
  {
    category: "articulation", label: "Articulações e respiração", selector: "notations > articulations",
    message: "Acentos, staccato, tenuto, respirações e cesuras ficam no MusicXML; os gestos não são realizados pelo guia.",
  },
  {
    category: "glissando", label: "Glissandos e portamentos", selector: "notations > glissando, notations > slide",
    message: "O áudio toca as alturas escritas; não faz a transição contínua de glissando ou portamento.",
  },
  {
    category: "arpeggio", label: "Arpejos", selector: "notations > arpeggiate",
    message: "O arpejo fica no MusicXML; as notas do acorde soam simultaneamente no guia.",
  },
  {
    category: "technical", label: "Técnicas instrumentais", selector: "notations > technical",
    message: "Dedilhados e técnicas instrumentais ficam no MusicXML; o guia coral não reproduz esses timbres e gestos.",
  },
  {
    category: "unpitched", label: "Sons sem altura definida", selector: "note > unpitched",
    message: "Percussão e sons sem altura definida ficam no MusicXML e mantêm seu lugar no tempo; não são cantados pelo guia.",
  },
  {
    category: "harmony", label: "Cifras e baixo cifrado", selector: "measure > harmony, measure > figured-bass",
    message: "Cifras e baixo cifrado ficam no MusicXML; o guia não gera acompanhamento a partir desses símbolos.",
  },
  {
    category: "measure_shorthand", label: "Abreviações de compassos", selector: "measure-style > measure-repeat, measure-style > beat-repeat, measure-style > slash",
    message: "Repetições abreviadas e barras rítmicas ficam no MusicXML; o áudio usa somente notas com altura e duração explícitas.",
  },
  {
    category: "grace", label: "Notas de adorno", selector: "note > grace",
    message: "As notas de adorno são breves no guia; a distribuição expressiva do tempo antes ou dentro do pulso é aproximada.",
  },
  {
    category: "playback_technique", label: "Técnicas de execução", selector: "note > play, sound > play, direction-type > pedal, direction-type > harp-pedals, direction-type > string-mute, direction-type > scordatura, direction-type > percussion, direction-type > damp, direction-type > damp-all, direction-type > accordion-registration",
    message: "A indicação de execução fica no MusicXML; o guia coral não interpreta automaticamente a técnica ou troca de timbre.",
  },
  {
    category: "octave_doubling", label: "Dobramento de oitava", selector: "transpose > double",
    message: "A transposição principal é aplicada; a voz adicional do dobramento de oitava não é criada automaticamente.",
  },
  {
    category: "note_dynamics", label: "Dinâmica vinculada à nota", selector: "notations > dynamics",
    message: "A dinâmica vinculada à nota fica no MusicXML; o guia aplica as dinâmicas codificadas como indicações de direção.",
  },
  {
    category: "free_meter", label: "Ritmo livre", selector: "time > senza-misura",
    message: "O ritmo livre usa as durações explícitas do arquivo; a flexibilidade expressiva deve ser conferida no ensaio.",
  },
];

const KNOWN_NOTATIONS = new Set([
  "accidental-mark", "arpeggiate", "articulations", "dynamics", "fermata", "footnote", "glissando",
  "level", "non-arpeggiate", "ornaments", "slur", "slide", "technical", "tied", "tuplet",
]);
const KNOWN_DIRECTIONS = new Set([
  "accordion-registration", "bracket", "coda", "damp", "damp-all", "dashes", "dynamics",
  "eyeglasses", "harp-pedals", "image", "metronome", "octave-shift", "pedal", "percussion",
  "principal-voice", "rehearsal", "scordatura", "segno", "staff-divide", "string-mute", "wedge", "words",
]);

/** @param {Document|Element} document */
export function inspectNotationCapabilities(document) {
  const root = document?.querySelector("score-partwise") || document;
  const parts = children(root).filter((node) => tag(node) === "part");
  const partNames = new Map(Array.from(root?.querySelectorAll("part-list > score-part") || [])
    .map((node) => [node.getAttribute("id"), text(node, ":scope > part-name")]));
  const issues = [];
  const groupsByCategory = new Map();
  let issueCount = 0;
  const MAX_ISSUES = 240;
  const add = (element, rule, location, symbol = tag(element)) => {
    const note = ancestor(element, "note");
    const direction = ancestor(element, "direction");
    const container = note || direction;
    const noteIndex = note ? children(note.parentElement).filter((node) => tag(node) === "note").indexOf(note) : null;
    const issue = {
      category: rule.category,
      label: rule.label,
      message: rule.message,
      severity: "review",
      ...location,
      noteIndex,
      staffNumber: text(container, ":scope > staff") || (["time", "transpose"].includes(tag(element)) ? element.getAttribute("number") : null),
      voiceNumber: text(container, ":scope > voice") || null,
      symbol,
      xmlPreserved: true,
    };
    issueCount += 1;
    if (issues.length < MAX_ISSUES) issues.push(issue);
    if (!groupsByCategory.has(rule.category)) {
      groupsByCategory.set(rule.category, { category: rule.category, label: rule.label, message: rule.message, count: 0, locations: [] });
    }
    const group = groupsByCategory.get(rule.category);
    group.count += 1;
    const label = `${location.partName}, c. ${location.measureNumber}`;
    if (group.locations.length < 12 && !group.locations.includes(label)) group.locations.push(label);
  };

  parts.forEach((part, partIndex) => {
    const partId = part.getAttribute("id") || `P${partIndex + 1}`;
    const partName = partNames.get(partId) || partId;
    children(part).filter((node) => tag(node) === "measure").forEach((measure, measureIndex) => {
      const location = { partId, partName, measureIndex, measureNumber: measure.getAttribute("number") || String(measureIndex + 1) };
      for (const rule of RULES) {
        for (const element of Array.from(measure.querySelectorAll(rule.selector))) add(element, rule, location);
      }
      for (const notation of Array.from(measure.querySelectorAll("notations > *, direction-type > *"))) {
        const known = tag(notation.parentElement) === "notations" ? KNOWN_NOTATIONS : KNOWN_DIRECTIONS;
        if (known.has(tag(notation))) continue;
        add(notation, {
          category: "other_notation", label: "Outras indicações",
          message: "Esta indicação fica no MusicXML; sua interpretação sonora ainda não está disponível no guia.",
        }, location);
      }
      for (const note of Array.from(measure.querySelectorAll(":scope > note"))) {
        const lyrics = Array.from(note.querySelectorAll(":scope > lyric"));
        if (lyrics.length > 1) add(note, {
          category: "multiple_verses", label: "Múltiplas estrofes",
          message: "Todas as estrofes ficam no MusicXML; o canto utiliza a primeira estrofe disponível.",
        }, location, "lyric");
        const accidental = text(note, ":scope > accidental");
        if (/(quarter|arrow|sori|koron|other)/i.test(accidental) && !note.querySelector(":scope > pitch > alter")) {
          add(note, {
            category: "microtonal_spelling", label: "Acidentais microtonais sem altura",
            message: "Há um símbolo microtonal sem alteração numérica da altura; o guia usa o pitch do arquivo. Confira a afinação indicada.",
          }, location, "accidental");
        }
      }
      for (const attributes of Array.from(measure.querySelectorAll(":scope > attributes"))) {
        const times = Array.from(attributes.querySelectorAll(":scope > time"));
        const numbered = times.filter((time) => time.hasAttribute("number"));
        if (numbered.length) add(numbered[0], {
          category: "staff_meter", label: "Compassos por pauta",
          message: "As durações de todas as pautas são preservadas; a fórmula de referência do guia é a da primeira pauta. Confira o alinhamento entre métricas diferentes.",
        }, location, "time");
      }
      for (const words of Array.from(measure.querySelectorAll("direction-type > words"))) {
        if (!/\b(rit(?:ard(?:ando)?)?|rall(?:entando)?|rubato|accel(?:erando)?|stringendo|allargando|a\s+tempo|swing)\b/i.test(words.textContent || "")) continue;
        add(words, {
          category: "expressive_tempo", label: "Andamento expressivo",
          message: "O texto de andamento fica no MusicXML; o guia aplica valores numéricos de metrônomo e não interpreta livremente rubato, swing ou mudanças graduais.",
        }, location, "words");
      }
    });
  });

  const groups = Array.from(groupsByCategory.values());
  const warnings = groups.map((group) => `${group.label}: ${group.message} Local: ${group.locations.slice(0, 3).join("; ")}${group.locations.length > 3 ? "; …" : ""}.`);
  return {
    version: NOTATION_CAPABILITIES_VERSION,
    issueCount,
    issues,
    omittedIssueCount: Math.max(0, issueCount - issues.length),
    groups,
    warnings,
    scope: "musicxml_playback_coverage",
  };
}
