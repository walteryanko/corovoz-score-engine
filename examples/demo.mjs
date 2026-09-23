import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
globalThis.DOMParser=DOMParser;
const {parseMusicXMLScore}=await import('../src/lib/musicxml-parser.js');
const score=parseMusicXMLScore(await readFile(new URL('./synthetic-satb.musicxml',import.meta.url),'utf8'));
console.log(JSON.stringify({schemaVersion:score.schemaVersion,engineVersion:score.engineVersion,parts:score.parts.map(p=>({id:p.id,name:p.name,measures:p.measures.length})),validation:score.validation,performanceOrder:score.metadata.performanceOrder},null,2));
