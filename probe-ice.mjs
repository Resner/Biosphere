// Temporary diagnostic (M14 T6): two pages (separate contexts or browsers) link over ICE, signalled
// through Node, with and without the hub's STUN servers.
import { chromium, firefox } from '@playwright/test';
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const prefs = { 'media.peerconnection.ice.obfuscate_host_addresses': false };
async function pageOf(browser) {
  const p = await (await browser.newContext()).newPage();
  await p.setContent('<html><body>probe</body></html>');
  return p;
}
async function pair(name, pa, pb, ice) {
  const setup = (ice) => {
    window.pc = new RTCPeerConnection({ iceServers: ice });
    window.cands = [];
    window.pc.onicecandidate = (e) => { if (e.candidate) window.cands.push(e.candidate.toJSON()); };
    window.opened = false;
  };
  await pa.evaluate(setup, ice); await pb.evaluate(setup, ice);
  const offer = await pa.evaluate(async () => {
    const ch = window.pc.createDataChannel('x'); ch.onopen = () => { window.opened = true; };
    await window.pc.setLocalDescription(); return window.pc.localDescription.toJSON();
  });
  const answer = await pb.evaluate(async (o) => {
    window.pc.ondatachannel = (e) => { e.channel.onopen = () => { window.opened = true; }; };
    await window.pc.setRemoteDescription(o); await window.pc.setLocalDescription(); return window.pc.localDescription.toJSON();
  }, offer);
  await pa.evaluate((a) => window.pc.setRemoteDescription(a), answer);
  // Trickle both ways for 6 s.
  const sent = { a: 0, b: 0 };
  for (let t = 0; t < 30; t++) {
    const ca = await pa.evaluate(() => window.cands); const cb = await pb.evaluate(() => window.cands);
    for (const c of ca.slice(sent.a)) await pb.evaluate((c) => window.pc.addIceCandidate(c).catch(() => {}), c);
    for (const c of cb.slice(sent.b)) await pa.evaluate((c) => window.pc.addIceCandidate(c).catch(() => {}), c);
    sent.a = ca.length; sent.b = cb.length;
    if (await pa.evaluate(() => window.opened)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const res = await pa.evaluate(() => ({ open: window.opened, state: window.pc.iceConnectionState, cands: window.cands.map((c) => c.candidate) }));
  const resb = await pb.evaluate(() => ({ state: window.pc.iceConnectionState, cands: window.cands.map((c) => c.candidate) }));
  console.log(name, JSON.stringify({ a: res, b: resb }));
}
const ff = await firefox.launch({ headless: false, firefoxUserPrefs: prefs });
const cr = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
for (const [label, ice] of [['nostun', []], ['stun', STUN]]) {
  await pair(`ff-ff-${label}`, await pageOf(ff), await pageOf(ff), ice);
  await pair(`cr-ff-${label}`, await pageOf(cr), await pageOf(ff), ice);
  await pair(`cr-cr-${label}`, await pageOf(cr), await pageOf(cr), ice);
}
await ff.close(); await cr.close();
