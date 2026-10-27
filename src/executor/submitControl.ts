import type { FormAts } from 'ats-form-fill'

/**
 * Finding an application form's own submit button — finding, not pressing.
 *
 * Kept out of the fill engine (ats-form-fill) on purpose: in Arkoo that engine
 * is also a browser extension's content script, and the extension never
 * submits. This lives with the executor only.
 *
 * The finder is plain JavaScript in a string so the browser and the
 * happy-dom tests run the very same code (a compiled TypeScript function
 * would carry bundler helpers that do not exist inside the page). It stamps
 * the button it found with `data-arkoo-submit` so the press targets exactly
 * that element and nothing that appeared since.
 */

export interface SubmitTarget {
  /** Always `[data-arkoo-submit="1"]`: the element the finder stamped. */
  selector: string
  /** The button's text, e.g. "Submit application". */
  text: string
  disabled: boolean
  /** How many controls matched the ATS's submit selector. More than one is ambiguous. */
  count: number
}

/** The submit control of each ATS's hosted form, in order of preference. */
export const SUBMIT_SELECTORS: Record<Exclude<FormAts, 'unknown'>, string[]> = {
  greenhouse: ['#application-form button[type="submit"]', 'form button[type="submit"]'],
  ashby: ['button.ashby-application-form-submit-button'],
  // Lever's visible button. `#hcaptchaSubmitBtn` is the hidden one hCaptcha
  // drives; pressing it directly would skip the page's own checks.
  lever: ['#btn-submit'],
}

/**
 * A form whose host has no driver (the agent route, src/navigator/): its own
 * submit control, inside the form. The wording check below still applies, and
 * more than one match is ambiguous, which the pre-submit gate refuses.
 */
export const GENERIC_SUBMIT_SELECTORS = ['form button[type="submit"]', 'form input[type="submit"]']

/** The words a submit button says. A match on anything else is not trusted. */
export const SUBMIT_WORDING = /\b(submit|apply|send)\b/i

export const SUBMIT_MARK = 'data-arkoo-submit'

/**
 * `(function (doc, selectors, wording) { … })` — evaluate it, then call it.
 * Returns a SubmitTarget, or null when no visible control says "submit".
 */
export const SUBMIT_FINDER_JS = `(function (doc, selectors, wording) {
  var rx = new RegExp(wording, 'i');
  var hidden = function (el) {
    for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node.hasAttribute('hidden')) return true;
      if ((node.getAttribute('aria-hidden') || '') === 'true') return true;
      var cls = ' ' + (node.getAttribute('class') || '') + ' ';
      if (cls.indexOf(' hidden ') >= 0) return true;
      var style = (node.getAttribute('style') || '').toLowerCase();
      if (/display:\\s*none|visibility:\\s*hidden/.test(style)) return true;
    }
    return false;
  };
  var old = doc.querySelectorAll('[${SUBMIT_MARK}]');
  for (var i = 0; i < old.length; i++) old[i].removeAttribute('${SUBMIT_MARK}');
  for (var s = 0; s < selectors.length; s++) {
    var all = Array.prototype.slice.call(doc.querySelectorAll(selectors[s]));
    var shown = all.filter(function (el) { return !hidden(el); });
    if (shown.length === 0) continue;
    var el = shown[0];
    var text = (el.textContent || el.getAttribute('value') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    if (!rx.test(text)) continue;
    el.setAttribute('${SUBMIT_MARK}', '1');
    return {
      selector: '[${SUBMIT_MARK}="1"]',
      text: text,
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      count: shown.length
    };
  }
  return null;
})`

/** The finder's arguments for one ATS, as JSON-safe values. */
export function finderArgs(ats: FormAts): [string[], string] {
  return [ats === 'unknown' ? GENERIC_SUBMIT_SELECTORS : SUBMIT_SELECTORS[ats], SUBMIT_WORDING.source]
}

type Finder = (doc: Document, selectors: string[], wording: string) => SubmitTarget | null

/** The finder run on a document in this process (tests, happy-dom). */
export function findSubmitControl(doc: Document, ats: FormAts): SubmitTarget | null {
  const finder = new Function(`return ${SUBMIT_FINDER_JS}`)() as Finder
  return finder(doc, ...finderArgs(ats))
}
