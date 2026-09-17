'use strict';
/**
 * Property list reading (XML or binary, auto-detected) and a small XML writer.
 *
 * The XML reader is a purpose-built tokenizer: it understands exactly the
 * plist vocabulary (dict/array/key/string/integer/real/true/false/date/data),
 * comments, CDATA, the XML declaration and a DOCTYPE, and nothing else.
 */
const { readBplist, isBplist } = require('./bplist.cjs');

function decodeText(buf) {
  // Honour a BOM; everything Apple writes without one is UTF-8.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const copy = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    copy.swap16();
    return copy.toString('utf16le');
  }
  return buf.toString('utf8');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m;
  });
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Parse an XML plist string into plain JS values. */
function parseXmlPlist(text) {
  let pos = 0;
  const len = text.length;

  // Yields { open:'dict' } | { close:'dict' } | { empty:'true' } | { text:'...' }.
  function next() {
    while (pos < len) {
      if (text[pos] !== '<') {
        const end = text.indexOf('<', pos);
        const raw = text.slice(pos, end === -1 ? len : end);
        pos = end === -1 ? len : end;
        return { text: unescapeXml(raw) };
      }
      if (text.startsWith('<!--', pos)) {
        const end = text.indexOf('-->', pos + 4);
        if (end === -1) throw new Error('plist: unterminated comment');
        pos = end + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', pos)) {
        const end = text.indexOf(']]>', pos + 9);
        if (end === -1) throw new Error('plist: unterminated CDATA');
        const raw = text.slice(pos + 9, end);
        pos = end + 3;
        return { text: raw };
      }
      if (text.startsWith('<?', pos)) {
        const end = text.indexOf('?>', pos + 2);
        if (end === -1) throw new Error('plist: unterminated processing instruction');
        pos = end + 2;
        continue;
      }
      if (text.startsWith('<!', pos)) {
        // DOCTYPE, possibly with an internal subset in [ ... ].
        let depth = 0;
        let i = pos + 2;
        for (; i < len; i++) {
          if (text[i] === '[') depth++;
          else if (text[i] === ']') depth--;
          else if (text[i] === '>' && depth <= 0) break;
        }
        pos = i + 1;
        continue;
      }
      const end = text.indexOf('>', pos);
      if (end === -1) throw new Error('plist: unterminated tag');
      let inner = text.slice(pos + 1, end).trim();
      pos = end + 1;
      if (inner[0] === '/') return { close: inner.slice(1).trim() };
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1).trim();
      const name = inner.split(/\s/, 1)[0];
      return selfClosing ? { empty: name } : { open: name };
    }
    return null;
  }

  function readTextUntilClose(name) {
    let out = '';
    for (;;) {
      const t = next();
      if (!t) throw new Error('plist: unexpected end inside <' + name + '>');
      if (t.text !== undefined) out += t.text;
      else if (t.close === name) return out;
      else throw new Error('plist: unexpected markup inside <' + name + '>');
    }
  }

  function nextSignificant() {
    for (;;) {
      const t = next();
      if (!t) return null;
      if (t.text !== undefined && t.text.trim() === '') continue;
      return t;
    }
  }

  function parseValue(tok) {
    if (tok.empty !== undefined) {
      switch (tok.empty) {
        case 'true': return true;
        case 'false': return false;
        case 'dict': return {};
        case 'array': return [];
        case 'string': case 'key': return '';
        case 'data': return Buffer.alloc(0);
        default: throw new Error('plist: unexpected <' + tok.empty + '/>');
      }
    }
    if (tok.open === undefined) throw new Error('plist: expected a value');
    switch (tok.open) {
      case 'string': return readTextUntilClose('string');
      case 'integer': {
        const s = readTextUntilClose('integer').trim();
        const n = /^[-+]?0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
        return n;
      }
      case 'real': return parseFloat(readTextUntilClose('real').trim());
      case 'date': return new Date(readTextUntilClose('date').trim());
      case 'data': return Buffer.from(readTextUntilClose('data').replace(/\s+/g, ''), 'base64');
      case 'true': readTextUntilClose('true'); return true;
      case 'false': readTextUntilClose('false'); return false;
      case 'array': {
        const out = [];
        for (;;) {
          const t = nextSignificant();
          if (!t) throw new Error('plist: unterminated <array>');
          if (t.close === 'array') return out;
          out.push(parseValue(t));
        }
      }
      case 'dict': {
        const out = {};
        for (;;) {
          const t = nextSignificant();
          if (!t) throw new Error('plist: unterminated <dict>');
          if (t.close === 'dict') return out;
          let key;
          if (t.open === 'key') key = readTextUntilClose('key');
          else if (t.empty === 'key') key = '';
          else throw new Error('plist: expected <key> in <dict>');
          const v = nextSignificant();
          if (!v) throw new Error('plist: missing value for key ' + key);
          out[key] = parseValue(v);
        }
      }
      default:
        throw new Error('plist: unknown element <' + tok.open + '>');
    }
  }

  let tok = nextSignificant();
  if (!tok) throw new Error('plist: empty document');
  if (tok.open === 'plist') {
    tok = nextSignificant();
    if (!tok || tok.close === 'plist') throw new Error('plist: empty <plist>');
  } else if (tok.empty === 'plist') {
    throw new Error('plist: empty <plist/>');
  }
  return parseValue(tok);
}

/** Parse an Info.plist-style buffer, XML or binary. */
function parsePlist(buf) {
  if (isBplist(buf)) return readBplist(buf);
  return parseXmlPlist(decodeText(buf));
}

/**
 * Serialize to the XML plist dialect Apple tools write: tab indentation,
 * keys in the order given, <data> as base64 wrapped to 68 columns.
 */
function buildXmlPlist(root) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
  ];
  function emit(v, depth) {
    const pad = '\t'.repeat(depth);
    if (typeof v === 'string') lines.push(pad + '<string>' + escapeXml(v) + '</string>');
    else if (typeof v === 'boolean') lines.push(pad + (v ? '<true/>' : '<false/>'));
    else if (typeof v === 'number') {
      lines.push(pad + (Number.isInteger(v) ? '<integer>' + v + '</integer>' : '<real>' + v + '</real>'));
    } else if (Buffer.isBuffer(v)) {
      lines.push(pad + '<data>');
      const b64 = v.toString('base64');
      for (let i = 0; i < b64.length; i += 68) lines.push(pad + b64.slice(i, i + 68));
      lines.push(pad + '</data>');
    } else if (Array.isArray(v)) {
      if (!v.length) { lines.push(pad + '<array/>'); return; }
      lines.push(pad + '<array>');
      for (const item of v) emit(item, depth + 1);
      lines.push(pad + '</array>');
    } else if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (!keys.length) { lines.push(pad + '<dict/>'); return; }
      lines.push(pad + '<dict>');
      for (const k of keys) {
        lines.push(pad + '\t<key>' + escapeXml(k) + '</key>');
        emit(v[k], depth + 1);
      }
      lines.push(pad + '</dict>');
    } else {
      throw new TypeError('plist: cannot serialize ' + v);
    }
  }
  emit(root, 0);
  lines.push('</plist>', '');
  return lines.join('\n');
}

module.exports = { parsePlist, parseXmlPlist, buildXmlPlist };
