/** Additive domain contract. The v1 player projection remains available. */
export const SCORE_ENGINE_VERSION = '2.0.0';
export const PROCESSING_STATES = Object.freeze(['uploaded', 'preprocessing', 'omr_running', 'partially_complete', 'normalizing', 'validating', 'needs_review', 'ready', 'failed']);
export const FEATURE_FLAGS = Object.freeze({ score_engine_v2: true, neural_voice: false, neural_choir: false, custom_voice: false });
const EPS = 1e-5;

/** A bounded execution graph: source nodes and explicit performance transitions.
 * Repeat semantics are resolved by the existing tested navigation interpreter;
 * all projections traverse these edges rather than independently expanding repeats.
 */
export function createPlaybackGraph(measures, navigation, order, choice = 'score_navigation') {
  if (!Array.isArray(order) || !order.length || order.length > Math.max(512, measures.length * 128)) throw new Error('Navegação vazia ou acima do limite.');
  if (order.some(i => !Number.isInteger(i) || !measures[i])) throw new Error('A navegação aponta para um compasso inexistente.');
  return {
    version: 1, choice, entry: order[0],
    nodes: measures.map((m, index) => ({ id: index, number: m.number, durationBeats: m.durationBeats, signs: navigation?.[index] || {} })),
    edges: order.map((from, visit) => ({ id: visit, from, to: order[visit + 1] ?? null,
      kind: visit === order.length - 1 ? 'end' : order[visit + 1] === from + 1 ? 'next' : order[visit + 1] <= from ? 'return' : 'skip' })),
    execution: order.map((_, i) => i),
  };
}

export function walkPlaybackGraph(graph) {
  if (graph?.version !== 1 || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.execution) || !graph.execution.length || graph.execution.length > Math.max(512, graph.nodes.length * 128)) throw new Error('Grafo de reprodução inválido.');
  let current = graph.entry;
  const order = [];
  for (const id of graph.execution) {
    const edge = graph.edges[id];
    if (!edge || edge.from !== current || !graph.nodes[current]) throw new Error('Transição musical inconsistente.');
    order.push(current); current = edge.to;
  }
  if (current !== null) throw new Error('A navegação foi truncada.');
  return order;
}

export function normalizeInternalParts(parsedParts, measures) {
  return parsedParts.map(part => {
    // Bucket once: a large score must not rescan every note for every measure.
    const buckets = new Map();
    for (const track of part.tracks) for (const note of track.notes) {
      if (!buckets.has(note.measureIndex)) buckets.set(note.measureIndex, new Map());
      const voices = buckets.get(note.measureIndex);
      if (!voices.has(track.id)) voices.set(track.id, { id: track.id, voice: track.voiceNumber, staff: track.staffNumber, events: [] });
      voices.get(track.id).events.push({ ...note, startBeat: (measures[note.measureIndex]?.startBeat || 0) + note.beatInMeasure });
    }
    return { id: part.id, name: part.name, staves: part.staffCount,
      measures: part.measures.map(m => ({ ...m, startBeat: measures[m.index]?.startBeat || 0, voices: [...(buckets.get(m.index)?.values() || [])] })) };
  });
}

/** Validation is structural evidence, never an invented recognition confidence. */
export function validateInternalScore(model) {
  const issues = [];
  const add = (code, message, location = {}, severity = 'review') => issues.push({ code, message, severity, ...location });
  const parts = model.parts || [];
  const expectedCount = model.metadata?.measureCount || 0;
  if (!parts.length) add('missing_parts', 'Reabra o MusicXML para validar as partes do modelo.');
  let checkedMeasures = 0, validMeasures = 0, checkedNotes = 0, lyricNotes = 0;
  if (!expectedCount || !Object.values(model.voices || {}).some(v => v.notes?.some(n => !n.rest))) add('no_music', 'Nenhuma nota com altura definida foi reconhecida.', {}, 'error');
  if (model.metadata?.legacy) add('legacy_model', 'Modelo antigo: reabra o MusicXML para validar a estrutura.');
  for (const part of parts) {
    if (part.measures.length !== expectedCount) add('part_measure_count', 'A quantidade de compassos difere entre as partes.', { partId: part.id });
    for (const m of part.measures) {
      checkedMeasures++;
      const location = { partId: part.id, partName: part.name, measureIndex: m.index, measureNumber: m.number };
      const actual = Number(m.parsedDurationBeats), nominal = Number(m.nominalBeats);
      const pickup = m.implicit && actual > 0 && actual < nominal;
      const first = part.measures[0];
      const closesPickup = m.index === part.measures.length - 1 && first?.implicit && first.parsedDurationBeats < nominal && Math.abs(actual + first.parsedDurationBeats - nominal) < EPS;
      if (m.senzaMisura || pickup || closesPickup || Math.abs(actual - nominal) < EPS) validMeasures++;
      else add('measure_duration', `Duração ${actual} semínimas; esperadas ${nominal}. Confira pausas, vozes e anacruse.`, location);
      const reference = parts[0]?.measures[m.index];
      if (reference && reference.timeSignature !== m.timeSignature) add('meter_mismatch', 'Fórmulas de compasso diferentes entre partes.', location);
      for (const voice of m.voices || []) for (const n of voice.events) {
        checkedNotes++;
        if (n.lyric) lyricNotes++;
        if (!Number.isFinite(n.durationBeats) || n.durationBeats < 0 || !Number.isFinite(n.beatInMeasure) || n.beatInMeasure < 0) add('invalid_timing', 'Nota com duração ou posição inválida.', { ...location, noteId: n.id }, 'error');
        if (!n.rest && (!Number.isFinite(n.midi) || n.midi < 0 || n.midi > 127)) add('invalid_pitch', 'Altura fora da faixa de reprodução.', { ...location, noteId: n.id }, 'error');
      }
    }
  }
  for (const issue of model.diagnostics?.navigationIssues || []) if (issue.severity === 'review') add(issue.code, issue.message, { measureIndexes: issue.measureIndexes });
  if (model.diagnostics?.notationCoverage?.issueCount) add('notation_limit', 'Há notação aproximada ou somente visual. Consulte a revisão musical.');
  if (model.diagnostics?.notationAudit?.issueCount) add('notation_audit', 'Há símbolos ou ligaduras que precisam de conferência.');
  if (model.diagnostics?.divergentKeyMeasures?.length) add('key_mismatch', 'Armaduras diferentes entre partes precisam de conferência.');
  if (model.diagnostics?.sourceGeometry?.requiresReview || model.diagnostics?.sourceComparison?.requiresReview || model.diagnostics?.completenessVerified === false) add('source_review', 'A cobertura e a correspondência com o original ainda precisam de conferência.');
  const tempoAtBeat = new Map();
  for (const change of model.metadata?.sourceTempoChanges || []) {
    const beat = Number(change.beat).toFixed(5);
    if (tempoAtBeat.has(beat) && Math.abs(tempoAtBeat.get(beat) - change.bpm) > EPS) add('tempo_conflict', 'Há andamentos divergentes na mesma posição musical.');
    tempoAtBeat.set(beat, change.bpm);
  }
  try { if (model.playbackGraph) walkPlaybackGraph(model.playbackGraph); else add('missing_graph', 'Reabra o MusicXML para reconstruir a navegação.'); }
  catch (e) { add('invalid_graph', e.message, {}, 'error'); }
  const errors = issues.filter(i => i.severity === 'error').length;
  return { version: 1, state: errors ? 'failed' : issues.length ? 'needs_review' : 'ready', readyForRehearsal: !issues.length,
    issues, metrics: { measureIntegrity: checkedMeasures ? { passed: validMeasures, checked: checkedMeasures } : null,
      noteAccuracy: null, rhythmAccuracy: null, lyricAlignment: null, partAssignment: null,
      checkedEvents: checkedNotes, eventsWithLyrics: lyricNotes }, recognitionConfidence: null };
}

export function withScoreEngineV2(model, parsedParts = null) {
  if (!FEATURE_FLAGS.score_engine_v2) return model;
  const measures = model.metadata?.sourceMeasures || model.metadata?.measures || [];
  const order = model.metadata?.performanceOrder || measures.map(m => m.index);
  const next = { ...model, engineVersion: SCORE_ENGINE_VERSION,
    parts: parsedParts ? normalizeInternalParts(parsedParts, measures) : (model.parts || []),
    playbackGraph: createPlaybackGraph(measures, model.metadata?.navigation, order, model.metadata?.navigationChoice),
    tempoMap: model.metadata?.tempoChanges || [],
    meterMap: measures.map(m => ({ measureIndex: m.index, beat: m.startBeat, timeSignature: m.timeSignature })),
    keyMap: measures.map(m => ({ measureIndex: m.index, beat: m.startBeat, keys: m.keySignatures || [] })),
  };
  next.validation = validateInternalScore(next);
  next.processingState = next.validation.state;
  return next;
}

export function processingStateForRegions(regions, phase = 'omr_running') {
  if (!PROCESSING_STATES.includes(phase)) throw new Error('Estado de processamento desconhecido.');
  const completed = regions.filter(r => r.status === 'completed' || r.status === 'ready').length;
  const failed = regions.filter(r => r.status === 'failed' || r.status === 'error').length;
  return { state: failed ? completed ? 'partially_complete' : 'failed' : phase,
    total: regions.length, completed, failed, retry: regions.filter(r => r.status === 'failed' || r.status === 'error').map(r => ({ page: r.pageNumber, system: r.systemNumber })) };
}

/** Ground-truth metrics require a manually verified reference; null without it. */
export function compareGoldenEvents(actual, reference, { actualOrder = null, referenceOrder = null } = {}) {
  if (!Array.isArray(reference) || !reference.length) return null;
  const fields = { noteAccuracy: 'midi', rhythmAccuracy: 'durationBeats', lyricAlignment: 'lyric', partAssignment: 'partId', onsetAccuracy: 'startBeat', measureAssignment: 'measureIndex' };
  const denominator = Math.max(actual.length, reference.length);
  const metrics = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, { matched: reference.filter((r, i) => actual[i] && (typeof r[field] === 'number' ? Math.abs(actual[i][field] - r[field]) < EPS : actual[i][field] === r[field])).length, total: denominator }]));
  return { ...metrics, repeatIntegrity: Array.isArray(referenceOrder) && referenceOrder.length && Array.isArray(actualOrder)
    ? { matched: referenceOrder.filter((measure, i) => actualOrder[i] === measure).length, total: Math.max(actualOrder.length, referenceOrder.length) } : null };
}
