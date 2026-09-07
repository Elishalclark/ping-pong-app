// Two-device shared play over a direct WebRTC data channel — no server.
//
// One phone hosts the match and holds the authoritative score; the other
// joins and mirrors it, each filming its own end of the table. The only thing
// two peers must exchange to connect is a offer/answer pair, and we move that
// by QR code: the host shows a code, the guest scans it and shows one back,
// the host scans that. After the handshake the phones talk directly.
//
// The signaling blobs are deflated then base64'd so a full offer with its ICE
// candidates fits in a single QR. ICE is gathered fully before the code is
// produced (non-trickle), because there is no channel to trickle over.

export class PeerLink {
  constructor() {
    this.pc = null;
    this.channel = null;
    this.role = null;                 // 'host' | 'guest'
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
    this.onState = () => {};
  }

  _newPeer() {
    // A public STUN server helps across networks; on the same Wi‑Fi the local
    // (host) candidates alone are enough, so pairing still works offline.
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      this.onState(st);
      if (st === 'failed' || st === 'disconnected' || st === 'closed') this.onClose(st);
    };
  }

  _wire(channel) {
    this.channel = channel;
    channel.onopen = () => this.onOpen();
    channel.onclose = () => this.onClose('channel-closed');
    channel.onmessage = e => {
      try { this.onMessage(JSON.parse(e.data)); } catch { /* ignore junk */ }
    };
  }

  // Wait until ICE gathering finishes so the description is complete.
  _gathered() {
    return new Promise(resolve => {
      if (this.pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      // Safety net: some browsers never flip to 'complete'.
      setTimeout(resolve, 2500);
    });
  }

  /** HOST: create the connection and return the offer code to show as a QR. */
  async createOffer() {
    this.role = 'host';
    this._newPeer();
    this._wire(this.pc.createDataChannel('umpire', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await this._gathered();
    return encodeSignal(this.pc.localDescription);
  }

  /** HOST: finish the handshake with the guest's scanned answer code. */
  async acceptAnswer(code) {
    await this.pc.setRemoteDescription(decodeSignal(code));
  }

  /** GUEST: take the host's offer code, return an answer code to show back. */
  async answerOffer(code) {
    this.role = 'guest';
    this._newPeer();
    this.pc.ondatachannel = e => this._wire(e.channel);
    await this.pc.setRemoteDescription(decodeSignal(code));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await this._gathered();
    return encodeSignal(this.pc.localDescription);
  }

  send(obj) {
    if (this.channel && this.channel.readyState === 'open') {
      this.channel.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  close() {
    try { this.channel?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.channel = this.pc = null;
  }
}

// --- signal encoding: {type, sdp} -> deflate -> base64url, and back ---------
// pako is loaded globally (see index.html); if it is missing we fall back to
// plain base64, which still works for short LAN-only descriptions.

export function encodeSignal(desc) {
  const json = JSON.stringify({ t: desc.type, s: desc.sdp });
  const bytes = new TextEncoder().encode(json);
  const packed = (typeof pako !== 'undefined') ? pako.deflate(bytes) : bytes;
  const flag = (typeof pako !== 'undefined') ? 'D' : 'R';
  return flag + bytesToB64(packed);
}

export function decodeSignal(code) {
  const flag = code[0];
  const packed = b64ToBytes(code.slice(1));
  const bytes = flag === 'D' && typeof pako !== 'undefined' ? pako.inflate(packed) : packed;
  const { t, s } = JSON.parse(new TextDecoder().decode(bytes));
  return { type: t, sdp: s };
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
