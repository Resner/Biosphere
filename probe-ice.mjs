// Temporary diagnostic (M14 T6): the game's way to link (no trickle: the SDP after gathering
// completes or 2 s), across contexts and browsers, with and without the hub's STUN servers.
import { chromium, firefox } from '@playwright/test';
const STUN = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const prefs = { 'media.peerconnection.ice.obfuscate_host_addresses': false };
async function pageOf(browser) {
  const p = await (await browser.newContext()).newPage();
  await p.setContent('<html><body>probe</body></html>');
  return p;
}
const gather = async () => {
  const pc = window.pc;
  const t0 = performance.now();
  if (pc.iceGatheringState !== 'complete') {
    await new Promise((res) => {
      const timer = setTimeout(res, 2000);
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); res(); } };
    });
  }
  window.gatherMs = Math.round(performance.now() - t0);
  return pc.localDescription.toJSON();
};
async function pair(name, pa, pb, ice) {
  const setup = (ice) => { window.pc = new RTCPeerConnection({ iceServers: ice }); window.opened = false; };
  await pa.evaluate(setup, ice); await pb.evaluate(setup, ice);
  const offer = await pa.evaluate(async (g) => {
    const ch = window.pc.createDataChannel('x'); ch.onopen = () => { window.opened = true; };
    await window.pc.setLocalDescription(); return await (0, eval)(`(${g})`)();
  }, gather.toString());
  const answer = await pb.evaluate(async ([o, g]) => {
    window.pc.ondatachannel = (e) => { e.channel.onopen = () => { window.opened = true; }; };
    await window.pc.setRemoteDescription(o); await window.pc.setLocalDescription(); return await (0, eval)(`(${g})`)();
  }, [offer, gather.toString()]);
  await pa.evaluate((a) => window.pc.setRemoteDescription(a), answer);
  for (let t = 0; t < 50 && !(await pa.evaluate(() => window.opened)); t++) await new Promise((r) => setTimeout(r, 200));
  const lines = (sdp) => sdp.split('\n').filter((l) => l.startsWith('a=candidate') || l.startsWith('c=')).map((l) => l.trim());
  const a = await pa.evaluate(() => ({ open: window.opened, state: window.pc.iceConnectionState, gatherMs: window.gatherMs }));
  const b = await pb.evaluate(() => ({ state: window.pc.iceConnectionState, gatherMs: window.gatherMs }));
  console.log(name, JSON.stringify({ a, b, offer: lines(offer.sdp), answer: lines(answer.sdp) }));
}
const ff = await firefox.launch({ headless: false, firefoxUserPrefs: prefs });
const cr = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
for (const [label, ice] of [['nostun', []], ['stun', STUN]]) {
  await pair(`ff-ff-${label}`, await pageOf(ff), await pageOf(ff), ice);
  await pair(`cr-ff-${label}`, await pageOf(cr), await pageOf(ff), ice);
  await pair(`ff-cr-${label}`, await pageOf(ff), await pageOf(cr), ice);
}
await ff.close(); await cr.close();
