import dgram from 'node:dgram';
import os from 'node:os';

const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const address = '224.0.0.251';
const name = Buffer.from([5, 111, 108, 101, 120, 97, 5, 108, 111, 99, 97, 108, 0]);
const ip = process.env.BOB_MDNS_IP ?? Object.values(os.networkInterfaces()).flat().find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address ?? '127.0.0.1';
const ipBytes = Buffer.from(ip.split('.').map(Number));
const packet = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 1, 0, 1, 0, 0, 0, 0]), name, Buffer.from([0, 1, 0, 1, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 120, 0, 4]), ipBytes]);
// FR-024: answer only questions actually asked about `bob.local`. Parse the QNAME out of
// each packet instead of replying to every mDNS packet on the LAN.
function asksBobLocal(query) {
  if (query.length < 13) return false;
  const flags = query.readUInt16BE(2);
  if ((flags & 0x8000) !== 0) return false; // a response, not a query
  if (query.readUInt16BE(4) < 1) return false; // no question to answer
  const labels = [];
  let offset = 12;
  while (offset < query.length) {
    const length = query[offset];
    offset += 1;
    if (length === 0) break;
    if (offset + length > query.length) return false;
    labels.push(query.toString('ascii', offset, offset + length).toLowerCase());
    offset += length;
  }
  return labels.join('.') === 'bob.local';
}

socket.on('message', (query, remote) => {
  if (!asksBobLocal(query)) return;
  socket.send(packet, 5353, remote.address);
});
socket.bind(5353, () => { socket.addMembership(address); socket.send(packet, 5353, address); });
process.on('SIGINT', () => socket.close());
