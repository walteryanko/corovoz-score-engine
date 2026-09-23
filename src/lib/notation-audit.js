// Engraving references inform checks, never overwrite explicit sounding data.
export const NOTATION_REFERENCES = Object.freeze([
  { id: 'gould', title: 'Elaine Gould · Behind Bars', pages: '47–53, 60, 78–81, 159–160, 203–213, 233–239, 446–448' },
  { id: 'gerou', title: 'Tom Gerou e Linda Lusk · Essential Dictionary of Music Notation', pages: '4–9, 160' },
  { id: 'stone', title: 'Kurt Stone · Music Notation in the Twentieth Century', pages: '66–67, 296–301' },
]);
const kids = (n, tag) => Array.from(n?.children || []).filter(c => !tag || c.localName === tag);
const one = (n, tag) => kids(n, tag)[0];
const txt = (n, tag, fallback = '') => one(n, tag)?.textContent?.trim() || fallback;
const types = { maxima: 32, long: 16, breve: 8, whole: 4, half: 2, quarter: 1, eighth: .5, '16th': .25, '32nd': .125, '64th': .0625, '128th': .03125 };
const alters = { flat: -1, natural: 0, sharp: 1, 'double-sharp': 2, 'sharp-sharp': 2, 'flat-flat': -2, 'quarter-flat': -.5, 'quarter-sharp': .5, 'three-quarters-flat': -1.5, 'three-quarters-sharp': 1.5 };
export function writtenDuration(note) {
  let duration = types[txt(note, 'type')];
  if (!duration) return null;
  duration *= 2 - 2 ** -kids(note, 'dot').length;
  const ratio = one(note, 'time-modification');
  if (ratio) {
    const actual = Number(txt(ratio, 'actual-notes')), normal = Number(txt(ratio, 'normal-notes'));
    if (!(actual > 0 && normal > 0)) return null;
    duration *= normal / actual;
  }
  return duration;
}

/** Musical contradictions are review items. A clean audit is not OMR accuracy. */
export function auditNotation(document, { measureStarts = [] } = {}) {
  const root = document.documentElement || document;
  const issues = [];
  let issueCount = 0;
  const add = (location, code, message, reference = 'gould') => {
    issueCount++;
    if (issues.length < 200) issues.push({ ...location, code, message, reference, severity: 'review' });
  };
  const names = new Map(kids(one(root, 'part-list'), 'score-part').map(p => [p.getAttribute('id'), txt(p, 'part-name')]));
  for (const part of kids(root, 'part')) {
    const partId = part.getAttribute('id');
    let divisions = 1, meter = 4, free = false;
    const openTies = new Map();
    const openSlurs = new Map();
    let absolute = 0;
    for (const [measureIndex, measure] of kids(part, 'measure').entries()) {
      if (Number.isFinite(measureStarts[measureIndex]?.startBeat)) absolute = measureStarts[measureIndex].startBeat;
      let cursor = 0, end = 0;
      const lastOnset = new Map();
      for (const [noteIndex, node] of kids(measure).entries()) {
        const location = { partId, partName: names.get(partId) || partId, measureIndex, measureNumber: measure.getAttribute('number') || String(measureIndex + 1), noteIndex: node.localName === 'note' ? kids(measure, 'note').indexOf(node) : noteIndex, staff: txt(node, 'staff', '1'), voice: txt(node, 'voice', '1') };
        if (node.localName === 'attributes') {
          divisions = Number(txt(node, 'divisions')) || divisions;
          const time = kids(node, 'time').find(t => !t.getAttribute('number') || t.getAttribute('number') === '1');
          if (time) {
            free = !!one(time, 'senza-misura');
            const beats = kids(time, 'beats'), units = kids(time, 'beat-type');
            if (!free && beats.length === units.length && beats.length) meter = beats.reduce((s, b, i) => s + b.textContent.split('+').reduce((a, v) => a + Number(v), 0) * 4 / Number(units[i].textContent), 0);
          }
          continue;
        }
        if (['backup', 'forward'].includes(node.localName)) {
          const amount = Number(txt(node, 'duration')) / divisions;
          if (!(amount > 0) || (node.localName === 'backup' && amount > cursor + .001)) add(location, 'invalid_cursor', 'Deslocamento de voz sai do compasso; confira as vozes simultâneas.');
          cursor = Math.max(0, cursor + (node.localName === 'backup' ? -amount : amount)); end = Math.max(end, cursor); continue;
        }
        if (node.localName !== 'note') continue;
        const grace = !!one(node, 'grace'), chord = !!one(node, 'chord');
        const rest = one(node, 'rest'), pitch = one(node, 'pitch');
        const written = writtenDuration(node);
        const duration = grace ? 0 : one(node, 'duration') ? Number(txt(node, 'duration')) / divisions : rest?.getAttribute('measure') === 'yes' && !free ? meter : written || 1;
        const start = chord ? lastOnset.get(location.voice) ?? cursor : cursor;
        if (chord && !lastOnset.has(location.voice)) add(location, 'orphan_chord', 'Uma nota de acorde não possui nota inicial na mesma voz.');
        if (!grace && rest?.getAttribute('measure') !== 'yes' && one(node, 'duration') && written && Math.abs(written - duration) > .015) add(location, 'duration_conflict', 'A duração não corresponde à figura, aos pontos ou à proporção da quiáltera.');
        if (!grace && rest?.getAttribute('measure') === 'yes' && !free && Math.abs(duration - meter) > .015) add(location, 'bar_rest_conflict', 'A pausa de compasso inteiro não ocupa a fórmula de compasso.');
        const ratio = one(node, 'time-modification');
        if (ratio && (!(Number(txt(ratio, 'actual-notes')) > 0) || !(Number(txt(ratio, 'normal-notes')) > 0))) add(location, 'invalid_tuplet', 'A quiáltera não informa uma proporção musical válida.', 'gerou');
        const accidental = one(node, 'accidental');
        const mark = accidental?.textContent?.trim();
        if (pitch && Object.hasOwn(alters, mark) && Number(txt(pitch, 'alter', '0')) !== alters[mark]) add(location, 'accidental_conflict', 'O acidente desenhado difere da altura codificada. O áudio mantém a altura do MusicXML; confira o original.', 'gerou');
        const notation = one(node, 'notations');
        const ties = [...kids(node, 'tie'), ...kids(notation, 'tied')].map(t => t.getAttribute('type'));
        if (pitch && !grace) {
          const semitone = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[txt(pitch, 'step')] + Number(txt(pitch, 'alter', '0')) + Number(txt(pitch, 'octave')) * 12;
          const key = `${location.staff}:${location.voice}:${semitone}`;
          for (const slur of kids(notation, 'slur')) {
            const slurNumber = slur.getAttribute('number') || '1', slurKey = `${location.staff}:${location.voice}:${slurNumber}`;
            if (slur.getAttribute('type') === 'stop') {
              const previous = openSlurs.get(slurKey);
              if (previous && previous.pitch === semitone && Math.abs(previous.end - absolute - start) < .015 && !ties.includes('stop')) {
                add({ ...location, startAddress: previous.location, slurNumber }, 'possible_tie', 'Uma ligadura une notas contíguas da mesma altura. Confira se é prolongamento (sustentar sem novo ataque) ou expressão.');
              }
              openSlurs.delete(slurKey);
            }
            if (slur.getAttribute('type') === 'start') openSlurs.set(slurKey, { pitch: semitone, end: absolute + start + duration, location });
          }
          if (ties.includes('stop')) {
            const previous = openTies.get(key);
            if (!previous || Math.abs(previous.end - absolute - start) > .015) add(location, 'broken_tie', 'A ligadura de prolongamento não encontra uma nota contígua da mesma altura e voz.');
            openTies.delete(key);
          }
          if (ties.includes('start')) openTies.set(key, { end: absolute + start + duration, location });
        }
        const head = txt(node, 'notehead');
        if (head && !['normal', 'diamond', 'do', 're', 'mi', 'fa', 'fa up', 'so', 'la', 'ti'].includes(head)) add(location, 'special_notehead', 'Cabeça de nota especial: confira a legenda da obra. O timbre ou a altura aproximada podem exigir interpretação humana.', 'stone');
        if (!chord) cursor += duration;
        lastOnset.set(location.voice, start); end = Math.max(end, cursor, start + duration);
      }
      absolute += end || meter;
    }
    for (const tie of openTies.values()) add(tie.location, 'unclosed_tie', 'A ligadura de prolongamento não foi concluída na parte.');
  }
  return { version: 1, issueCount, issues, truncated: issueCount > issues.length, references: NOTATION_REFERENCES, verifiedAgainstOriginal: false };
}
