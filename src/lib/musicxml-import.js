import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";

// Only the manifest and the score are inflated. Images/audio inside an MXL are
// never opened or fetched. These limits also apply before ZIP metadata is read.
export const MUSICXML_IMPORT_LIMITS = Object.freeze({
  fileBytes: 32 * 1024 * 1024,
  scoreBytes: 16 * 1024 * 1024,
  containerBytes: 64 * 1024,
  zipEntries: 2048,
  nestingDepth: 128,
  elements: 250000,
  declaredArchiveBytes: 256 * 1024 * 1024,
});

class MusicXMLImportError extends Error {
  constructor(message) {
    super(message);
    this.name = "MusicXMLImportError";
  }
}

const fail = (message) => { throw new MusicXMLImportError(message); };
const elements = (node) => Array.from(node?.children || []);
const named = (node, name) => elements(node).filter((child) => child.localName === name);
const serialize = (doc) => (typeof XMLSerializer === "function"
  ? new XMLSerializer().serializeToString(doc)
  : doc.toString()) // linkedom implements Document#toString for non-browser tests.
  .replace(/^(\s*<\?xml\b[^?]*\bencoding\s*=\s*)["'][^"']*["']/i, '$1"UTF-8"');

function parseXML(xml, description) {
  if (typeof xml !== "string" || !xml.trim()) fail(`${description} está vazio.`);
  if (new TextEncoder().encode(xml).byteLength > MUSICXML_IMPORT_LIMITS.scoreBytes) {
    fail("O MusicXML descompactado ultrapassa 16 MB. Divida a obra em movimentos menores.");
  }
  // Standard external DOCTYPE identifiers are common in MusicXML 1–4. They
  // may be discarded safely; entity declarations and internal DTD subsets are
  // refused, so no parser or later renderer can resolve an external entity.
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE\s[^>]*\[/i.test(xml)) {
    fail("O MusicXML contém definições XML externas ou entidades não suportadas. Exporte novamente como MusicXML sem entidades personalizadas.");
  }
  const clean = xml.replace(/<!DOCTYPE\s+(?:[^>"']|"[^"]*"|'[^']*')*>/gi, "");
  if (XMLValidator.validate(clean) !== true) {
    fail(`${description} contém XML malformado. Exporte novamente o arquivo no editor de partituras.`);
  }
  let depth = 0, count = 0;
  for (const match of clean.matchAll(/<(?:!--[\s\S]*?--|!\[CDATA\[[\s\S]*?\]\]|\?[\s\S]*?\?|(?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const token = match[0];
    if (/^<[!?]/.test(token)) continue;
    if (/^<\//.test(token)) { depth--; continue; }
    count++; if (!/\/>$/.test(token)) depth++;
    if (depth > MUSICXML_IMPORT_LIMITS.nestingDepth || count > MUSICXML_IMPORT_LIMITS.elements) fail("Estrutura XML acima do limite de segurança. Divida a obra em movimentos menores.");
  }
  const doc = new DOMParser().parseFromString(clean, "application/xml");
  if (!doc.documentElement || doc.getElementsByTagName("parsererror").length) {
    fail(`${description} não pôde ser lido como XML.`);
  }
  return doc;
}

function partIds(root) {
  const lists = named(root, "part-list");
  if (lists.length !== 1) fail("A partitura precisa de uma lista única de partes musicais (part-list).");
  const ids = named(lists[0], "score-part").map((part) => part.getAttribute("id"));
  if (!ids.length || ids.some((id) => !id?.trim()) || new Set(ids).size !== ids.length) {
    fail("A lista de partes contém identificadores ausentes ou repetidos. Corrija a exportação da partitura.");
  }
  return ids;
}

function validateParts(container, ids, description) {
  const parts = named(container, "part");
  const byId = new Map();
  for (const part of parts) {
    const id = part.getAttribute("id");
    if (!ids.includes(id) || byId.has(id)) {
      fail(`${description} contém uma parte desconhecida ou repetida (${id || "sem identificador"}).`);
    }
    byId.set(id, part);
  }
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) fail(`${description} está incompleto: falta a parte ${missing.join(", ")}. Nenhuma pausa foi inventada para substituí-la.`);
  return byId;
}

/** Return an independent partwise document, keeping every musical child node. */
export function normalizeMusicXMLDocument(document) {
  return normalizeParsedDocument(parseXML(serialize(document), "O arquivo MusicXML"));
}

function normalizeParsedDocument(doc) {
  const root = doc.documentElement;
  if (root.localName === "opus") {
    fail("Este arquivo reúne várias obras (opus). Exporte cada obra como um MusicXML separado para escolher suas vozes.");
  }
  if (!["score-partwise", "score-timewise"].includes(root.localName)) {
    fail("O arquivo não contém uma partitura MusicXML (score-partwise ou score-timewise).");
  }
  const ids = partIds(root);
  if (root.localName === "score-partwise") {
    const parts = validateParts(root, ids, "A partitura");
    for (const [id, part] of parts) {
      if (!named(part, "measure").length) fail(`A parte ${id} não contém compassos.`);
    }
    return doc;
  }

  const measures = named(root, "measure");
  if (!measures.length) fail("A partitura não contém compassos.");
  const replacement = doc.createElementNS(root.namespaceURI, "score-partwise");
  for (const attribute of Array.from(root.attributes)) replacement.setAttribute(attribute.name, attribute.value);
  // The header (work/identification/defaults/credits/part-list) stays verbatim,
  // including comments, unknown annotations, namespace declarations and order.
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1 || /** @type {Element} */ (child).localName !== "measure") replacement.appendChild(child.cloneNode(true));
  }
  const outputParts = new Map(ids.map((id) => {
    const part = doc.createElementNS(root.namespaceURI, "part");
    part.setAttribute("id", id);
    replacement.appendChild(part);
    return [id, part];
  }));
  measures.forEach((measure, index) => {
    const label = measure.getAttribute("number") || String(index + 1);
    const sources = validateParts(measure, ids, `O compasso ${label}`);
    if (elements(measure).some((child) => child.localName !== "part")) {
      fail(`O compasso ${label} contém conteúdo fora de suas partes. Corrija a exportação MusicXML para preservar a música.`);
    }
    for (const id of ids) {
      const source = sources.get(id);
      // timewise part only carries its ID. Extra attributes have no equivalent
      // on a partwise measure; reject rather than silently discard them.
      if (Array.from(source.attributes).some((attribute) => attribute.name !== "id" && !attribute.name.startsWith("xmlns"))) {
        fail(`A parte ${id} do compasso ${label} contém atributos que precisam de revisão na exportação MusicXML.`);
      }
      const output = doc.createElementNS(root.namespaceURI, "measure");
      for (const attribute of Array.from(measure.attributes)) output.setAttribute(attribute.name, attribute.value);
      for (const child of Array.from(source.childNodes)) output.appendChild(child.cloneNode(true));
      outputParts.get(id).appendChild(output);
    }
  });
  doc.replaceChild(replacement, root);
  return doc;
}

export function parseMusicXMLDocument(xml) {
  return normalizeParsedDocument(parseXML(xml, "O arquivo MusicXML"));
}

export function normalizeMusicXMLText(xml) {
  return serialize(parseMusicXMLDocument(xml));
}

function decodeXML(bytes) {
  try {
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be"
        : bytes[0] === 0x3c && bytes[1] === 0x00 ? "utf-16le"
          : bytes[0] === 0x00 && bytes[1] === 0x3c ? "utf-16be" : null;
    const declaration = new TextDecoder("windows-1252").decode(bytes.subarray(0, 200));
    const declared = declaration.match(/^\s*(?:ï»¿)?<\?xml\s[^?]*encoding\s*=\s*["']([^"']+)["']/i)?.[1];
    return new TextDecoder(utf16 || declared || "utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("A codificação do texto MusicXML não pôde ser lida. Exporte novamente em UTF-8.");
  }
}

function safeArchivePath(path) {
  return typeof path === "string" && !!path && !/^(?:\/|[a-z][a-z\d+.-]*:)/i.test(path)
    && !/[\\\u0000-\u001f]/.test(path) && path.split("/").every((segment) => segment !== ".." && segment !== ".");
}

// Inspect the directory without inflating anything, then independently enforce
// the actual byte limit while streaming. ZIP header sizes cannot be trusted.
function zipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50 && offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail("O arquivo MXL está incompleto ou não é um ZIP válido.");
  const count = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)
      || view.getUint16(end + 8, true) !== count || count === 0xffff
      || size === 0xffffffff || start === 0xffffffff) {
    fail("Este MXL usa um ZIP dividido ou ZIP64. Exporte novamente a obra como MusicXML simples.");
  }
  if (!count || count > MUSICXML_IMPORT_LIMITS.zipEntries || start + size > end) {
    fail("O arquivo MXL contém entradas demais ou um índice inválido. Exporte apenas a partitura desejada.");
  }
  const entries = new Map();
  let offset = start;
  let declaredBytes = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + size || view.getUint32(offset, true) !== 0x02014b50) fail("O índice do arquivo MXL está danificado.");
    const length = view.getUint16(offset + 28, true);
    const next = offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > start + size) fail("O índice do arquivo MXL está truncado.");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + length));
    const uncompressed = view.getUint32(offset + 24, true);
    declaredBytes += uncompressed;
    if (!safeArchivePath(name) || entries.has(name)) fail("O MXL contém caminhos de arquivo inválidos ou repetidos.");
    if (view.getUint16(offset + 8, true) & 1) fail("O MXL está protegido por senha. Envie uma exportação sem senha.");
    if (uncompressed === 0xffffffff || declaredBytes > MUSICXML_IMPORT_LIMITS.declaredArchiveBytes) {
      fail("O MXL descompactado é grande demais. Exporte apenas a partitura, sem áudio ou imagens adicionais.");
    }
    entries.set(name, { uncompressed, crc32: view.getUint32(offset + 16, true) });
    offset = next;
  }
  if (offset !== start + size) fail("O índice do arquivo MXL contém dados não reconhecidos.");
  return entries;
}

const crcTable = new Uint32Array(256).map((_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function inflateBounded(entry, limit, description, expectedCRC) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let checksum = 0xffffffff;
    let finished = false;
    const stream = entry.internalStream("uint8array");
    const stop = (error) => {
      if (finished) return;
      finished = true;
      stream.pause();
      chunks.length = 0;
      reject(error);
    };
    stream.on("data", (chunk) => {
      if (finished) return;
      size += chunk.length;
      if (size > limit) {
        stop(new MusicXMLImportError(`${description} ultrapassa o limite de tamanho após descompactar. Exporte a obra em partes menores.`));
        return;
      }
      for (const byte of chunk) checksum = crcTable[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
      chunks.push(chunk);
    }).on("error", () => stop(new MusicXMLImportError(`${description} está danificado e não pôde ser descompactado.`)))
      .on("end", () => {
        if (finished) return;
        if (((checksum ^ 0xffffffff) >>> 0) !== expectedCRC) {
          stop(new MusicXMLImportError(`${description} está danificado: a integridade do arquivo não confere. Exporte novamente a partitura.`));
          return;
        }
        finished = true;
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
        resolve(output);
      }).resume();
  });
}

async function readCompressedXML(bytes) {
  try {
    const directory = zipDirectory(bytes);
    const manifestInfo = directory.get("META-INF/container.xml");
    if (!manifestInfo) fail("O MXL não contém META-INF/container.xml. Exporte novamente como MusicXML compactado.");
    if (manifestInfo.uncompressed > MUSICXML_IMPORT_LIMITS.containerBytes) fail("O índice musical do MXL é grande demais.");
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: false, createFolders: false });
    const manifestEntry = zip.file("META-INF/container.xml");
    if (!manifestEntry) fail("O MXL não contém um índice musical legível.");
    const manifest = parseXML(decodeXML(await inflateBounded(manifestEntry, MUSICXML_IMPORT_LIMITS.containerBytes, "O índice musical", manifestInfo.crc32)), "O índice musical do MXL");
    const containers = named(manifest.documentElement, "rootfiles");
    const rootfile = containers.length === 1 && named(containers[0], "rootfile")[0];
    if (manifest.documentElement.localName !== "container" || !rootfile) fail("O índice do MXL não indica a partitura principal.");
    const path = rootfile.getAttribute("full-path");
    const mediaType = rootfile.getAttribute("media-type");
    if (mediaType && mediaType !== "application/vnd.recordare.musicxml+xml") fail("O primeiro arquivo indicado pelo MXL não é uma partitura MusicXML.");
    if (!safeArchivePath(path) || !directory.has(path)) fail("A partitura principal indicada pelo MXL não existe dentro do arquivo.");
    if (directory.get(path).uncompressed > MUSICXML_IMPORT_LIMITS.scoreBytes) fail("A partitura MusicXML descompactada ultrapassa 16 MB. Divida a obra em movimentos menores.");
    const entry = zip.file(path);
    if (!entry || (entry.unsafeOriginalName && entry.unsafeOriginalName !== path)) fail("O caminho da partitura principal no MXL é inválido.");
    return normalizeMusicXMLText(decodeXML(await inflateBounded(entry, MUSICXML_IMPORT_LIMITS.scoreBytes, "A partitura MusicXML", directory.get(path).crc32)));
  } catch (error) {
    if (error instanceof MusicXMLImportError) throw error;
    fail("O arquivo MXL está danificado ou usa uma compactação incompatível. Exporte novamente como MusicXML simples.");
  }
}

/** Read .xml/.musicxml/.mxl entirely on-device; never resolve linked resources. */
export async function readMusicXMLFile(file) {
  if (!file || typeof file.arrayBuffer !== "function") fail("Selecione um arquivo MusicXML para continuar.");
  if (file.size > MUSICXML_IMPORT_LIMITS.fileBytes) fail("O arquivo ultrapassa 32 MB. Divida a obra em movimentos menores.");
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { fail("Não foi possível abrir o arquivo selecionado. Selecione-o novamente para continuar."); }
  if (bytes.byteLength > MUSICXML_IMPORT_LIMITS.fileBytes) fail("O arquivo ultrapassa 32 MB. Divida a obra em movimentos menores.");
  if (!bytes.length) fail("O arquivo MusicXML está vazio.");
  const zipSignature = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (/\.mxl$/i.test(file.name || "") || zipSignature) return readCompressedXML(bytes);
  if (bytes.byteLength > MUSICXML_IMPORT_LIMITS.scoreBytes) fail("O MusicXML ultrapassa 16 MB. Divida a obra em movimentos menores.");
  return normalizeMusicXMLText(decodeXML(bytes));
}
