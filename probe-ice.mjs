// Temporary diagnostic (M14 T6): which ICE candidates each engine gathers on a runner.
import { chromium, firefox } from '@playwright/test';
const page = `<html><body>probe</body></html>`;
async function probe(name, browser) {
  const p = await browser.newPage();
  await p.setContent(page);
  const r = await p.evaluate(async () => {
    const out = { cands: [], open: false, state: null, err: null };
    try {
      const a = new RTCPeerConnection(); const c = new RTCPeerConnection();
      a.onicecandidate = (e) => { if (e.candidate) { out.cands.push(e.candidate.candidate); c.addIceCandidate(e.candidate); } };
      c.onicecandidate = (e) => { if (e.candidate) a.addIceCandidate(e.candidate); };
      const ch = a.createDataChannel('x');
      const opened = new Promise((res) => { ch.onopen = () => res(true); setTimeout(() => res(false), 10000); });
      await a.setLocalDescription(); await c.setRemoteDescription(a.localDescription);
      await c.setLocalDescription(); await a.setRemoteDescription(c.localDescription);
      out.open = await opened; out.state = a.iceConnectionState;
    } catch (e) { out.err = String(e); }
    return out;
  });
  console.log(name, JSON.stringify(r));
}
const prefsets = {
  base: { 'media.peerconnection.ice.obfuscate_host_addresses': false },
  loopback: { 'media.peerconnection.ice.obfuscate_host_addresses': false, 'media.peerconnection.ice.loopback': true },
  allIf: { 'media.peerconnection.ice.obfuscate_host_addresses': false, 'media.peerconnection.ice.default_address_only': false, 'media.peerconnection.ice.no_host': false },
};
for (const [k, prefs] of Object.entries(prefsets)) {
  const b = await firefox.launch({ headless: false, firefoxUserPrefs: prefs });
  await probe(`firefox-${k}`, b);
  await b.close();
}
const c = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
await probe('chromium', c);
await c.close();
