'use strict';
/**
 * HFS+ B-tree bulk builder (TN1150 "B-Trees").
 *
 * The caller hands over every leaf record already sorted; the tree is built
 * bottom-up: pack leaves left to right, then one index level per pass until a
 * single root remains, then the header node (node 0) and, only when the
 * header's map record cannot describe every node, a chain of map nodes.
 *
 * Node layout:  14-byte descriptor | records ... | free | offsets (u16 each,
 * growing backwards from the end of the node; one extra entry points at the
 * start of free space).
 */

const NODE_DESCRIPTOR_SIZE = 14;
const HEADER_REC_SIZE = 106;
const USER_DATA_REC_SIZE = 128;

const KIND_LEAF = -1;
const KIND_INDEX = 0;
const KIND_HEADER = 1;
const KIND_MAP = 2;

const BT_BIG_KEYS = 0x00000002; // key length is a u16 (always, on HFS+)
const BT_VARIABLE_INDEX_KEYS = 0x00000004; // index keys keep their real length (catalog, attributes)

/** Bits the header node's map record can hold. */
function headerMapBits(nodeSize) {
  return (nodeSize - NODE_DESCRIPTOR_SIZE - HEADER_REC_SIZE - USER_DATA_REC_SIZE - 4 * 2) * 8;
}

/**
 * Bits one map node can hold. Apple's newfs_hfs sizes the record as
 * nodeSize - descriptor - 2 offsets - 2 so that it stays word aligned.
 */
function mapNodeBits(nodeSize) {
  return (nodeSize - NODE_DESCRIPTOR_SIZE - 2 * 2 - 2) * 8;
}

function writeNode(nodeSize, { fLink, bLink, kind, height, records }) {
  const buf = Buffer.alloc(nodeSize);
  buf.writeUInt32BE(fLink >>> 0, 0);
  buf.writeUInt32BE(bLink >>> 0, 4);
  buf.writeInt8(kind, 8);
  buf.writeUInt8(height, 9);
  buf.writeUInt16BE(records.length, 10);
  let pos = NODE_DESCRIPTOR_SIZE;
  for (let i = 0; i < records.length; i++) {
    buf.writeUInt16BE(pos, nodeSize - 2 * (i + 1));
    records[i].copy(buf, pos);
    pos += records[i].length;
  }
  buf.writeUInt16BE(pos, nodeSize - 2 * (records.length + 1)); // free space offset
  if (pos > nodeSize - 2 * (records.length + 1)) throw new Error('btree: node overflow');
  return buf;
}

/**
 * @param {object} o
 * @param {number} o.nodeSize          power of two, 512..32768
 * @param {Array<{key:Buffer,data:Buffer}>} o.records  sorted; `key` includes its u16 keyLength prefix
 * @param {number} o.maxKeyLength
 * @param {number} o.keyCompareType    0xBC binary (HFSX) / 0xCF case folding / 0 for non-catalog trees
 * @param {number} o.attributes        BT_* flags
 * @param {number} [o.clumpSize]
 * @param {number} [o.minNodes]        pad the file with zeroed free nodes up to this many nodes
 * @returns {{nodes:Buffer[], totalNodes:number, freeNodes:number, depth:number, rootNode:number,
 *            leafRecords:number, firstLeaf:number, lastLeaf:number, mapNodes:number}}
 */
function buildBTree(o) {
  const { nodeSize, records, maxKeyLength, keyCompareType = 0, attributes, clumpSize = nodeSize, minNodes = 0 } = o;
  if (nodeSize < 512 || nodeSize > 32768 || (nodeSize & (nodeSize - 1))) throw new Error('btree: bad node size');
  if (records.length && !(attributes & BT_VARIABLE_INDEX_KEYS)) {
    throw new Error('btree: only variable-length index keys are implemented');
  }

  // A level is a list of { firstKey, records[] }. Node numbers are handed out
  // level by level, leaves first, so every leaf run is physically contiguous.
  const capacity = nodeSize - NODE_DESCRIPTOR_SIZE;
  function pack(items) {
    const out = [];
    let cur = null;
    let used = 0;
    for (const it of items) {
      const need = it.bytes.length + 2; // record + its offset slot
      if (need + 2 > capacity) throw new Error('btree: record larger than a node');
      if (!cur || used + need + 2 > capacity) { // +2: the free-space offset slot
        cur = { firstKey: it.key, records: [] };
        out.push(cur);
        used = 0;
      }
      cur.records.push(it.bytes);
      used += need;
    }
    return out;
  }

  const even = (b) => (b.length & 1 ? Buffer.concat([b, Buffer.alloc(1)]) : b);

  const levels = [];
  if (records.length) {
    let level = pack(records.map((r) => ({ key: r.key, bytes: even(Buffer.concat([r.key, r.data])) })));
    let nextNumber = 1;
    for (;;) {
      for (const n of level) n.number = nextNumber++;
      levels.push(level);
      if (level.length === 1) break;
      level = pack(level.map((n) => {
        const ptr = Buffer.alloc(4);
        ptr.writeUInt32BE(n.number, 0);
        return { key: n.firstKey, bytes: even(Buffer.concat([n.firstKey, ptr])) };
      }));
    }
  }

  const treeNodes = levels.reduce((sum, l) => sum + l.length, 0);
  // Map nodes are themselves nodes that need a bit, hence the fixed point.
  let mapNodes = 0;
  for (;;) {
    const total = Math.max(1 + treeNodes + mapNodes, minNodes);
    const needed = total <= headerMapBits(nodeSize) ? 0 : Math.ceil((total - headerMapBits(nodeSize)) / mapNodeBits(nodeSize));
    if (needed === mapNodes) break;
    mapNodes = needed;
  }
  const usedNodes = 1 + treeNodes + mapNodes;
  const totalNodes = Math.max(usedNodes, minNodes);
  const firstMapNode = 1 + treeNodes;

  const nodes = new Array(totalNodes);
  levels.forEach((level, li) => {
    level.forEach((n, i) => {
      nodes[n.number] = writeNode(nodeSize, {
        fLink: i + 1 < level.length ? level[i + 1].number : 0,
        bLink: i > 0 ? level[i - 1].number : 0,
        kind: li === 0 ? KIND_LEAF : KIND_INDEX,
        height: li + 1,
        records: n.records,
      });
    });
  });

  // Allocation map: one bit per node, MSB first, set for every node in use.
  const mapBits = Buffer.alloc(Math.ceil((headerMapBits(nodeSize) + mapNodes * mapNodeBits(nodeSize)) / 8));
  for (let n = 0; n < usedNodes; n++) mapBits[n >> 3] |= 0x80 >> (n & 7);

  const depth = levels.length;
  const rootNode = depth ? levels[depth - 1][0].number : 0;
  const header = Buffer.alloc(HEADER_REC_SIZE);
  header.writeUInt16BE(depth, 0);
  header.writeUInt32BE(rootNode, 2);
  header.writeUInt32BE(records.length, 6);
  header.writeUInt32BE(depth ? levels[0][0].number : 0, 10);
  header.writeUInt32BE(depth ? levels[0][levels[0].length - 1].number : 0, 14);
  header.writeUInt16BE(nodeSize, 18);
  header.writeUInt16BE(maxKeyLength, 20);
  header.writeUInt32BE(totalNodes, 22);
  header.writeUInt32BE(totalNodes - usedNodes, 26);
  header.writeUInt32BE(clumpSize >>> 0, 32);
  header.writeUInt8(0, 36); // btreeType: kHFSBTreeType
  header.writeUInt8(keyCompareType, 37);
  header.writeUInt32BE(attributes >>> 0, 38);

  const headerMapBytes = headerMapBits(nodeSize) / 8;
  nodes[0] = writeNode(nodeSize, {
    fLink: mapNodes ? firstMapNode : 0,
    bLink: 0,
    kind: KIND_HEADER,
    height: 0,
    records: [header, Buffer.alloc(USER_DATA_REC_SIZE), Buffer.from(mapBits.subarray(0, headerMapBytes))],
  });

  const mapBytes = mapNodeBits(nodeSize) / 8;
  for (let m = 0; m < mapNodes; m++) {
    const start = headerMapBytes + m * mapBytes;
    nodes[firstMapNode + m] = writeNode(nodeSize, {
      fLink: m + 1 < mapNodes ? firstMapNode + m + 1 : 0,
      bLink: 0,
      kind: KIND_MAP,
      height: 0,
      records: [Buffer.from(mapBits.subarray(start, start + mapBytes))],
    });
  }

  for (let n = usedNodes; n < totalNodes; n++) nodes[n] = Buffer.alloc(nodeSize); // free nodes stay zeroed

  return {
    nodes, totalNodes, freeNodes: totalNodes - usedNodes, depth, rootNode,
    leafRecords: records.length,
    firstLeaf: depth ? levels[0][0].number : 0,
    lastLeaf: depth ? levels[0][levels[0].length - 1].number : 0,
    mapNodes,
  };
}

module.exports = {
  buildBTree, headerMapBits, mapNodeBits,
  NODE_DESCRIPTOR_SIZE, HEADER_REC_SIZE, USER_DATA_REC_SIZE,
  KIND_LEAF, KIND_INDEX, KIND_HEADER, KIND_MAP,
  BT_BIG_KEYS, BT_VARIABLE_INDEX_KEYS,
};
