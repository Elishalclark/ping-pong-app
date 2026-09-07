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
    // STUN alone finds each phone's public address, but that is not enough
    // whenever either phone is behind a NAT that won't let an unsolicited
    // packet through it — carrier-grade NAT on mobile data is exactly that,
    // and it is the ordinary case, not an edge case: two personal phones are
    // very often on two different networks (home Wi-Fi + cellular, or two
    // different carriers). Without a relay, that combination fails silently:
    // the handshake completes, then the connection just never opens. TURN
    // servers relay the traffic when a direct path can't be found, which is
    // what makes phone-to-phone actually work across networks. These are a
    // free public test relay (openrelay.metered.ca) — fine for this app's
    // one-connection-per-match traffic, not something to build a business on.
    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:openrelay.metered.ca:80' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
        // TURN over TLS on 443: to a firewall this is indistinguishable from
        // ordinary HTTPS traffic, so it is the one variant here most likely
        // to get through a restrictive campus, workplace, or carrier network
        // that a plain TURN/UDP or TURN/TCP relay cannot.
        { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
      ],
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
      // Safety net: some browsers never flip to 'complete'. A TURN relay
      // candidate takes an extra round trip to allocate, so this is longer
      // than plain STUN needs — cutting it off early is what silently drops
      // the one candidate that would have let two phones on different
      // networks actually connect.
      setTimeout(resolve, 4500);
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

  /**
   * A compact snapshot of what the connection actually managed, for
   * diagnosing a failed pairing after the fact rather than guessing at it —
   * "still not working" carries no information; this does. In particular it
   * says outright whether a TURN relay was ever reached at all, which is the
   * one fact that separates "the relay is unreachable from this network" from
   * every other possible cause.
   */
  async diagnose() {
    if (!this.pc) return { note: 'no connection was ever created' };
    const stats = await this.pc.getStats().catch(() => null);
    const local = [], remote = [];
    let usedPair = null;
    stats?.forEach(r => {
      if (r.type === 'local-candidate') local.push(r.candidateType);
      if (r.type === 'remote-candidate') remote.push(r.candidateType);
      if (r.type === 'candidate-pair' && r.state === 'succeeded') usedPair = r;
    });
    let usedTypes = null;
    if (usedPair && stats) {
      const l = stats.get(usedPair.localCandidateId);
      const r = stats.get(usedPair.remoteCandidateId);
      usedTypes = { local: l?.candidateType, remote: r?.candidateType };
    }
    return {
      connectionState: this.pc.connectionState,
      iceConnectionState: this.pc.iceConnectionState,
      iceGatheringState: this.pc.iceGatheringState,
      localCandidateTypes: [...new Set(local)],
      remoteCandidateTypes: [...new Set(remote)],
      relayCandidateGathered: local.includes('relay'),
      succeededPairTypes: usedTypes,
    };
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
