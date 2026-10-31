#!/usr/bin/env node
// Put the case panel into the Aleph preset before its first turn.
//
// A session's preset is locked once it has started, so this script switches the
// preset on a fresh session, or opens one when the restored session already ran
// under another preset. It can also deliver the opening instruction.
//
// Usage: node scripts/case-ui.mjs [run-root] [--kickoff "message"]
// The panel is opened by scripts/case-run.sh, which serves CDP at ALEPH_CDP
// (default http://127.0.0.1:9223).

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const runRoot = args.find((item) => !item.startsWith('--')) ?? process.env.ALEPH_RUN_ROOT ?? '/tmp/aleph-runs/iter18';
const kickoffIndex = args.indexOf('--kickoff');
const kickoff = kickoffIndex >= 0 ? args[kickoffIndex + 1] : (process.env.ALEPH_KICKOFF ?? null);
const cdp = process.env.ALEPH_CDP ?? 'http://127.0.0.1:9223';

const run = JSON.parse(readFileSync(`${runRoot}/run.json`, 'utf8'));
const targets = await (await fetch(`${cdp}/json`)).json();
const page = targets.find((target) => target.type === 'page');
if (!page) throw new Error('no CDP page target; is the case panel open?');

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  }
};
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
const send = (method, params = {}) => new Promise((resolve) => {
  const callId = ++id;
  pending.set(callId, resolve);
  ws.send(JSON.stringify({ id: callId, method, params }));
});
const evaluate = async (expression) => {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.result?.exceptionDetails) {
    const detail = out.result.exceptionDetails;
    throw new Error(detail.exception?.description ?? detail.text ?? 'evaluation failed');
  }
  return out.result?.result?.value;
};

await send('Page.navigate', { url: run.url });
await new Promise((resolve) => setTimeout(resolve, 2500));

const preset = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, button: 0 }));
  const text = (el) => (el.textContent || '').trim();
  // The preset chip is a button labelled with the current preset name.
  const current = () => [...document.querySelectorAll('button')].map(text).find((label) => /Aleph Research|标准模式|Standard|极简模式|创造模式/.test(label)) ?? '';

  if (/Aleph Research/.test(current())) return 'already-aleph';

  // The preset seat is a header button showing the current preset name.
  const seat = [...document.querySelectorAll('button')].find((button) => /标准模式|Standard|极简模式|创造模式/.test(text(button)));
  if (!seat) {
    // A restored session that already started cannot switch, so open a new one.
    const fresh = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '新建会话');
    if (!fresh) return 'no-seat-and-no-new-session';
    click(fresh);
    await sleep(1200);
  }
  const pick = [...document.querySelectorAll('button')].find((button) => /标准模式|Standard|极简模式|创造模式/.test(text(button)));
  if (!pick) return 'no-preset-picker';
  click(pick);
  await sleep(700);
  const items = [...document.querySelectorAll('[role="menu"] *')].filter((el) => text(el).startsWith('Aleph'));
  const item = items.find((el) => el.children.length === 0) ?? items[0];
  if (!item) return 'aleph-item-missing';
  click(item);
  await sleep(900);
  await sleep(600);
  return /Aleph Research/.test(current()) ? 'switched' : 'switch-failed:' + current();
})()`);

let delivered = null;
if (kickoff) {
  delivered = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = document.querySelector('textarea,[contenteditable="true"]');
    if (!box) return 'no-input';
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(box, ${JSON.stringify(kickoff)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      box.textContent = ${JSON.stringify(kickoff)};
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await sleep(300);
    const send = [...document.querySelectorAll('button')].find((b) => /发送|Send/.test(b.textContent || '') || b.getAttribute('aria-label') === 'Send');
    if (!send) return 'no-send-button';
    send.click();
    await sleep(500);
    return 'sent';
  })()`);
}

console.log(`preset: ${preset}${delivered ? `, kickoff: ${delivered}` : ''}`);
ws.close();
