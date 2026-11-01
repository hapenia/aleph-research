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
  // The preset chip shows the current preset name; its label may be truncated in the button.
  const current = () => [...document.querySelectorAll('button')].map(text)
    .find((label) => /Aleph Re|Aleph Research|标准模式|Standard|极简模式|创造模式/.test(label)) ?? '';

  if (/Aleph Re/.test(current())) return 'already-aleph';

  // The profile defaults new sessions to Aleph, so a fresh session is enough.
  const fresh = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === '新建会话');
  if (fresh) {
    click(fresh);
    await sleep(1500);
    if (/Aleph Re/.test(current())) return 'new-session-aleph';
  }

  // Fall back to choosing the preset from the seat menu.
  const seat = [...document.querySelectorAll('button')].find((button) => /标准模式|Standard|极简模式|创造模式/.test(text(button)));
  if (!seat) return 'no-preset-picker:' + current();
  click(seat);
  await sleep(700);
  const items = [...document.querySelectorAll('[role="menu"] *')].filter((el) => text(el).startsWith('Aleph'));
  const item = items.find((el) => el.children.length === 0) ?? items[0];
  if (!item) return 'aleph-item-missing';
  click(item);
  await sleep(900);
  return /Aleph Re/.test(current()) ? 'switched' : 'switch-failed:' + current();
})()`);

let delivered = null;
if (kickoff) {
  // The editor mounts after navigation and only accepts real input events, so click into it
  // first, then type, and retry once before giving up.
  let box = null;
  for (let attempt = 0; attempt < 40 && !box; attempt += 1) {
    box = await evaluate(`(() => {
      const element = document.querySelector('textarea,[contenteditable="true"]');
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    if (!box) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!box) {
    delivered = 'no-composer';
  } else {
    // Focusing through the page is more reliable than clicking a coordinate that the
    // panel may have moved; a real click is the fallback.
    let focused = false;
    for (let attempt = 0; attempt < 20 && !focused; attempt += 1) {
      focused = await evaluate(`(() => { const element = document.querySelector('textarea,[contenteditable="true"]'); if (!element) return false; element.focus(); return true; })()`);
      if (!focused) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!focused) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    for (let attempt = 0; attempt < 3 && delivered !== 'sent'; attempt += 1) {
      await send('Input.insertText', { text: kickoff });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const typed = await evaluate(`(() => { const element = document.querySelector('textarea,[contenteditable="true"]'); return (element?.value ?? element?.textContent ?? '').trim().length; })()`);
      if (typed > 0) {
        for (const type of ['keyDown', 'keyUp']) {
          await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        }
        await new Promise((resolve) => setTimeout(resolve, 700));
        delivered = 'sent';
      } else {
        delivered = 'insert-failed';
      }
    }
  }
}

console.log(`preset: ${preset}${delivered ? `, kickoff: ${delivered}` : ''}`);
ws.close();
