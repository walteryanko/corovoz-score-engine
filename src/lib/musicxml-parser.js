/**
 * MusicXML -> CoroVoz score model.
 *
 * The former parser inferred duration from <type> and appended every note in
 * document order. That loses sync as soon as a score uses divisions,
 * backup/forward, multiple voices on one staff, pickups, tuplets or chords.
 * This parser keeps an absolute beat timeline and enough source coordinates
 * for visual following in OSMD.
 */

import { inspectNotationCapabilities } from "./notation-capabilities.js";
import { auditNotation } from "./notation-audit.js";
import { parseMusicXMLDocument } from "./musicxml-import.js";
import { createPlaybackGraph, walkPlaybackGraph, withScoreEngineV2 } from "./score-engine-v2.js";

export const SCORE_MODEL_VERSION = 4;

export const VOICE_ROLE_LABELS = {
  soprano: "Soprano",
  contralto: "Contralto",
  tenor: "Tenor",
  baixo: "Baixo",
  outra: "Outra voz",
};

const DEFAULT_BPM = 100;

const NOTE_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const TYPE_TO_BEATS = {
  maxima: 32,
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
  "128th": 0.03125,
  "256th": 0.015625,
  "512th": 0.0078125,
  "1024th": 0.00390625,
};

const DYNAMIC_VELOCITIES = {
  pppp: 0.18,
  ppp: 0.24,
  pp: 0.32,
  p: 0.42,
  mp: 0.54,
  mf: 0.68,
  f: 0.78,
  ff: 0.88,
  fff: 0.95,
  ffff: 1,
  sf: 0.88,
  sfz: 0.94,
  fz: 0.9,
  fp: 0.62,
};

const VOCAL_HINT = /(sopr|sop\.?|contralto|alto|alt\.?|mezzo|tenor|ten\.?|baixo|bass|basso|bar[ií]tono|baritone|coro|coral|choir|voice|voz|vocal|cantus)/i;
const NON_VOCAL_HINT = /(piano|keyboard|teclado|organ|órgão|guitar|viol[aã]o|violin|violino|viola|cello|violoncelo|sax|flute|flauta|clarinet|clarinete|oboe|bassoon|fagote|trumpet|trompete|horn|trompa|accomp|acompanhamento|drum|percuss|orchestra|orquestra)/i;

const directChildren = (element) => Array.from(element?.children || []);

function childText(element, selector, fallback = "") {
  return element?.querySelector(selector)?.textContent?.trim() || fallback;
}

function finiteNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeKey(value) {
  return String(value || "voz")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "voz";
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function pitchFromNote(noteElement, transposition = 0, location = "Nota") {
  const pitch = noteElement.querySelector(":scope > pitch");
  if (!pitch) return null;

  const step = childText(pitch, ":scope > step").toUpperCase();
  const alter = finiteNumber(childText(pitch, ":scope > alter", "0"), NaN);
  const octave = finiteNumber(childText(pitch, ":scope > octave"), NaN);
  if (!Object.hasOwn(NOTE_SEMITONES, step) || !Number.isFinite(alter)
    || !Number.isInteger(octave) || octave < 0 || octave > 9) {
    throw new Error(`${location}: a altura está incompleta; confira nome, alteração e oitava da nota.`);
  }
  const writtenMidi = (octave + 1) * 12 + NOTE_SEMITONES[step] + alter;
  // MusicXML transpose is added to written pitch. Decimal alter values remain
  // fractional semitones; rounding here would erase quarter tones.
  const midi = writtenMidi + transposition;
  const accidental = alter === 1 ? "#" : alter === -1 ? "b" : alter > 0 ? `(+${alter})` : alter < 0 ? `(${alter})` : "";

  return {
    step,
    alter,
    octave,
    midi,
    writtenMidi,
    transposition,
    noteName: `${step}${accidental}${octave}`,
    frequency: midiToFrequency(midi),
  };
}

// Keep every beat/beat-type pair: 3+2/8 and 2/4+3/8 are different
// encodings. A free meter consumes the explicit note durations without a
// fabricated four-beat bar. XML engraving continues to use the original time.
function readTimeSignature(timeElement, previous) {
  if (!timeElement) return previous;
  if (timeElement.querySelector(":scope > senza-misura")) {
    return { ...previous, senzaMisura: true, nominalBeats: null, label: "Sem compasso fixo" };
  }
  const pairs = [];
  let pendingBeats = "";
  for (const child of directChildren(timeElement)) {
    if (child.tagName?.toLowerCase() === "beats") pendingBeats = child.textContent?.trim() || "";
    if (child.tagName?.toLowerCase() !== "beat-type" || !pendingBeats) continue;
    const terms = pendingBeats.split("+").map((term) => Number(term.trim()));
    const beatType = Number(child.textContent?.trim());
    if (!terms.length || terms.some((term) => !Number.isInteger(term) || term <= 0)
      || !Number.isInteger(beatType) || beatType <= 0) return previous;
    pairs.push({ beats: terms.reduce((sum, term) => sum + term, 0), beatType, label: pendingBeats });
    pendingBeats = "";
  }
  if (!pairs.length || pendingBeats) return previous;
  return {
    beats: pairs[0].beats,
    beatType: pairs[0].beatType,
    nominalBeats: pairs.reduce((sum, pair) => sum + pair.beats * 4 / pair.beatType, 0),
    label: pairs.map((pair) => `${pair.label}/${pair.beatType}`).join(" + "),
    senzaMisura: false,
  };
}

function fallbackDurationBeats(noteElement) {
  const type = childText(noteElement, ":scope > type", "quarter");
  let beats = TYPE_TO_BEATS[type] || 1;
  const dotCount = noteElement.querySelectorAll(":scope > dot").length;
  let addition = beats / 2;
  for (let index = 0; index < dotCount; index += 1) {
    beats += addition;
    addition /= 2;
  }

  const actual = finiteNumber(childText(noteElement, ":scope > time-modification > actual-notes"), 0);
  const normal = finiteNumber(childText(noteElement, ":scope > time-modification > normal-notes"), 0);
  if (actual > 0 && normal > 0) beats *= normal / actual;
  return beats;
}

function durationBeats(noteElement, divisions, location = "Nota", measureBeats = null) {
  // Grace notes sound, but do not consume score time unless MusicXML provides
  // an explicit performed duration elsewhere. Advancing the cursor here shifts
  // every following onset in the measure.
  if (noteElement.querySelector(":scope > grace")) return 0;
  const durationElements = Array.from(noteElement.querySelectorAll(":scope > duration"));
  if (durationElements.length) {
    const duration = Number(durationElements[0].textContent?.trim());
    if (durationElements.length !== 1 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error(`${location}: a duração explícita da nota deve ser um número positivo.`);
    }
    return duration / divisions;
  }
  if (noteElement.querySelector(':scope > rest[measure="yes"]') && Number.isFinite(measureBeats) && measureBeats > 0) return measureBeats;
  return fallbackDurationBeats(noteElement);
}

function readLyric(noteElement) {
  const lyricElements = Array.from(noteElement.querySelectorAll(":scope > lyric"));
  if (!lyricElements.length) return { text: "", syllabic: "", extend: false, extendType: "", verse: "" };

  const lyric = lyricElements.find((item) => ["", "1"].includes(item.getAttribute("number") || "")) || lyricElements[0];
  const extendElement = lyric.querySelector(":scope > extend");
  const text = Array.from(lyric.querySelectorAll(":scope > text"))
    .map((item) => item.textContent?.trim() || "")
    .join(lyric.querySelector(":scope > elision")?.textContent || "")
    .trim();

  return {
    text,
    syllabic: childText(lyric, ":scope > syllabic"),
    extend: Boolean(extendElement),
    extendType: extendElement?.getAttribute("type") || "",
    verse: lyric.getAttribute("number") || "1",
  };
}

export function detectWrittenChoirRoles(name = "") {
  const normalized = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const hints = [];
  if (/(^|\b)(soprano|sop|sopr|cantus|treble)(\b|\d)/.test(normalized) || /^s\d?$/.test(normalized.trim())) hints.push("soprano");
  if (/(^|\b)(contralto|alto|alt|mezzo)(\b|\d)/.test(normalized) || /^a\d?$/.test(normalized.trim())) hints.push("contralto");
  if (/(^|\b)(tenor|ten)(\b|\d)/.test(normalized) || /^t\d?$/.test(normalized.trim())) hints.push("tenor");
  if (/(^|\b)(baixo|bass|basso|baritone|baritono|bas)(\b|\d)/.test(normalized) || /^b\d?$/.test(normalized.trim())) hints.push("baixo");
  const abbreviation = normalized.trim().replace(/[\s/.,&+-]/g, "");
  if (/^(sa|ssa|ssaa|tb|ttbb|satb)$/.test(abbreviation)) {
    return [["s", "soprano"], ["a", "contralto"], ["t", "tenor"], ["b", "baixo"]]
      .filter(([letter]) => abbreviation.includes(letter)).map(([, role]) => role);
  }
  if (/\bs\s*[./&+ -]?a\s*[./&+ -]?t\s*[./&+ -]?b\b/.test(normalized)) return ["soprano", "contralto", "tenor", "baixo"];
  return hints;
}

function detectExplicitRole(name = "") {
  const hints = detectWrittenChoirRoles(name);
  return hints.length === 1 ? hints[0] : null;
}

const UNISON_WORDS = /(?:\bunis(?:ono|on)?\.?\b|\ba\s*[. ]?\s*2\b)/i;

/** Extra singers of one written melody. Roles never transpose its pitches. */
export function normalizeUnisonRoles(value, primaryRole) {
  return ["soprano", "contralto", "tenor", "baixo"].filter((role) => role !== primaryRole && Array.isArray(value) && value.includes(role));
}

function roleFromRange(medianMidi) {
  if (!Number.isFinite(medianMidi)) return "outra";
  if (medianMidi >= 67) return "soprano";
  if (medianMidi >= 59) return "contralto";
  if (medianMidi >= 50) return "tenor";
  return "baixo";
}

function median(values) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function parseDirection(element, divisions, measureIndex, cursorBeat, partId) {
  const offset = finiteNumber(childText(element, ":scope > offset"), 0) / Math.max(divisions, 1);
  const beatInMeasure = Math.max(0, cursorBeat + offset);
  const events = [];

  // <sound> is valid both inside a direction and directly in a measure.
  // Its own offset overrides the direction offset for playback parameters,
  // while engraved wedges keep the direction's original position.
  const soundElement = element.tagName?.toLowerCase() === "sound"
    ? element : element.querySelector(":scope > sound");
  const soundOffset = soundElement?.querySelector(":scope > offset");
  const soundBeatInMeasure = soundOffset
    ? Math.max(0, cursorBeat + finiteNumber(soundOffset.textContent?.trim(), 0) / Math.max(divisions, 1))
    : beatInMeasure;
  const tempo = finiteNumber(soundElement?.getAttribute("tempo"), NaN);
  const metronome = element.querySelector(":scope > direction-type > metronome");
  const perMinute = finiteNumber(childText(metronome, ":scope > per-minute"), NaN);
  const beatUnit = childText(metronome, ":scope > beat-unit", "quarter");
  const unitDots = metronome?.querySelectorAll(":scope > beat-unit-dot").length || 0;
  let beatUnitBeats = TYPE_TO_BEATS[beatUnit] || 1;
  let dotAddition = beatUnitBeats / 2;
  for (let index = 0; index < unitDots; index += 1) {
    beatUnitBeats += dotAddition;
    dotAddition /= 2;
  }
  const metronomeTempo = Number.isFinite(perMinute) ? perMinute * beatUnitBeats : NaN;
  const bpm = Number.isFinite(tempo) && tempo > 0 ? tempo : metronomeTempo;
  const directionStaff = finiteNumber(childText(element, ":scope > staff"), NaN);
  const staffNumber = Number.isFinite(directionStaff) && directionStaff > 0 ? directionStaff : null;
  const directionVoice = childText(element, ":scope > voice");
  const voiceNumber = directionVoice || null;
  if (Number.isFinite(bpm) && bpm > 0) {
    events.push({ kind: "tempo", bpm, measureIndex, beatInMeasure: Number.isFinite(tempo) && tempo > 0 ? soundBeatInMeasure : beatInMeasure, partId, staffNumber, voiceNumber });
  }

  const soundDynamic = finiteNumber(soundElement?.getAttribute("dynamics"), NaN);
  const dynamicElement = element.querySelector(":scope > direction-type > dynamics > *");
  const mark = dynamicElement?.tagName?.toLowerCase() || "";
  const velocity = Number.isFinite(soundDynamic)
    ? Math.max(0.08, Math.min(1, soundDynamic / 100))
    : DYNAMIC_VELOCITIES[mark];
  if (Number.isFinite(velocity)) {
    events.push({ kind: "dynamic", mark: mark || "custom", velocity, measureIndex, beatInMeasure: Number.isFinite(soundDynamic) ? soundBeatInMeasure : beatInMeasure, partId, staffNumber, voiceNumber });
  }

  const wedge = element.querySelector(":scope > direction-type > wedge");
  if (wedge) {
    events.push({
      kind: "wedge",
      wedgeType: wedge.getAttribute("type") || "stop",
      number: wedge.getAttribute("number") || "1",
      measureIndex,
      beatInMeasure,
      partId,
      staffNumber,
      voiceNumber,
    });
  }

  return events;
}

function parsePart(partElement, partInfo) {
  let divisions = 1;
  let currentTime = { beats: 4, beatType: 4, nominalBeats: 4, label: "4/4", senzaMisura: false };
  let globalTransposition = 0;
  const transpositionByStaff = new Map();
  let currentKeyFifths = 0;
  const measureData = [];
  const trackMap = new Map();
  const expressionEvents = [];
  const unisonIndications = [];
  let maxStaff = 1;

  const measures = Array.from(partElement.querySelectorAll(":scope > measure"));
  measures.forEach((measureElement, measureIndex) => {
    let cursor = 0;
    let maxCursor = 0;
    // A chord may cross staves while remaining in the same MusicXML voice.
    // Its onset belongs to that voice, not to the staff used to engrave it.
    const lastStartByVoice = new Map();
    const number = measureElement.getAttribute("number") || String(measureIndex + 1);

    directChildren(measureElement).forEach((node, sourceIndex) => {
      const tag = node.tagName?.toLowerCase();

      if (tag === "attributes") {
        const nextDivisions = finiteNumber(childText(node, ":scope > divisions"), divisions);
        if (nextDivisions > 0) divisions = nextDivisions;
        const timeElements = Array.from(node.querySelectorAll(":scope > time"));
        // The shared timeline follows the unnumbered / first staff meter;
        // simultaneous staff-specific meters are retained and diagnosed.
        const referenceTime = timeElements.find((time) => !time.hasAttribute("number"))
          || timeElements.find((time) => time.getAttribute("number") === "1");
        currentTime = readTimeSignature(referenceTime, currentTime);
        for (const transpose of Array.from(node.querySelectorAll(":scope > transpose"))) {
          const chromatic = finiteNumber(childText(transpose, ":scope > chromatic"), NaN);
          const octaveChange = finiteNumber(childText(transpose, ":scope > octave-change", "0"), NaN);
          if (!Number.isFinite(chromatic) || !Number.isInteger(octaveChange)) {
            throw new Error(`${partInfo.name}, compasso ${number}: a transposição está incompleta.`);
          }
          const semitones = chromatic + octaveChange * 12;
          const staff = transpose.getAttribute("number");
          if (staff) transpositionByStaff.set(staff, semitones);
          else {
            globalTransposition = semitones;
            transpositionByStaff.clear();
          }
        }
        currentKeyFifths = finiteNumber(childText(node, ":scope > key > fifths"), currentKeyFifths);
        return;
      }

      if (tag === "backup" || tag === "forward") {
        const amount = finiteNumber(childText(node, ":scope > duration"), 0) / Math.max(divisions, 1);
        cursor = tag === "backup" ? Math.max(0, cursor - amount) : cursor + amount;
        maxCursor = Math.max(maxCursor, cursor);
        return;
      }

      if (tag === "direction" || tag === "sound") {
        const words = Array.from(node.querySelectorAll(":scope > direction-type > words"))
          .map((word) => word.textContent || "").join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        if (UNISON_WORDS.test(words)) unisonIndications.push({
          measureIndex, measureNumber: number, text: words.slice(0, 120),
          staffNumber: childText(node, ":scope > staff") || null,
          voiceNumber: childText(node, ":scope > voice") || null,
        });
        expressionEvents.push(...parseDirection(node, divisions, measureIndex, cursor, partInfo.id));
        return;
      }

      if (tag !== "note") return;

      const voiceNumber = childText(node, ":scope > voice", "1");
      const staffNumber = Math.max(1, finiteNumber(childText(node, ":scope > staff", "1"), 1));
      maxStaff = Math.max(maxStaff, staffNumber);
      const trackId = `${partInfo.id}::${staffNumber}::${voiceNumber}`;
      const isChord = Boolean(node.querySelector(":scope > chord"));
      const location = `${partInfo.name}, compasso ${number}, pauta ${staffNumber}`;
      const noteKinds = directChildren(node).filter((child) => ["pitch", "rest", "unpitched"].includes(child.tagName?.toLowerCase()));
      if (noteKinds.length !== 1) {
        throw new Error(`${location}: cada nota deve conter uma altura, uma pausa ou um som sem altura definida.`);
      }
      const duration = Math.max(0, durationBeats(node, divisions, location, currentTime.senzaMisura ? null : currentTime.nominalBeats));
      const grace = Boolean(node.querySelector(":scope > grace"));
      const start = isChord ? (lastStartByVoice.get(voiceNumber) ?? cursor) : cursor;
      const rest = Boolean(node.querySelector(":scope > rest"));
      const pitch = rest ? null : pitchFromNote(
        node,
        transpositionByStaff.get(String(staffNumber)) ?? globalTransposition,
        location,
      );
      const lyric = readLyric(node);
      const tieTypes = Array.from(node.querySelectorAll(":scope > tie, :scope > notations > tied"))
        .map((tie) => tie.getAttribute("type"))
        .filter(Boolean);
      const tieNumbers = [...new Set(Array.from(node.querySelectorAll(":scope > notations > tied"))
        .map((tie) => tie.getAttribute("number")).filter(Boolean))];

      const event = {
        id: `${trackId}::${measureIndex}::${sourceIndex}`,
        sourceIndex,
        partId: partInfo.id,
        partIndex: partInfo.partIndex,
        staffNumber,
        globalStaffIndex: partInfo.staffOffset + staffNumber - 1,
        voiceNumber,
        measure: number,
        measureIndex,
        beatInMeasure: start,
        startBeat: 0,
        durationBeats: duration,
        grace,
        duracao: duration / 2,
        rest,
        nota: rest ? "rest" : pitch?.noteName || "",
        noteName: rest ? "Pausa" : pitch?.noteName || "",
        midi: pitch?.midi ?? null,
        writtenMidi: pitch?.writtenMidi ?? null,
        pitchStep: pitch?.step || null,
        pitchAlter: pitch?.alter ?? null,
        pitchOctave: pitch?.octave ?? null,
        stem: childText(node, ":scope > stem") || null,
        transposition: pitch?.transposition ?? 0,
        frequencia: pitch?.frequency ?? 0,
        frequency: pitch?.frequency ?? 0,
        letra: lyric.text,
        lyric: lyric.text,
        syllabic: lyric.syllabic,
        lyricExtend: lyric.extend,
        lyricExtendType: lyric.extendType,
        verse: lyric.verse,
        tieStart: tieTypes.includes("start"),
        tieStop: tieTypes.includes("stop"),
        tieNumbers,
        articulations: Array.from(node.querySelectorAll(':scope > notations > articulations > *')).map(item => item.localName),
        slurs: Array.from(node.querySelectorAll(':scope > notations > slur')).map(item => ({ type: item.getAttribute('type'), number: item.getAttribute('number') || '1' })),
        notation: {
          divisions, type: node.querySelector(":scope > type")?.textContent?.trim() || null,
          beams: Array.from(node.querySelectorAll(':scope > beam')).map(item => ({ number: item.getAttribute('number') || '1', value: item.textContent.trim() })),
          accidental: node.querySelector(':scope > accidental')?.textContent?.trim() || null,
          tuplet: node.querySelector(':scope > time-modification') ? {
            actual: Number(node.querySelector('time-modification > actual-notes')?.textContent),
            normal: Number(node.querySelector('time-modification > normal-notes')?.textContent),
          } : null,
          fermatas: Array.from(node.querySelectorAll(':scope > notations > fermata')).map(item => ({ type: item.getAttribute('type'), shape: item.textContent.trim(), playback: 'written_duration_only' })),
        },
        chord: isChord,
        velocity: 0.68,
        dynamic: "mf",
        dynamicExplicit: false,
      };

      if (!trackMap.has(trackId)) {
        trackMap.set(trackId, {
          id: trackId,
          partId: partInfo.id,
          partIndex: partInfo.partIndex,
          partName: partInfo.name,
          abbreviation: partInfo.abbreviation,
          staffNumber,
          globalStaffIndex: partInfo.staffOffset + staffNumber - 1,
          voiceNumber,
          notes: [],
        });
      }
      trackMap.get(trackId).notes.push(event);

      lastStartByVoice.set(voiceNumber, start);
      if (!isChord) cursor += duration;
      maxCursor = Math.max(maxCursor, start + duration, cursor);
    });

    const nominalBeats = currentTime.senzaMisura ? maxCursor : currentTime.nominalBeats;
    measureData.push({
      index: measureIndex,
      number,
      parsedDurationBeats: maxCursor,
      implicit: measureElement.getAttribute("implicit") === "yes",
      nominalBeats,
      timeSignature: currentTime.label,
      senzaMisura: currentTime.senzaMisura,
      keyFifths: currentKeyFifths,
      annotations: {
        clefChanges: Array.from(measureElement.querySelectorAll(':scope > attributes > clef')).map(item => ({ staff: item.getAttribute('number') || '1', sign: item.querySelector('sign')?.textContent, line: item.querySelector('line')?.textContent, octaveChange: Number(item.querySelector('clef-octave-change')?.textContent || 0) })),
        octaveShifts: Array.from(measureElement.querySelectorAll('direction-type > octave-shift')).map(item => ({ type: item.getAttribute('type'), size: Number(item.getAttribute('size') || 8), number: item.getAttribute('number') || '1' })),
        rehearsalMarks: Array.from(measureElement.querySelectorAll('direction-type > rehearsal')).map(item => item.textContent.trim()),
      },
    });
  });

  return {
    ...partInfo,
    staffCount: Math.max(partInfo.staffCount || 1, maxStaff),
    measures: measureData,
    tracks: Array.from(trackMap.values()),
    expressionEvents,
    unisonIndications,
  };
}

function mergeTies(notes) {
  const result = [];
  const activeByPitch = new Map();

  [...notes]
    .sort((a, b) => a.startBeat - b.startBeat || a.sourceIndex - b.sourceIndex)
    .forEach((note) => {
      const pitchKey = note.rest ? null : `${note.midi}`;
      const candidates = pitchKey ? activeByPitch.get(pitchKey) || [] : [];
      const previous = note.tieStop ? candidates.find((candidate) => {
        const contiguous = Math.abs(candidate.startBeat + candidate.durationBeats - note.startBeat) < 0.000001;
        const numbered = candidate.tieNumbers?.length && note.tieNumbers?.length;
        return contiguous && (!numbered || candidate.tieNumbers.some((number) => note.tieNumbers.includes(number)));
      }) : null;

      if (previous) {
        previous.durationBeats += note.durationBeats;
        previous.duracao = previous.durationBeats / 2;
        previous.tieStart = note.tieStart;
        if (!note.tieStart) activeByPitch.set(pitchKey, candidates.filter((candidate) => candidate !== previous));
        return;
      }

      result.push(note);
      if (pitchKey && note.tieStart) activeByPitch.set(pitchKey, [...candidates, note]);
    });

  return result;
}

function latestDynamicBefore(dynamicEvents, beat) {
  let current = { mark: "mf", velocity: DYNAMIC_VELOCITIES.mf, explicit: false };
  for (const event of dynamicEvents) {
    if (event.beat > beat + 0.0001) break;
    current = { ...event, explicit: true };
  }
  return current;
}

function applyDynamics(notes, events) {
  const dynamics = events.filter((event) => event.kind === "dynamic").sort((a, b) => a.beat - b.beat);
  const wedges = events.filter((event) => event.kind === "wedge").sort((a, b) => a.beat - b.beat);

  notes.forEach((note) => {
    const dynamic = latestDynamicBefore(dynamics, note.startBeat);
    note.velocity = dynamic.velocity;
    note.dynamic = dynamic.mark;
    note.dynamicExplicit = dynamic.explicit;
  });

  const starts = new Map();
  wedges.forEach((wedge) => {
    if (wedge.wedgeType === "crescendo" || wedge.wedgeType === "diminuendo") {
      starts.set(wedge.number, wedge);
      return;
    }
    if (wedge.wedgeType !== "stop") return;
    const start = starts.get(wedge.number);
    if (!start || wedge.beat <= start.beat) return;
    const startDynamic = latestDynamicBefore(dynamics, start.beat);
    const explicitTarget = dynamics.find((dynamic) => dynamic.beat >= wedge.beat - 0.05);
    const targetVelocity = explicitTarget?.velocity ?? Math.max(
      0.12,
      Math.min(1, startDynamic.velocity + (start.wedgeType === "crescendo" ? 0.16 : -0.16)),
    );

    notes.forEach((note) => {
      if (note.startBeat < start.beat || note.startBeat > wedge.beat) return;
      const ratio = (note.startBeat - start.beat) / (wedge.beat - start.beat);
      note.velocity = startDynamic.velocity + (targetVelocity - startDynamic.velocity) * ratio;
      note.dynamic = start.wedgeType === "crescendo" ? "cresc." : "dim.";
      note.dynamicExplicit = true;
    });
    starts.delete(wedge.number);
  });
}

function uniqueVoiceKey(preferredKey, existing) {
  if (!existing.has(preferredKey)) return preferredKey;
  let suffix = 2;
  while (existing.has(`${preferredKey}_${suffix}`)) suffix += 1;
  return `${preferredKey}_${suffix}`;
}

function finalizeTracks(parsedParts, measureStarts, expressionEvents) {
  const rawTracks = parsedParts.flatMap((part) => part.tracks).map((track) => {
    track.notes.forEach((note) => {
      note.startBeat = (measureStarts[note.measureIndex]?.startBeat || 0) + note.beatInMeasure;
    });

    const notes = [...track.notes].sort((a, b) => a.startBeat - b.startBeat || a.sourceIndex - b.sourceIndex);
    const pitched = notes.filter((note) => !note.rest && Number.isFinite(note.midi));
    const midiValues = pitched.map((note) => note.midi);
    const lyricCount = pitched.filter((note) => note.lyric).length;
    const sameStartCounts = new Map();
    pitched.forEach((note) => sameStartCounts.set(note.startBeat, (sameStartCounts.get(note.startBeat) || 0) + 1));
    const polyphonicNotes = Array.from(sameStartCounts.values()).filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
    const nameHint = `${track.partName} ${track.abbreviation}`.trim();
    const candidateRoles = detectWrittenChoirRoles(nameHint);
    const indications = (parsedParts.find((part) => part.id === track.partId)?.unisonIndications || [])
      .filter((item) => (!item.staffNumber || String(item.staffNumber) === String(track.staffNumber))
        && (!item.voiceNumber || item.voiceNumber === track.voiceNumber));
    const explicitRole = detectExplicitRole(nameHint);
    const medianMidi = median(midiValues);
    const rangeRole = roleFromRange(medianMidi);
    const likelyInstrument = NON_VOCAL_HINT.test(nameHint);
    const likelyVocal = Boolean(explicitRole || lyricCount > 0 || VOCAL_HINT.test(nameHint) || (!likelyInstrument && polyphonicNotes <= Math.max(2, pitched.length * 0.08)));

    const localEvents = expressionEvents
      .filter((event) => event.partId === track.partId
        && (!event.staffNumber || event.staffNumber === track.staffNumber)
        && (!event.voiceNumber || event.voiceNumber === track.voiceNumber))
      .map((event) => ({ ...event, beat: (measureStarts[event.measureIndex]?.startBeat || 0) + event.beatInMeasure }));

    return {
      ...track,
      notes,
      medianMidi,
      minMidi: midiValues.length ? Math.min(...midiValues) : null,
      maxMidi: midiValues.length ? Math.max(...midiValues) : null,
      playableNoteCount: pitched.length,
      lyricNoteCount: lyricCount,
      polyphonyRatio: pitched.length ? polyphonicNotes / pitched.length : 0,
      explicitRole,
      rangeRole,
      likelyVocal,
      likelyInstrument,
      expressionEvents: localEvents,
      unisonHint: {
        indicated: UNISON_WORDS.test(nameHint) || indications.length > 0,
        candidateRoles: candidateRoles.length > 1 ? candidateRoles : [],
        locations: indications.slice(0, 12),
        doubleStemCount: notes.filter((note) => note.stem === "double").length,
      },
    };
  }).filter((track) => track.playableNoteCount > 0);

  const genericVocalTracks = rawTracks.filter((track) => track.likelyVocal && !track.explicitRole);
  const orderedGeneric = [...genericVocalTracks].sort((a, b) => (b.medianMidi ?? -1) - (a.medianMidi ?? -1));
  const inferredById = new Map();

  if (orderedGeneric.length === 4) {
    ["soprano", "contralto", "tenor", "baixo"].forEach((role, index) => inferredById.set(orderedGeneric[index].id, role));
  } else if (orderedGeneric.length === 3) {
    const lowest = orderedGeneric[2]?.medianMidi;
    const roles = Number.isFinite(lowest) && lowest < 55
      ? ["soprano", "contralto", "baixo"]
      : ["soprano", "contralto", "tenor"];
    roles.forEach((role, index) => inferredById.set(orderedGeneric[index].id, role));
  } else if (orderedGeneric.length === 2) {
    const average = (orderedGeneric[0].medianMidi + orderedGeneric[1].medianMidi) / 2;
    const roles = average >= 63 ? ["soprano", "contralto"] : average <= 55 ? ["tenor", "baixo"] : ["contralto", "tenor"];
    roles.forEach((role, index) => inferredById.set(orderedGeneric[index].id, role));
  }

  const usedKeys = new Set();
  const voices = {};
  rawTracks.forEach((track, index) => {
    const role = track.explicitRole || inferredById.get(track.id) || track.rangeRole || "outra";
    const confidence = track.explicitRole ? "alta" : inferredById.has(track.id) ? "media" : "baixa";
    const partHasSeveralTracks = rawTracks.filter((candidate) => candidate.partId === track.partId).length > 1;
    const suggestedName = track.explicitRole
      ? track.partName
      : partHasSeveralTracks
        ? `${track.partName} — voz ${track.voiceNumber}`
        : track.partName || `Voz ${index + 1}`;
    const preferredKey = track.explicitRole || safeKey(suggestedName || `${role}_${index + 1}`);
    const key = uniqueVoiceKey(preferredKey, usedKeys);
    usedKeys.add(key);

    voices[key] = {
      id: key,
      sourceTrackId: track.id,
      nome: suggestedName || VOICE_ROLE_LABELS[role],
      role,
      detectionConfidence: confidence,
      // Names such as Violin/Cello often survive in vocal arrangements. Missing
      // lyrics must not silently exclude an otherwise playable melodic line.
      enabled: true,
      detectedKind: track.lyricNoteCount > 0 || track.explicitRole
        ? "vocal"
        : track.likelyInstrument ? "instrumental" : "unknown",
      notas: track.notes,
      notes: track.notes,
      letra: track.notes.filter((note) => note.lyric).map((note) => note.lyric).join(" "),
      stats: {
        playableNotes: track.playableNoteCount,
        lyricNotes: track.lyricNoteCount,
        medianMidi: track.medianMidi,
        minMidi: track.minMidi,
        maxMidi: track.maxMidi,
        polyphonyRatio: track.polyphonyRatio,
      },
      source: {
        partId: track.partId,
        partIndex: track.partIndex,
        partName: track.partName,
        staffNumber: track.staffNumber,
        globalStaffIndex: track.globalStaffIndex,
        voiceNumber: track.voiceNumber,
      },
      sourceExpressionEvents: track.expressionEvents,
      unisonHint: track.unisonHint,
    };
  });

  // Matching melodic lines stay independent. Equal pitch is not evidence that
  // two written MusicXML voices should be collapsed into one singer.
  const melodies = new Map();
  for (const voice of Object.values(voices)) {
    const signature = voice.notes.map((note) => [note.startBeat, note.durationBeats,
      note.rest ? "rest" : note.midi, Boolean(note.grace)].join(":")).join("|");
    const group = melodies.get(signature) || [];
    group.push(voice);
    melodies.set(signature, group);
  }
  for (const group of melodies.values()) {
    if (group.length < 2) continue;
    for (const voice of group) {
      voice.unisonMatchingTracks = group.filter((candidate) => candidate !== voice).map((candidate) => candidate.sourceTrackId);
      // Equal tessitura cannot establish which of several generic voices is
      // soprano/alto/tenor/bass. Keep review confidence honest.
      if (!detectExplicitRole(`${voice.source.partName} ${voice.nome}`)) voice.detectionConfidence = "baixa";
    }
  }

  return voices;
}

function buildDiagnostics(voices) {
  const list = Object.values(voices);
  const selected = list.filter((voice) => voice.enabled !== false);
  const playableNotes = selected.reduce((sum, voice) => sum + (voice.stats?.playableNotes || 0), 0);
  const lyricNotes = selected.reduce((sum, voice) => sum + (voice.stats?.lyricNotes || 0), 0);
  const warnings = [];

  if (!selected.length) warnings.push("Nenhuma linha melódica foi selecionada.");
  if (playableNotes && !lyricNotes) warnings.push("A partitura não contém sílabas vinculadas às notas; o modo cantado usará a vogal neutra ‘ah’. ");
  if (selected.some((voice) => voice.detectionConfidence === "baixa")) warnings.push("Há vozes classificadas pela tessitura; confirme os naipes antes de salvar.");
  if (selected.some((voice) => voice.detectedKind === "instrumental")) warnings.push("Há linhas com nomes de instrumentos. Todas estão selecionadas; escolha quais deseja ouvir.");
  if (list.some((voice) => voice.enabled === false)) warnings.push("Há linhas melódicas desmarcadas na seleção.");
  if (selected.some((voice) => voice.unisonHint?.indicated || voice.unisonHint?.candidateRoles?.length || voice.unisonHint?.doubleStemCount)) {
    warnings.push("Há indicação de canto conjunto ou pauta compartilhada. Confirme os naipes em uníssono; nenhuma segunda melodia é inventada.");
  }

  const lyricCoverage = playableNotes ? lyricNotes / playableNotes : 0;
  const classificationScore = selected.length
    ? selected.reduce((sum, voice) => sum + ({ alta: 1, media: 0.72, baixa: 0.42 }[voice.detectionConfidence] || 0.4), 0) / selected.length
    : 0;
  const score = Math.round((classificationScore * 0.55 + Math.min(1, playableNotes / 32) * 0.25 + Math.min(1, lyricCoverage * 2) * 0.2) * 100);

  return {
    score,
    voiceCount: selected.length,
    trackCount: list.length,
    playableNotes,
    lyricNotes,
    lyricCoverage,
    warnings,
  };
}

// Navigation is score-wide. Missing marks in another part are not contradictory
// evidence; incompatible explicit marks require a review, never discarded notes.
const NAVIGATION_FLAGS = ["repeatForward", "repeatBackward", "segno", "coda", "dalsegno", "dacapo", "toCoda", "fine"];
const navigationLimit = (measureCount) => Math.min(16384, Math.max(512, measureCount * 64));
const navigationIssue = (code, message, measureIndexes = [], severity = "review", partIds = []) =>
  ({ code, severity, message, measureIndexes, partIds });

function endingNumbers(value = "") {
  const result = new Set();
  String(value).split(/\s*,\s*/).forEach((token) => {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      // Keep huge/invalid values visible to validation without an unbounded loop.
      if (end < start || end - start > 64) { result.add(1000000); return; }
      for (let number = start; number <= end; number += 1) result.add(number);
    } else if (/^\d+$/.test(token)) result.add(Number(token));
    else if (token.trim()) result.add(1000000);
  });
  return result;
}

function readNavigation(partElement) {
  const activeEndings = new Set();
  let navigationDivisions = 1;
  const measures = Array.from(partElement?.querySelectorAll(":scope > measure") || []);
  return measures.map((measureElement, index) => {
    const endings = Array.from(measureElement.querySelectorAll(":scope > barline > ending"));
    endings.filter((ending) => ending.getAttribute("type") === "start").forEach((ending) => {
      endingNumbers(ending.getAttribute("number")).forEach((number) => activeEndings.add(number));
    });
    const repeats = Array.from(measureElement.querySelectorAll(":scope > barline > repeat"));
    const backward = repeats.find((repeat) => repeat.getAttribute("direction") === "backward");
    const directions = Array.from(measureElement.querySelectorAll(":scope > direction"));
    const words = directions.flatMap((direction) => Array.from(direction.querySelectorAll(":scope > direction-type > words")))
      .map((word) => word.textContent || "").join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const sounds = Array.from(measureElement.querySelectorAll(":scope > sound, :scope > direction > sound"));
    const soundValues = (name) => [...new Set(sounds.map((sound) => sound.getAttribute(name)).filter((value) => value !== null && value !== "" && value !== "no" && value !== "0"))];
    const hasSound = (name) => soundValues(name).length > 0;
    // Navigation is currently represented at measure boundaries. Resolve the
    // XML cursor and offsets before accepting a sign as a whole-measure jump.
    const navigationPositions = [];
    let cursor = 0;
    let measureEnd = 0;
    const navigationAttributes = ["segno", "coda", "dacapo", "dalsegno", "tocoda", "fine", "forward-repeat"];
    const isNavigationSound = (sound) => navigationAttributes.some((name) => sound.hasAttribute(name));
    const normalizeWords = (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const isNavigationDirection = (direction) => Boolean(direction.querySelector(":scope > direction-type > segno, :scope > direction-type > coda"))
      || Array.from(direction.querySelectorAll(":scope > direction-type > words")).some((word) => /\bd\.?\s*[sc]\.?\b|\b(da\s+capo|dal\s+segno|segno|coda|fine)\b/.test(normalizeWords(word.textContent)));
    Array.from(measureElement.children).forEach((element) => {
      if (element.tagName === "attributes") {
        const divisions = Number(childText(element, ":scope > divisions"));
        if (Number.isFinite(divisions) && divisions > 0) navigationDivisions = divisions;
      }
      if (element.tagName === "direction" || element.tagName === "sound") {
        const ownSounds = element.tagName === "sound" ? [element] : Array.from(element.querySelectorAll(":scope > sound"));
        const navigationSounds = ownSounds.filter(isNavigationSound);
        const directionNavigation = element.tagName === "direction" && isNavigationDirection(element);
        if (navigationSounds.length || directionNavigation) {
          const offsets = (navigationSounds.length ? navigationSounds : [element]).map((sound) => {
            const soundOffset = sound.querySelector(":scope > offset");
            const directionOffset = element.querySelector(":scope > offset");
            const offsetElement = soundOffset || directionOffset;
            const offset = offsetElement ? Number(offsetElement.textContent) : 0;
            return cursor + offset / navigationDivisions;
          });
          navigationPositions.push(...offsets);
        }
      }
      const duration = element.tagName === "note" ? durationBeats(element, navigationDivisions)
        : Number(childText(element, ":scope > duration")) / navigationDivisions;
      if (element.tagName === "note" && !element.querySelector(":scope > chord, :scope > grace") && Number.isFinite(duration)) cursor += duration;
      if (element.tagName === "backup" && Number.isFinite(duration)) cursor -= duration;
      if (element.tagName === "forward" && Number.isFinite(duration)) cursor += duration;
      measureEnd = Math.max(measureEnd, cursor);
    });
    const inMeasureNavigation = navigationPositions.some((position) => !Number.isFinite(position)
      || (Math.abs(position) > 0.001 && Math.abs(position - measureEnd) > 0.001));
    const dsWords = /\bd\.?\s*s\.?\b|\bdal\s+segno\b/.test(words);
    const dcWords = /\bda\s+capo\b|\bd\.?\s*c\.?\b/.test(words);
    const descriptor = {
      index,
      repeatForward: repeats.some((repeat) => repeat.getAttribute("direction") === "forward") || hasSound("forward-repeat"),
      repeatBackward: Boolean(backward),
      repeatTimes: backward?.hasAttribute("times") ? Number(backward.getAttribute("times")) : 2,
      repeatTimesExplicit: Boolean(backward?.hasAttribute("times")),
      repeatAfterJump: backward?.getAttribute("after-jump") || null,
      endingNumbers: [...activeEndings].sort((a, b) => a - b),
      segno: Boolean(measureElement.querySelector(":scope > direction > direction-type > segno")) || hasSound("segno") || (!dsWords && /\bsegno\b/.test(words)),
      coda: Boolean(measureElement.querySelector(":scope > direction > direction-type > coda")) || hasSound("coda") || /^\s*coda\s*$/.test(words),
      dalsegno: hasSound("dalsegno"),
      dacapo: hasSound("dacapo") || dcWords,
      toCoda: hasSound("tocoda") || (!dsWords && !dcWords && /\b(to|al)\s+coda\b/.test(words)),
      fine: hasSound("fine") || (!dsWords && !dcWords && /\bfine\b/.test(words)),
      segnoLabels: soundValues("segno"), codaLabels: soundValues("coda"),
      dsLabels: soundValues("dalsegno"), toCodaLabels: soundValues("tocoda"),
      dsWords,
      inMeasureNavigation,
      timedNavigation: sounds.some((sound) => sound.hasAttribute("time-only") && ["dacapo", "dalsegno", "tocoda", "fine"].some((name) => sound.hasAttribute(name))),
      middleNavigation: Array.from(measureElement.querySelectorAll(':scope > barline[location="middle"]')).some((barline) => barline.querySelector("repeat, ending")),
    };
    endings.filter((ending) => ["stop", "discontinue"].includes(ending.getAttribute("type"))).forEach((ending) => {
      const numbers = endingNumbers(ending.getAttribute("number"));
      if (numbers.size) numbers.forEach((number) => activeEndings.delete(number));
      else activeEndings.clear();
    });
    return descriptor;
  });
}

function reconcileNavigation(navigationByPart, partIds, measureCount) {
  const issues = [];
  const empty = (index) => ({ index, repeatTimes: 2, endingNumbers: [], segnoLabels: [], codaLabels: [], dsLabels: [], toCodaLabels: [] });
  const navigation = Array.from({ length: measureCount }, (_, index) => {
    const entries = navigationByPart.map((items) => items[index]).filter(Boolean);
    const result = { ...empty(index), ...entries[0] };
    [...NAVIGATION_FLAGS, "dsWords", "timedNavigation", "middleNavigation", "inMeasureNavigation"].forEach((key) => { result[key] = entries.some((item) => item[key]); });
    const endings = [...new Set(entries.filter((item) => item.endingNumbers.length).map((item) => JSON.stringify(item.endingNumbers)))];
    if (endings.length > 1) issues.push(navigationIssue("conflicting_endings", `Casas de repetição diferentes entre pautas no compasso ${index + 1}.`, [index]));
    result.endingNumbers = endings.length ? JSON.parse(endings[0]) : [];
    ["segnoLabels", "codaLabels", "dsLabels", "toCodaLabels"].forEach((key) => { result[key] = [...new Set(entries.flatMap((item) => item[key]))]; });
    const times = [...new Set(entries.filter((item) => item.repeatBackward && item.repeatTimesExplicit).map((item) => item.repeatTimes))];
    if (times.length > 1) issues.push(navigationIssue("conflicting_repeat_counts", `Quantidades de repetição diferentes entre pautas no compasso ${index + 1}.`, [index]));
    result.repeatTimes = times[0] ?? 2;
    result.repeatTimesExplicit = times.length > 0;
    const afterJump = [...new Set(entries.map((item) => item.repeatAfterJump).filter(Boolean))];
    if (afterJump.length > 1) issues.push(navigationIssue("conflicting_after_jump", `Repetições após o salto divergem no compasso ${index + 1}.`, [index]));
    result.repeatAfterJump = afterJump[0] || null;
    return result;
  });
  // One part may omit any subset of marks. Two incompatible nonempty positional
  // sets cannot establish a single shared roadmap safely.
  [...NAVIGATION_FLAGS, "dsWords"].forEach((key) => {
    const sets = navigationByPart.map((items) => new Set(items.filter((item) => item[key]).map((item) => item.index))).filter((set) => set.size);
    if (sets.some((a, index) => sets.slice(index + 1).some((b) => ![...a].every((value) => b.has(value)) && ![...b].every((value) => a.has(value))))) {
      issues.push(navigationIssue("conflicting_navigation_positions", "Há sinais de navegação em posições incompatíveis entre as pautas; confira a ordem de execução.", [...new Set(sets.flatMap((set) => [...set]))], "review", partIds));
    }
  });
  const signature = (items) => JSON.stringify(items.map((item) => [NAVIGATION_FLAGS.map((key) => Boolean(item[key])), item.endingNumbers, item.dsWords]));
  const reconciled = navigationByPart.some((items) => signature(items) !== signature(navigationByPart[0] || []));
  if (reconciled && !issues.length) issues.push(navigationIssue("shared_navigation", "Sinais presentes em algumas pautas foram aplicados ao conjunto para manter as vozes sincronizadas.", [], "info", partIds));

  const dsWords = navigation.filter((item) => item.dsWords);
  const explicitSegno = navigation.some((item) => item.segno);
  if (!explicitSegno && dsWords.length > 1) {
    dsWords[0].segno = true;
    dsWords[0].navigationInferred = true;
  }
  dsWords.forEach((item, index) => {
    if (explicitSegno || index > 0) item.dalsegno = true;
    if (!explicitSegno) item.navigationInferred = true;
  });
  if (!explicitSegno && dsWords.length === 1) dsWords[0].unresolvedDalsegno = true;
  const resolveTarget = (item, mark, labels, targets) => {
    const candidates = navigation.filter((candidate) => candidate[mark] && (!item[labels].length || item[labels].some((label) => candidate[targets].includes(label))));
    if (candidates.length === 1) return candidates[0].index;
    issues.push(navigationIssue(candidates.length ? "ambiguous_jump_target" : "missing_jump_target", `O salto no compasso ${item.index + 1} não tem um destino ${mark === "segno" ? "Segno" : "Coda"} único.`, [item.index]));
    return null;
  };
  navigation.forEach((item) => {
    if (item.dalsegno) item.segnoTarget = resolveTarget(item, "segno", "dsLabels", "segnoLabels");
    if (item.toCoda) item.codaTarget = resolveTarget(item, "coda", "toCodaLabels", "codaLabels");
    if (item.unresolvedDalsegno) issues.push(navigationIssue("missing_jump_target", `O D.S. no compasso ${item.index + 1} não possui Segno identificável.`, [item.index]));
    if (item.timedNavigation || item.middleNavigation || item.inMeasureNavigation) issues.push(navigationIssue("special_navigation", `O compasso ${item.index + 1} contém navegação por passagem ou dentro do compasso; escolha a execução em ordem escrita para revisar.`, [item.index]));
  });
  if (navigation.some((item) => item.navigationInferred)) issues.push(navigationIssue("inferred_navigation", "A navegação D.S. foi inferida a partir do texto; confirme a ordem de execução.", navigation.filter((item) => item.navigationInferred).map((item) => item.index)));
  return { navigation, issues, reconciled };
}

function repeatStructure(navigation) {
  const stack = [];
  const blocks = [];
  const issues = [];
  navigation.forEach((item, index) => {
    if (item.repeatForward) stack.push(index);
    if (!item.repeatBackward) return;
    const continuation = blocks.findLast((block) => index > block.end && index <= block.tail && item.endingNumbers.length);
    if (continuation) {
      if (item.repeatTimesExplicit && item.repeatTimes !== continuation.times) issues.push(navigationIssue("conflicting_ending_repeat_count", `A contagem explícita de repetição no compasso ${index + 1} não corresponde às casas numeradas.`, [index]));
      continuation.backwardIndexes.push(index);
      return;
    }
    const start = stack.length ? stack.pop() : 0;
    let tail = index;
    if (item.endingNumbers.length) {
      while (tail + 1 < navigation.length && navigation[tail + 1].endingNumbers.length && !navigation[tail + 1].repeatForward) tail += 1;
    }
    let endingStart = index;
    while (endingStart > start && navigation[endingStart - 1].endingNumbers.length) endingStart -= 1;
    const endingPasses = navigation.slice(endingStart, tail + 1).flatMap((measure) => measure.endingNumbers);
    const times = endingPasses.length ? Math.max(2, ...endingPasses) : item.repeatTimes;
    if (endingPasses.length && item.repeatTimesExplicit && item.repeatTimes !== times) issues.push(navigationIssue("conflicting_ending_repeat_count", `A contagem explícita de repetição no compasso ${index + 1} não corresponde às casas numeradas.`, [index]));
    if (!Number.isInteger(times) || times < 1 || times > 64) issues.push(navigationIssue("repeat_execution_limit", `A repetição no compasso ${index + 1} excede a execução automática ou tem contagem inválida; as notas continuam disponíveis em ordem escrita.`, [index]));
    blocks.push({ id: blocks.length, start, end: index, tail, endingStart, times, afterJump: item.repeatAfterJump, backwardIndexes: [index] });
  });
  if (stack.length) issues.push(navigationIssue("unclosed_repeat", "Há início de repetição sem fechamento identificável.", stack));
  const endingOwner = new Map();
  navigation.forEach((item, index) => {
    if (!item.endingNumbers.length) return;
    const owners = blocks.filter((block) => index >= block.endingStart && index <= block.tail).sort((a, b) => b.start - a.start);
    if (!owners.length) issues.push(navigationIssue("orphan_ending", `A casa do compasso ${index + 1} não está associada a uma repetição identificável.`, [index]));
    else endingOwner.set(index, owners[0]);
  });
  return { blocks, endingOwner, issues };
}

function buildPerformanceOrder(navigation, { repeatAfterJump = false } = {}) {
  const hasNavigation = navigation.some((item) => NAVIGATION_FLAGS.some((key) => item[key]) || item.endingNumbers.length);
  const { blocks, endingOwner, issues } = repeatStructure(navigation);
  if (issues.length) return { order: [], truncated: false, hasNavigation, issues };
  const order = [];
  const passes = new Map(blocks.map((block) => [block.id, 1]));
  const completed = new Set();
  const takenJumps = new Set();
  const takenCodas = new Set();
  const backwardOwner = new Map(blocks.flatMap((block) => block.backwardIndexes.map((index) => [index, block])));
  let index = 0;
  let afterJump = false;
  let steps = 0;
  const maxSteps = navigationLimit(navigation.length);
  while (index >= 0 && index < navigation.length && steps < maxSteps) {
    steps += 1;
    const descriptor = navigation[index];
    const endingBlock = endingOwner.get(index);
    const shouldPlay = !descriptor.endingNumbers.length || descriptor.endingNumbers.includes(passes.get(endingBlock?.id) || 1);
    if (shouldPlay) order.push(index);
    if (shouldPlay && afterJump && descriptor.fine) break;
    if (shouldPlay && afterJump && descriptor.toCoda && !takenCodas.has(index) && Number.isInteger(descriptor.codaTarget)) {
      takenCodas.add(index);
      index = descriptor.codaTarget;
      continue;
    }
    const jumpTarget = descriptor.dalsegno ? descriptor.segnoTarget : descriptor.dacapo ? 0 : null;
    if (shouldPlay && Number.isInteger(jumpTarget) && !takenJumps.has(index)) {
      takenJumps.add(index);
      afterJump = true;
      blocks.forEach((block) => {
        if (block.afterJump === "yes" || (block.afterJump !== "no" && repeatAfterJump)) { passes.set(block.id, 1); completed.delete(block.id); }
      });
      index = jumpTarget;
      continue;
    }
    const block = backwardOwner.get(index);
    if (block && shouldPlay && !completed.has(block.id)) {
      const pass = passes.get(block.id) || 1;
      if (pass < block.times) {
        passes.set(block.id, pass + 1);
        // A repeated outer section starts each of its inner repeats afresh.
        blocks.filter((child) => child.id !== block.id && child.start >= block.start && child.tail < block.tail).forEach((child) => {
          passes.set(child.id, 1); completed.delete(child.id);
        });
        index = block.start;
        continue;
      }
      completed.add(block.id);
    }
    index += 1;
  }
  const truncated = steps >= maxSteps && index < navigation.length;
  if (truncated) issues.push(navigationIssue("navigation_execution_limit", "A navegação excedeu o limite de execução automática. Use a ordem escrita para revisar, sem perder notas."));
  return { order, truncated, hasNavigation, issues };
}

function performanceTimeline(sourceMeasures, performanceOrder) {
  let runningBeat = 0;
  const occurrenceBySource = new Map();
  return performanceOrder.map((sourceMeasureIndex, performanceIndex) => {
    const source = sourceMeasures[sourceMeasureIndex];
    const occurrence = (occurrenceBySource.get(sourceMeasureIndex) || 0) + 1;
    occurrenceBySource.set(sourceMeasureIndex, occurrence);
    const durationBeats = source?.durationBeats || 4;
    const measure = {
      ...source,
      index: performanceIndex,
      performanceIndex,
      sourceMeasureIndex,
      sourceNumber: source?.number || String(sourceMeasureIndex + 1),
      occurrence,
      startBeat: runningBeat,
      endBeat: runningBeat + durationBeats,
    };
    runningBeat += durationBeats;
    return measure;
  });
}

function expandVoicesForPerformance(voices, performanceMeasures) {
  return Object.fromEntries(Object.entries(voices).map(([key, voice]) => {
    const writtenNotes = voice.notes || voice.notas || [];
    const byMeasure = new Map();
    writtenNotes.forEach((note) => {
      const list = byMeasure.get(note.measureIndex) || [];
      list.push(note);
      byMeasure.set(note.measureIndex, list);
    });
    const expandedNotes = performanceMeasures.flatMap((performanceMeasure) =>
      (byMeasure.get(performanceMeasure.sourceMeasureIndex) || []).map((note) => ({
        ...note,
        id: `${note.id}::take-${performanceMeasure.performanceIndex}`,
        sourceMeasureIndex: note.measureIndex,
        performanceMeasureIndex: performanceMeasure.performanceIndex,
        performanceOccurrence: performanceMeasure.occurrence,
        startBeat: performanceMeasure.startBeat + note.beatInMeasure,
      })),
    );
    const sourceEvents = voice.sourceExpressionEvents || [];
    const eventsByMeasure = new Map();
    sourceEvents.forEach((event) => {
      const list = eventsByMeasure.get(event.measureIndex) || [];
      list.push(event);
      eventsByMeasure.set(event.measureIndex, list);
    });
    const performanceEvents = performanceMeasures.flatMap((performanceMeasure) =>
      (eventsByMeasure.get(performanceMeasure.sourceMeasureIndex) || []).map((event) => ({
        ...event,
        beat: performanceMeasure.startBeat + event.beatInMeasure,
      })),
    );
    applyDynamics(expandedNotes, performanceEvents);
    const notes = mergeTies(expandedNotes);
    return [key, {
      ...voice,
      notes,
      notas: notes,
      writtenNotes,
      stats: {
        ...voice.stats,
        performancePlayableNotes: notes.filter((note) => !note.rest && Number.isFinite(note.midi)).length,
      },
    }];
  }));
}

function expandTempoChanges(sourceChanges, sourceMeasures, performanceMeasures) {
  const sorted = [...sourceChanges].sort((a, b) => a.beat - b.beat);
  const tempoAt = (beat) => {
    let current = sorted[0]?.bpm || DEFAULT_BPM;
    sorted.forEach((change) => { if (change.beat <= beat + 0.0001) current = change.bpm; });
    return current;
  };
  const expanded = [];
  performanceMeasures.forEach((performanceMeasure) => {
    const source = sourceMeasures[performanceMeasure.sourceMeasureIndex];
    expanded.push({ beat: performanceMeasure.startBeat, bpm: tempoAt(source?.startBeat || 0) });
    sorted.forEach((change) => {
      if (change.beat < (source?.startBeat || 0) - 0.0001 || change.beat >= (source?.endBeat || 0) - 0.0001) return;
      expanded.push({ beat: performanceMeasure.startBeat + change.beat - source.startBeat, bpm: change.bpm });
    });
  });
  return expanded
    .sort((a, b) => a.beat - b.beat)
    .filter((event, index, events) => index === 0 || Math.abs(event.beat - events[index - 1].beat) > 0.001 || event.bpm !== events[index - 1].bpm);
}

export function parseMusicXMLScore(xmlString) {
  const document = parseMusicXMLDocument(xmlString);
  const parserError = document.querySelector("parsererror");
  if (parserError || !document.querySelector("score-partwise")) {
    throw new Error("O arquivo não contém um MusicXML score-partwise válido.");
  }

  const title = childText(document, "work > work-title") || childText(document, "movement-title");
  const creators = Array.from(document.querySelectorAll("identification > creator"));
  const composer = creators.find((creator) => creator.getAttribute("type") === "composer")?.textContent?.trim() || "";
  const lyricist = creators.find((creator) => creator.getAttribute("type") === "lyricist")?.textContent?.trim() || "";

  const partDefinitions = new Map();
  Array.from(document.querySelectorAll("part-list > score-part")).forEach((part, partIndex) => {
    const id = part.getAttribute("id") || `P${partIndex + 1}`;
    partDefinitions.set(id, {
      id,
      partIndex,
      name: childText(part, ":scope > part-name", `Parte ${partIndex + 1}`),
      abbreviation: childText(part, ":scope > part-abbreviation"),
    });
  });

  const partElements = Array.from(document.querySelectorAll("score-partwise > part"));
  let staffOffset = 0;
  const parsedParts = partElements.map((part, partIndex) => {
    const id = part.getAttribute("id") || `P${partIndex + 1}`;
    const definition = partDefinitions.get(id) || { id, partIndex, name: `Parte ${partIndex + 1}`, abbreviation: "" };
    const staffCount = Math.max(1, finiteNumber(childText(part, "measure attributes staves", "1"), 1));
    const parsed = parsePart(part, { ...definition, partIndex, staffCount, staffOffset });
    staffOffset += parsed.staffCount;
    return parsed;
  });

  const measureCount = Math.max(0, ...parsedParts.map((part) => part.measures.length));
  const measureStarts = [];
  let runningBeat = 0;
  for (let measureIndex = 0; measureIndex < measureCount; measureIndex += 1) {
    const candidates = parsedParts.map((part) => part.measures[measureIndex]).filter(Boolean);
    const parsedDuration = Math.max(0, ...candidates.map((measure) => measure.parsedDurationBeats || 0));
    const nominal = candidates[0]?.nominalBeats || 4;
    const duration = parsedDuration > 0 ? parsedDuration : nominal;
    const keySignatures = parsedParts.map((part) => ({
      partId: part.id,
      partName: part.name,
      fifths: part.measures[measureIndex]?.keyFifths ?? 0,
    }));
    measureStarts.push({
      index: measureIndex,
      number: candidates[0]?.number || String(measureIndex + 1),
      startBeat: runningBeat,
      durationBeats: duration,
      endBeat: runningBeat + duration,
      timeSignature: candidates[0]?.timeSignature || "4/4",
      keySignatures,
    });
    runningBeat += duration;
  }

  const sourceDurationBeats = runningBeat;
  const expressionEvents = parsedParts.flatMap((part) => part.expressionEvents);
  const sourceVoices = finalizeTracks(parsedParts, measureStarts, expressionEvents);
  const sourceTempoChanges = expressionEvents
    .filter((event) => event.kind === "tempo")
    .map((event) => ({
      beat: (measureStarts[event.measureIndex]?.startBeat || 0) + event.beatInMeasure,
      bpm: event.bpm,
    }))
    .sort((a, b) => a.beat - b.beat)
    .filter((event, index, events) => index === 0 || Math.abs(event.beat - events[index - 1].beat) > 0.001 || event.bpm !== events[index - 1].bpm);

  const tempoExplicit = sourceTempoChanges.length > 0;
  const initialTempoExplicit = sourceTempoChanges.some((event) => event.beat <= 0.001);
  const dynamicsExplicit = expressionEvents.some((event) => event.kind === "dynamic" || event.kind === "wedge");
  if (!sourceTempoChanges.length || sourceTempoChanges[0].beat > 0) sourceTempoChanges.unshift({ beat: 0, bpm: DEFAULT_BPM });

  const navigationByPart = partElements.map(readNavigation);
  const reconciledNavigation = reconcileNavigation(navigationByPart, partElements.map((part) => part.getAttribute("id")), measureCount);
  const { navigation } = reconciledNavigation;
  const automaticPlan = buildPerformanceOrder(navigation);
  const navigationIssues = [...reconciledNavigation.issues, ...automaticPlan.issues];
  const navigationRequiresReview = navigationIssues.some((issue) => issue.severity === "review");
  const mustUseWrittenOrder = !automaticPlan.order.length || automaticPlan.truncated
    || navigationIssues.some((issue) => issue.severity === "review" && issue.code !== "inferred_navigation");
  const writtenOrder = measureStarts.map((measure) => measure.index);
  const navigationChoice = mustUseWrittenOrder || !automaticPlan.hasNavigation ? "written_order"
    : navigation.some((item) => item.navigationInferred) ? "inferred" : "score_navigation";
  const performancePlan = mustUseWrittenOrder
    ? { ...automaticPlan, order: writtenOrder, hasNavigation: false }
    : automaticPlan;
  const playbackGraph = createPlaybackGraph(measureStarts, navigation, performancePlan.order, navigationChoice);
  const performanceMeasures = performanceTimeline(measureStarts, walkPlaybackGraph(playbackGraph));
  const voices = expandVoicesForPerformance(sourceVoices, performanceMeasures);
  const tempoChanges = expandTempoChanges(sourceTempoChanges, measureStarts, performanceMeasures);
  const performanceDurationBeats = performanceMeasures.at(-1)?.endBeat || sourceDurationBeats;
  /** @type {Record<string, any>} */
  const diagnostics = {
    ...buildDiagnostics(sourceVoices),
    notationCoverage: inspectNotationCapabilities(document),
    notationAudit: auditNotation(document, { measureStarts }),
    performanceMeasureCount: performanceMeasures.length,
    performancePlayableNotes: Object.values(voices).reduce((sum, voice) => sum + (voice.stats?.performancePlayableNotes || 0), 0),
    navigationExpanded: performancePlan.hasNavigation,
    navigationInferred: navigation.some((item) => item.navigationInferred),
    navigationIssues,
    navigationRequiresReview,
    navigationReconciled: reconciledNavigation.reconciled,
    navigationFallback: mustUseWrittenOrder ? "written_order" : null,
    navigationChoice,
    tempoExplicit,
    initialTempoExplicit,
    dynamicsExplicit,
  };
  const rhythmIssues = parsedParts.flatMap((part) => part.measures.flatMap((measure) => {
    if (measure.senzaMisura) return [];
    const difference = Number(measure.parsedDurationBeats || 0) - Number(measure.nominalBeats || 0);
    if (Math.abs(difference) <= 0.03) return [];
    return [{
      partId: part.id,
      partName: part.name,
      measureIndex: measure.index,
      measureNumber: measure.number,
      parsedBeats: measure.parsedDurationBeats,
      expectedBeats: measure.nominalBeats,
    }];
  }));
  diagnostics.rhythmIssueCount = rhythmIssues.length;
  if (diagnostics.notationAudit.issueCount) diagnostics.warnings.push(`${diagnostics.notationAudit.issueCount} inconsistência(s) de notação para conferir por compasso.`);
  diagnostics.rhythmIssues = rhythmIssues.slice(0, 24);
  const divergentKeyMeasures = measureStarts
    .filter((measure) => new Set(measure.keySignatures.map((item) => item.fifths)).size > 1)
    .map((measure) => measure.number);
  diagnostics.divergentKeyMeasures = divergentKeyMeasures;
  if (rhythmIssues.length) {
    diagnostics.warnings.push(`${rhythmIssues.length} compasso(s)/pauta têm duração diferente da fórmula de compasso; confira pausas, quiálteras e anacruse.`);
  }
  if (divergentKeyMeasures.length) {
    diagnostics.warnings.push(`Há armaduras diferentes entre pautas nos compassos ${divergentKeyMeasures.join(", ")}; confirme que a divergência pertence à partitura.`);
  }
  diagnostics.warnings.push(...new Set(navigationIssues.map((issue) => issue.message)));
  if (diagnostics.notationCoverage.issueCount) {
    diagnostics.warnings.push(`${diagnostics.notationCoverage.groups.length} tipo(s) de notação têm reprodução aproximada ou somente visual; consulte os detalhes da revisão.`);
  }
  /** @type {Record<string, any>} */
  const navigationAlternatives = {
    written_order: { label: "Ordem escrita · tocar cada compasso uma vez", order: writtenOrder },
  };
  if (!mustUseWrittenOrder && automaticPlan.hasNavigation) {
    navigationAlternatives[navigationChoice] = {
      label: diagnostics.navigationInferred ? "D.S. inferido · sem refazer repetições já concluídas" : "Seguir os sinais de repetição da partitura",
      order: automaticPlan.order,
    };
  }
  const withoutJumps = navigation.map((item) => ({ ...item, segno: false, coda: false, dalsegno: false, dacapo: false, toCoda: false, fine: false }));
  const repeatPlan = buildPerformanceOrder(withoutJumps);
  const conflicts = navigationIssues.some((issue) => issue.code.startsWith("conflicting_") || ["special_navigation", "orphan_ending"].includes(issue.code));
  if (!conflicts && repeatPlan.order.length && !repeatPlan.truncated) {
    navigationAlternatives.repeats_only = { label: "Manter repetições e casas · ignorar D.S./D.C./Coda", order: repeatPlan.order };
  }
  if (!mustUseWrittenOrder && navigation.some((item) => item.dalsegno || item.dacapo)) {
    const repeatedPlan = buildPerformanceOrder(navigation, { repeatAfterJump: true });
    if (repeatedPlan.order.length && !repeatedPlan.truncated) navigationAlternatives.repeat_after_jump = {
      label: "Refazer repetições após D.S./D.C.", order: repeatedPlan.order,
    };
  }
  if (conflicts) navigationByPart.forEach((items, partIndex) => {
    const candidate = reconcileNavigation([items], [partElements[partIndex]?.getAttribute("id")], measureCount);
    const plan = buildPerformanceOrder(candidate.navigation);
    if (candidate.issues.some((issue) => issue.severity === "review") || plan.issues.length || !plan.order.length || !plan.hasNavigation) return;
    navigationAlternatives[`part_${partIndex + 1}`] = {
      label: `Seguir somente os sinais de ${parsedParts[partIndex]?.name || `pauta ${partIndex + 1}`}`,
      order: plan.order,
      requiresReview: true,
    };
  });

  return withScoreEngineV2({
    schemaVersion: SCORE_MODEL_VERSION,
    metadata: {
      title,
      composer,
      lyricist,
      initialBpm: tempoChanges[0]?.bpm || DEFAULT_BPM,
      tempoExplicit,
      initialTempoExplicit,
      dynamicsExplicit,
      durationBeats: performanceDurationBeats,
      sourceDurationBeats,
      measureCount,
      measures: measureStarts,
      sourceMeasures: measureStarts,
      performanceMeasureCount: performanceMeasures.length,
      performanceMeasures,
      performanceOrder: performancePlan.order,
      navigationAlternatives,
      navigationChoice,
      navigation,
      tempoChanges,
      sourceTempoChanges,
      staffCount: staffOffset,
    },
    diagnostics,
    voices,
  }, parsedParts);
}

function normalizeLegacyNote(note, cursorBeat, index) {
  const duration = Number.isFinite(Number(note?.durationBeats))
    ? Number(note.durationBeats)
    : Number.isFinite(Number(note?.duracao))
      ? Number(note.duracao) * 2
      : (TYPE_TO_BEATS[note?.type] || 1);
  const startBeat = Number.isFinite(Number(note?.startBeat)) ? Number(note.startBeat) : cursorBeat;
  const frequency = finiteNumber(note?.frequencia ?? note?.freq ?? note?.frequency, 0);
  const lyric = String(note?.letra ?? note?.lyric ?? "").trim();
  const rest = note?.rest === true || note?.nota === "rest" || frequency <= 0;

  return {
    ...note,
    id: note?.id || `legacy-${index}`,
    startBeat,
    beatInMeasure: Number.isFinite(Number(note?.beatInMeasure)) ? Number(note.beatInMeasure) : startBeat % 4,
    durationBeats: Math.max(0.01, duration),
    duracao: Math.max(0.01, duration) / 2,
    frequencia: frequency,
    frequency,
    letra: lyric,
    lyric,
    rest,
    nota: rest ? "rest" : (note?.nota || ""),
    velocity: Math.max(0.08, Math.min(1, finiteNumber(note?.velocity, 0.68))),
    measureIndex: Number.isFinite(Number(note?.measureIndex)) ? Number(note.measureIndex) : Math.floor(startBeat / 4),
    measure: note?.measure || String(Math.floor(startBeat / 4) + 1),
    globalStaffIndex: Number.isFinite(Number(note?.globalStaffIndex)) ? Number(note.globalStaffIndex) : 0,
  };
}

export function normalizeScoreModel(value, xmlString = "") {
  const usableVoices = value?.voices && Object.values(value.voices).some((voice) =>
    Array.isArray(voice?.notes || voice?.notas),
  );
  if (value?.schemaVersion >= SCORE_MODEL_VERSION && usableVoices && value?.metadata) return value;
  if (value?.schemaVersion === 3 && usableVoices && value?.metadata && xmlString) {
    const parsed = parseMusicXMLScore(xmlString);
    return withScoreEngineV2({ ...value, schemaVersion: SCORE_MODEL_VERSION, parts: parsed.parts });
  }
  if ((value?.voices || value?.voiceSummary) && xmlString) {
    const parsed = parseMusicXMLScore(xmlString);
    const previous = Object.values(value.voices || value.voiceSummary || {}).filter((voice) => !voice.unisonCopy);
    const allowPositionalFallback = Number(value?.storageVersion || 0) < 2;
    const review = {};
    Object.entries(parsed.voices).forEach(([key, voice], index) => {
      const sameSource = previous.find((candidate) => candidate?.sourceTrackId && candidate.sourceTrackId === voice.sourceTrackId)
        || previous.find((candidate) => candidate?.source?.partId === voice.source?.partId
          && candidate?.source?.staffNumber === voice.source?.staffNumber
          && String(candidate?.source?.voiceNumber) === String(voice.source?.voiceNumber))
        || (allowPositionalFallback ? previous[index] : null);
      review[key] = {
        enabled: sameSource?.enabled !== false,
        role: sameSource?.role || voice.role,
        name: sameSource?.nome || sameSource?.name || voice.nome,
        polyphonyMode: sameSource?.polyphonyMode || voice.polyphonyMode || "all",
        unisonRoles: normalizeUnisonRoles(sameSource?.unisonRoles, sameSource?.role || voice.role),
      };
    });
    return applyVoiceReview(parsed, review);
  }
  if ((!value || typeof value !== "object") && xmlString) return parseMusicXMLScore(xmlString);

  const legacyVoices = value?.voices || value || {};
  const voices = {};
  let durationBeats = 0;

  Object.entries(legacyVoices).forEach(([key, voice], voiceIndex) => {
    if (!voice || !Array.isArray(voice.notas || voice.notes)) return;
    let cursorBeat = 0;
    const notes = (voice.notas || voice.notes).map((note, noteIndex) => {
      const normalized = normalizeLegacyNote(note, cursorBeat, noteIndex);
      cursorBeat = Math.max(cursorBeat, normalized.startBeat + normalized.durationBeats);
      durationBeats = Math.max(durationBeats, cursorBeat);
      return normalized;
    });
    const role = detectExplicitRole(`${key} ${voice.nome || ""}`) || roleFromRange(median(notes.filter((note) => !note.rest && note.midi).map((note) => note.midi)));
    voices[key] = {
      ...voice,
      id: key,
      nome: voice.nome || VOICE_ROLE_LABELS[role] || `Voz ${voiceIndex + 1}`,
      role,
      enabled: voice.enabled !== false,
      detectionConfidence: detectExplicitRole(`${key} ${voice.nome || ""}`) ? "alta" : "baixa",
      notas: notes,
      notes,
      letra: voice.letra || notes.filter((note) => note.lyric).map((note) => note.lyric).join(" "),
      source: voice.source || { partIndex: voiceIndex, staffNumber: 1, globalStaffIndex: voiceIndex, voiceNumber: "1" },
      stats: voice.stats || {
        playableNotes: notes.filter((note) => !note.rest).length,
        lyricNotes: notes.filter((note) => note.lyric).length,
      },
    };
  });

  const measureCount = Math.max(1, Math.ceil(durationBeats / 4));
  const measures = Array.from({ length: measureCount }, (_, index) => ({
    index,
    number: String(index + 1),
    startBeat: index * 4,
    durationBeats: Math.min(4, Math.max(0, durationBeats - index * 4)) || 4,
    endBeat: Math.min(durationBeats, (index + 1) * 4),
    timeSignature: "4/4",
  }));

  return {
    schemaVersion: SCORE_MODEL_VERSION,
    metadata: {
      title: "",
      composer: "",
      lyricist: "",
      initialBpm: DEFAULT_BPM,
      durationBeats,
      measureCount,
      measures,
      sourceMeasures: measures,
      performanceMeasureCount: measureCount,
      performanceMeasures: measures.map((measure) => ({ ...measure, performanceIndex: measure.index, sourceMeasureIndex: measure.index, occurrence: 1 })),
      performanceOrder: measures.map((measure) => measure.index),
      tempoChanges: [{ beat: 0, bpm: DEFAULT_BPM }],
      staffCount: Object.keys(voices).length,
      legacy: true,
    },
    diagnostics: buildDiagnostics(voices),
    voices,
  };
}

export function parseMusicXML(xmlString) {
  return parseMusicXMLScore(xmlString).voices;
}

export function enabledVoices(scoreModel) {
  return Object.fromEntries(Object.entries(scoreModel?.voices || {}).filter(([, voice]) => {
    if (voice.enabled === false) return false;
    const notes = voice.notes || voice.notas;
    if (Array.isArray(notes)) return notes.some((note) => !note.rest && Number(note.frequency ?? note.frequencia ?? note.freq) > 0);
    return Number(voice.stats?.playableNotes) > 0;
  }));
}

export function measureRangeToBeats(scoreModel, startMeasure, endMeasure) {
  const performanceMeasures = scoreModel?.metadata?.performanceMeasures || [];
  const measures = scoreModel?.diagnostics?.navigationExpanded && performanceMeasures.length
    ? performanceMeasures
    : (scoreModel?.metadata?.measures || []);
  const startIndex = Math.max(0, Math.min(measures.length - 1, Number(startMeasure || 1) - 1));
  const endIndex = Math.max(startIndex, Math.min(measures.length - 1, Number(endMeasure || startMeasure || 1) - 1));
  return {
    startBeat: measures[startIndex]?.startBeat || 0,
    endBeat: measures[endIndex]?.endBeat || scoreModel?.metadata?.durationBeats || 0,
  };
}

export function applyPerformanceOrder(scoreModel, requestedOrder, navigationChoice = "custom") {
  const sourceMeasures = scoreModel?.metadata?.sourceMeasures || scoreModel?.metadata?.measures || [];
  const measureCount = sourceMeasures.length;
  if (!measureCount || !Array.isArray(requestedOrder) || !requestedOrder.length) return scoreModel;
  const order = requestedOrder.map((value) => Number(value));
  if (order.length > navigationLimit(measureCount)
    || order.some((value) => !Number.isInteger(value) || value < 0 || value >= measureCount)) {
    throw new Error("A ordem de execução escolhida é inválida.");
  }

  const playbackGraph = createPlaybackGraph(sourceMeasures, scoreModel.metadata?.navigation, order, navigationChoice);
  const performanceMeasures = performanceTimeline(sourceMeasures, walkPlaybackGraph(playbackGraph));
  const sourceVoices = Object.fromEntries(Object.entries(scoreModel?.voices || {}).map(([key, voice]) => {
    const writtenNotes = voice.writtenNotes?.length ? voice.writtenNotes : (voice.notes || voice.notas || []);
    return [key, { ...voice, notes: writtenNotes, notas: writtenNotes, writtenNotes }];
  }));
  const voices = expandVoicesForPerformance(sourceVoices, performanceMeasures);
  const sourceTempoChanges = scoreModel?.metadata?.sourceTempoChanges || scoreModel?.metadata?.tempoChanges || [{ beat: 0, bpm: DEFAULT_BPM }];
  const tempoChanges = expandTempoChanges(sourceTempoChanges, sourceMeasures, performanceMeasures);
  const linear = order.length === measureCount && order.every((value, index) => value === index);

  return withScoreEngineV2({
    ...scoreModel,
    metadata: {
      ...scoreModel.metadata,
      durationBeats: performanceMeasures.at(-1)?.endBeat || 0,
      performanceMeasureCount: performanceMeasures.length,
      performanceMeasures,
      performanceOrder: order,
      tempoChanges,
      navigationChoice,
    },
    diagnostics: {
      ...(scoreModel.diagnostics || {}),
      navigationExpanded: !linear,
      navigationChoice,
      navigationFallback: navigationChoice === "written_order" && scoreModel?.diagnostics?.navigationRequiresReview ? "written_order" : null,
      performanceMeasureCount: performanceMeasures.length,
      performancePlayableNotes: Object.values(voices).reduce((sum, voice) => sum + (voice.stats?.performancePlayableNotes || 0), 0),
    },
    voices,
  });
}

export function applyStudyTempo(scoreModel, requestedBpm, userSet = true) {
  const bpm = Math.max(40, Math.min(200, Math.round(Number(requestedBpm) || DEFAULT_BPM)));
  const previous = Math.max(20, Number(scoreModel?.metadata?.initialBpm) || DEFAULT_BPM);
  if (scoreModel?.metadata?.initialTempoExplicit || (bpm === previous && !userSet)) return scoreModel;
  const ratio = bpm / previous;
  const scale = (changes) => (changes || []).map((change) => ({ ...change, bpm: Number(change.bpm || previous) * ratio }));
  return {
    ...scoreModel,
    tempoMap: scale(scoreModel?.metadata?.tempoChanges),
    metadata: {
      ...scoreModel.metadata,
      initialBpm: bpm,
      tempoChanges: scale(scoreModel?.metadata?.tempoChanges),
      sourceTempoChanges: scale(scoreModel?.metadata?.sourceTempoChanges),
      studyBpmUserSet: userSet,
    },
  };
}

function selectPolyphonicLine(notes, mode) {
  if (!Array.isArray(notes) || mode === "all") return notes || [];
  const groups = new Map();
  notes.forEach((note) => {
    // Grace ornaments share score time with the following principal note, but
    // are sequential events rather than alternative notes of the same chord.
    const key = note?.grace
      ? `grace:${note.id || note.sourceIndex}`
      : Number(note?.startBeat || 0).toFixed(5);
    const group = groups.get(key) || [];
    group.push(note);
    groups.set(key, group);
  });

  return [...groups.values()].flatMap((group) => {
    const pitched = group.filter((note) => !note.rest && Number.isFinite(Number(note.midi)));
    if (pitched.length <= 1) return group;
    const chosen = pitched.reduce((best, note) => {
      if (!best) return note;
      return mode === "upper"
        ? (Number(note.midi) > Number(best.midi) ? note : best)
        : (Number(note.midi) < Number(best.midi) ? note : best);
    }, null);
    const lyricSource = pitched.find((note) => String(note.lyric || note.letra || "").trim());
    const selected = lyricSource && !String(chosen.lyric || chosen.letra || "").trim()
      ? {
          ...chosen,
          letra: lyricSource.letra,
          lyric: lyricSource.lyric,
          syllabic: lyricSource.syllabic,
          lyricExtend: lyricSource.lyricExtend,
          lyricExtendType: lyricSource.lyricExtendType,
          verse: lyricSource.verse,
        }
      : chosen;
    return [...group.filter((note) => note.rest), selected];
  }).sort((left, right) => Number(left.startBeat || 0) - Number(right.startBeat || 0) || Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0));
}

function reviewedVoiceStats(voice, notes, writtenNotes) {
  const performedPitched = notes.filter((note) => !note.rest && Number.isFinite(Number(note.midi)));
  const writtenPitched = (writtenNotes?.length ? writtenNotes : notes)
    .filter((note) => !note.rest && Number.isFinite(Number(note.midi)));
  const midi = writtenPitched.map((note) => Number(note.midi));
  return {
    ...(voice.stats || {}),
    playableNotes: writtenPitched.length,
    performancePlayableNotes: performedPitched.length,
    lyricNotes: writtenPitched.filter((note) => String(note.lyric || note.letra || "").trim()).length,
    medianMidi: median(midi),
    minMidi: midi.length ? Math.min(...midi) : null,
    maxMidi: midi.length ? Math.max(...midi) : null,
    polyphonyRatio: 0,
  };
}

export function applyVoiceReview(scoreModel, review) {
  const usedKeys = new Set();
  const voices = {};

  Object.entries(scoreModel?.voices || {}).filter(([, voice]) => !voice.unisonCopy).forEach(([sourceKey, voice], index) => {
    const choice = review?.[sourceKey] || {};
    if (choice.enabled === false) return;
    const role = choice.role || voice.role || "outra";
    const name = String(choice.name || voice.nome || VOICE_ROLE_LABELS[role] || `Voz ${index + 1}`).trim();
    const preferred = role !== "outra" ? role : safeKey(name);
    const key = uniqueVoiceKey(preferred, usedKeys);
    const polyphonyMode = ["upper", "lower", "all"].includes(choice.polyphonyMode) ? choice.polyphonyMode : (voice.polyphonyMode || "all");
    const unisonRoles = normalizeUnisonRoles(choice.unisonRoles ?? voice.unisonRoles, role);
    const unisonGroupId = unisonRoles.length ? (voice.unisonGroupId || `unison:${voice.sourceTrackId || sourceKey}`) : undefined;
    const reviewedNotes = selectPolyphonicLine(voice.notes || voice.notas || [], polyphonyMode);
    const reviewedWrittenNotes = selectPolyphonicLine(voice.writtenNotes || [], polyphonyMode);
    usedKeys.add(key);
    voices[key] = {
      ...voice,
      id: key,
      nome: name,
      role,
      enabled: true,
      polyphonyMode,
      notes: reviewedNotes,
      notas: reviewedNotes,
      writtenNotes: reviewedWrittenNotes,
      stats: polyphonyMode === "all" ? voice.stats : reviewedVoiceStats(voice, reviewedNotes, reviewedWrittenNotes),
      unisonRoles,
      unisonGroupId,
      unisonSourceRole: unisonRoles.length ? role : undefined,
      unisonSourceName: unisonRoles.length ? name : undefined,
      unisonCopy: false,
    };
    for (const singerRole of unisonRoles) {
      const singerKey = uniqueVoiceKey(singerRole, usedKeys);
      usedKeys.add(singerKey);
      const notes = reviewedNotes.map((note) => ({ ...note }));
      voices[singerKey] = {
        ...voices[key],
        id: singerKey,
        role: singerRole,
        nome: `${VOICE_ROLE_LABELS[singerRole]} · ${name}`,
        unisonCopy: true,
        unisonRoles: [],
        notes,
        notas: notes,
        writtenNotes: reviewedWrittenNotes.map((note) => ({ ...note })),
        stats: { ...voices[key].stats },
      };
    }
  });

  const next = { ...scoreModel, voices };
  const refreshed = buildDiagnostics(voices);
  next.diagnostics = {
    ...(scoreModel?.diagnostics || {}),
    ...refreshed,
    warnings: [...new Set([...(scoreModel?.diagnostics?.warnings || []), ...refreshed.warnings])],
    unisonGroups: Object.values(voices).filter((voice) => !voice.unisonCopy && voice.unisonRoles?.length)
      .map((voice) => ({ sourceTrackId: voice.sourceTrackId, roles: [voice.role, ...voice.unisonRoles] })),
  };
  return next;
}
